import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Api, type Model } from '@earendil-works/pi-ai';
import { getAgentDir, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type {
  RouterConfig,
  RouterProfile,
  RoutedTierConfig,
  ConfigLoadResult,
  ParsedConfigFile,
  RouterTier,
  RoutingRule,
} from './types';

export const ROUTER_TIERS = ['high', 'medium', 'low'] as const;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
export const ROUTER_PIN_VALUES = ['clear', 'high', 'medium', 'low'] as const;

const isObjectRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel);

export const isRouterTier = (value: unknown): value is RouterTier =>
  value === 'high' || value === 'medium' || value === 'low';

/**
 * Returns true if value is a valid pin value.
 * 'clear' unpins; 'high'|'medium'|'low' pins to that tier.
 */
export const isPinValue = (value: string): value is (typeof ROUTER_PIN_VALUES)[number] =>
  (ROUTER_PIN_VALUES as readonly string[]).includes(value);

const validateNonNegativeInt = (val: unknown, label: string, fallback: number | undefined, warnings: string[]): number | undefined => {
  if (val === undefined || val === null) return fallback;
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
    warnings.push(`Invalid ${label} (${JSON.stringify(val)}). Must be a non-negative integer.`);
    return fallback;
  }
  return val;
};

const parseConfigFile = (path: string): ParsedConfigFile => {
  if (!existsSync(path)) {
    return { config: {}, warnings: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!isObjectRecord(parsed)) {
      return {
        config: {},
        warnings: [`Ignored router config at ${path}: expected a JSON object.`],
      };
    }
    return { config: parsed as Partial<RouterConfig>, warnings: [] };
  } catch (error) {
    return {
      config: {},
      warnings: [
        `Failed to parse router config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
};

const mergeTier = (
  existing?: RoutedTierConfig,
  next?: Partial<RoutedTierConfig>,
): RoutedTierConfig | undefined => {
  if (!next) return existing;
  if (!existing) return next?.model ? (next as RoutedTierConfig) : undefined;
  return { ...existing, ...next };
};

const mergeConfig = (
  base: RouterConfig,
  override: Partial<RouterConfig>,
): RouterConfig => {
  const mergedProfiles: Record<string, RouterProfile> = { ...base.profiles };
  for (const [name, profile] of Object.entries(override.profiles ?? {})) {
    if (!isObjectRecord(profile)) continue;
    const existing = mergedProfiles[name];
    const nextProfile = profile as Partial<RouterProfile>;
    mergedProfiles[name] = {
      high: mergeTier(existing?.high, nextProfile.high),
      medium: mergeTier(existing?.medium, nextProfile.medium),
      low: mergeTier(existing?.low, nextProfile.low),
    };
  }
  return {
    debug: override.debug ?? base.debug,
    classifierModels: override.classifierModels ?? base.classifierModels,
    classifierModelThinking:
      override.classifierModelThinking ?? base.classifierModelThinking,
    classifierRunOnceAfterToolCount:
      override.classifierRunOnceAfterToolCount ?? base.classifierRunOnceAfterToolCount,
    classifierRunAfterToolFailures:
      override.classifierRunAfterToolFailures ?? base.classifierRunAfterToolFailures,
    classifierInterval:
      override.classifierInterval ?? base.classifierInterval,
    tierStickiness: override.tierStickiness ?? base.tierStickiness,
    defaultContextThresholdPercent:
      override.defaultContextThresholdPercent ?? base.defaultContextThresholdPercent,
    contextThresholdPercentOverrides:
      override.contextThresholdPercentOverrides ?? base.contextThresholdPercentOverrides,
    rules: override.rules ?? base.rules,
    profiles: mergedProfiles,
  };
};

export const parseCanonicalModelRef = (
  value: string,
): { provider: string; modelId: string } => {
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(
      `Invalid model reference "${value}". Expected "provider/model".`,
    );
  }
  const provider = value.slice(0, slashIndex).trim();
  const modelId = value.slice(slashIndex + 1).trim();
  if (!provider || !modelId) {
    throw new Error(
      `Invalid model reference "${value}". Expected "provider/model".`,
    );
  }
  return { provider, modelId };
};

/**
 * Resolves a concrete model from a canonical reference string and a registry.
 */
export const resolveModelFromRef = (
  modelRef: string,
  modelRegistry: ExtensionContext['modelRegistry'] | undefined,
): Model<Api> | undefined => {
  if (!modelRegistry) return undefined;
  try {
    const { provider, modelId } = parseCanonicalModelRef(modelRef);
    return modelRegistry.find(provider, modelId);
  } catch {
    return undefined;
  }
};

const normalizeTierConfig = (
  value: unknown,
  profileName: string,
  tier: RouterTier,
  warnings: string[],
): RoutedTierConfig | undefined => {
  if (!isObjectRecord(value)) {
    return undefined;
  }

  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!model) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier is missing a model. Tier disabled.`,
    );
    return undefined;
  }

  try {
    parseCanonicalModelRef(model);
  } catch (error) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier: ${error instanceof Error ? error.message : String(error)} Tier disabled.`,
    );
    return undefined;
  }

  const thinking = isThinkingLevel(value.thinking)
    ? value.thinking
    : 'medium';
  if (value.thinking !== undefined && !isThinkingLevel(value.thinking)) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier has invalid thinking level. Defaulting to medium.`,
    );
  }

  let fallbacks: string[] | undefined;
  if (Array.isArray(value.fallbacks)) {
    fallbacks = [];
    for (const rawFB of value.fallbacks) {
      if (typeof rawFB !== 'string') continue;
      const trimmedFB = rawFB.trim();
      if (!trimmedFB) continue;
      try {
        parseCanonicalModelRef(trimmedFB);
        fallbacks.push(trimmedFB);
      } catch (error) {
        warnings.push(
          `Invalid fallback model "${rawFB}" in profile "${profileName}" ${tier} tier: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return { model, thinking, fallbacks };
};

export const normalizeConfig = (raw: RouterConfig): ConfigLoadResult => {
  const warnings: string[] = [];
  const normalizedProfiles: Record<string, RouterProfile> = {};

  for (const [name, profile] of Object.entries(raw.profiles ?? {})) {
    const trimmedName = name.trim();
    if (!trimmedName) {
      warnings.push('Ignored profile with empty name.');
      continue;
    }
    if (trimmedName !== name) {
      warnings.push(`Profile name "${name}" has leading/trailing whitespace. Using "${trimmedName}".`);
    }
    const high = normalizeTierConfig(
      profile?.high,
      trimmedName,
      'high',
      warnings,
    );
    const medium = normalizeTierConfig(
      profile?.medium,
      trimmedName,
      'medium',
      warnings,
    );
    const low = normalizeTierConfig(
      profile?.low,
      trimmedName,
      'low',
      warnings,
    );

    if (!high && !medium && !low) {
      warnings.push(
        `Profile "${trimmedName}" has no valid tiers. Skipped.`,
      );
      continue;
    }

    normalizedProfiles[trimmedName] = { high, medium, low };
  }

  if (Object.keys(normalizedProfiles).length === 0) {
    warnings.push('No router profiles configured. Define at least one profile in your config.');
  }

  const tierStickiness =
    typeof raw.tierStickiness === 'number'
      ? Math.max(0, Math.min(1, raw.tierStickiness))
      : 0.5;

  let defaultContextThresholdPercent = 90;
  if (typeof raw.defaultContextThresholdPercent === 'number') {
    if (raw.defaultContextThresholdPercent <= 0) {
      warnings.push(
        `defaultContextThresholdPercent (${raw.defaultContextThresholdPercent}) is not a positive number. Falling back to 90.`,
      );
    } else if (raw.defaultContextThresholdPercent > 100) {
      warnings.push(
        `defaultContextThresholdPercent (${raw.defaultContextThresholdPercent}) exceeds 100. Falling back to 90.`,
      );
    } else {
      defaultContextThresholdPercent = raw.defaultContextThresholdPercent;
    }
  }

  const contextThresholdPercentOverrides = isObjectRecord(raw.contextThresholdPercentOverrides)
    ? Object.fromEntries(
        Object.entries(raw.contextThresholdPercentOverrides).flatMap(([key, val]) => {
          const trimmed = key.trim();
          if (!trimmed) return [];
          try {
            parseCanonicalModelRef(trimmed);
          } catch (error) {
            warnings.push(`Ignored contextThresholdPercentOverride "${key}": invalid model reference — ${error instanceof Error ? error.message : String(error)}`);
            return [];
          }
          if (typeof val !== 'number' || val <= 0) {
            warnings.push(`Ignored contextThresholdPercentOverride "${key}" (${JSON.stringify(val)}): expected a positive number.`);
            return [];
          }
          return [[trimmed, val] as [string, number]];
        }),
      )
    : undefined;

  const rules: RoutingRule[] = [];
  if (Array.isArray(raw.rules)) {
    for (const rule of raw.rules) {
      if (isObjectRecord(rule)) {
        const matches = rule.matches;
        const tier = rule.tier;
        if (
          (typeof matches === 'string' || Array.isArray(matches)) &&
          isRouterTier(tier)
        ) {
          rules.push({
            matches,
            tier,
            reason: typeof rule.reason === 'string' ? rule.reason : undefined,
          });
        } else {
          warnings.push(
            `Ignored invalid routing rule: ${JSON.stringify(rule)}`,
          );
        }
      }
    }
  }

  let classifierModels: string[] | undefined = undefined;
  if (Array.isArray(raw.classifierModels)) {
    classifierModels = [];
    for (const rawCM of raw.classifierModels) {
      if (typeof rawCM === 'string') {
        const trimmedCM = rawCM.trim();
        if (!trimmedCM) continue;
        try {
          parseCanonicalModelRef(trimmedCM);
          classifierModels.push(trimmedCM);
        } catch (error) {
          warnings.push(
            `Invalid classifierModels entry "${rawCM}": ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        warnings.push(`Ignored non-string classifierModels entry: ${JSON.stringify(rawCM)}`);
      }
    }
    if (classifierModels.length === 0) {
      classifierModels = undefined;
    }
  }

  const classifierModelThinking = isThinkingLevel(raw.classifierModelThinking) ? raw.classifierModelThinking : 'off';
  if (raw.classifierModelThinking !== undefined && !isThinkingLevel(raw.classifierModelThinking)) {
    warnings.push(`Invalid classifierModelThinking value "${raw.classifierModelThinking}". Falling back to "off".`);
  }

  const classifierRunOnceAfterToolCount = validateNonNegativeInt(raw.classifierRunOnceAfterToolCount, 'classifierRunOnceAfterToolCount', 3, warnings);
  const classifierRunAfterToolFailures = validateNonNegativeInt(raw.classifierRunAfterToolFailures, 'classifierRunAfterToolFailures', 2, warnings);
  const classifierInterval = validateNonNegativeInt(raw.classifierInterval, 'classifierInterval', 10, warnings);

  return {
    config: {
      debug: typeof raw.debug === 'boolean' ? raw.debug : false,
      classifierModels,
      classifierModelThinking,
      classifierRunOnceAfterToolCount,
      classifierRunAfterToolFailures,
      classifierInterval,
      tierStickiness,
      defaultContextThresholdPercent,
      contextThresholdPercentOverrides,
      rules: rules.length > 0 ? rules : undefined,
      profiles: normalizedProfiles,
    },
    warnings,
  };
};

export const loadRouterConfig = (cwd: string): ConfigLoadResult => {
  const globalPath = join(getAgentDir(), 'model-router.json');
  const projectPath = join(cwd, '.pi', 'model-router.json');
  const globalResult = parseConfigFile(globalPath);
  const projectResult = parseConfigFile(projectPath);
  const baseConfig: RouterConfig = { profiles: {} };
  const merged = mergeConfig(
    mergeConfig(baseConfig, globalResult.config),
    projectResult.config,
  );
  const normalized = normalizeConfig(merged);
  return {
    config: normalized.config,
    warnings: [
      ...globalResult.warnings,
      ...projectResult.warnings,
      ...normalized.warnings,
    ],
  };
};

export const profileNames = (config: RouterConfig): string[] => {
  return Object.keys(config.profiles).sort();
};

/**
 * OpenRouter attribution headers required for API usage tracking.
 * These identify the app to OpenRouter's analytics.
 */
export const OPENROUTER_ATTR_HEADERS: Readonly<Record<string, string>> = {
  'HTTP-Referer': 'https://pi.dev',
  'X-OpenRouter-Title': 'pi',
  'X-OpenRouter-Categories': 'cli-agent',
};

/** Create an onPayload handler that injects session_id for OpenRouter session tracking. */
export const createOpenRouterOnPayload = (
  sessionProvider?: { getSessionId(): string; getSessionName(): string | undefined },
  origOnPayload?: (p: any, m: any) => any,
): ((p: any, m: any) => Promise<any>) | undefined => {
  const rawId = sessionProvider?.getSessionId();
  const name = sessionProvider?.getSessionName();
  const sessionId = name && rawId ? `${name.replace(/\s+/g, '-')}-${rawId.slice(0, 8)}` : rawId;
  if (!sessionId) return undefined;
  return async (p: any, m: any) => {
    const payload = origOnPayload ? await origOnPayload(p, m) : p;
    return { ...payload, session_id: sessionId };
  };
};

export const resolveProfileName = (
  config: RouterConfig,
  requested?: string,
): string | undefined =>
  requested && config.profiles[requested] ? requested : undefined;
