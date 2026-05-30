import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  RoutingDecision,
  RouterConfig,
  RouterPinByProfile,
  RouterThinkingByProfile,
} from './types';

const getEffectiveThinking = (
  thinkingByProfile: RouterThinkingByProfile,
  profileName: string,
  decision: RoutingDecision,
) => thinkingByProfile[profileName]?.[decision.tier] ?? decision.thinking;

const getDecisionFlags = (decision: RoutingDecision): string[] => {
  const flags: string[] = [];
  if (decision.isFallback) flags.push('fallback');
  if (decision.isContextTriggered) flags.push('context');
  if (decision.isRuleMatched) flags.push('rule');
  return flags;
};

const formatRoutingDetails = (
  decision: RoutingDecision,
  thinkingByProfile: RouterThinkingByProfile,
): string => {
  const effectiveThinking = getEffectiveThinking(
    thinkingByProfile,
    decision.profile,
    decision,
  );
  const flags = getDecisionFlags(decision);
  const flagsStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
  return `${decision.tier}${flagsStr} -> ${decision.targetProvider}/${decision.targetModelId} (${effectiveThinking})`;
};

export const formatDecision = (d: RoutingDecision): string => {
  return `[${new Date(d.timestamp).toLocaleTimeString()}] ${d.tier} -> ${d.targetProvider}/${d.targetModelId} (${d.thinking}) - ${d.reasoning}`;
};

export const formatPinSummary = (
  pinnedTierByProfile: RouterPinByProfile,
): string => {
  const entries = Object.entries(pinnedTierByProfile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, tier]) => `${profile}:${tier}`);
  return entries.length > 0 ? entries.join(', ') : 'none';
};

export const formatThinkingSummary = (
  thinkingByProfile: RouterThinkingByProfile,
): string => {
  const entries = Object.entries(thinkingByProfile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, tierMap]) => {
      const tiers = Object.entries(tierMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tier, level]) => `${tier}:${level}`);
      return `${profile}(${tiers.join(',')})`;
    });
  return entries.length > 0 ? entries.join(', ') : 'none';
};

export const formatModelRef = (ref: string | undefined): string => {
  return ref ?? 'none';
};

export const updateStatus = (
  ctx: ExtensionContext,
  routerEnabled: boolean,
  selectedProfile: string,
  pinnedTierByProfile: RouterPinByProfile,
  thinkingByProfile: RouterThinkingByProfile,
  lastDecision: RoutingDecision | undefined,
  lastNonRouterModel: string | undefined,
  widgetEnabled: boolean,
  currentConfig: RouterConfig
) => {
  const activeRouterProfile = routerEnabled ? selectedProfile : undefined;
  const statusProfile = selectedProfile;
  const activePin = pinnedTierByProfile[statusProfile];
  const pinLabel = activePin ? ` [pin:${activePin}]` : '';

  let statusText: string;
  if (activeRouterProfile) {
    const matchesProfile =
      lastDecision && lastDecision.profile === activeRouterProfile;
    const matchesPin = activePin ? lastDecision?.tier === activePin : true;

    if (lastDecision && matchesProfile && matchesPin) {
      statusText = `router:${activeRouterProfile}${pinLabel} -> ${formatRoutingDetails(lastDecision, thinkingByProfile)}`;
    } else {
      statusText = `router:${activeRouterProfile}${pinLabel} -> waiting`;
    }
  } else {
    statusText = `router:off (${selectedProfile}${pinLabel}) -> ${formatModelRef(lastNonRouterModel)}`;
  }
  ctx.ui.setStatus('router', ctx.ui.theme.fg('dim', statusText));

  if (!widgetEnabled) {
    ctx.ui.setWidget('router', undefined);
    return;
  }

  const widgetLines = [
    `Router: ${routerEnabled ? 'enabled' : 'disabled'}`,
    `Profile: ${statusProfile}${activeRouterProfile ? ' (active)' : ''}`,
    `Pin: ${activePin ?? 'auto'}`,
  ];
  if (lastDecision && lastDecision.profile === statusProfile) {
    widgetLines.push(
      `Route: ${formatRoutingDetails(lastDecision, thinkingByProfile)}`,
    );
  } else if (!routerEnabled && lastNonRouterModel) {
    widgetLines.push(`Fallback: ${lastNonRouterModel}`);
  }
  if (Object.keys(pinnedTierByProfile).length > 1) {
    widgetLines.push(`Pins: ${formatPinSummary(pinnedTierByProfile)}`);
  }

  ctx.ui.setWidget(
    'router',
    widgetLines.map((line) => ctx.ui.theme.fg('dim', line)),
  );
};
