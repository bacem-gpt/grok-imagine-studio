// Storage cleanup decisions (core/db.js planGarbage): what gets deleted, and when.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGarbage } from '../../extension/studio/core/db.js';

test('planGarbage: referenced keys stay; unreferenced ones go right away without a grace period', () => {
  const plan = planGarbage({ keys: ['a', 'b', 'c', 'c'], keep: ['a'], now: 1000 });
  assert.deepEqual(plan.remove.sort(), ['b', 'c']);
  assert.deepEqual(plan.record, {});
});

test('planGarbage: with a grace period a file is deleted only after staying unreferenced that long', () => {
  const grace = 15 * 60 * 1000;
  // first sweep: everything unreferenced is only remembered
  let plan = planGarbage({ keys: ['old', 'new', 'used'], keep: new Set(['used']), record: {}, now: 0, graceMs: grace });
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.record, { old: 0, new: 0 });
  // later: 'new' got referenced again (undo in another window), 'old' still unreferenced but too recent
  plan = planGarbage({ keys: ['old', 'new', 'used'], keep: ['used', 'new'], record: plan.record, now: grace - 1, graceMs: grace });
  assert.deepEqual(plan.remove, []);
  assert.deepEqual(plan.record, { old: 0 }, 'referenced again: forgotten');
  // once the grace period has passed it goes
  plan = planGarbage({ keys: ['old', 'used'], keep: ['used'], record: plan.record, now: grace, graceMs: grace });
  assert.deepEqual(plan.remove, ['old']);
  assert.deepEqual(plan.record, {});
  // entries of files that no longer exist are dropped from the record
  plan = planGarbage({ keys: ['x'], keep: [], record: { gone: 5 }, now: 10, graceMs: grace });
  assert.deepEqual(plan.record, { x: 10 });
});
