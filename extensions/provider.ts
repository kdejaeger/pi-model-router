import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  streamSimple
} from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RouterConfig, RouterPinByProfile, RouterTier, RoutingDecision } from './types';
import { createOpenRouterOnPayload, OPENROUTER_ATTR_HEADERS, parseCanonicalModelRef, profileNames, resolveModelFromRef, ROUTER_TIERS } from './config';
import { buildRoutingDecision, countToolResultsSinceLastUserPrompt, decisionsMatch, extractTextFromContent, makeHeuristicAnalysis, runClassifier, shouldRunClassifier } from './routing';
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

/**
 * Heuristic token estimator aligned with pi's built-in compaction heuristic:
 * 1 token ~= 4 characters. This is conservative and matches the core compaction path.
 */
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

  // Remove oldest until it fits
  while (messages.length > 0) {
    const currentTokens =
      systemTokens +
      estimateTokens(extractTextFromContent(latestMessage.content)) +
      messages.reduce((sum, m) => sum + estimateTokens(extractTextFromContent(m.content)), 0);
    if (currentTokens <= limit) break;
    messages.shift();
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

const checkModelSupportsImage = (
  modelRef: string,
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): boolean => {
  return resolveModelFromRef(modelRef, modelRegistry)?.input?.includes('image') ?? false;
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
    let maxContextWindow = 1_000_000;
    let maxOutputTokens = 120_000;
    let highestContextWindowFound = 0;

    if (state.currentModelRegistry) {
      for (const tier of ROUTER_TIERS) {
        const tierConfig = profile[tier];
        if (!tierConfig) continue;
        const modelsInTier = [tierConfig.model, ...(tierConfig.fallbacks ?? [])];
        for (const modelRef of modelsInTier) {
          const model = resolveModelFromRef(modelRef, state.currentModelRegistry);
          if (model) {
            const currentContextWindow = model.contextWindow ?? 0;
            if (currentContextWindow > highestContextWindowFound) {
              highestContextWindowFound = currentContextWindow;
              maxContextWindow = currentContextWindow;
              maxOutputTokens = model.maxTokens ?? 120_000;
            }
          }
        }
      }
    }

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
      maxTokens: maxOutputTokens,
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
            const heuristicAnalysis = makeHeuristicAnalysis(context, lastDecision, pinnedTier, currentConfig.tierStickiness, currentConfig.rules);

            let resolvedTier: RouterTier = heuristicAnalysis.suggestedTier;
            let resolvedReasoning: string = `Heuristic: ${heuristicAnalysis.reasoning}`;
            let lastClassifierRunToolCount = lastDecision?.lastClassifierRunToolCount;

            if (currentConfig.classifierModels?.length && !pinnedTier) {
              const toolResultsCount = countToolResultsSinceLastUserPrompt(context);

              const shouldRunTheClassifier = shouldRunClassifier(currentConfig, context, lastDecision, lastMsgWasTool, toolResultsCount, state.debugEnabled, ctx);
              const classifierResult = shouldRunTheClassifier
                ? await runClassifier(currentConfig, modelRegistry, context, lastDecision, heuristicAnalysis, ctx, state.debugEnabled)
                : null;

              if (classifierResult) { // Use the result from the fresh classifier run
                resolvedTier = classifierResult.tier;
                resolvedReasoning = `Classifier: ${classifierResult.reasoning}`;
                lastClassifierRunToolCount = toolResultsCount;
              } else {
                if (shouldRunTheClassifier && state.debugEnabled && ctx) {
                  ctx.ui.notify('Classifier returned no result', 'warning');
                }
                if (lastDecision?.reasoning.startsWith('Classifier:')) { // If classifier failed or was skipped, reuse the previous classifier's decision
                  resolvedTier = lastDecision.tier;
                  resolvedReasoning = lastDecision.reasoning;
                }
              }
            }

            decision = buildRoutingDecision(model.id, profile, resolvedTier, resolvedReasoning, lastClassifierRunToolCount);
            decision.isHeuristicRuleMatched = heuristicAnalysis.isRuleMatched;
          }

          let tokensUsed = 0;
          try {
            const contextUsage = await ctx?.getContextUsage();
            tokensUsed = contextUsage?.tokens ?? 0;
          } catch {
            ctx?.ui.notify('Unable to get context usage (and determine tokens used) from pi', 'warning');
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
                if (detectedImageInRecentContext && !checkModelSupportsImage(modelRef, modelRegistry)) {
                  failureReasons.push(`${modelRef} does not support images`);
                  continue;
                }

                const targetModel = resolveModelFromRef(modelRef, modelRegistry);
                if (!targetModel) {
                  failureReasons.push(`${modelRef} not found in registry`);
                  continue;
                }

                if (targetModel.contextWindow === undefined || targetModel.contextWindow === 0) {
                  ctx?.ui.notify(`Router warning: model ${modelRef} has no contextWindow in registry`, 'warning');
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

                  decision.targetProvider = targetProvider;
                  decision.targetModelId = targetModelId;
                  decision.targetLabel = modelRef;
                  decision.isFallback = !tierConfig || modelRef !== tierConfig.model;
                  decision.isContextTriggered = !fitsContext;
                }

                if (ctx) {
                  if (state.debugEnabled && !decisionsMatch(state.lastDecision, decision)) {
                    ctx.ui.notify(`Decision ${formatDecision(decision)}`, 'info');
                  }
                  actions.updateStatus(ctx);
                }

                const auth = await modelRegistry.getApiKeyAndHeaders(targetModel);
                if (!auth.ok || !auth.apiKey) {
                  const reason = auth.ok
                    ? `No API key for model: ${modelRef}`
                    : `Auth failed for model: ${modelRef}: ${auth.error}`;
                  lastError = new Error(reason);
                  failureReasons.push(`${modelRef} auth failed: ${reason}`);
                  continue;
                }

                // Try delegation
                const MAX_ATTEMPTS_PER_MODEL = 2;
                for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
                  try {
                    const delegatedReasoning =
                      targetModel.reasoning && decision.thinking !== 'off'
                        ? decision.thinking
                        : undefined;
                    pi.setThinkingLevel(delegatedReasoning ?? 'off');

                    let effectiveContext = context;
                    if (!fitsContext) {
                      ctx?.ui.notify(`Context too large for ${modelRef} (${thresholdPercent}% of ${targetContextWindow}). Truncating now. Run /compact to avoid context loss.`, 'warning',);
                      effectiveContext = truncateContext(context, targetContextLimit);
                    }

                    // Strip pi's reasoning from options — the router controls thinking.
                    const { onPayload: origOnPayload, headers: originalHeaders, ...delegationOptions } = options ?? {};

                    // Build effective headers: request headers → provider headers → OpenRouter attribution
                    const effectiveHeaders: Record<string, string> = {
                      ...(originalHeaders as Record<string, string> | undefined),
                      ...(auth.headers ?? {}),
                    };

                    if (targetProvider === 'openrouter') {
                      Object.assign(effectiveHeaders, OPENROUTER_ATTR_HEADERS);
                    }

                    const effectiveOptions: Record<string, unknown> = {
                      ...delegationOptions,
                      apiKey: auth.apiKey,
                      headers: effectiveHeaders,
                      ...(delegatedReasoning ? { reasoning: delegatedReasoning } : {})
                    };

                    if (targetProvider === 'openrouter') {
                      const onPayload = createOpenRouterOnPayload(ctx?.sessionManager, origOnPayload);
                      if (onPayload) effectiveOptions.onPayload = onPayload;
                    } else if (origOnPayload) {
                      effectiveOptions.onPayload = origOnPayload;
                    }

                    const delegatedStream = streamSimple(targetModel, effectiveContext, effectiveOptions);

                    let contentReceived = false;
                    for await (const event of delegatedStream) {
                      if (event.type === 'error' && !contentReceived) {
                        throw new Error(((event as { error?: AssistantMessage }).error?.errorMessage) || 'Model failed before sending content.');
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
                    ctx?.ui.notify(
                      `Failed to delegate to model ${modelRef} (attempt ${attempt}/${MAX_ATTEMPTS_PER_MODEL}): ${err}${retryMsg}`,
                      'warning',
                    );
                  }
                }
              }
            }
          }

          actions.recordDebugDecision(decision);

          if (!success) {
            throw lastError || new Error(
              `Failed to delegate to any model in the chain.${failureReasons.length > 0 ? ' Reasons: ' + failureReasons.filter(Boolean).join('; ') + '.' : ''}`,
            );
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
