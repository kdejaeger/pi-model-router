import assert from 'node:assert/strict';
import test from 'node:test';
import { createPendingCompaction } from '../extensions/compaction.ts';

test('pending context compaction waits for completion and is consumed once', async () => {
  const controller = createPendingCompaction();
  let complete: (() => void) | undefined;
  let compactCalls = 0;
  const activeContext = {
    isIdle: () => false,
    compact: (options: { onComplete?: () => void; onError?: (error: Error) => void }) => {
      compactCalls++;
      complete = options.onComplete;
    },
  };

  assert.equal(controller.request(activeContext), true);
  const flush = controller.run(activeContext);
  assert.equal(compactCalls, 1);
  assert.equal(complete !== undefined, true);
  complete!();
  assert.equal(await flush, true);
  assert.equal(await controller.run(activeContext), false);
  assert.equal(compactCalls, 1);
});

test('idle contexts do not schedule compaction', async () => {
  const controller = createPendingCompaction();
  const idleContext = {
    isIdle: () => true,
    compact: () => {
      throw new Error('should not compact an idle routing request');
    },
  };

  assert.equal(controller.request(idleContext), false);
  assert.equal(await controller.run(idleContext), false);
});
