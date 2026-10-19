import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitRect, buildFilter, textAnimationState, easeInOut } from '../../extension/studio/engine/effects.js';
import { TRANSITIONS } from '../../extension/studio/core/model.js';
import { TRANSITION_RENDERERS } from '../../extension/studio/engine/transitions.js';

test('fitRect cover/contain/fill', () => {
  assert.deepEqual(fitRect(1920, 1080, 1280, 720, 'cover'), { x: 0, y: 0, w: 1280, h: 720 });
  const v = fitRect(720, 1280, 1280, 720, 'contain'); // vertical into horizontal: pillarbox
  assert.equal(v.h, 720);
  assert.ok(Math.abs(v.w - 405) < 1 && Math.abs(v.x - 437.5) < 1);
  const c = fitRect(720, 1280, 1280, 720, 'cover'); // vertical cover: overflow top/bottom
  assert.equal(c.w, 1280);
  assert.ok(c.y < 0 && c.h > 720);
  assert.deepEqual(fitRect(10, 10, 100, 50, 'fill'), { x: 0, y: 0, w: 100, h: 50 });
});

test('buildFilter emits only non-neutral functions and scales blur', () => {
  assert.equal(buildFilter(null, 720), 'none');
  assert.equal(buildFilter({ brightness: 1.2, grayscale: 1 }, 720), 'brightness(1.2) grayscale(1)');
  assert.equal(buildFilter({ blur: 2 }, 1440), 'blur(4.00px)');
  assert.equal(buildFilter({}, 720, 3), 'blur(3.00px)');
});

test('text animations', () => {
  assert.equal(textAnimationState('fade', 0, 3, 5).alpha, 0);
  assert.equal(textAnimationState('fade', 1.5, 3, 5).alpha, 1);
  assert.ok(textAnimationState('slide-up', 0.05, 3, 5).dy > 0);
  const tw = textAnimationState('typewriter', 0.1, 4, 20);
  assert.ok(tw.chars > 0 && tw.chars < 20);
  assert.equal(textAnimationState('typewriter', 3, 4, 20).chars, 20);
  assert.equal(textAnimationState('none', 0, 1, 3).alpha, 1);
});

test('every catalogued transition has a renderer, easing is monotonic', () => {
  for (const t of TRANSITIONS) assert.ok(TRANSITION_RENDERERS[t.id], `missing renderer for ${t.id}`);
  let prev = -1;
  for (let i = 0; i <= 20; i++) {
    const v = easeInOut(i / 20);
    assert.ok(v >= prev);
    prev = v;
  }
});
