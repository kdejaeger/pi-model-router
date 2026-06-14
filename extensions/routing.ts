import { type Context, type Message, streamSimple } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  HeuristicAnalysis,
  RouterConfig,
  RouterProfile,
  RouterTier,
  RoutingDecision,
  RoutingRule,
} from './types';
import { createOpenRouterOnPayload, OPENROUTER_ATTR_HEADERS, parseCanonicalModelRef, resolveModelFromRef } from './config';

export const extractTextFromContent = (content: string | Message['content']): string => {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'thinking') return part.thinking;
      if (part.type === 'toolCall') return `${part.name} ${JSON.stringify(part.arguments)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

const getLastUserText = (context: Context): string => {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i] as Message;
    if (message.role === 'user') {
      const content = extractTextFromContent(message.content).trim();
      if (message.timestamp) {
        const time = new Date(message.timestamp).toISOString();
        return `[${time}] ${content}`;
      }
      return content;
    }
  }
  return '';
};

const getRecentConversationText = (context: Context, limit = 6): string => {
  return context.messages
    .slice(-limit)
    .map((message) => {
      const time = message.timestamp ? `[${new Date(message.timestamp).toISOString()}] ` : '';

      let rolePrefix: string;
      const role = (message as Message).role;
      switch (role) {
        case 'user':
          rolePrefix = 'User';
          break;
        case 'assistant':
          rolePrefix = 'Assistant';
          break;
        case 'toolResult':
          rolePrefix = 'Tool';
          break;
        default:
          rolePrefix = role || 'Unknown';
      }

      const content = extractTextFromContent(message.content).trim();
      if (!content) return '';

      return `${time}${rolePrefix}: ${content}`;
    })
    .filter(Boolean)
    .join('\n\n');
};

/** Count tool results since the last user message (current turn only). */
export const countToolResultsSinceLastUserPrompt = (context: Context): number => {
  let count = 0;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i] as Message;
    if (msg.role === 'user') break;
    if (msg.role === 'toolResult') count++;
  }
  return count;
};

/** Count consecutive failed tool results from the tail of the current turn.
 *  Resets to 0 as soon as a successful tool result is encountered. */
const countConsecutiveRecentToolFailuresSinceLastUserPrompt = (context: Context): number => {
  let count = 0;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i] as Message;
    if (msg.role === 'user') break;
    if (msg.role !== 'toolResult') continue;
    if ((msg as { isError?: boolean }).isError) {
      count++;
    } else {
      break; // success resets the chain
    }
  }
  return count;
};

const countWords = (text: string): number => {
  return text.split(/\s+/).filter(Boolean).length;
};

const containsAny = (text: string, keywords: string[]): boolean => {
  return keywords.some((keyword) => text.includes(keyword));
};

const EXPLICIT_HIGH_HINTS = [
  'best',
  'deep',
  'deeply',
  'carefully',
  'thoroughly',
  'robust',
  'comprehensive',
  'step by step',
  'think hard',
  'highest quality',
  'ultrathink',
];
const EXPLICIT_LOW_HINTS = ['fast', 'cheap', 'quick', 'quickly', 'brief', 'briefly', 'one sentence', 'one line', 'tiny', 'small'];
const PLANNING_KEYWORDS = [
  'plan',
  'planning',
  'architecture',
  'architect',
  'design',
  'tradeoff',
  'trade-off',
  'research',
  'investigate',
  'root cause',
  'analyze',
  'analysis',
  'migration',
  'strategy',
  'compare',
  'options',
  'approach',
];
const SUMMARY_KEYWORDS = [
  'summarize',
  'summary',
  'changelog',
  'rewrite',
  'reformat',
  'format',
  'rename',
  'explain briefly',
  'recap',
  'tl;dr',
];
const IMPLEMENTATION_KEYWORDS = [
  'implement',
  'code',
  'fix',
  'update',
  'edit',
  'write',
  'refactor',
  'add tests',
  'patch',
  'change',
  'apply',
  'continue',
  'resume',
  'make the changes',
  'go ahead',
];
const LOOKUP_KEYWORDS = ['where is', 'which file', 'show me', 'list', 'what files', 'find', 'grep'];

export const buildRoutingDecision = (
  profileName: string,
  profile: RouterProfile,
  tier: RouterTier,
  reasoning: string,
  lastClassifierRunToolCount?: number,
): RoutingDecision => {
  const routedTierConf = profile[tier]!;

  const { provider, modelId } = parseCanonicalModelRef(routedTierConf.model);

  return {
    profile: profileName,
    tier,
    targetProvider: provider,
    targetModelId: modelId,
    targetLabel: routedTierConf.model,
    reasoning,
    thinking: routedTierConf.thinking ?? 'medium',
    timestamp: Date.now(),
    lastClassifierRunToolCount,
  };
};

/** Compare only the semantically meaningful fields of two routing decisions. */
export const decisionsMatch = (a: RoutingDecision | undefined, b: RoutingDecision): boolean =>
  a !== undefined &&
  a.profile === b.profile &&
  a.tier === b.tier &&
  a.targetProvider === b.targetProvider &&
  a.targetModelId === b.targetModelId &&
  a.thinking === b.thinking &&
  a.isFallback === b.isFallback &&
  a.isContextTriggered === b.isContextTriggered &&
  a.reasoning === b.reasoning;

/**
 * Analyze a user prompt and conversation context using local heuristics.
 *
 * When a classifier model is configured, this analysis is used as advisory input
 * for the LLM classifier (the classifier has final say). When no classifier is
 * configured, the heuristic analysis directly becomes the routing decision.
 */
const analyzeKeywords = (prompt: string) => ({
  explicitHigh: containsAny(prompt, EXPLICIT_HIGH_HINTS),
  explicitLow: containsAny(prompt, EXPLICIT_LOW_HINTS),
  planning: containsAny(prompt, PLANNING_KEYWORDS),
  implementation: containsAny(prompt, IMPLEMENTATION_KEYWORDS),
  summary: containsAny(prompt, SUMMARY_KEYWORDS),
  lookup: containsAny(prompt, LOOKUP_KEYWORDS),
});

const matchCustomRule = (
  prompt: string,
  rules: RoutingRule[] | undefined,
): { tier: RouterTier; reasoning: string; matched: boolean } => {
  if (!rules) return { tier: 'medium', reasoning: '', matched: false };
  for (const rule of rules) {
    const matches = Array.isArray(rule.matches) ? rule.matches : [rule.matches];
    if (containsAny(prompt, matches)) {
      return {
        tier: rule.tier,
        reasoning: rule.reason ?? `Matched custom routing rule for: ${matches.join(', ')}`,
        matched: true,
      };
    }
  }
  return { tier: 'medium', reasoning: '', matched: false };
};

const analyzeHeuristicTier = (
  context: Context,
  previousDecision: RoutingDecision | undefined,
  tierStickiness: number,
): { tier: RouterTier; reasoning: string } => {
  const prompt = getLastUserText(context).toLowerCase();
  const highThreshold = Math.max(40, 120 - (previousDecision?.tier === 'high' ? tierStickiness * 80 : 0));
  const lowThreshold = Math.max(
    4,
    12 - (previousDecision?.tier === 'medium' || previousDecision?.tier === 'high' ? tierStickiness * 8 : 0),
  );

  const hints = analyzeKeywords(prompt);
  if (hints.explicitHigh) {
    return { tier: 'high', reasoning: 'Detected an explicit request for deeper or higher-quality reasoning.' };
  }
  if (hints.explicitLow) {
    return { tier: 'low', reasoning: 'Detected an explicit request for a faster or lighter response.' };
  }
  if (hints.summary) {
    return { tier: 'low', reasoning: 'Detected summary or lightweight transformation keywords.' };
  }

  const recentConversation = getRecentConversationText(context);
  const toolResultCount = countToolResultsSinceLastUserPrompt(context);
  const wordCount = countWords(prompt);
  const multiLinePrompt = prompt.split('\n').length >= 4;

  if (hints.planning || prompt.startsWith('why ') || wordCount >= highThreshold || multiLinePrompt) {
    return {
      tier: 'high',
      reasoning:
        previousDecision?.tier === 'high'
          ? 'Continued high tier based on complexity or keywords.'
          : 'Detected planning, broad analysis, or a high-complexity request.',
    };
  }
  if (hints.implementation) {
    return { tier: 'medium', reasoning: 'Detected implementation-oriented work with bounded execution scope.' };
  }
  if (hints.lookup && wordCount <= 24 && toolResultCount === 0) {
    return { tier: 'low', reasoning: 'Detected a short read-only lookup request.' };
  }
  if (previousDecision?.tier === 'high' && toolResultCount === 0 && wordCount > lowThreshold) {
    return { tier: 'high', reasoning: 'Kept the high tier bias because the conversation still looks exploratory.' };
  }
  if (previousDecision?.tier === 'medium' || recentConversation.includes('plan:')) {
    const reasons: string[] = [];
    if (previousDecision?.tier === 'medium') reasons.push('continuation of medium tier');
    if (recentConversation.includes('plan:')) reasons.push('active plan detected in context');
    return { tier: 'medium', reasoning: `Biasing to medium tier: ${reasons.join(', ')}.` };
  }
  if (wordCount <= lowThreshold) {
    return { tier: 'low', reasoning: 'Detected a short bounded request.' };
  }
  return { tier: 'medium', reasoning: 'Defaulted to medium tier for general coding work.' };
};

export const makeHeuristicAnalysis = (
  context: Context,
  previousDecision: RoutingDecision | undefined,
  pinnedTier?: RouterTier,
  tierStickiness = 0.5,
  rules?: RoutingRule[],
): HeuristicAnalysis => {
  if (pinnedTier) {
    return { suggestedTier: pinnedTier, reasoning: `Pinned to ${pinnedTier} tier via /router-pin.`, isRuleMatched: false };
  }

  const prompt = getLastUserText(context).toLowerCase();
  const ruleResult = matchCustomRule(prompt, rules);
  if (ruleResult.matched) {
    return { suggestedTier: ruleResult.tier, reasoning: ruleResult.reasoning, isRuleMatched: true };
  }

  const heuristic = analyzeHeuristicTier(context, previousDecision, tierStickiness);
  return { suggestedTier: heuristic.tier, reasoning: heuristic.reasoning, isRuleMatched: false };
};

/**
 * Determine if the classifier should be run based on the current context and configuration.
 */
export const shouldRunClassifier = (
  currentConfig: RouterConfig,
  context: Context,
  lastDecision: RoutingDecision | undefined,
  lastMsgWasTool: boolean,
  toolResultsCount: number,
  debugEnabled?: boolean,
  lastExtensionContext?: ExtensionContext,
): boolean => {
  if (!lastMsgWasTool) return true;

  const confInitN = currentConfig.classifierRunOnceAfterToolCount ?? 3;
  const confFailN = currentConfig.classifierRunAfterToolFailures ?? 2;
  const lastCls = lastDecision?.lastClassifierRunToolCount ?? 0;

  const triggers: string[] = [];
  if (confInitN > 0 && toolResultsCount >= confInitN && confInitN > lastCls) {
    triggers.push(`init(≥${confInitN})`);
  }
  const failCount = countConsecutiveRecentToolFailuresSinceLastUserPrompt(context);
  if (failCount >= confFailN) triggers.push(`fail(${failCount}≥${confFailN})`);
  const confInterval = currentConfig.classifierInterval ?? 10;
  if (confInterval > 0 && Math.floor(toolResultsCount / confInterval) > Math.floor(lastCls / confInterval)) {
    triggers.push(`interval(%${confInterval})`);
  }

  if (debugEnabled && lastExtensionContext && triggers.length > 0) {
    lastExtensionContext.ui.notify(
      `RUN classifier — ${triggers.join(', ')} (cont:${toolResultsCount})`,
      'info',
    );
  }
  return triggers.length > 0;
};

/**
 * Build enriched classifier prompt by including heuristic analysis as advisory context.
 */
const buildClassifierPrompt = (
  context: Context,
  previousDecision: RoutingDecision | undefined,
  heuristicAnalysis?: HeuristicAnalysis,
): string => {
  const historyText = getRecentConversationText(context);
  const promptText = getLastUserText(context);

  let heuristicSection = '';
  if (heuristicAnalysis) {
    heuristicSection = `Heuristic analysis (advisory — you may override):
  Heuristic suggested tier: ${heuristicAnalysis.suggestedTier}
  Heuristic reasoning: ${heuristicAnalysis.reasoning}`;
  }

  const previousTierLine = previousDecision?.tier ? `Previous tier: ${previousDecision.tier}` : '';

  return `You are a model router classifier. Your job is to categorize the user's latest request into one of three tiers: "high", "medium", or "low". 

Tiers:
- high: Extremely complex reasoning, architectural design, multi-step planning, tradeoff analysis, or resolving deep-rooted bugs. The high tier usually contains the most expensive models with highest thinking requirements and biggest context windows.
- medium: Standard coding tasks, implementing well-defined features, multi-file edits, focused debugging, and writing tests within an established pattern. The medium tier usually contains balanced models with medium to high thinking requirements.
- low: Routine tasks requiring no or minimal reasoning, such as summaries, renaming, changelogs, formatting, quick explanations, lookups, or other small bounded text transforms. The low tier usually contains cheaper models with no to low thinking requirements.

${previousTierLine}

${heuristicSection}

Recent history & tool results (The Context):
${historyText}

Latest user message (The Intent):
${promptText}

Return your decision in exactly two lines:
Tier: [high|medium|low]
Reasoning: [one concise sentence summarizing the request's complexity and why it fits the tier]`;
};

export const runClassifier = async (
  currentConfig: RouterConfig,
  modelRegistry: ExtensionContext['modelRegistry'],
  context: Context,
  previousDecision: RoutingDecision | undefined,
  heuristicAnalysis?: HeuristicAnalysis,
  extCtx?: ExtensionContext,
  debugEnabled = false,
): Promise<{ tier: RouterTier; reasoning: string } | undefined> => {
  const classifierModels = currentConfig.classifierModels ?? [];
  if (classifierModels.length === 0) return undefined;

  const thinking = currentConfig.classifierModelThinking;
  const classifierPrompt = buildClassifierPrompt(context, previousDecision, heuristicAnalysis);
  const classifierContext: Context = { messages: [{ role: 'user', content: classifierPrompt, timestamp: Date.now() }] };

  const MAX_CLASSIFIER_ATTEMPTS = 3;
  for (const classifierModelRef of classifierModels) {
    const model = resolveModelFromRef(classifierModelRef, modelRegistry);
    if (!model) {
      extCtx?.ui.notify(`[router] Classifier model "${classifierModelRef}" not found in registry, skipping.`, 'warning');
      continue;
    }

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      const reason = auth.ok
        ? `No API key for model: ${classifierModelRef}`
        : `Auth failed for model: ${classifierModelRef}: ${auth.error}`;
      extCtx?.ui.notify(`[router] ${reason}`, 'warning');
      continue;
    }

    for (let attempt = 1; attempt <= MAX_CLASSIFIER_ATTEMPTS; attempt++) {
      try {
        const isOpenRouter = classifierModelRef.startsWith('openrouter/');

        // Build headers: base headers + OpenRouter attribution when applicable
        const classifierHeaders: Record<string, string> = {
          ...(auth.headers ?? {}),
          ...(isOpenRouter ? OPENROUTER_ATTR_HEADERS : {}),
        };

        const classifierOptions: Record<string, unknown> = {
          apiKey: auth.apiKey,
          headers: classifierHeaders,
          ...(thinking && thinking !== 'off' ? { reasoning: thinking } : {}),
        };

        if (isOpenRouter) {
          const onPayload = createOpenRouterOnPayload(extCtx?.sessionManager);
          if (onPayload) classifierOptions.onPayload = onPayload;
        }

        const stream = streamSimple(model, classifierContext, classifierOptions);
        let fullText = '';
        for await (const event of stream) {
          if (event.type === 'error') throw new Error(event.error?.errorMessage ?? 'Unknown classifier error');
          if (event.type === 'text_delta') fullText += event.delta;
        }

        const tierMatch = fullText.match(/tier:\s*(high|medium|low)/i);
        const reasoningMatch = fullText.match(/reasoning:\s*(.+)/i);

        if (tierMatch) {
          const tierValue = tierMatch[1].toLowerCase() as RouterTier;
          return {
            tier: tierValue,
            reasoning: reasoningMatch ? reasoningMatch[1].trim() : 'Classifier decision.',
          };
        }
        if (debugEnabled && extCtx) {
          extCtx.ui.notify('[router] Classifier returned unparseable response', 'warning');
        }
      } catch (_err) {
        if (attempt < MAX_CLASSIFIER_ATTEMPTS) {
          const errMsg = (_err as Error)?.message ?? String(_err);
          const detectedStatus = /429|Too Many Requests|rate.?limit/i.test(errMsg) ? 429 : undefined;
          const waitMs = detectedStatus === 429 ? attempt * 2000 : 1000;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }
  }

  extCtx?.ui.notify('[router] Classifier exhausted all models — falling back to heuristic routing.', 'warning');
  return undefined;
};
