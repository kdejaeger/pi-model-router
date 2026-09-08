import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDuration } from '../extensions/ui.ts';

test('formatDuration renders suspension lengths readably', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59), '59s');
  assert.equal(formatDuration(60), '1min');
  assert.equal(formatDuration(3599), '59min');
  assert.equal(formatDuration(3600), '1hr');
  assert.equal(formatDuration(5400), '1hr 30min');
  assert.equal(formatDuration(86399), '23hr 59min');
  assert.equal(formatDuration(86400), '1d');
  assert.equal(formatDuration(90000), '1d 1hr');
});
