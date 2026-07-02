import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RouterConfig, RouterPinByProfile, RouterTier, RoutingDecision } from './types';
import { createOpenRouterOnPayload, OPENROUTER_ATTR_HEADERS, parseCanonicalModelRef, profileNames, resolveModelFromRef, ROUTER_TIERS } from './config';
import { buildRoutingDecision, countToolResultsSinceLastUserPrompt, extractTextFromContent, runClassifier, shouldRunClassifier } from './routing';
import { formatDecision } from './ui';

const createErrorMessage = (model: Model<Api>, message: string): AssistantMessage => {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'error',
    errorMessage: message,
    timestamp: Date.now(),
  };
};

/** Token estimator: 1 token ~= 4 characters. Conservative and matches pi's compaction path. */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Truncate context to fit within a target token limit by removing oldest messages.
 * Always preserves the first system message and the latest user message.
 */
const truncateContext = (context: Context, limit: number): Context => {
  const messages = [...context.messages];
  if (messages.length <= 1) return context;

  const systemTokens = context.systemPrompt ? estimateTokens(context.systemPrompt) : 0;
  const totalTokens = systemTokens + messages.reduce((sum, m) => sum + estimateTokens(extractTextFromContent(m.content)), 0);
  if (totalTokens <= limit) return context;

  const latestMessage = messages.pop()!;
  const latestTokens = estimateTokens(extractTextFromContent(latestMessage.content));

  let runningTotal = systemTokens + latestTokens + messages.reduce((sum, m) => sum + estimateTokens(extractTextFromContent(m.content)), 0);
  while (messages.length > 0 && runningTotal > limit) {
    const shifted = messages.shift()!;
    runningTotal -= estimateTokens(extractTextFromContent(shifted.content));
  }

  return { ...context, messages: [...messages, latestMessage] };
};

const hasRecentImage = (context: Context): boolean => {
  // Only check the last 6 messages (typically covers the last 3 full turns (3 user messages and 3 assistant responses)
  // to detect images relevant to the current turn. This covers: direct user uploads, tool results from screenshot reads,
  // and assistant messages with images - without firing on stale images from many turns ago.
  const recentMessages = context.messages.slice(-6);
  return recentMessages.some((msg) => Array.isArray(msg.content) && msg.content.some((part) => part.type === 'image'));
};

export const registerRouterProvider = (
  pi: ExtensionAPI,
  state: {
    lastLoadedModelKeys: string;
    readonly currentConfig: RouterConfig;
    readonly currentModelRegistry: ExtensionContext['modelRegistry'] | undefined;
    readonly lastExtensionContext: ExtensionContext | undefined;
    selectedProfile: string | undefined;
    routerEnabled: boolean;
    lastDecision: RoutingDecision | undefined;
    readonly pinnedTierByProfile: RouterPinByProfile;
    debugEnabled: boolean;
  },
  actions: {
    persistState: () => void;
    recordDebugDecision: (decision: RoutingDecision) => void;
    updateStatus: (ctx: ExtensionContext) => void;
  },
) => {
  const currentConfig = state.currentConfig;

  // Map profiles to their capacities
  const models = profileNames(currentConfig).map((name) => {
    const profile = currentConfig.profiles[name];
    let maxContextWindow = 0;
    let maxTokens = 0;

    if (state.currentModelRegistry) {
      for (const tier of ROUTER_TIERS) {
        const tierConfig = profile[tier];
        if (!tierConfig) continue;
        const modelsInTier = [tierConfig.model, ...(tierConfig.fallbacks ?? [])];
        for (const modelRef of modelsInTier) {
          const model = resolveModelFromRef(modelRef, state.currentModelRegistry);
          if (model) {
            const currentContextWindow = model.contextWindow ?? 0;
            if (currentContextWindow > maxContextWindow) {
              maxContextWindow = currentContextWindow;
              maxTokens = model.maxTokens ?? 120_000;
            }
          }
        }
      }
    }

    if (maxContextWindow === 0) maxContextWindow = 1_000_000;
    if (maxTokens === 0) maxTokens = 120_000;

    const profileSupportsReasoning = state.currentModelRegistry
      ? ROUTER_TIERS.some((tier) => {
          const tierConfig = profile[tier];
          if (!tierConfig) return false;
          return (
            resolveModelFromRef(tierConfig.model, state.currentModelRegistry)?.reasoning ||
            tierConfig.fallbacks?.some(
              (fb) => resolveModelFromRef(fb, state.currentModelRegistry)?.reasoning,
            )
          );
        })
      : false;

    return {
      id: name,
      name: `⇋ ${name}`,
      reasoning: profileSupportsReasoning,
      input: ['text', 'image'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: maxContextWindow,
      maxTokens,
    };
  });

  if (state.currentModelRegistry) {
    const invalidOverrides = Object.keys(
      state.currentConfig.contextThresholdPercentOverrides ?? {},
    ).filter((modelRef) => !resolveModelFromRef(modelRef, state.currentModelRegistry));

    if (invalidOverrides.length > 0) {
      state.lastExtensionContext?.ui.notify(
        `Router configuration contains contextThresholdPercentOverrides for models that do not exist: ${invalidOverrides.map((modelRef) => JSON.stringify(modelRef)).join(', ')}`,
        'warning',
      );
    }
  }

  const loadedModelKeys = models.map((m) => `${m.id}:${m.contextWindow}:${m.maxTokens}:${m.reasoning}`).join(',');
  if (state.lastLoadedModelKeys === loadedModelKeys) return; // models did not change, no need to re-register

  pi.registerProvider(
    'router', { // config (baseUrl, apiKey, ...)
    baseUrl: 'router://local',
    apiKey: 'pi-model-router',
    api: 'router-local-api',
    models,
    streamSimple: (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ): AssistantMessageEventStream => {
      const stream = createAssistantMessageEventStream();
      const ctx = state.lastExtensionContext;
      const modelRegistry = state.currentModelRegistry;

      (async () => {
        try {
          if (!modelRegistry) {
            throw new Error('Router provider not initialized yet. Wait for session_start and retry.');
          }
          const profile = currentConfig.profiles[model.id];
          if (!profile) {
            throw new Error(`Unknown router profile: ${model.id}`);
          }

          state.selectedProfile = model.id;
          state.routerEnabled = true;

          const pinnedTier = state.pinnedTierByProfile[model.id];
          const lastDecision = state.lastDecision;

          const lastMessage = context.messages[context.messages.length - 1];
          const lastMsgWasTool = lastMessage?.role === 'toolResult';

          let decision: RoutingDecision;

          let bShouldRunClassifier = false;

          const isGoogleContinuation =
            lastMsgWasTool &&
            lastDecision?.profile === model.id &&
            lastDecision?.targetProvider === 'google' &&
            lastDecision?.thinking !== 'off';
          if (isGoogleContinuation) { // Google thinking lock — preserve exact model on tool-result continuations
            const toolResultsCount = countToolResultsSinceLastUserPrompt(context);
            decision = {
              ...lastDecision!,
              timestamp: Date.now(),
              reasoning: `Preserved ${lastDecision!.targetLabel} for Google tool-result continuation.`,
              lastClassifierRunToolCount: toolResultsCount,
            };
          } else {
            let resolvedTier: RouterTier;
            let resolvedReasoning: string;
            let lastClassifierRunToolCount = lastDecision?.lastClassifierRunToolCount;

            if (currentConfig.classifierModels?.length && !pinnedTier) {
              const toolResultsCount = countToolResultsSinceLastUserPrompt(context);

              bShouldRunClassifier = shouldRunClassifier(currentConfig, context, lastDecision, lastMsgWasTool, toolResultsCount, state.debugEnabled, ctx);
              const classifierResult = bShouldRunClassifier
                ? await runClassifier(currentConfig, modelRegistry, context, lastDecision, ctx, state.debugEnabled)
                : null;

              if (classifierResult) {
                resolvedTier = classifierResult.tier;
                resolvedReasoning = `Classifier: ${classifierResult.reasoning}`;
                lastClassifierRunToolCount = toolResultsCount;
              } else if (lastDecision) {
                // Classifier skipped or failed — reuse previous decision
                resolvedTier = lastDecision.tier;
                resolvedReasoning = lastDecision.reasoning;
              } else {
                resolvedTier = 'medium';
                resolvedReasoning = 'No classifier result yet, defaulting to medium.';
              }
            } else if (pinnedTier) {
              resolvedTier = pinnedTier;
              resolvedReasoning = `Pinned to ${pinnedTier} tier.`;
            } else {
              resolvedTier = 'medium';
              resolvedReasoning = 'No classifier configured, defaulting to medium.';
            }

            decision = buildRoutingDecision(model.id, profile, resolvedTier, resolvedReasoning, lastClassifierRunToolCount);
          }

          let tokensUsed = 0;
          try {
            const contextUsage = await ctx?.getContextUsage();
            tokensUsed = contextUsage?.tokens ?? 0;
          } catch {
            ctx?.ui.notify('Could not read current context size from pi.', 'warning');
          }

          const detectedImageInRecentContext = hasRecentImage(context);
          const tiersToTry = ROUTER_TIERS.slice(0, ROUTER_TIERS.indexOf(decision.tier) + 1).reverse();
          const triedModels = new Set<string>();
          const failureReasons: string[] = [];
          let lastError: unknown;
          let success = false;

          // Pass 1: models that satisfy both image support and context thresholds.
          // Pass 2: last resort — models that satisfy image support but need context truncation.
          attemptLoop: for (const pass of [1, 2]) {
            for (const tier of tiersToTry) {
              const tierConfig = profile[tier];
              if (!tierConfig) continue;
              const modelsInTier = [tierConfig.model, ...(tierConfig.fallbacks ?? [])];

              if (pass === 2) {
                // Sort models by context window descending to minimize truncation.
                modelsInTier.sort((a, b) => {
                  const limitA = resolveModelFromRef(a, modelRegistry)?.contextWindow || 0;
                  const limitB = resolveModelFromRef(b, modelRegistry)?.contextWindow || 0;
                  return limitB - limitA;
                });
              }

              for (const modelRef of modelsInTier) {
                if (triedModels.has(modelRef)) continue;
                if (detectedImageInRecentContext && !resolveModelFromRef(modelRef, modelRegistry)?.input?.includes('image')) {
                  failureReasons.push(`${modelRef} does not support images`);
                  continue;
                }

                const targetModel = resolveModelFromRef(modelRef, modelRegistry);
                if (!targetModel) {
                  failureReasons.push(`${modelRef} not found in registry`);
                  continue;
                }

                if (targetModel.contextWindow === undefined || targetModel.contextWindow === 0) {
                  ctx?.ui.notify(`Router warning: model ${modelRef} has no known context size`, 'warning');
                }

                const thresholdPercent =
                  currentConfig.contextThresholdPercentOverrides?.[modelRef] ??
                  currentConfig.defaultContextThresholdPercent ?? 90;
                const targetContextWindow = targetModel.contextWindow || 200_000;
                const targetContextLimit = Math.floor((thresholdPercent / 100) * targetContextWindow);
                const fitsContext = tokensUsed <= targetContextLimit;

                if (pass === 1 && !fitsContext) {
                  failureReasons.push(`${modelRef} context exceeded (used ${tokensUsed} > ${targetContextLimit})`);
                  continue;
                }
                triedModels.add(modelRef);
                const { provider: targetProvider, modelId: targetModelId } = parseCanonicalModelRef(modelRef);

                if (tier !== decision.tier || modelRef !== decision.targetLabel) {
                  const triggerReasons = [
                    ...(detectedImageInRecentContext ? ['images'] : []),
                    ...(!fitsContext ? ['context limit exceeded'] : []),
                  ].join(' and ');

                  if (tier !== decision.tier) {
                    decision = buildRoutingDecision(
                      model.id, profile, tier,
                      `Forced ${tier} tier because ${decision.tier} tier lacks models${triggerReasons ? ` for ${triggerReasons}` : ''}.`,
                      decision.lastClassifierRunToolCount,
                    );
                  } else {
                    decision.reasoning += triggerReasons ? ` (Using ${modelRef} for ${triggerReasons})` : '';
                  }
                }
                decision.targetProvider = targetProvider;
                decision.targetModelId = targetModelId;
                decision.targetLabel = modelRef;
                decision.isFallback = !tierConfig || modelRef !== tierConfig.model;
                decision.isContextTriggered = !fitsContext;

                if (ctx) {
                  if (state.debugEnabled && bShouldRunClassifier) {
                    ctx.ui.notify(`Decision ${formatDecision(decision)}`, 'info');
                  }
                  actions.updateStatus(ctx);
                }

                const auth = await modelRegistry.getApiKeyAndHeaders(targetModel);
                if (!auth.ok) {
                  const reason = `Auth failed for model: ${modelRef}: ${auth.error}`;
                  lastError = new Error(reason);
                  failureReasons.push(`${modelRef} auth failed: ${reason}`);
                  continue;
                }
                // Note: auth.apiKey may be undefined for env-var-based providers
                // (e.g., OPENROUTER_API_KEY). The compat streamSimple resolves
                // env vars independently, so we pass auth.apiKey as-is to let the
                // compat layer handle the fallback.

                let effectiveContext = context;
                if (!fitsContext) {
                  effectiveContext = truncateContext(context, targetContextLimit);
                  ctx?.ui.notify(`Memory too large for ${modelRef} — trimmed ${context.messages.length - effectiveContext.messages.length} messages. Run /compact to reduce context size.`, 'warning');
                }

                // Attention: stripping reasoning from pi's incoming options so it doesn't leak into ...baseOptions. The router controls this via delegatedReasoning below.
                const { onPayload, headers: originalHeaders, reasoning: _incomingReasoning, ...baseOptions } = options ?? {};

                const effectiveHeaders: Record<string, string> = {
                  ...(originalHeaders as Record<string, string> | undefined),
                  ...(auth.headers ?? {}),
                  ...(targetProvider === 'openrouter' ? OPENROUTER_ATTR_HEADERS : {}),
                };

                const delegatedReasoning = targetModel.reasoning && decision.thinking !== 'off' ? decision.thinking : undefined;
                pi.setThinkingLevel(delegatedReasoning ?? 'off');

                const effectiveOptions: SimpleStreamOptions = {
                  ...baseOptions,
                  apiKey: auth.apiKey,
                  headers: effectiveHeaders,
                  ...(delegatedReasoning ? { reasoning: delegatedReasoning } : {}),
                };

                if (targetProvider === 'openrouter') {
                  effectiveOptions.onPayload = createOpenRouterOnPayload(ctx?.sessionManager, onPayload) ?? onPayload;
                } else if (onPayload) {
                  effectiveOptions.onPayload = onPayload;
                }

                const MAX_ATTEMPTS_PER_MODEL = 2;
                for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
                  try {
                    const delegatedStream = streamSimple(targetModel, effectiveContext, effectiveOptions);
                    let contentReceived = false;
                    for await (const event of delegatedStream) {
                      if (event.type === 'error' && !contentReceived) {
                        throw new Error(event.error.errorMessage || 'Model failed before sending content.');
                      }
                      if (
                        event.type === 'text_delta' ||
                        event.type === 'thinking_delta' ||
                        event.type === 'toolcall_delta' ||
                        event.type === 'toolcall_end'
                      ) {
                        contentReceived = true;
                      }
                      stream.push(event);
                    }
                    success = true;
                    state.lastDecision = decision;
                    break attemptLoop;
                  } catch (err) {
                    lastError = err;
                    const remaining = MAX_ATTEMPTS_PER_MODEL - attempt;
                    const retryMsg = remaining > 0 ? ` — ${remaining} ${remaining === 1 ? 'retry' : 'retries'} left` : '';
                    ctx?.ui.notify(`Failed to reach model ${modelRef} (attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL}): ${err}${retryMsg}`, 'warning');
                  }
                }
              }
            }
          }

          actions.recordDebugDecision(decision);

          if (!success) {
            const errorMsg = `Failed to delegate to any model in the chain.${failureReasons.length > 0 ? ' Reasons: ' + failureReasons.filter(Boolean).join('; ') + '.' : ''}`;
            const combinedError = lastError ? new Error(`${(lastError as Error).message} — ${errorMsg}`) : new Error(errorMsg);
            throw combinedError;
          }

          stream.end();
        } catch (error) {
          stream.push({
            type: 'error',
            reason: 'error',
            error: createErrorMessage(model, error instanceof Error ? error.message : String(error)),
          });
          stream.end();
        } finally {
          actions.persistState();
        }
      })();

      return stream;
    },
  });

  state.lastLoadedModelKeys = loadedModelKeys;
};
