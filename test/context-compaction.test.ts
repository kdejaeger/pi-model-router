import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { registerRouterProvider } from '../extensions/provider.ts';

const model = {
  provider: 'provider-a',
  id: 'small-model',
  api: 'test-api',
  baseUrl: 'https://provider-a.test',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
};
const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const fullUsage = {
  input: 1_000,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test('over-threshold context and a full response request settled-session compaction', async () => {
  let responseUsage = fullUsage;
  let receivedContext: { messages: unknown[] } | undefined;
  const sentMessage = { role: 'user' as const, content: [{ type: 'text', text: 'hello' }], timestamp: Date.now() };
  const streamSimple = (_model: unknown, context: { messages: unknown[] }) => {
    receivedContext = context;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({
        type: 'done',
        reason: 'stop',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: responseUsage,
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      });
      stream.end();
    });
    return stream;
  };
  const registry = {
    find: (provider: string, id: string) => (provider === model.provider && id === model.id ? model : undefined),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key', headers: {} }),
    getRegisteredProviderConfig: () => ({ api: model.api, streamSimple }),
  };
  const ctx = {
    model: undefined,
    isIdle: () => false,
    getContextUsage: () => ({ tokens: contextTokens, contextWindow: 1_000, percent: contextTokens / 10 }),
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => 'test', getSessionName: () => undefined },
  };
  const registered: Array<{ name: string; config: { models?: Array<{ id: string }>; streamSimple?: Function } }> = [];
  const pi = {
    registerProvider: (name: string, config: { models?: Array<{ id: string }>; streamSimple?: Function }) =>
      registered.push({ name, config }),
    setThinkingLevel: () => {},
  };
  const modelCooldowns = new Map<string, number>();
  let contextTokens = 400;
  let compactionRequests = 0;
  const state = {
    lastLoadedModelKeys: '',
    currentConfig: {
      defaultContextThresholdPercent: 50,
      profiles: {
        balanced: {
          high: { model: 'provider-a/small-model' },
          medium: { model: 'provider-a/small-model' },
          low: { model: 'provider-a/small-model' },
        },
      },
    },
    currentModelRegistry: registry,
    lastExtensionContext: ctx,
    selectedProfile: 'balanced',
    routerEnabled: true,
    lastDecision: undefined,
    pinnedTierByProfile: {},
    debugEnabled: false,
    modelCooldowns,
  };
  registerRouterProvider(pi, state, {
    persistState: () => {},
    updateStatus: () => {},
    requestContextCompaction: () => {
      compactionRequests++;
    },
  });

  const routerRegistration = registered.find((entry) => entry.name === 'router');
  assert.ok(routerRegistration?.config.models?.[0]);
  ctx.model = { provider: 'router', id: routerRegistration.config.models[0].id };
  const runTurn = async () => {
    const stream = routerRegistration.config.streamSimple?.(routerRegistration.config.models[0], { messages: [sentMessage] }, {});
    assert.ok(stream);
    for await (const _event of stream) {
      // Drain the delegated stream.
    }
  };

  await runTurn();
  assert.equal(compactionRequests, 1);

  compactionRequests = 0;
  contextTokens = 900;
  responseUsage = emptyUsage;
  await runTurn();
  assert.equal(compactionRequests, 1);
  // Pass 2 sends the full context as-is: no trimming, message identity preserved.
  assert.equal(receivedContext?.messages.length, 1);
  assert.equal(receivedContext?.messages[0], sentMessage);

  // autoCompaction: false disables scheduling entirely.
  compactionRequests = 0;
  state.currentConfig.autoCompaction = false;
  await runTurn();
  assert.equal(compactionRequests, 0);
});
