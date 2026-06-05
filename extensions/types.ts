import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export type RouterTier = 'high' | 'medium' | 'low';
export type RouterPinByProfile = Partial<Record<string, RouterTier>>;
export type RouterThinkingByTier = Partial<Record<RouterTier, ThinkingLevel>>;
export type RouterThinkingByProfile = Record<string, RouterThinkingByTier>;

export interface RoutingRule {
  matches: string | string[];
  tier: RouterTier;
  reason?: string;
}

export interface RoutedTierConfig {
  model: string;
  thinking?: ThinkingLevel;
  fallbacks?: string[];
}

export interface RouterProfile {
  high: RoutedTierConfig;
  medium: RoutedTierConfig;
  low: RoutedTierConfig;
}

export interface RouterConfig {
  defaultProfile?: string;
  debug?: boolean;
  classifierModels?: string[];
  classifierModelThinking?: ThinkingLevel;
  classifierRunOnceAfterToolCount?: number; // Run the classifier once after this many tool continuations. Default: 3.
  classifierRunAfterToolFailures?: number; // Run the classifier after this many consecutive tool failures in a single turn. Default: 2.
  classifierInterval?: number; // Run the classifier every Nth tool continuation during long chains. Default: 10.
  tierStickiness?: number;
  defaultContextThresholdPercent: number;
  contextThresholdPercentOverrides?: Record<string, number>;
  rules?: RoutingRule[];
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
  isHeuristicRuleMatched?: boolean;
  lastClassifierRunToolCount?: number; // Tool-continuation count when the classifier last ran
}

export interface HeuristicAnalysis {
  suggestedTier: RouterTier;
  reasoning: string;
  isRuleMatched: boolean;
}

export interface RouterPersistedState {
  enabled: boolean;
  selectedProfile: string;
  pinTier?: RouterTier;
  pinByProfile?: RouterPinByProfile;
  thinkingByProfile?: RouterThinkingByProfile;
  debugEnabled?: boolean;
  widgetEnabled?: boolean;
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
