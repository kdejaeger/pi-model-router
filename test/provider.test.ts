import assert from 'node:assert/strict';
import test from 'node:test';
import { type Api, createAssistantMessageEventStream, getSupportedThinkingLevels, type Model } from '@earendil-works/pi-ai';
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

const makeErrorStream = (
  model: ReturnType<typeof makeModel>,
  gatewayFetch?: (input: string, init?: RequestInit) => Promise<Response>,
  errorMessage = 'HTTP 429 rate limit exceeded',
) => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    // Optionally mirror the real failure path first: the SDK calls the injected fetch and
    // the gateway answers 429 before the error event reaches the router.
    await gatewayFetch?.('https://gateway.test/v1/chat/completions', {});
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
        errorMessage,
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

test('a gateway retry-after header observed via the injected fetch drives the suspension length', async () => {
  const models = [makeModel('provider-a', 'model-a'), makeModel('provider-b', 'model-b')];
  const byKey = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const calls: string[] = [];
  const modelRegistry = {
    find: (provider: string, id: string) => byKey.get(`${provider}/${id}`),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'test-key', headers: {} }),
    getRegisteredProviderConfig: (provider: string) => ({
      api: 'test-api',
      streamSimple: (
        model: ReturnType<typeof makeModel>,
        _context: unknown,
        options?: { fetch?: (input: string, init?: RequestInit) => Promise<Response> },
      ) => {
        calls.push(`${model.provider}/${model.id}`);
        return model.provider === 'provider-a' ? makeErrorStream(model, options?.fetch) : makeSuccessStream(model);
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
          high: { model: 'provider-a/model-a', fallbacks: ['provider-b/model-b'] },
          medium: { model: 'provider-a/model-a', fallbacks: ['provider-b/model-b'] },
          low: { model: 'provider-a/model-a', fallbacks: ['provider-b/model-b'] },
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

  // Stand-in for the network layer: the capture wrapper wraps this stub, so the 429 and
  // its retry-after header stay fully in-memory.
  const outerOptions = {
    fetch: async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '120' } }),
  };

  await consume(routerRegistration.config.streamSimple(routerModel, context, outerOptions));
  assert.deepEqual(calls, ['provider-a/model-a', 'provider-b/model-b']);
  assert.ok(
    notifications.some((message) => message.includes('suspended for 2min')),
    notifications.join(' | '),
  );

  // The header-derived 2min cooldown keeps model-a benched on the next turn.
  await consume(routerRegistration.config.streamSimple(routerModel, context, outerOptions));
  assert.deepEqual(calls, ['provider-a/model-a', 'provider-b/model-b', 'provider-b/model-b']);
});

test('a non-rate-limit failure is attempted exactly once before falling back', async () => {
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
        return model.provider === 'provider-a'
          ? makeErrorStream(model, undefined, 'HTTP 503 service unavailable')
          : makeSuccessStream(model);
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
  // Each failed model gets exactly one attempt — no same-model retry before the fallback.
  assert.deepEqual(calls, ['provider-a/model-a', 'provider-a/model-a-2', 'provider-b/model-b']);
  assert.ok(
    notifications.some((message) => message.includes('Failed to reach model provider-a/model-a')),
    notifications.join(' | '),
  );
});

test("the logical model advertises the union of its targets' thinking levels (incl. max)", () => {
  // Mirrors the glm profile: every tier routes to the same model whose catalog
  // entry declares max, so the logical model must offer it too — otherwise pi
  // clamps setThinkingLevel('max') back to 'high'.
  const glm = {
    ...makeModel('opencode-go', 'glm-5.3-flash'),
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', high: 'high', max: 'max' },
  };
  const modelRegistry = {
    find: (provider: string, id: string) => (provider === 'opencode-go' && id === glm.id ? glm : undefined),
  };
  const registered: Array<{
    name: string;
    config: { models?: Array<{ id: string; thinkingLevelMap?: Record<string, string | null> }> };
  }> = [];
  registerRouterProvider(
    { registerProvider: (name, config) => registered.push({ name, config }), setThinkingLevel: () => {} },
    {
      lastLoadedModelKeys: '',
      currentConfig: {
        profiles: {
          glm: {
            high: { model: 'opencode-go/glm-5.3-flash', thinking: 'max' },
            medium: { model: 'opencode-go/glm-5.3-flash', thinking: 'high' },
            low: { model: 'opencode-go/glm-5.3-flash', thinking: 'high' },
          },
        },
      },
      currentModelRegistry: modelRegistry,
      lastExtensionContext: undefined,
      selectedProfile: 'glm',
      routerEnabled: true,
      lastDecision: undefined,
      pinnedTierByProfile: {},
      debugEnabled: false,
      modelCooldowns: new Map(),
    },
    { persistState: () => {}, updateStatus: () => {}, requestContextCompaction: () => false },
  );

  const logicalModel = registered[0]?.config.models?.[0];
  assert.ok(logicalModel);
  // Mirrors the raw glm-5.3-flash surface exactly: explicit catalog entries win
  // (off/xhigh nulled out), missing base levels default to on, max stays offered.
  assert.deepEqual(logicalModel.thinkingLevelMap, {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: null,
    max: 'max',
  });
  // What pi's picker actually consumes from this map: max must be offered, not
  // clamped away the way it was before the union existed.
  assert.ok(getSupportedThinkingLevels(logicalModel as unknown as Model<Api>).includes('max'));
});

test('the logical model unions the thinking maps of every target in the profile', () => {
  const iet = { ...makeModel('provider-a', 'iet'), reasoning: true, thinkingLevelMap: { low: 'low', high: 'high' } };
  const nova = { ...makeModel('provider-b', 'nova'), reasoning: true, thinkingLevelMap: { high: null, max: 'max' } };
  const modelRegistry = {
    find: (provider: string, id: string) => (provider === 'provider-a' ? iet : provider === 'provider-b' ? nova : undefined),
  };
  const registered: Array<{
    name: string;
    config: { models?: Array<{ id: string; thinkingLevelMap?: Record<string, string | null> }> };
  }> = [];
  registerRouterProvider(
    { registerProvider: (name, config) => registered.push({ name, config }), setThinkingLevel: () => {} },
    {
      lastLoadedModelKeys: '',
      currentConfig: {
        profiles: { stacked: { medium: { model: 'provider-a/iet', fallbacks: ['provider-b/nova'] } } },
      },
      currentModelRegistry: modelRegistry,
      lastExtensionContext: undefined,
      selectedProfile: 'stacked',
      routerEnabled: true,
      lastDecision: undefined,
      pinnedTierByProfile: {},
      debugEnabled: false,
      modelCooldowns: new Map(),
    },
    { persistState: () => {}, updateStatus: () => {}, requestContextCompaction: () => false },
  );

  const logicalModel = registered[0]?.config.models?.[0];
  assert.ok(logicalModel);
  // The tier model's high survives despite the fallback nulling it, and the
  // fallback's max is offered even though the tier model lacks it.
  assert.deepEqual(logicalModel.thinkingLevelMap, {
    off: 'off',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: null,
    max: 'max',
  });
});

test('registration without a registry yields the fallback capacities and no thinking map', () => {
  const registered: Array<{
    name: string;
    config: {
      models?: Array<{
        id: string;
        reasoning: boolean;
        thinkingLevelMap?: Record<string, string | null>;
        contextWindow: number;
        maxTokens: number;
      }>;
    };
  }> = [];
  registerRouterProvider(
    { registerProvider: (name, config) => registered.push({ name, config }), setThinkingLevel: () => {} },
    {
      lastLoadedModelKeys: '',
      currentConfig: { profiles: { glm: { high: { model: 'opencode-go/glm-5.3-flash', thinking: 'max' } } } },
      currentModelRegistry: undefined,
      lastExtensionContext: undefined,
      selectedProfile: 'glm',
      routerEnabled: true,
      lastDecision: undefined,
      pinnedTierByProfile: {},
      debugEnabled: false,
      modelCooldowns: new Map(),
    },
    { persistState: () => {}, updateStatus: () => {}, requestContextCompaction: () => false },
  );

  const logicalModel = registered[0]?.config.models?.[0];
  assert.ok(logicalModel);
  assert.equal(logicalModel.reasoning, false);
  assert.equal(logicalModel.thinkingLevelMap, undefined);
  assert.equal(logicalModel.contextWindow, 1_000_000);
  assert.equal(logicalModel.maxTokens, 120_000);
});
