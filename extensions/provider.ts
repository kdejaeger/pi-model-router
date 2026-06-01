import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  streamSimple
} from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RouterConfig, RouterPinByProfile, RouterThinkingByProfile, RouterTier, RoutingDecision } from './types';
import { parseCanonicalModelRef, profileNames, resolveModelFromRef, ROUTER_TIERS } from './config';
import { buildRoutingDecision, countToolResultsSinceLastUserPrompt, extractTextFromContent, makeHeuristicAnalysis, runClassifier, shouldRunClassifier } from './routing';
import { formatDecision } from './ui';

export const createErrorMessage = (model: Model<Api>, message: string): AssistantMessage => {
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

  const getSystemTokens = () => (context.systemPrompt ? estimateTokens(context.systemPrompt) : 0);

  // Initial estimate
  const totalTokens = getSystemTokens() + messages.reduce((sum, m) => sum + estimateTokens(extractTextFromContent(m.content)), 0);
  if (totalTokens <= limit) return context;

  const latestMessage = messages.pop();
  if (!latestMessage) return context;

  // Remove oldest until it fits
  while (messages.length > 0) {
    const currentTokens =
      getSystemTokens() +
      estimateTokens(extractTextFromContent(latestMessage.content)) +
      messages.reduce((sum, m) => sum + estimateTokens(extractTextFromContent(m.content)), 0);

    if (currentTokens <= limit) break;
    messages.shift(); // Remove oldest
  }

  const finalMessages: Message[] = [];
  finalMessages.push(...messages);
  finalMessages.push(latestMessage);

  return { ...context, messages: finalMessages };
};

const supportsReasoning = (
  profile: RouterConfig['profiles'][string],
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): boolean => {
  if (!modelRegistry) return false;

  for (const tier of ROUTER_TIERS) {
    const modelsInTier = [profile[tier].model, ...(profile[tier].fallbacks ?? [])];
    for (const modelRef of modelsInTier) {
      if (resolveModelFromRef(modelRef, modelRegistry)?.reasoning) {
        return true;
      }
    }
  }

  return false;
};

const imageDetectedInRecentContext = (context: Context): boolean => {
  // Only check the last 6 messages (typically covers the last 3 full turns (3 user messages and 3 assistant responses)
  // to detect images relevant to the current turn. This covers: direct user uploads, tool results from screenshot reads,
  // and assistant messages with images - without firing on stale images from many turns ago.
  const recentMessages = context.messages.slice(-6);
  return recentMessages.some((msg) => {
    return Array.isArray(msg.content) && msg.content.some((part) => part.type === 'image');
  });
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
    selectedProfile: string;
    routerEnabled: boolean;
    lastDecision: RoutingDecision | undefined;
    readonly thinkingByProfile: RouterThinkingByProfile;
    readonly pinnedTierByProfile: RouterPinByProfile;
    debugEnabled: boolean;
  },
  actions: {
    persistState: () => void;
    recordDebugDecision: (decision: RoutingDecision) => void;
    getThinkingOverride: (profileName: string, tier: RouterTier) => any;
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

    return {
      id: name,
      name: `Router ${name}`,
      reasoning: supportsReasoning(profile, state.currentModelRegistry),
      input: ['text', 'image'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: maxContextWindow,
      maxTokens: maxOutputTokens,
    };
  });

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

      (async () => {
        try {
          if (!state.currentModelRegistry) {
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
            decision = {
              ...lastDecision!,
              timestamp: Date.now(),
              reasoning: `Preserved ${lastDecision!.targetLabel} for Google tool-result continuation.`,
            };
          } else {
            const heuristicAnalysis = makeHeuristicAnalysis(context, lastDecision, pinnedTier, currentConfig.tierStickiness, currentConfig.rules);

            let resolvedTier: RouterTier = heuristicAnalysis.suggestedTier;
            let resolvedReasoning: string = `Heuristic: ${heuristicAnalysis.reasoning}`;
            let lastClassifierRunToolCount = lastDecision?.lastClassifierRunToolCount;

            if (currentConfig.classifierModel && !pinnedTier) {
              const toolResultsCount = countToolResultsSinceLastUserPrompt(context);

              const shouldRunTheClassifier = shouldRunClassifier(currentConfig, context, lastDecision, lastMsgWasTool, toolResultsCount, state.debugEnabled, state.lastExtensionContext);
              const classifierResult = shouldRunTheClassifier
                ? await runClassifier(currentConfig, state.currentModelRegistry, context, lastDecision, heuristicAnalysis)
                : null;

              if (classifierResult) { // Use the result from the fresh classifier run
                resolvedTier = classifierResult.tier;
                resolvedReasoning = `Classifier: ${classifierResult.reasoning}`;
                lastClassifierRunToolCount = toolResultsCount;
              } else {
                if (shouldRunTheClassifier && state.debugEnabled && state.lastExtensionContext) {
                  state.lastExtensionContext.ui.notify('Classifier returned no result', 'warning');
                }
                if (lastDecision?.reasoning.startsWith('Classifier:')) { // If classifier failed or was skipped, reuse the previous classifier's decision
                  resolvedTier = lastDecision.tier;
                  resolvedReasoning = lastDecision.reasoning;
                }
              }
            }

            decision = buildRoutingDecision(model.id, profile, resolvedTier, resolvedReasoning, state.thinkingByProfile[model.id], lastClassifierRunToolCount);
            decision.isHeuristicRuleMatched = heuristicAnalysis.isRuleMatched;
          }

          let tokensUsed = 0;
          try {
            const contextUsage = await state.lastExtensionContext?.getContextUsage();
            tokensUsed = contextUsage?.tokens ?? 0;
          } catch {
            state.lastExtensionContext?.ui.notify('Unable to get context usage (and determine tokens used) from pi','warning');
          }

          const detectedImageInRecentContext = imageDetectedInRecentContext(context);
          const tiersToTry = ROUTER_TIERS.slice(0, ROUTER_TIERS.indexOf(decision.tier) + 1).reverse();
          const triedModels = new Set<string>();
          const failureReasons: string[] = [];
          let lastError: any;
          let success = false;

          // Pass 1: Try models that satisfy both image support and context thresholds.
          // Pass 2: Last resort — try models that satisfy image support but need context truncation.
          attemptLoop: for (const pass of [1, 2]) {
            for (const tier of tiersToTry) {
              const modelsInTier = [profile[tier].model, ...(profile[tier].fallbacks ?? [])];

              if (pass === 2) { // sort models by context window descending to minimize truncation.
                modelsInTier.sort((a, b) => {
                  const limitA = resolveModelFromRef(a, state.currentModelRegistry)?.contextWindow || 0;
                  const limitB = resolveModelFromRef(b, state.currentModelRegistry)?.contextWindow || 0;
                  return limitB - limitA;
                });
              }

              for (const modelRef of modelsInTier) {
                if (triedModels.has(modelRef)) continue;
                if (detectedImageInRecentContext && !checkModelSupportsImage(modelRef, state.currentModelRegistry)) {
                  failureReasons.push(`${modelRef} does not support images`);
                  continue;
                }

                const targetModel = resolveModelFromRef(modelRef, state.currentModelRegistry);
                if (!targetModel) {
                  failureReasons.push(`${modelRef} not found in registry`);
                  continue;
                }

                if (targetModel.contextWindow === undefined || targetModel.contextWindow === 0) {
                  state.lastExtensionContext?.ui.notify(`Router warning: model ${modelRef} has no contextWindow in registry`, 'warning');
                }

                const thresholdPercent =
                  currentConfig.contextThresholdPercentOverrides?.[modelRef] ??
                  currentConfig.defaultContextThresholdPercent;
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
                  const triggers = [
                    ...(detectedImageInRecentContext ? ['images'] : []),
                    ...(!fitsContext ? ['context limit exceeded'] : [])
                  ].join(' and ');

                  if (tier !== decision.tier) {
                    decision = buildRoutingDecision(
                      model.id, profile, tier,
                      `Forced ${tier} tier because ${decision.tier} tier lacks models for ${triggers}.`,
                      state.thinkingByProfile[model.id], decision.lastClassifierRunToolCount
                    );
                  } else {
                    decision.reasoning += ` (Using ${modelRef} for ${triggers})`;
                  }

                  Object.assign(decision, { targetProvider, targetModelId, targetLabel: modelRef, isFallback: modelRef !== profile[tier].model, isContextTriggered: !fitsContext });
                }

                if (state.lastExtensionContext) {
                  if (state.debugEnabled) state.lastExtensionContext.ui.notify('Decision = ' + formatDecision(decision), 'info');
                  actions.updateStatus(state.lastExtensionContext);
                }

                const auth = await state.currentModelRegistry!.getApiKeyAndHeaders(targetModel);
                if (!auth.ok || !auth.apiKey) {
                  const reason = auth.ok
                    ? `No API key for model: ${modelRef}`
                    : `Auth failed for model: ${modelRef}: ${auth.error}`;
                  lastError = new Error(reason);
                  failureReasons.push(`${modelRef} auth failed: ${reason}`);
                  continue;
                }

                // Try delegation
                const MAX_RETRIES_PER_MODEL = 2;
                for (let attempt = 1; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
                  try {
                    const thinkingOverride = actions.getThinkingOverride(model.id, decision.tier);
                    const delegatedReasoning =
                      targetModel.reasoning && (thinkingOverride ?? decision.thinking) !== 'off'
                        ? (thinkingOverride ?? decision.thinking)
                        : undefined;
                    pi.setThinkingLevel(delegatedReasoning ?? 'off');
                    if (state.lastExtensionContext) {
                      if (delegatedReasoning) {
                        state.lastExtensionContext.ui.setHiddenThinkingLabel?.(`Thinking (${targetProvider}/${targetModelId})...`);
                      } else {
                        state.lastExtensionContext.ui.setHiddenThinkingLabel?.();
                      }
                    }

                    let effectiveContext = context;
                    if (!fitsContext) {
                      state.lastExtensionContext?.ui.notify(`Context too large for ${modelRef}. Truncating now. Run /compact to avoid context loss.`, 'warning',);
                      effectiveContext = truncateContext(context, targetContextLimit);
                    }

                    const effectiveOptions = {
                      ...options,
                      apiKey: auth.apiKey,
                      headers: auth.headers,
                      ...(delegatedReasoning ? { reasoning: delegatedReasoning } : {})
                    };

                    const delegatedStream = streamSimple(targetModel, effectiveContext, effectiveOptions);

                    let contentReceived = false;
                    for await (const event of delegatedStream) {
                      if (event.type === 'error' && !contentReceived) {
                        throw new Error((event as any).error?.errorMessage || 'Model failed before sending content.');
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
                    const remaining = MAX_RETRIES_PER_MODEL - attempt;
                    state.lastExtensionContext?.ui.notify(
                      `Failed to delegate to model ${modelRef} (attempt ${attempt}/${MAX_RETRIES_PER_MODEL}): ${err}${remaining > 0 ? ` — ${remaining} retr${remaining === 1 ? 'y' : 'ies'} left` : ''}`,
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
