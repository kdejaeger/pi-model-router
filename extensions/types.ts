import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export type RouterTier = 'high' | 'medium' | 'low';
export type RouterPinByProfile = Partial<Record<string, RouterTier>>;

export interface RoutedTierConfig {
  model: string;
  thinking?: ThinkingLevel;
  fallbacks?: string[];
}

export interface RouterProfile {
  high?: RoutedTierConfig;
  medium?: RoutedTierConfig;
  low?: RoutedTierConfig;
}

export interface RouterConfig {
  debug?: boolean;
  classifierModels?: string[];
  classifierModelThinking?: ThinkingLevel;
  /** Run the classifier once after this many tool continuations. Default: 3. */
  classifierRunOnceAfterToolCount?: number;
  /** Run the classifier after this many consecutive tool failures in a single turn. Default: 2. */
  classifierRunAfterToolFailures?: number;
  /** Run the classifier every Nth tool continuation during long chains. Default: 10. */
  classifierInterval?: number;
  defaultContextThresholdPercent?: number;
  contextThresholdPercentOverrides?: Record<string, number>;
  profiles: Record<string, RouterProfile>;
}

export interface RoutingDecision {
  profile: string;
  tier: RouterTier;
  targetProvider: string;
  targetModelId: string;
  targetLabel: string;
  reasoning: string;
  thinking: ThinkingLevel;
  timestamp: number;
  isFallback?: boolean;
  isContextTriggered?: boolean;
  /** Tool-continuation count when the classifier last ran */
  lastClassifierRunToolCount?: number;
}

export interface RouterPersistedState {
  enabled: boolean;
  selectedProfile: string;
  pinTier?: RouterTier;
  pinByProfile?: RouterPinByProfile;
  debugEnabled?: boolean;
  debugHistory?: RoutingDecision[];
  lastDecision?: RoutingDecision;
  lastNonRouterModel?: string;
  timestamp: number;
}

export interface ConfigLoadResult {
  config: RouterConfig;
  warnings: string[];
}

export interface ParsedConfigFile {
  config: Partial<RouterConfig>;
  warnings: string[];
}

export interface CustomSessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}
