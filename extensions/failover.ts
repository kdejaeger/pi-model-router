export const DEFAULT_PROVIDER_COOLDOWN_MS = 60_000;

const getErrorText = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : String(message ?? '');
  }
  return String(error ?? '');
};

export const isRateLimitError = (error: unknown): boolean =>
  /(?:\b429\b|rate[\s_-]*limit|too many requests|throttl|quota)/i.test(getErrorText(error));

export const getRateLimitCooldownMs = (error: unknown, defaultCooldownMs = DEFAULT_PROVIDER_COOLDOWN_MS): number => {
  const match = getErrorText(error).match(
    /(?:retry[\s_-]*after|retry in)\s*[:=]?\s*(\d+(?:\.\d+)?)(?:\s*(ms|s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?))?/i,
  );
  if (!match) return defaultCooldownMs;

  const value = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'ms' ? 1 : unit?.startsWith('m') ? 60_000 : 1_000;
  return Math.max(1_000, Math.ceil(value * multiplier));
};

export const suspendProvider = (cooldowns: Map<string, number>, provider: string, error: unknown, now = Date.now()): number => {
  const until = now + getRateLimitCooldownMs(error);
  cooldowns.set(provider, until);
  return until;
};

export const isProviderSuspended = (cooldowns: Map<string, number>, provider: string, now = Date.now()): boolean => {
  const until = cooldowns.get(provider);
  if (until === undefined) return false;
  if (until <= now) {
    cooldowns.delete(provider);
    return false;
  }
  return true;
};
