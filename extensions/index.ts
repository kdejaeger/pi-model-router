import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { type RouterConfig, type RoutingDecision, type RouterPinByProfile, type CustomSessionEntry } from './types';
import { loadRouterConfig, profileNames, resolveProfileName } from './config';
import { isRouterPersistedState, buildPersistedState } from './state';
import { updateStatus } from './ui';
import { registerCommands } from './commands';
import { registerRouterProvider } from './provider';

const routerExtension = (pi: ExtensionAPI) => {
  let currentConfig: RouterConfig = { profiles: {} };
  let currentModelRegistry: ExtensionContext['modelRegistry'] | undefined;
  let currentCwd = process.cwd();
  let lastDecision: RoutingDecision | undefined;
  let debugEnabled = false;
  let routerEnabled = false;
  let selectedProfile: string | undefined;
  let lastLoadedModelKeys = '';
  let pinnedTierByProfile: RouterPinByProfile = {};
  let lastNonRouterModel: string | undefined;
  let lastExtensionContext: ExtensionContext | undefined;
  let lastConfigWarnings: string[] = [];
  let lastPersistedSnapshot: string | undefined;
  let isInitialized = false;
  let isRouterDelegating = false;

  const setModelInternally = async (model: NonNullable<ExtensionContext['model']>) => {
    isRouterDelegating = true;
    try {
      return await pi.setModel(model);
    } catch {
      // Extension context may be stale after session teardown.
      return false;
    } finally {
      isRouterDelegating = false;
    }
  };

  const persistState = () => {
    const state = buildPersistedState(
      routerEnabled,
      selectedProfile,
      pinnedTierByProfile,
      debugEnabled,
      lastDecision,
      lastNonRouterModel,
    );
    const snapshot = JSON.stringify({
      ...state,
      timestamp: 0,
      lastDecision: state.lastDecision ? { ...state.lastDecision, timestamp: 0 } : undefined,
    });
    if (snapshot === lastPersistedSnapshot) {
      return;
    }
    try {
      pi.appendEntry('router-state', state);
    } catch {
      // Defensive fallback: session_shutdown or teardown may have invalidated context
      return;
    }
    lastPersistedSnapshot = snapshot;
  };

  const actions = {
    persistState,
    updateStatus: (ctx: ExtensionContext) => updateStatus(ctx, routerEnabled, selectedProfile, pinnedTierByProfile, lastDecision),
    reloadConfig: (ctx?: ExtensionContext, options?: { preserveDebug?: boolean }) => {
      const loaded = loadRouterConfig(currentCwd);
      currentConfig = loaded.config;
      lastConfigWarnings = loaded.warnings;
      if (!options?.preserveDebug) {
        debugEnabled = currentConfig.debug ?? false;
      }
      const prevSelectedProfile = selectedProfile;
      selectedProfile = resolveProfileName(currentConfig, selectedProfile);
      if (!selectedProfile && prevSelectedProfile && routerEnabled) {
        ctx?.ui.notify(`Router profile "${prevSelectedProfile}" is no longer configured. Router disabled.`, 'warning');
        routerEnabled = false;
      }
      actions.registerRouterProvider();
      if (ctx) {
        actions.updateStatus(ctx);
      }
    },
    ensureValidActiveRouterProfile: async (ctx: ExtensionContext) => {
      if (ctx.model?.provider !== 'router') {
        return;
      }
      if (currentConfig.profiles[ctx.model.id]) {
        selectedProfile = ctx.model.id;
        routerEnabled = true;
        return;
      }

      ctx.ui.notify(`Router profile "${ctx.model.id}" is no longer configured.`, 'warning');
      routerEnabled = false;
      selectedProfile = undefined;
    },
    switchToRouterProfile: async (profileName: string, ctx: ExtensionContext, strict = true) => {
      if (!currentConfig.profiles[profileName]) {
        if (strict) {
          ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        }
        return false;
      }

      // Ensure the provider is registered with current capacities for this profile
      actions.registerRouterProvider();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const routerModel = ctx.modelRegistry.find('router', profileName);
      if (!routerModel) {
        ctx.ui.notify(`Unknown router profile: ${profileName}`, 'error');
        return false;
      }
      if (ctx.model && ctx.model.provider !== 'router') {
        lastNonRouterModel = `${ctx.model.provider}/${ctx.model.id}`;
      }
      const success = await setModelInternally(routerModel);
      if (!success) {
        ctx.ui.notify(`Failed to switch to router/${profileName}`, 'error');
        return false;
      }
      selectedProfile = profileName;
      routerEnabled = true;
      persistState();
      try {
        pi.setThinkingLevel('off');
      } catch {
        // Stale context
      }
      actions.updateStatus(ctx);
      return true;
    },
    registerRouterProvider: () => {
      registerRouterProvider(
        pi,
        {
          get lastLoadedModelKeys() {
            return lastLoadedModelKeys;
          },
          set lastLoadedModelKeys(v) {
            lastLoadedModelKeys = v;
          },
          get currentConfig() {
            return currentConfig;
          },
          get currentModelRegistry() {
            return currentModelRegistry;
          },
          get lastExtensionContext() {
            return lastExtensionContext;
          },
          get selectedProfile() {
            return selectedProfile;
          },
          set selectedProfile(v) {
            selectedProfile = v;
          },
          get routerEnabled() {
            return routerEnabled;
          },
          set routerEnabled(v) {
            routerEnabled = v;
          },
          get lastDecision() {
            return lastDecision;
          },
          set lastDecision(v) {
            lastDecision = v;
          },
          get pinnedTierByProfile() {
            return pinnedTierByProfile;
          },
          set pinnedTierByProfile(v) {
            pinnedTierByProfile = v;
          },
          get debugEnabled() {
            return debugEnabled;
          },
        },
        {
          persistState,
          updateStatus: actions.updateStatus,
        },
      );
    },
  };

  actions.reloadConfig();

  const restoreStateFromSession = async (ctx: ExtensionContext) => {
    lastExtensionContext = ctx;
    currentModelRegistry = ctx.modelRegistry;
    currentCwd = ctx.cwd;
    actions.reloadConfig();

    // Give the registry a moment to synchronize after re-registration
    await new Promise((resolve) => setTimeout(resolve, 50));

    routerEnabled = ctx.model?.provider === 'router';
    selectedProfile = resolveProfileName(currentConfig, ctx.model?.provider === 'router' ? ctx.model.id : selectedProfile);
    pinnedTierByProfile = {};
    lastNonRouterModel =
      ctx.model && ctx.model.provider !== 'router' ? `${ctx.model.provider}/${ctx.model.id}` : lastNonRouterModel;

    const entries = ctx.sessionManager.getBranch() as CustomSessionEntry[];
    const savedState = entries
      .filter((entry) => entry.type === 'custom' && entry.customType === 'router-state')
      .map((entry) => entry.data)
      .findLast((data) => isRouterPersistedState(data));

    if (isRouterPersistedState(savedState)) {
      selectedProfile = resolveProfileName(currentConfig, savedState.selectedProfile);
      if (!selectedProfile) {
        routerEnabled = false;
      } else {
        routerEnabled = savedState.enabled;
      }
      lastDecision = savedState.lastDecision;
      pinnedTierByProfile = savedState.pinByProfile ? { ...savedState.pinByProfile } : {};
      if (savedState.pinTier && selectedProfile) {
        pinnedTierByProfile[selectedProfile] = savedState.pinTier;
      }
      debugEnabled = savedState.debugEnabled ?? debugEnabled;
      lastNonRouterModel = savedState.lastNonRouterModel ?? lastNonRouterModel;
    }

    await actions.ensureValidActiveRouterProfile(ctx);

    if (routerEnabled && selectedProfile) {
      const routerModel = ctx.modelRegistry.find('router', selectedProfile);
      if (routerModel) {
        const success = await setModelInternally(routerModel);
        if (!success) {
          ctx.ui.notify(`Failed to restore router/${selectedProfile} after relaunch.`, 'warning');
          routerEnabled = false;
        }
      } else if (selectedProfile) {
        ctx.ui.notify(`Unable to restore router/${selectedProfile}; model is unavailable.`, 'warning');
        routerEnabled = false;
        ctx.ui.setHiddenThinkingLabel?.();
      }
    } else {
      ctx.ui.setHiddenThinkingLabel?.();
    }

    persistState();
    actions.updateStatus(ctx);
  };

  registerCommands(
    pi,
    {
      get currentConfig() {
        return currentConfig;
      },
      get routerEnabled() {
        return routerEnabled;
      },
      set routerEnabled(v) {
        routerEnabled = v;
      },
      get selectedProfile() {
        return selectedProfile;
      },
      set selectedProfile(v) {
        selectedProfile = v;
      },
      get pinnedTierByProfile() {
        return pinnedTierByProfile;
      },
      set pinnedTierByProfile(v) {
        pinnedTierByProfile = v;
      },
      get lastDecision() {
        return lastDecision;
      },
      get lastNonRouterModel() {
        return lastNonRouterModel;
      },
      set lastNonRouterModel(v) {
        lastNonRouterModel = v;
      },
      get debugEnabled() {
        return debugEnabled;
      },
      set debugEnabled(v) {
        debugEnabled = v;
      },

      get lastConfigWarnings() {
        return lastConfigWarnings;
      },
    },
    actions,
  );

  const ensureInitializedFromContext = (ctx: ExtensionContext) => {
    if (!currentModelRegistry) {
      currentModelRegistry = ctx.modelRegistry;
      lastExtensionContext = ctx;
      currentCwd = ctx.cwd;
      actions.reloadConfig(ctx);
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    await restoreStateFromSession(ctx);
    isInitialized = true;

    if (lastConfigWarnings.length > 0) {
      ctx.ui.notify(`Router config warnings:\n${lastConfigWarnings.join('\n')}`, 'warning');
    }

    if (debugEnabled) {
      ctx.ui.notify(`Router initialized with profiles: ${profileNames(currentConfig).join(', ')}`, 'info');
    }
  });

  pi.on('turn_start', async (_event, ctx) => {
    ensureInitializedFromContext(ctx);
  });

  pi.on('model_select', async (event, ctx) => {
    ensureInitializedFromContext(ctx);
    if (!isInitialized || isRouterDelegating) return;
    if (event.model.provider === 'router') {
      const profileName = resolveProfileName(currentConfig, event.model.id);
      if (!profileName) {
        ctx.ui.notify(`Unknown router profile: ${event.model.id}`, 'error');
        return;
      }

      // If the selected model has stale capacities (e.g. from the initial registration),
      // re-apply the model from the registry to force a TUI refresh.
      const registryModel = ctx.modelRegistry.find('router', profileName);
      if (
        registryModel &&
        (registryModel.contextWindow !== event.model.contextWindow || registryModel.maxTokens !== event.model.maxTokens)
      ) {
        await setModelInternally(registryModel);
      }

      routerEnabled = true;
      selectedProfile = profileName;
    } else {
      routerEnabled = false;
      lastNonRouterModel = `${event.model.provider}/${event.model.id}`;
      ctx.ui.setHiddenThinkingLabel?.();
    }
    persistState();
    actions.updateStatus(ctx);
  });

  pi.on('turn_end', async (_event, ctx) => {
    ensureInitializedFromContext(ctx);
    if (routerEnabled && selectedProfile && ctx.model?.provider !== 'router') {
      const routerModel = ctx.modelRegistry.find('router', selectedProfile);
      if (routerModel) {
        const success = await setModelInternally(routerModel);
        if (!success) {
          try {
            ctx.ui.notify('Failed to re-assert router model after turn. Router disabled.', 'warning');
          } catch {
            // Stale context
          }
          routerEnabled = false;
          selectedProfile = undefined;
        }
      }
    }
    persistState();
    try {
      actions.updateStatus(ctx);
    } catch {
      // Stale context
    }
  });
};

export default routerExtension;
