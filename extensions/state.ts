import type {
  RouterPinByProfile,
  RoutingDecision,
  RouterPersistedState,
} from './types';

export const isRouterPersistedState = (
  value: unknown,
): value is RouterPersistedState => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.enabled === 'boolean' &&
    typeof v.selectedProfile === 'string' &&
    typeof v.timestamp === 'number'
  );
};

export const buildPersistedState = (
  routerEnabled: boolean,
  selectedProfile: string | undefined,
  pinnedTierByProfile: RouterPinByProfile,
  debugEnabled: boolean,
  lastDecision?: RoutingDecision,
  lastNonRouterModel?: string,
): RouterPersistedState => ({
  enabled: routerEnabled,
  selectedProfile: selectedProfile ?? '',
  pinTier: selectedProfile ? pinnedTierByProfile[selectedProfile] : undefined,
  pinByProfile: { ...pinnedTierByProfile },
  debugEnabled,
  lastDecision,
  lastNonRouterModel,
  timestamp: Date.now(),
});
