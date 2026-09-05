import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MODEL_COOLDOWN_MS, isModelSuspended, isRateLimitError, suspendModel } from '../extensions/failover.ts';

test('rate-limited model slugs stay out of routing until their cooldown expires', () => {
  const cooldowns = new Map<string, number>();
  const now = 1_000_000;

  assert.equal(isRateLimitError(new Error('HTTP 429: too many requests')), true);
  assert.equal(isRateLimitError(new Error('GoUsageLimitError: monthly usage limit reached')), true);
  assert.equal(isRateLimitError(new Error('provider returned 503')), false);

  const suspendedFor = suspendModel(cooldowns, 'provider-a/model-a', new Error('429 rate limit exceeded; retry after 2s'), now);
  assert.equal(suspendedFor, 2);
  assert.equal(isModelSuspended(cooldowns, 'provider-a/model-a', now + 1_999), true);
  assert.equal(isModelSuspended(cooldowns, 'provider-a/model-a', now + 2_000), false);

  const defaultSuspension = suspendModel(cooldowns, 'provider-b/model-b', 'rate limit exceeded', now);
  assert.equal(defaultSuspension, DEFAULT_MODEL_COOLDOWN_MS / 1_000);
});
