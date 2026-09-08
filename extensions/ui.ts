import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RoutingDecision, RouterPinByProfile } from './types';

const getDecisionFlags = (decision: RoutingDecision): string[] => {
  const flags: string[] = [];
  if (decision.isFallback) flags.push('fallback');
  if (decision.isContextTriggered) flags.push('context');
  return flags;
};

export const formatDecision = (d: RoutingDecision): string => {
  return `[${new Date(d.timestamp).toLocaleTimeString()}] ${d.tier} -> ${d.targetProvider}/${d.targetModelId} (${d.thinking}) - ${d.reasoning}`;
};

export const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes > 0 ? `${hours}hr ${restMinutes}min` : `${hours}hr`;
  const restHours = hours % 24;
  return restHours > 0 ? `${Math.floor(hours / 24)}d ${restHours}hr` : `${Math.floor(hours / 24)}d`;
};

export const formatPinSummary = (pinnedTierByProfile: RouterPinByProfile): string => {
  const entries = Object.entries(pinnedTierByProfile)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([profile, tier]) => `${profile}:${tier}`);
  return entries.length > 0 ? entries.join(', ') : 'none';
};

export const updateStatus = (
  ctx: ExtensionContext,
  routerEnabled: boolean,
  selectedProfile: string | undefined,
  pinnedTierByProfile: RouterPinByProfile,
  lastDecision: RoutingDecision | undefined,
) => {
  const activePin = selectedProfile ? pinnedTierByProfile[selectedProfile] : undefined;
  const pinLabel = activePin ? ` [pin:${activePin}]` : '';

  let detail: string;
  if (routerEnabled && selectedProfile) {
    const matchesProfile = lastDecision?.profile === selectedProfile;
    const matchesPin = activePin ? lastDecision?.tier === activePin : true;

    if (matchesProfile && matchesPin && lastDecision) {
      const pinnedStar = activePin && lastDecision.tier === activePin ? ' *' : '';
      const flags = getDecisionFlags(lastDecision);
      const flagsStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
      detail = `${pinLabel} ${lastDecision.tier}${pinnedStar}${flagsStr} -> ${lastDecision.targetProvider}/${lastDecision.targetModelId}`;
    } else {
      detail = `${pinLabel} waiting`;
    }
  } else {
    detail = ' off';
  }
  ctx.ui.setStatus('router', ctx.ui.theme.fg('accent', '⇋') + ctx.ui.theme.fg('dim', detail));
};
