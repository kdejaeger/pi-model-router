export const DEFAULT_MODEL_COOLDOWN_MS = 60_000;

const getErrorText = (error: unknown): string => (error instanceof Error ? error.message : String(error ?? ''));

export const isRateLimitError = (error: unknown): boolean =>
  /\b429\b|rate[\s_-]*limit|too many requests|throttl|quota|usage[\s_-]*limit|out of budget|billing/i.test(getErrorText(error));

export const getRateLimitCooldownMs = (error: unknown, defaultCooldownMs = DEFAULT_MODEL_COOLDOWN_MS): number => {
  const match = getErrorText(error).match(
    /(?:retry[\s_-]*after|retry in)\s*[:=]?\s*(\d+(?:\.\d+)?)(?:\s*(ms|s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?))?/i,
  );
  if (!match) return defaultCooldownMs;

  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'ms' ? 1 : unit?.startsWith('m') ? 60_000 : 1_000;
  return Math.max(1_000, Math.ceil(value * multiplier));
};

export const suspendModel = (cooldowns: Map<string, number>, slug: string, error: unknown, now = Date.now()): number => {
  const seconds = Math.ceil(getRateLimitCooldownMs(error) / 1_000);
  cooldowns.set(slug, now + seconds * 1_000);
  return seconds;
};

export const isModelSuspended = (cooldowns: Map<string, number>, slug: string, now = Date.now()): boolean => {
  const until = cooldowns.get(slug);
  if (until === undefined) return false;
  if (until <= now) {
    cooldowns.delete(slug);
    return false;
  }
  return true;
};
