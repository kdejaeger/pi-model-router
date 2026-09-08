import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_MODEL_COOLDOWN_MS,
  MAX_MODEL_COOLDOWN_MS,
  createRetryAfterCapture,
  getRateLimitCooldownMs,
  isModelSuspended,
  isRateLimitError,
  parseHumanizedRetryMs,
  parseRetryAfterHeader,
  suspendModel,
  supportsRetryAfterCapture,
} from '../extensions/failover.ts';

test('rate-limited model slugs stay out of routing until their cooldown expires', () => {
  const cooldowns = new Map<string, number>();
  const now = 1_000_000;

  assert.equal(isRateLimitError(new Error('HTTP 429: too many requests')), true);
  assert.equal(isRateLimitError(new Error('GoUsageLimitError: monthly usage limit reached')), true);
  assert.equal(isRateLimitError(new Error('provider returned 503')), false);

  const suspendedFor = suspendModel(cooldowns, 'provider-a/model-a', new Error('429 rate limit exceeded; retry after 2s'), { now });
  assert.equal(suspendedFor, 2);
  assert.equal(isModelSuspended(cooldowns, 'provider-a/model-a', now + 1_999), true);
  assert.equal(isModelSuspended(cooldowns, 'provider-a/model-a', now + 2_000), false);

  const defaultSuspension = suspendModel(cooldowns, 'provider-b/model-b', 'rate limit exceeded', { now });
  assert.equal(defaultSuspension, DEFAULT_MODEL_COOLDOWN_MS / 1_000);
});

test('parseRetryAfterHeader handles delay-seconds and HTTP-date forms', () => {
  assert.equal(parseRetryAfterHeader('60'), 60_000);
  assert.equal(parseRetryAfterHeader(' 90 '), 90_000);
  assert.equal(parseRetryAfterHeader('0'), 0);
  assert.equal(parseRetryAfterHeader(null), undefined);
  assert.equal(parseRetryAfterHeader(undefined), undefined);
  assert.equal(parseRetryAfterHeader(''), undefined);
  assert.equal(parseRetryAfterHeader('not-a-date'), undefined);

  const now = Date.parse('2026-02-03T10:00:00Z');
  assert.equal(parseRetryAfterHeader('Wed, 11 Feb 2026 10:00:00 GMT', now), 8 * 24 * 3_600_000);
  assert.equal(parseRetryAfterHeader('Wed, 11 Feb 2026 10:00:01 GMT', now), 8 * 24 * 3_600_000 + 1_000);
  assert.equal(parseRetryAfterHeader('Wed, 11 Feb 2025 10:00:00 GMT', now), 0); // already past
});

test('parseHumanizedRetryMs reads OpenCode gateway 429 wording', () => {
  // GoUsageLimitError body text: "5-hour usage limit reached. Resets in 2hr 30min. ..."
  assert.equal(
    parseHumanizedRetryMs(
      '429: {"type":"error","error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 2hr 30min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_01K46JDFR0E75SG2Q8K172KF3Y/go"},"metadata":{"limitName":"5 hour"}}',
    ),
    (2 * 3_600 + 30 * 60) * 1_000,
  );
  // Black-subscription wording previously misparsed as 2 seconds.
  assert.equal(parseHumanizedRetryMs('Subscription quota exceeded. Retry in 2hr 30min.'), 2.5 * 3_600_000);
  assert.equal(parseHumanizedRetryMs('Weekly usage limit reached. Resets in 1 day.'), 86_400_000);
  assert.equal(parseHumanizedRetryMs('Resets in 1.5 hours'), 5_400_000);
  assert.equal(parseHumanizedRetryMs('resets in 45min'), 45 * 60_000);
  assert.equal(parseHumanizedRetryMs('please try again in 30 seconds'), 30_000);
  assert.equal(parseHumanizedRetryMs('retry after: 500ms'), 500);
  assert.equal(parseHumanizedRetryMs('retry in 90'), 90_000); // unitless defaults to seconds
  assert.equal(parseHumanizedRetryMs('Rate limit exceeded. Please try again later.'), undefined);
  assert.equal(parseHumanizedRetryMs('no timing info here'), undefined);
});

test('parseHumanizedRetryMs ignores numbers that are not part of the duration', () => {
  // Absolute timestamps in the same sentence must not inflate the cooldown.
  assert.equal(parseHumanizedRetryMs('Resets in 2hr 30min on 2026-02-11'), 9_000_000);
  assert.equal(parseHumanizedRetryMs('Quota resets in 2025-03-14 10:30:00 UTC'), undefined);
  // A word between numbers ends the duration phrase (old-parser parity).
  assert.equal(parseHumanizedRetryMs('Retry in 2s and 5s'), 2_000);
  // Month wording is not minutes; unmatched units fall back to the default cooldown.
  assert.equal(parseHumanizedRetryMs('Retry in 1 month'), 1_000);
  assert.equal(parseHumanizedRetryMs('Resets in 1mo'), undefined);
  // Bare numbers still parse when standalone, even with trailing prose.
  assert.equal(parseHumanizedRetryMs('retry in 90 (attempt 3)'), 90_000);
  // A zero signal parses (and clamps to 1s downstream), matching the header path.
  assert.equal(parseHumanizedRetryMs('retry after 0'), 0);
  assert.equal(getRateLimitCooldownMs(new Error('retry after 0')), 1_000);
});

test('getRateLimitCooldownMs falls back to the default when no duration is parseable', () => {
  assert.equal(getRateLimitCooldownMs(new Error('Resets in 2hr 30min')), 9_000_000);
  assert.equal(getRateLimitCooldownMs(new Error('429 too many requests')), DEFAULT_MODEL_COOLDOWN_MS);
  assert.equal(getRateLimitCooldownMs(new Error('retry after 3'), 5_000), 3_000);
});

test('suspendModel prefers the observed retry-after header and caps extreme values', () => {
  const cooldowns = new Map<string, number>();
  const now = 1_000_000;

  // Header value wins over (unparseable) error text.
  assert.equal(suspendModel(cooldowns, 'a/m1', new Error('429'), { retryAfterMs: 90_000, now }), 90);
  assert.equal(isModelSuspended(cooldowns, 'a/m1', now + 89_999), true);

  // Sub-second header values clamp to 1s; multi-day values cap at 24h.
  assert.equal(suspendModel(cooldowns, 'a/m2', new Error('429'), { retryAfterMs: 0, now }), 1);
  assert.equal(suspendModel(cooldowns, 'a/m3', new Error('429'), { retryAfterMs: 40 * 24 * 3_600_000, now }), MAX_MODEL_COOLDOWN_MS / 1_000);

  // Humanized message parsing still applies when no header was observed.
  assert.equal(suspendModel(cooldowns, 'a/m4', new Error('Resets in 2hr 30min'), { now }), 9_000);
});

test('supportsRetryAfterCapture skips adapters that reject custom fetch', () => {
  assert.equal(supportsRetryAfterCapture('openai-completions'), true);
  assert.equal(supportsRetryAfterCapture('anthropic-messages'), true);
  assert.equal(supportsRetryAfterCapture(undefined), true);
  assert.equal(supportsRetryAfterCapture('google-generative-ai'), false);
  assert.equal(supportsRetryAfterCapture('google-vertex'), false);
});

test('createRetryAfterCapture records the retry-after header from raw 429 responses', async () => {
  const capture = createRetryAfterCapture(async () =>
    new Response('rate limited', { status: 429, headers: { 'retry-after': '123' } }),
  );
  const response = await capture.fetch('https://opencode.ai/zen/go/v1/chat/completions', { method: 'POST' });
  assert.equal(response.status, 429);
  assert.equal(capture.getRetryAfterMs(), 123_000);

  const noHeader = createRetryAfterCapture(async () => new Response('rate limited', { status: 429 }));
  await noHeader.fetch('https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(noHeader.getRetryAfterMs(), undefined);

  const success = createRetryAfterCapture(async () => new Response('ok', { status: 200, headers: { 'retry-after': '999' } }));
  await success.fetch('https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(success.getRetryAfterMs(), undefined); // only 429 responses are captured

  const httpDate = createRetryAfterCapture(async () =>
    new Response('rate limited', { status: 429, headers: { 'retry-after': 'Wed, 11 Feb 2026 10:00:00 GMT' } }),
  );
  await httpDate.fetch('https://opencode.ai/zen/go/v1/chat/completions');
  assert.ok(httpDate.getRetryAfterMs() !== undefined);
});
