import assert from 'node:assert/strict';
import test from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { registerRouterProvider } from '../extensions/provider.ts';

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const makeModel = (provider: string, id: string) => ({
  provider,
  id,
  api: 'test-api',
  baseUrl: `https://${provider}.test`,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_000,
});

const makeErrorStream = (model: ReturnType<typeof makeModel>) => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage,
        stopReason: 'error',
        errorMessage: 'HTTP 429 rate limit exceeded',
        timestamp: Date.now(),
      },
    });
    stream.end();
  });
  return stream;
};

const makeSuccessStream = (model: ReturnType<typeof makeModel>) => {
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
        usage: zeroUsage,
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    });
    stream.end();
  });
  return stream;
};

const consume = async (stream: AsyncIterable<unknown>) => {
  for await (const _event of stream) {
    // Drain the stream so the delegated request completes.
  }
};

test('rate-limited model slugs are skipped individually on later turns', async () => {
  const models = [makeModel('provider-a', 'model-a'), makeModel('provider-a', 'model-a-2'), makeModel('provider-b', 'model-b')];
  const byKey = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const calls: string[] = [];
  const modelRegistry = {
    find: (provider: string, id: string) => byKey.get(`${provider}/${id}`),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key', headers: {} }),
    getRegisteredProviderConfig: (provider: string) => ({
      api: 'test-api',
      streamSimple: (model: ReturnType<typeof makeModel>) => {
        calls.push(`${model.provider}/${model.id}`);
        return model.provider === 'provider-a' ? makeErrorStream(model) : makeSuccessStream(model);
      },
    }),
  };
  const notifications: string[] = [];
  const ctx = {
    model: undefined,
    isIdle: () => false,
    getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
    ui: { notify: (message: string) => notifications.push(message) },
    getSystemPrompt: () => '',
    sessionManager: { getSessionId: () => 'test', getSessionName: () => undefined },
  };
  const registered: Array<{ name: string; config: { models?: Array<{ id: string }> } }> = [];
  const pi = {
    registerProvider: (name: string, config: { models?: Array<{ id: string }> }) => registered.push({ name, config }),
    setThinkingLevel: () => {},
  };
  const modelCooldowns = new Map<string, number>();
  const state = {
    lastLoadedModelKeys: '',
    currentConfig: {
      profiles: {
        balanced: {
          high: { model: 'provider-a/model-a', fallbacks: ['provider-a/model-a-2', 'provider-b/model-b'] },
          medium: { model: 'provider-a/model-a', fallbacks: ['provider-a/model-a-2', 'provider-b/model-b'] },
          low: { model: 'provider-a/model-a', fallbacks: ['provider-a/model-a-2', 'provider-b/model-b'] },
        },
      },
    },
    currentModelRegistry: modelRegistry,
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
    requestContextCompaction: () => {},
  });

  const routerRegistration = registered.find((entry) => entry.name === 'router');
  assert.ok(routerRegistration?.config.models?.[0]);
  const routerModel = routerRegistration.config.models[0];
  ctx.model = { provider: 'router', id: routerModel.id };
  const context = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: Date.now() }] };

  await consume(routerRegistration.config.streamSimple(routerModel, context, {}));
  assert.deepEqual(calls, ['provider-a/model-a', 'provider-a/model-a-2', 'provider-b/model-b']);
  assert.equal(
    notifications.some((message) => message.includes('suspended')),
    true,
  );

  await consume(routerRegistration.config.streamSimple(routerModel, context, {}));
  assert.deepEqual(calls, ['provider-a/model-a', 'provider-a/model-a-2', 'provider-b/model-b', 'provider-b/model-b']);
});
