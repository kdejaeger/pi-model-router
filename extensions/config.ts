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

export const FALLBACK_CONFIG: RouterConfig = {
  defaultProfile: 'auto',
  debug: false,
  classifierModelThinking: 'off',
  classifierRunOnceAfterToolCount: 3,
  classifierRunAfterToolFailures: 2,
  classifierInterval: 10,
  defaultContextThresholdPercent: 90,
  profiles: {
    auto: {
      high: { model: 'openai/gpt-5.4-pro', thinking: 'off' },
      medium: { model: 'google/gemini-flash-latest', thinking: 'off' },
      low: { model: 'openai/gpt-5.4-nano', thinking: 'off' },
    },
  },
};

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
export const ROUTER_PIN_VALUES = ['auto', 'high', 'medium', 'low'] as const;

const isObjectRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === 'string' && THINKING_LEVELS.includes(value as ThinkingLevel);

const isRouterTier = (value: unknown): value is RouterTier =>
  value === 'high' || value === 'medium' || value === 'low';

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

const mergeConfig = (
  base: RouterConfig,
  override: Partial<RouterConfig>,
): RouterConfig => {
  const mergedProfiles: Record<string, RouterProfile> = { ...base.profiles };
  for (const [name, profile] of Object.entries(override.profiles ?? {})) {
    const existing = mergedProfiles[name];
    const nextProfile = profile as Partial<RouterProfile>;
    mergedProfiles[name] = {
      high: {
        ...(existing?.high ?? FALLBACK_CONFIG.profiles.auto.high),
        ...(nextProfile.high ?? {}),
      },
      medium: {
        ...(existing?.medium ?? FALLBACK_CONFIG.profiles.auto.medium),
        ...(nextProfile.medium ?? {}),
      },
      low: {
        ...(existing?.low ?? FALLBACK_CONFIG.profiles.auto.low),
        ...(nextProfile.low ?? {}),
      },
    };
  }
  return {
    defaultProfile: override.defaultProfile ?? base.defaultProfile,
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
  fallback: RoutedTierConfig,
  profileName: string,
  tier: RouterTier,
  warnings: string[],
): RoutedTierConfig => {
  if (!isObjectRecord(value)) {
    warnings.push(
      `Profile "${profileName}" has invalid ${tier} tier config. Falling back to ${fallback.model}.`,
    );
    return { ...fallback };
  }

  const model = typeof value.model === 'string' ? value.model.trim() : '';
  let parsedModel = fallback.model;
  if (!model) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier is missing a model. Falling back to ${fallback.model}.`,
    );
  } else {
    try {
      parseCanonicalModelRef(model);
      parsedModel = model;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  const thinking = isThinkingLevel(value.thinking)
    ? value.thinking
    : fallback.thinking;
  if (value.thinking !== undefined && !isThinkingLevel(value.thinking)) {
    warnings.push(
      `Profile "${profileName}" ${tier} tier has invalid thinking level. Falling back to ${fallback.thinking ?? 'medium'}.`,
    );
  }

  let fallbacks: string[] | undefined = undefined;
  if (Array.isArray(value.fallbacks)) {
    fallbacks = [];
    for (const rawFB of value.fallbacks) {
      if (typeof rawFB === 'string') {
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
  }

  return { model: parsedModel, thinking, fallbacks };
};

export const normalizeConfig = (raw: RouterConfig): ConfigLoadResult => {
  const warnings: string[] = [];
  const normalizedProfiles: Record<string, RouterProfile> = {};
  const fallbackAuto = FALLBACK_CONFIG.profiles.auto;

  for (const [name, profile] of Object.entries(raw.profiles ?? {})) {
    normalizedProfiles[name] = {
      high: normalizeTierConfig(
        profile?.high,
        fallbackAuto.high,
        name,
        'high',
        warnings,
      ),
      medium: normalizeTierConfig(
        profile?.medium,
        fallbackAuto.medium,
        name,
        'medium',
        warnings,
      ),
      low: normalizeTierConfig(
        profile?.low,
        fallbackAuto.low,
        name,
        'low',
        warnings,
      ),
    };
  }

  if (Object.keys(normalizedProfiles).length === 0) {
    normalizedProfiles.auto = fallbackAuto;
    warnings.push(
      'No valid router profiles found. Falling back to the built-in auto profile.',
    );
  }

  let defaultProfile =
    typeof raw.defaultProfile === 'string' && raw.defaultProfile.trim()
      ? raw.defaultProfile.trim()
      : undefined;
  if (!defaultProfile || !normalizedProfiles[defaultProfile]) {
    const fallbackProfile = normalizedProfiles[
      FALLBACK_CONFIG.defaultProfile ?? 'auto'
    ]
      ? (FALLBACK_CONFIG.defaultProfile ?? 'auto')
      : Object.keys(normalizedProfiles).sort()[0];
    if (defaultProfile && !normalizedProfiles[defaultProfile]) {
      warnings.push(
        `Default router profile "${defaultProfile}" was not found. Falling back to "${fallbackProfile}".`,
      );
    }
    defaultProfile = fallbackProfile;
  }

  const tierStickiness =
    typeof raw.tierStickiness === 'number'
      ? Math.max(0, Math.min(1, raw.tierStickiness))
      : 0.5;

  const defaultContextThresholdPercent =
    typeof raw.defaultContextThresholdPercent === 'number' &&
    raw.defaultContextThresholdPercent > 0
      ? raw.defaultContextThresholdPercent
      : FALLBACK_CONFIG.defaultContextThresholdPercent;

  const contextThresholdPercentOverrides = isObjectRecord(raw.contextThresholdPercentOverrides)
    ? Object.fromEntries(
        Object.entries(raw.contextThresholdPercentOverrides!).flatMap(([key, val]) => {
          const trimmed = key.trim();
          if (!trimmed) return [];
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
      }
    }
    if (classifierModels.length === 0) {
      classifierModels = undefined;
    }
  }

  const classifierModelThinking = isThinkingLevel(raw.classifierModelThinking) ? raw.classifierModelThinking : FALLBACK_CONFIG.classifierModelThinking;
  if (raw.classifierModelThinking !== undefined && !isThinkingLevel(raw.classifierModelThinking)) {
    warnings.push(`Invalid classifierModelThinking value "${raw.classifierModelThinking}". Falling back to "${FALLBACK_CONFIG.classifierModelThinking}".`);
  }

  const classifierRunOnceAfterToolCount = validateNonNegativeInt(raw.classifierRunOnceAfterToolCount, 'classifierRunOnceAfterToolCount', FALLBACK_CONFIG.classifierRunOnceAfterToolCount, warnings);
  const classifierRunAfterToolFailures = validateNonNegativeInt(raw.classifierRunAfterToolFailures, 'classifierRunAfterToolFailures', FALLBACK_CONFIG.classifierRunAfterToolFailures, warnings);
  const classifierInterval = validateNonNegativeInt(raw.classifierInterval, 'classifierInterval', FALLBACK_CONFIG.classifierInterval, warnings);

  return {
    config: {
      defaultProfile,
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
  const merged = mergeConfig(
    mergeConfig(FALLBACK_CONFIG, globalResult.config),
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

export const resolveProfileName = (
  config: RouterConfig,
  requested?: string,
): string => {
  if (requested && config.profiles[requested]) {
    return requested;
  }
  if (config.defaultProfile && config.profiles[config.defaultProfile]) {
    return config.defaultProfile;
  }
  return profileNames(config)[0] ?? 'auto';
};
