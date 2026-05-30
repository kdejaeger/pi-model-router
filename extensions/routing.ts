import { streamSimple, type Context, type Message } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  RouterTier,
  RouterProfile,
  RoutingDecision,
  RoutingRule,
  RouterThinkingByTier,
  HeuristicAnalysis,
  RouterConfig,
} from './types';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { parseCanonicalModelRef, isRouterTier } from './config';

export const extractTextFromContent = (
  content: string | Message['content'],
): string => {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'thinking') return part.thinking;
      if (part.type === 'toolCall')
        return `${part.name} ${JSON.stringify(part.arguments)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

export const getLastUserText = (context: Context): string => {
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

export const getRecentConversationText = (
  context: Context,
  limit = 6,
): string => {
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
export const countToolResultsSinceLastUserPrompt = (
  context: Context,
): number => {
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
export const countConsecutiveRecentToolFailuresSinceLastUserPrompt = (
  context: Context,
): number => {
  let count = 0;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i] as Message;
    if (msg.role === 'user') break;
    if (msg.role !== 'toolResult') continue;
    if ((msg as any).isError) {
      count++;
    } else {
      break; // success resets the chain
    }
  }
  return count;
};

export const countWords = (text: string): number => {
  return text.split(/\s+/).filter(Boolean).length;
};

export const containsAny = (text: string, keywords: string[]): boolean => {
  return keywords.some((keyword) => text.includes(keyword));
};

const EXPLICIT_HIGH_HINTS = [
  'best', 'deep', 'deeply', 'carefully', 'thoroughly', 'robust',
  'comprehensive', 'step by step', 'think hard', 'highest quality',
];
const EXPLICIT_LOW_HINTS = [
  'fast', 'cheap', 'quick', 'quickly', 'brief', 'briefly',
  'one sentence', 'one line', 'tiny', 'small',
];
const PLANNING_KEYWORDS = [
  'plan', 'planning', 'architecture', 'architect', 'design', 'tradeoff', 'trade-off',
  'research', 'investigate', 'root cause', 'analyze', 'analysis',
  'migration', 'strategy', 'compare', 'options', 'approach',
];
const SUMMARY_KEYWORDS = [
  'summarize', 'summary', 'changelog', 'rewrite', 'reformat', 'format',
  'rename', 'explain briefly', 'recap', 'tl;dr',
];
const IMPLEMENTATION_KEYWORDS = [
  'implement', 'code', 'fix', 'update', 'edit', 'write', 'refactor',
  'add tests', 'patch', 'change', 'apply', 'continue', 'resume',
  'make the changes', 'go ahead',
];
const LOOKUP_KEYWORDS = [
  'where is', 'which file', 'show me', 'list', 'what files', 'find', 'grep',
];

export const buildRoutingDecision = (
  profileName: string,
  profile: RouterProfile,
  tier: RouterTier,
  reasoning: string,
  thinkingOverrides?: RouterThinkingByTier,
  isClassifier?: boolean,
  lastClassifierRunToolCount?: number,
  heuristicResult?: HeuristicAnalysis,
): RoutingDecision => {
  const routedTierConf = profile[tier];
  const { provider, modelId } = parseCanonicalModelRef(routedTierConf.model);
  let baseThinking: ThinkingLevel;
  if (routedTierConf.thinking != null) {
    baseThinking = routedTierConf.thinking;
  } else if (tier === 'high') {
    baseThinking = 'high';
  } else if (tier === 'low') {
    baseThinking = 'low';
  } else {
    baseThinking = 'medium';
  }
  const effectiveThinking = thinkingOverrides?.[tier] ?? baseThinking;

  return {
    profile: profileName,
    tier,
    targetProvider: provider,
    targetModelId: modelId,
    targetLabel: routedTierConf.model,
    reasoning,
    thinking: effectiveThinking,
    timestamp: Date.now(),
    isClassifier,
    lastClassifierRunToolCount,
    isRuleMatched: heuristicResult?.isRuleMatched,
  };
};

/**
 * Analyze a user prompt and conversation context using local heuristics.
 * 
 * When a classifier model is configured, this analysis is used as advisory input
 * for the LLM classifier (the classifier has final say). When no classifier is
 * configured, the heuristic analysis directly becomes the routing decision.
 */
export const analyzePrompt = (
  context: Context,
  previousDecision: RoutingDecision | undefined,
  pinnedTier?: RouterTier,
  phaseBias = 0.5,
  rules?: RoutingRule[],
): HeuristicAnalysis => {
  const prompt = getLastUserText(context).toLowerCase();

  let tier: RouterTier = 'medium';
  let reasoning = 'Defaulted to medium tier for general coding work.';
  let isRuleMatched = false;

  if (pinnedTier) {
    tier = pinnedTier;
    reasoning = `Pinned to ${pinnedTier} tier via /router-pin.`;
  } else {
    // Check custom rules first
    if (rules) {
      for (const rule of rules) {
        const matches = Array.isArray(rule.matches)
          ? rule.matches
          : [rule.matches];
        if (containsAny(prompt, matches)) {
          tier = rule.tier;
          reasoning =
            rule.reason ??
            `Matched custom routing rule for: ${matches.join(', ')}`;
          isRuleMatched = true;
          break;
        }
      }
    }

    if (!isRuleMatched) {
      // Sticky bias: lower thresholds when continuing in the same tier
      const highThreshold = Math.max(
        40,
        120 - (previousDecision?.tier === 'high' ? phaseBias * 80 : 0),
      );
      const lowThreshold = Math.max(
        4,
        12 -
          (
            (previousDecision?.tier === 'medium' || previousDecision?.tier === 'high')
            ? phaseBias * 8
            : 0
          ),
      );

      const keywordHints = {
        explicitHigh: containsAny(prompt, EXPLICIT_HIGH_HINTS),
        explicitLow: containsAny(prompt, EXPLICIT_LOW_HINTS),
        planning: containsAny(prompt, PLANNING_KEYWORDS),
        implementation: containsAny(prompt, IMPLEMENTATION_KEYWORDS),
        summary: containsAny(prompt, SUMMARY_KEYWORDS),
        lookup: containsAny(prompt, LOOKUP_KEYWORDS),
      };

      const recentConversation = getRecentConversationText(context);
      const toolResultCountSinceLastUserPrompt = countToolResultsSinceLastUserPrompt(context);
      const wordCount = countWords(prompt);
      const multiLinePrompt = prompt.split('\n').length >= 4;

      if (keywordHints.explicitHigh) {
        tier = 'high';
        reasoning = 'Detected an explicit request for deeper or higher-quality reasoning.';
      } else if (keywordHints.explicitLow) {
        tier = 'low';
        reasoning = 'Detected an explicit request for a faster or lighter response.';
      } else if (keywordHints.summary) {
        tier = 'low';
        reasoning = 'Detected summary or lightweight transformation keywords.';
      } else if (
        keywordHints.planning ||
        prompt.startsWith('why ') ||
        wordCount >= highThreshold ||
        multiLinePrompt
      ) {
        tier = 'high';
        reasoning =
          previousDecision?.tier === 'high'
            ? 'Continued high tier based on complexity or keywords.'
            : 'Detected planning, broad analysis, or a high-complexity request.';
      } else if (keywordHints.implementation) {
        tier = 'medium';
        reasoning = 'Detected implementation-oriented work with bounded execution scope.';
      } else if (
        keywordHints.lookup &&
        wordCount <= 24 &&
        toolResultCountSinceLastUserPrompt === 0
      ) {
        tier = 'low';
        reasoning = 'Detected a short read-only lookup request.';
      } else if (
        previousDecision?.tier === 'high' &&
        toolResultCountSinceLastUserPrompt === 0 &&
        wordCount > lowThreshold
      ) {
        tier = 'high';
        reasoning = 'Kept the high tier bias because the conversation still looks exploratory.';
      } else if (
        previousDecision?.tier === 'medium' ||
        recentConversation.includes('plan:')
      ) {
        tier = 'medium';
        const reasons: string[] = [];
        if (previousDecision?.tier === 'medium') {
          reasons.push('continuation of medium tier');
        }
        if (recentConversation.includes('plan:')) {
          reasons.push('active plan detected in context');
        }
        reasoning = `Biasing to medium tier: ${reasons.join(', ')}.`;
      } else if (wordCount <= lowThreshold) {
        tier = 'low';
        reasoning = 'Detected a short bounded request.';
      }
    }
  }

  return {
    suggestedTier: tier,
    reasoning,
    isRuleMatched
  };
};

/**
 * Build enriched classifier prompt by including heuristic analysis as advisory context.
 */
export const buildClassifierPrompt = (
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
): Promise<{ tier: RouterTier; reasoning: string } | undefined> => {
  try {
    if (!currentConfig.classifierModel) return undefined;
    const { provider, modelId } = parseCanonicalModelRef(currentConfig.classifierModel);
    const thinking = currentConfig.classifierModelThinking;
    const model = modelRegistry.find(provider, modelId);
    if (!model) return undefined;

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return undefined;

    const classifierPrompt = buildClassifierPrompt(context, previousDecision, heuristicAnalysis);
    const classifierContext: Context = { messages: [{ role: 'user', content: classifierPrompt, timestamp: Date.now() }] };

    const MAX_CLASSIFIER_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_CLASSIFIER_RETRIES; attempt++) {
      try {
        const stream = streamSimple(model, classifierContext, {
          apiKey: auth.apiKey,
          headers: auth.headers,
          ...(thinking && thinking !== 'off' ? { reasoning: thinking } : {}),
        });
        let fullText = '';
        for await (const event of stream) {
          if (event.type === 'text_delta' && typeof (event as any).delta === 'string') {
            fullText += (event as any).delta;
          }
        }

        const lines = fullText.trim().split('\n');
        const tierLine = lines.find((l) => l.toLowerCase().startsWith('tier:'));
        const reasoningLine = lines.find((l) => l.toLowerCase().startsWith('reasoning:'));

        if (tierLine) {
          const tierValue = tierLine.split(':')[1].trim().toLowerCase();
          if (isRouterTier(tierValue)) {
            return {
              tier: tierValue,
              reasoning: reasoningLine ? reasoningLine.split(':')[1].trim() : 'Classifier decision.',
            };
          }
        }
      } catch (err) {
        if (attempt < MAX_CLASSIFIER_RETRIES) {
          // Retry on next iteration
        } else {
          throw err; // Last attempt failed — let outer catch handle it
        }
      }
    }
  } catch (error) {
    // Ignore classifier errors and fall back to heuristics
  }
  return undefined;
};
