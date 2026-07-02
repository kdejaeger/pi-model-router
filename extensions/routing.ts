import { streamSimple } from '@earendil-works/pi-ai/compat';
import type { Context, Message } from '@earendil-works/pi-ai';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RouterConfig, RouterProfile, RouterTier, RoutingDecision } from './types';
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

const lastUserMessage = (context: Context): Message | undefined => {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === 'user') return msg;
  }
  return undefined;
};

const escapeXML = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const getRecentConversationText = (context: Context, limit: number): string => {
  const messages = context.messages.slice(-limit);

  // Ensure the last user message is included in the context window
  // at its correct chronological position.
  const lastUserMsg = lastUserMessage(context);
  if (lastUserMsg && !messages.includes(lastUserMsg)) {
    messages.unshift(lastUserMsg);
  }

  const entries = messages
    .map((message) => {
      const content = extractTextFromContent(message.content).trim();
      if (!content) return '';

      const timeStamp = message.timestamp ? ` timestamp="${new Date(message.timestamp).toISOString()}"` : '';

      switch (message.role) {
        case 'user':
          return `<USER${timeStamp}>\n${escapeXML(content)}\n</USER>`;
        case 'assistant':
          return `<ASSISTANT${timeStamp}>\n${escapeXML(content)}\n</ASSISTANT>`;
        case 'toolResult':
          return `<TOOL name="${escapeXML(message.toolName ?? 'unknown')}"${message.isError ? ' error="true"' : ''}${timeStamp}>\n${escapeXML(content)}\n</TOOL>`;
        default:
          return `<${(message as { role: string }).role.toUpperCase()}${timeStamp}>\n${escapeXML(content)}\n</${(message as { role: string }).role.toUpperCase()}>`;
      }
    })
    .filter(Boolean)
    .join('\n\n');

  if (!entries) return '';
  return `<HISTORY>\n${entries}\n</HISTORY>`;
};

/** Count tool results since the last user message (current turn only). */
export const countToolResultsSinceLastUserPrompt = (context: Context): number => {
  let count = 0;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === 'user') break;
    if (msg.role === 'toolResult') count++;
  }
  return count;
};

const countConsecutiveRecentToolFailures = (context: Context): number => {
  let count = 0;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === 'user') break;
    if (msg.role !== 'toolResult') continue;
    if (!msg.isError) break;
    count++;
  }
  return count;
};

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
  const failCount = countConsecutiveRecentToolFailures(context);
  if (failCount >= confFailN) triggers.push(`fail(${failCount}≥${confFailN})`);
  const confInterval = currentConfig.classifierInterval ?? 10;
  if (confInterval > 0 && Math.floor(toolResultsCount / confInterval) > Math.floor(lastCls / confInterval)) {
    triggers.push(`interval(%${confInterval})`);
  }

  if (debugEnabled && lastExtensionContext && triggers.length > 0) {
    lastExtensionContext.ui.notify(`Running router classifier — ${triggers.join(', ')} (cont:${toolResultsCount}) ...`, 'info');
  }
  return triggers.length > 0;
};

/**
 * Build the classifier prompt with conversation history and previous decision context.
 */
const buildClassifierPrompt = (
  context: Context,
  previousDecision: RoutingDecision | undefined,
  classifierInterval?: number,
): string => {
  // Include messages covering the full classifier interval plus padding for coherence.
  // This ensures the classifier has enough history to understand the conversation
  // trajectory without needing the entire session.
  const historyLimit = (classifierInterval ?? 10) + 4;
  const historyText = getRecentConversationText(context, historyLimit);

  const previousTierLine = previousDecision?.tier
    ? `Previous tier: ${previousDecision.tier} (${previousDecision.reasoning})`
    : '';

  return `You are a model router classifier. Choose the most appropriate tier for the task.
Prefer lower tiers when they suffice.

Tiers:

low — Tasks requiring minimal reasoning, where the action is obvious:
  Good for: summaries, changelogs, renames, reformatting, simple edits,
            lookups ("where is X"), yes/no questions, quick explanations,
            trivial error explanation ("what does this error mean"),
            small repetitive changes across files.
  NOT for: debugging (traces, root cause investigation), any task where you
           need to figure out what to do, novel code generation, complex
           multi-step logic.

medium — Standard coding with clear scope:
  Good for: well-defined feature implementation, known bug pattern fixes,
            writing tests within existing patterns, multi-file edits with
            specific instructions, focused debugging.
  NOT for: novel architecture, security analysis, open-ended research,
           problems where the approach is unclear from the start.

high — Complex reasoning where the approach is unclear:
  Good for: architecture design from scratch, security threat modeling,
            root-cause analysis of obscure issues, multi-system migration
            planning, novel algorithm design, trade-off analysis with
            no established precedent.
  NOT for: reading files to gather context, implementing a plan that
           already exists, editing files when the user specified exactly
           what to change.

${previousTierLine}

Conversation history (The Context):

\`\`\`xml
${historyText}
\`\`\`

Return your decision in exactly two lines:
Tier: [high|medium|low]
Reasoning: [one concise sentence summarizing the request's complexity and why it fits the tier]`;
};

export const runClassifier = async (
  currentConfig: RouterConfig,
  modelRegistry: ExtensionContext['modelRegistry'],
  context: Context,
  previousDecision: RoutingDecision | undefined,
  extCtx?: ExtensionContext,
  debugEnabled = false,
): Promise<{ tier: RouterTier; reasoning: string } | undefined> => {
  const classifierModels = currentConfig.classifierModels ?? [];
  if (classifierModels.length === 0) return undefined;

  const thinking = currentConfig.classifierModelThinking;
  const classifierInterval = currentConfig.classifierInterval ?? 10;
  const classifierPrompt = buildClassifierPrompt(context, previousDecision, classifierInterval);
  const classifierContext: Context = { messages: [{ role: 'user', content: classifierPrompt, timestamp: Date.now() }] };

  for (const classifierModelRef of classifierModels) {
    const model = resolveModelFromRef(classifierModelRef, modelRegistry);
    if (!model) {
      extCtx?.ui.notify(`[router] Classifier model "${classifierModelRef}" is not available, skipping.`, 'warning');
      continue;
    }

    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      const reason = `Auth failed for model: ${classifierModelRef}: ${auth.error}`;
      extCtx?.ui.notify(`[router] ${reason}`, 'warning');
      continue;
    }

    const isOpenRouter = parseCanonicalModelRef(classifierModelRef).provider === 'openrouter';

    const classifierOptions: Record<string, unknown> = {
      apiKey: auth.apiKey,
      headers: {
        ...(auth.headers ?? {}),
        ...(isOpenRouter ? OPENROUTER_ATTR_HEADERS : {}),
      },
      ...(thinking && thinking !== 'off' ? { reasoning: thinking } : {}),
    };


    if (isOpenRouter) {
      const onPayload = createOpenRouterOnPayload(extCtx?.sessionManager);
      if (onPayload) classifierOptions.onPayload = onPayload;
    }

    const MAX_CLASSIFIER_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_CLASSIFIER_ATTEMPTS; attempt++) {
      try {
        const stream = streamSimple(model, classifierContext, classifierOptions);
        let fullText = '';
        for await (const event of stream) {
          if (event.type === 'error') throw new Error(event.error?.errorMessage ?? 'Unknown classifier error');
          if (event.type === 'text_delta') fullText += event.delta;
        }

        const tierMatch = fullText.match(/"?tier"?\s*:\s*"?(high|medium|low)/i);
        const reasoningMatch = fullText.match(/"?reasoning"?\s*:\s*"?([^\n\r]+)/i);
        if (tierMatch) {
          return {
            tier: tierMatch[1].toLowerCase() as RouterTier,
            reasoning: reasoningMatch ? reasoningMatch[1].trim() : 'Classifier decision.',
          };
        }
        if (debugEnabled && extCtx) {
          extCtx.ui.notify('[router] Classifier gave an unparseable response.', 'warning');
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

  extCtx?.ui.notify('[router] Classifier models all failed — falling back to medium tier.', 'warning');
  return undefined;
};
