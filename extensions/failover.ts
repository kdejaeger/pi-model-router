import type { FetchFunction } from '@earendil-works/pi-ai';

export const DEFAULT_MODEL_COOLDOWN_MS = 60_000;
/** Upper bound for a single suspension so multi-day quota windows cannot bench a model for the rest of a long-lived session. */
export const MAX_MODEL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const getErrorText = (error: unknown): string => (error instanceof Error ? error.message : String(error ?? ''));

export const isRateLimitError = (error: unknown): boolean =>
  /\b429\b|rate[\s_-]*limit|too many requests|throttl|quota|usage[\s_-]*limit|out of budget|billing/i.test(getErrorText(error));

/**
 * Parses an HTTP `retry-after` response header (delay-seconds or HTTP-date) into milliseconds.
 * Returns undefined when the value is absent or unparseable.
 */
export const parseRetryAfterHeader = (value: string | null | undefined, now: number = Date.now()): number | undefined => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  return undefined;
};

const RETRY_PHRASE_PATTERN =
  /(?:retry[\s_-]*(?:after|in)|resets?[\s_-]*in|try[\s_-]*again\s+(?:in|after))\s*[:=]?\s*([^.\n]*(?:\.\d+[^.\n]*)*)/i;
const DURATION_PAIR_PATTERN = /(\d+(?:\.\d+)?)\s*(ms|s(?:ec(?:ond)?)?s?|m(?!o)(?:in(?:ute)?)?s?|h(?:r|our)?s?|d(?:ay)?s?)?/gi;

/**
 * Parses a humanized retry phrase — "retry after 2s", "Retry in 2hr 30min", "Resets in 1 day" —
 * into milliseconds. Consecutive whitespace-separated `<number><unit>` pairs are summed so
 * compound durations resolve correctly. A bare number is trusted only as a standalone first
 * token ("retry in 90"), never as a date/version fragment ("2026-02-11"), and any intervening
 * word ("2s and 5s") ends the duration. OpenCode's Zen/Go gateway uses this wording in 429
 * bodies when it does not send a usable header.
 */
export const parseHumanizedRetryMs = (text: string): number | undefined => {
  const phraseMatch = text.match(RETRY_PHRASE_PATTERN);
  if (!phraseMatch) return undefined;
  const segment = phraseMatch[1];

  let totalMs = 0;
  let sawNumber = false;
  let scanFrom = 0; // end of the previous accepted pair; pairs must be whitespace-separated
  for (const match of segment.matchAll(DURATION_PAIR_PATTERN)) {
    const at = match.index ?? 0;
    if (!/^\s*$/.test(segment.slice(scanFrom, at))) break; // a word intervened — the duration ended
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue; // guards absurdly long digit runs parsing to Infinity
    const unit = match[2]?.toLowerCase();
    let multiplier: number;
    if (unit === 'ms') {
      multiplier = 1;
    } else if (unit?.startsWith('d')) {
      multiplier = 86_400_000;
    } else if (unit?.startsWith('h')) {
      multiplier = 3_600_000;
    } else if (unit?.startsWith('m')) {
      multiplier = 60_000;
    } else {
      if (!unit) {
        const charAfterValue = segment[at + match[1].length];
        if (sawNumber || (charAfterValue !== undefined && /[^\s)\],;.!?'"]/.test(charAfterValue))) break;
      }
      multiplier = 1_000;
    }
    sawNumber = true;
    totalMs += value * multiplier;
    scanFrom = at + match[0].length;
  }
  return sawNumber ? totalMs : undefined;
};

export const getRateLimitCooldownMs = (error: unknown, defaultCooldownMs = DEFAULT_MODEL_COOLDOWN_MS): number => {
  const parsedMs = parseHumanizedRetryMs(getErrorText(error));
  if (parsedMs === undefined) return defaultCooldownMs;
  return Math.max(1_000, Math.ceil(parsedMs));
};

export interface SuspendModelOptions {
  /** Cooldown observed from a 429 `retry-after` response header; takes precedence over error-text parsing. */
  retryAfterMs?: number;
  now?: number;
}

export const suspendModel = (
  cooldowns: Map<string, number>,
  slug: string,
  error: unknown,
  options: SuspendModelOptions = {},
): number => {
  const now = options.now ?? Date.now();
  const cooldownMs = Math.min(
    MAX_MODEL_COOLDOWN_MS,
    Math.max(1_000, Math.ceil(options.retryAfterMs ?? getRateLimitCooldownMs(error))),
  );
  const seconds = Math.ceil(cooldownMs / 1_000);
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

export interface RetryAfterCapture {
  /** Fetch wrapper to pass to the delegated request via SimpleStreamOptions.fetch. */
  fetch: FetchFunction;
  /** Milliseconds parsed from the most recent 429 `retry-after` header seen by this capture, if any. */
  getRetryAfterMs: () => number | undefined;
}

/** pi-ai adapters that throw on a custom fetch; retry-after capture must be skipped for them. */
const APIS_REJECTING_CUSTOM_FETCH: readonly string[] = ['google-generative-ai', 'google-vertex'];

export const supportsRetryAfterCapture = (api: string | undefined): boolean =>
  api === undefined || !APIS_REJECTING_CUSTOM_FETCH.includes(api);

/**
 * Wraps the delegated request's fetch so the raw 429 `retry-after` response header can be
 * observed before pi-ai collapses the error into a plain message string (the header is lost
 * on that path). Pair the captured value with `suspendModel`.
 */
export const createRetryAfterCapture = (baseFetch: FetchFunction = globalThis.fetch): RetryAfterCapture => {
  let retryAfterMs: number | undefined;
  const fetch: FetchFunction = async (input, init) => {
    const response = await baseFetch(input, init);
    if (response.status === 429) {
      const parsedMs = parseRetryAfterHeader(response.headers?.get('retry-after'));
      if (parsedMs !== undefined) retryAfterMs = parsedMs;
    }
    return response;
  };
  return { fetch, getRetryAfterMs: () => retryAfterMs };
};
