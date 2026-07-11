import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import type {
  RouterConfig,
  RouterPinByProfile,
  RoutingDecision,
} from './types';
import {
  profileNames,
  ROUTER_PIN_VALUES,
  resolveModelFromRef,
  isPinValue,
} from './config';
import {
  formatPinSummary,
} from './ui';

export const registerCommands = (
  pi: ExtensionAPI,
  state: {
    readonly currentConfig: RouterConfig;
    routerEnabled: boolean;
    selectedProfile: string | undefined;
    readonly pinnedTierByProfile: RouterPinByProfile;
    readonly lastDecision: RoutingDecision | undefined;
    lastNonRouterModel: string | undefined;
    debugEnabled: boolean;
    readonly lastConfigWarnings: string[];
  },
  actions: {
    persistState: () => void;
    updateStatus: (ctx: ExtensionContext) => void;
    reloadConfig: (
      ctx?: ExtensionContext,
      options?: { preserveDebug?: boolean },
    ) => void;
    ensureValidActiveRouterProfile: (ctx: ExtensionContext) => Promise<void>;
    switchToRouterProfile: (
      profileName: string,
      ctx: ExtensionContext,
      strict?: boolean,
    ) => Promise<boolean>;
  },
) => {
  const SUBCOMMAND_DETAILS = [
    { name: 'status', desc: 'Show current router status' },
    { name: 'profile', desc: 'Switch to a different router profile' },
    { name: 'pin', desc: 'Pin routing for a profile to a tier, or clear' },
    { name: 'disable', desc: 'Disable the router and restore last model' },

    { name: 'debug', desc: 'Toggle router debug notifications on/off' },
    { name: 'reload', desc: 'Reload the model router configuration' },
    { name: 'help', desc: 'Show usage help for subcommands' },
  ];

  const getSubcommandCompletions = (
    prefix: string,
  ): AutocompleteItem[] | null => {
    const items = SUBCOMMAND_DETAILS.filter((s) =>
      s.name.startsWith(prefix),
    ).map((s) => ({
      value: s.name,
      label: s.name,
      description: s.desc,
    }));
    return items.length > 0 ? items : null;
  };

  const getPinCompletions = (args: string[]): AutocompleteItem[] | null => {
    // pin [profile] <tier|clear>
    if (args.length <= 1) {
      const token = args[0] ?? '';
      const pinItems = ROUTER_PIN_VALUES.filter((value) =>
        value.startsWith(token),
      ).map((value) => ({ value, label: value }));
      const profileItems = profileNames(state.currentConfig)
        .filter((name) => name.startsWith(token))
        .map((name) => ({ value: name, label: `router/${name}` }));
      const items = [...pinItems, ...profileItems];
      return items.length > 0 ? items : null;
    }

    const profileToken = args[0];
    if (!state.currentConfig.profiles[profileToken]) return null;
    const pinPrefix = args[1] ?? '';
    const items = ROUTER_PIN_VALUES.filter((value) =>
      value.startsWith(pinPrefix),
    ).map((value) => ({
      value: `${profileToken} ${value}`,
      label: `${profileToken} ${value}`,
    }));
    return items.length > 0 ? items : null;
  };

  const getActiveProfileOrWarn = (ctx: ExtensionContext): string | undefined => {
    if (!state.selectedProfile) {
      ctx.ui.notify('No router profile is active. Select a router model first.', 'error');
    }
    return state.selectedProfile;
  };

  const handleStatus = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 0) {
      ctx.ui.notify('Usage: /router status (no arguments)', 'error');
      return;
    }
    const profilePin = state.selectedProfile
      ? state.pinnedTierByProfile[state.selectedProfile] ?? 'none'
      : 'none';
    const lines = [
      `Router enabled: ${state.routerEnabled ? 'yes' : 'off'}`,
      `Selected profile: ${state.selectedProfile ?? 'none'}`,
      `Selected profile pin: ${profilePin}`,
      `Pins by profile: ${formatPinSummary(state.pinnedTierByProfile)}`,
      `Available profiles: ${profileNames(state.currentConfig).join(', ')}`,
      `Last non-router model: ${state.lastNonRouterModel ?? 'none'}`,
      `Debug: ${state.debugEnabled ? 'on' : 'off'}`,
    ];
    if (state.lastDecision) {
      lines.push(
        `Last routed tier: ${state.lastDecision.tier}`,
        `Last model: ${state.lastDecision.targetProvider}/${state.lastDecision.targetModelId} (${state.lastDecision.thinking})`,
        `Reason: ${state.lastDecision.reasoning}`,
      );
    }
    if (state.lastConfigWarnings.length > 0) {
      lines.push('', '⚠️ Configuration Warnings:', ...state.lastConfigWarnings.map((w) => `  - ${w}`));
    }
    ctx.ui.notify(lines.join('\n'), 'info');
    actions.updateStatus(ctx);
  };

  const handleProfile = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 1) {
      ctx.ui.notify('Usage: /router profile [name]', 'error');
      return;
    }
    if (!args[0]) {
      ctx.ui.notify(
        `Current profile: ${state.selectedProfile}. Available: ${profileNames(state.currentConfig).join(', ')}`,
        'info',
      );
      return;
    }
    const success = await actions.switchToRouterProfile(args[0], ctx);
    if (success) {
      ctx.ui.notify(`Switched to router profile: ${state.selectedProfile}`, 'info');
    }
  };

  const handlePin = async (args: string[], ctx: ExtensionContext) => {
    const currentProfile = getActiveProfileOrWarn(ctx);
    if (!currentProfile) return;

    const pinUsage = 'Usage: /router pin [profile] <high|medium|low|clear>';

    if (args.length === 0) {
      ctx.ui.notify(
        [
          `Profile: ${currentProfile}`,
          `Pinned tier: ${state.pinnedTierByProfile[currentProfile] ?? 'none'}`,
          `Pins by profile: ${formatPinSummary(state.pinnedTierByProfile)}`,
          pinUsage,
        ].join('\n'),
        'info',
      );
      actions.updateStatus(ctx);
      return;
    }

    if (args.length > 2) {
      ctx.ui.notify(pinUsage, 'error');
      return;
    }

    let profileName: string;
    let pinValue: string;

    if (args.length === 1) {
      // pin <value>
      profileName = currentProfile;
      pinValue = args[0];
    } else if (args[0] in state.currentConfig.profiles) {
      // pin <profile> <value>
      [profileName, pinValue] = args;
    } else {
      // pin <unknown> <value> — the first arg isn't a valid profile
      ctx.ui.notify(`Unknown router profile: ${args[0]}`, 'error');
      return;
    }

    if (!isPinValue(pinValue)) {
      ctx.ui.notify(
        `Invalid router pin: ${pinValue}. Use high, medium, low, or clear`,
        'error',
      );
      return;
    }

    const nextTier = pinValue === 'clear' ? undefined : pinValue;
    if (nextTier) {
      const profile = state.currentConfig.profiles[profileName];
      if (!profile || !profile[nextTier]) {
        ctx.ui.notify(
          `Profile "${profileName}" has no "${nextTier}" tier configured. All three tiers (high, medium, low) are required.`,
          'error',
        );
        return;
      }
      state.pinnedTierByProfile[profileName] = nextTier;
    } else {
      delete state.pinnedTierByProfile[profileName];
    }
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      nextTier
        ? `Router profile '${profileName}' pinned to ${nextTier}`
        : `Router profile ${profileName} pin cleared; classifier routing restored`,
      'info',
    );
  };

  const handleDisable = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 0) {
      ctx.ui.notify('Usage: /router disable (no arguments)', 'error');
      return;
    }
    if (!state.lastNonRouterModel) {
      ctx.ui.notify('No previous non-router model recorded. Use /model to pick a concrete model.', 'warning');
      return;
    }
    const targetModel = resolveModelFromRef(state.lastNonRouterModel, ctx.modelRegistry);
    if (!targetModel) {
      ctx.ui.notify(
        `Recorded non-router model is unavailable: ${state.lastNonRouterModel}`,
        'error',
      );
      return;
    }
    const success = await pi.setModel(targetModel);
    if (!success) {
      ctx.ui.notify(`Failed to switch to ${state.lastNonRouterModel}`, 'error');
      return;
    }
    state.routerEnabled = false;
    actions.persistState();
    pi.setThinkingLevel('off');
    actions.updateStatus(ctx);
    ctx.ui.notify(
      `Router disabled. Restored ${state.lastNonRouterModel}`,
      'info',
    );
  };

  const handleDebug = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 1) {
      ctx.ui.notify('Usage: /router debug <on|off>', 'error');
      return;
    }
    const cmd = args[0]?.toLowerCase();
    if (cmd === 'on') state.debugEnabled = true;
    else if (cmd === 'off') state.debugEnabled = false;
    else {
      state.debugEnabled = !state.debugEnabled;
    }
    actions.persistState();
    actions.updateStatus(ctx);
    ctx.ui.notify(
      `Router debug ${state.debugEnabled ? 'enabled' : 'disabled'}.`,
      'info',
    );
  };

  const handleReload = async (args: string[], ctx: ExtensionContext) => {
    if (args.length > 0) {
      ctx.ui.notify('Usage: /router reload (no arguments)', 'error');
      return;
    }
    actions.reloadConfig(ctx, { preserveDebug: true });
    await actions.ensureValidActiveRouterProfile(ctx);
    actions.updateStatus(ctx);

    if (state.lastConfigWarnings.length > 0) {
      ctx.ui.notify(`Router reload warnings:\n${state.lastConfigWarnings.join('\n')}`, 'warning');
    }

    ctx.ui.notify(
      `Router config reloaded. Profiles: ${profileNames(state.currentConfig).join(', ')}`,
      'info',
    );
  };

  pi.registerCommand('router', {
    description: 'Model router control center',
    getArgumentCompletions: (prefix) => {
      const trimmedLeft = prefix.trimStart();
      const hasTrailingSpace = /\s$/.test(prefix);
      const parts = trimmedLeft.length > 0 ? trimmedLeft.split(/\s+/) : [];

      if (parts.length === 0) {
        return getSubcommandCompletions('');
      }

      if (parts.length === 1 && !hasTrailingSpace) {
        return getSubcommandCompletions(parts[0]);
      }

      const subcommand = parts[0];
      const subArgs = parts.slice(1);
      if (hasTrailingSpace && parts.length === 1) {
        subArgs.push('');
      }

      switch (subcommand) {
        case 'profile': {
          const profilePrefix = subArgs[0] ?? '';
          const items = profileNames(state.currentConfig)
            .filter((name) => name.startsWith(profilePrefix))
            .map((name) => ({
              value: `profile ${name}`,
              label: `router/${name}`,
              description: `Switch to router profile "${name}"`,
            }));
          return items.length > 0 ? items : null;
        }
        case 'pin': {
          const completions = getPinCompletions(subArgs);
          return (
            completions?.map((c) => {
              // c.value is either a profile name, pin value, or "profile pinValue"
              const spaceIdx = c.value.indexOf(' ');
              const hasProfileAndPin = spaceIdx !== -1;
              // c.value is a pin value (high/medium/low/clear), "profile pinValue", or bare profile name
              const isProfile = state.currentConfig.profiles[c.value] !== undefined;
              const desc = hasProfileAndPin
                ? c.value.slice(spaceIdx + 1) === 'clear'
                  ? `Clear pin on profile '${c.value.slice(0, spaceIdx)}'`
                  : `Pin profile '${c.value.slice(0, spaceIdx)}' to ${c.value.slice(spaceIdx + 1)}`
                : isProfile
                  ? `Pin '${c.label}' to...`
                  : c.value === 'clear'
                    ? 'Clear pin on current profile'
                    : `Pin current profile to ${c.label}`;
              return { ...c, value: `pin ${c.value}`, description: desc };
            }) ?? null
          );
        }
        case 'debug': {
          const debugPrefix = subArgs[0] ?? '';
          const items = ['on', 'off', 'toggle']
            .filter((v) => v.startsWith(debugPrefix))
            .map((v) => ({
              value: `debug ${v}`,
              label: v,
              description: `Router debug: ${v}`,
            }));
          return items.length > 0 ? items : null;
        }
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) ?? [];
      const subcommand = parts[0];
      const subArgs = parts.slice(1);

      switch (subcommand) {
        case 'profile':
          await handleProfile(subArgs, ctx);
          break;
        case 'pin':
          await handlePin(subArgs, ctx);
          break;
        case 'disable':
          await handleDisable(subArgs, ctx);
          break;
        case 'debug':
          await handleDebug(subArgs, ctx);
          break;
        case 'reload':
          await handleReload(subArgs, ctx);
          break;
        case 'status':
          await handleStatus(subArgs, ctx);
          break;
        case 'help':
          if (subArgs.length > 0) {
            ctx.ui.notify('Usage: /router help (no arguments)', 'error');
            return;
          }
          ctx.ui.notify(
            [
              'Router Subcommands:',
              '  status                      Show current status, profile, pin, and last decision.',
              '  profile [name]              Switch to a profile (enables router if off). Lists available if no name.',
              '  pin [profile] <tier|clear>   Pin to a tier (high|medium|low) or clear the pin.',
              '  disable                     Disable the router and restore the last used non-router model.',
              '  debug <on|off>            Enable/disable routing debug notifications.',
              '  reload                      Hot-reload the configuration JSON from .pi/model-router.json.',
              '  help                         Show this help message.',
            ].join('\n'),
            'info',
          );
          break;
        default:
          if (subcommand) {
            // Check if subcommand is actually a profile name (backwards compatible-ish with /router-on)
            if (state.currentConfig.profiles[subcommand]) {
              if (subArgs.length > 0) {
                ctx.ui.notify(
                  `Usage: /router ${subcommand} (no extra arguments allowed)`,
                  'error',
                );
                return;
              }
              await actions.switchToRouterProfile(subcommand, ctx);
              ctx.ui.notify(
                `Router enabled with profile: ${state.selectedProfile}`,
                'info',
              );
            } else {
              ctx.ui.notify(
                `Unknown router subcommand: ${subcommand}. Try /router help`,
                'error',
              );
            }
          } else {
            await handleStatus(subArgs, ctx);
          }
          break;
      }
    },
  });
};
