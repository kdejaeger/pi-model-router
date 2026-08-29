import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PROVIDER_COOLDOWN_MS,
  getRateLimitCooldownMs,
  isProviderSuspended,
  isRateLimitError,
  suspendProvider,
} from '../extensions/failover.ts';

test('rate-limited providers stay out of routing until their cooldown expires', () => {
  const cooldowns = new Map<string, number>();
  const now = 1_000_000;

  assert.equal(isRateLimitError(new Error('HTTP 429: too many requests')), true);
  assert.equal(isRateLimitError(new Error('provider returned 503')), false);

  const until = suspendProvider(cooldowns, 'provider-a', new Error('429 rate limit exceeded; retry after 2s'), now);
  assert.equal(until, now + 2_000);
  assert.equal(isProviderSuspended(cooldowns, 'provider-a', now + 1_999), true);
  assert.equal(isProviderSuspended(cooldowns, 'provider-a', now + 2_000), false);

  const defaultUntil = suspendProvider(cooldowns, 'provider-b', 'rate limit exceeded', now);
  assert.equal(defaultUntil, now + DEFAULT_PROVIDER_COOLDOWN_MS);
});
