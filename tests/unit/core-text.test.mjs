// Text overlays (engine/effects.js): line wrapping for every script, typewriter by grapheme, right-to-left lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, wrapLines, textDirection, drawTextItem, textAnimationState } from '../../extension/studio/engine/effects.js';

// Measures 10 px per wide (CJK / fullwidth) character and 5.5 px per other code point.
const measure = (s) => [...s].reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? 10 : 5.5), 0);
function fakeCtx() {
  const calls = [];
  const ctx = {
    font: '10px test',
    canvas: { width: 1280, height: 720 },
    calls,
    measureText: (s) => ({ width: measure(s) }),
    save() {},
    restore() {},
    translate() {},
    scale() {},
    beginPath() {},
    roundRect() {},
    rect() {},
    fill() {},
    strokeText() {},
    fillText(text, x, y) {
      calls.push({ text, direction: ctx.direction, align: ctx.textAlign });
    },
  };
  return ctx;
}

test('wrapText: CJK breaks between words and keeps every line inside the width', () => {
  const ctx = fakeCtx();
  const text = '東京の夜景とネオンの街を歩く女性のシネマティックな映像、雨上がりの路面に反射する光';
  const lines = wrapLines(ctx, text, 115);
  assert.ok(lines.length >= 3, lines.join('|'));
  assert.equal(lines.join(''), text, 'nothing lost or added');
  for (const l of lines) assert.ok(measure(l) <= 115 + 10, `${l} (${measure(l)})`); // + one kept punctuation mark
  assert.ok(!lines.some((l) => /^[、。]/.test(l)), 'no line starts with closing punctuation');
});

test('wrapText: words and long URLs never run past the width', () => {
  const ctx = fakeCtx();
  const words = wrapLines(ctx, 'A long title that should wrap nicely across lines', 100);
  assert.deepEqual(words, ['A long title that', 'should wrap nicely', 'across lines']);
  const url = 'see https://example.com/a/very/long/path/that/never/ends/with/a/space for details';
  const lines = wrapLines(ctx, url, 90);
  for (const l of lines) assert.ok(measure(l) <= 90, l);
  assert.equal(lines.join('').replace(/\s/g, ''), url.replace(/\s/g, ''));
  const giant = wrapLines(ctx, 'Supercalifragilisticexpialidocious', 60);
  assert.ok(giant.length > 1 && giant.every((l) => measure(l) <= 60), giant.join('|'));
  assert.deepEqual(wrapLines(ctx, 'He said (hello) and left.', 55), ['He said', '(hello)', 'and left.'], 'an opening bracket moves to the next line');
  assert.deepEqual(wrapLines(ctx, 'line one\nline two', 500), ['line one', 'line two']);
});

test('textDirection: the first strong letter decides', () => {
  assert.equal(textDirection('رجل يمشي في المطر.'), 'rtl');
  assert.equal(textDirection('  123 שלום!'), 'rtl');
  assert.equal(textDirection('iPhone של'), 'ltr');
  assert.equal(textDirection('123 456'), 'ltr');
  assert.deepEqual(
    wrapText(fakeCtx(), 'Hello\nשלום עולם', 500).map((l) => l.dir),
    ['ltr', 'rtl'],
  );
});

const textItem = (text, animation = 'none', extra = {}) => ({
  clip: { text, animation, style: { size: 0.05, maxWidth: 0.9, x: 0.5, y: 0.5, align: 'center', shadow: false, ...extra } },
  start: 0,
  duration: 4,
});

test('drawTextItem: right-to-left paragraphs are drawn right-to-left, alignment stays physical', () => {
  const ctx = fakeCtx();
  drawTextItem(ctx, textItem('Title\nرجل يمشي في المطر.'), 1, 1280, 720);
  assert.deepEqual(ctx.calls.map((c) => [c.text, c.direction, c.align]), [
    ['Title', 'ltr', 'center'],
    ['رجل يمشي في المطر.', 'rtl', 'center'],
  ]);
  const left = fakeCtx();
  drawTextItem(left, textItem('שלום', 'none', { align: 'left' }), 1, 1280, 720);
  assert.deepEqual([left.calls[0].direction, left.calls[0].align], ['rtl', 'left']);
});

test('drawTextItem: the typewriter reveals whole graphemes (never half an emoji)', () => {
  const text = '🎬🚀 Launch 👨‍👩‍👧 family';
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const seen = new Set();
  for (let t = 0; t <= 4; t += 0.01) {
    const ctx = fakeCtx();
    drawTextItem(ctx, textItem(text, 'typewriter'), t, 1280, 720);
    for (const c of ctx.calls) {
      assert.ok(!lone.test(c.text), `lone surrogate at t=${t.toFixed(2)}: ${JSON.stringify(c.text)}`);
      assert.ok(!/‍$/.test(c.text), `ZWJ sequence cut at t=${t.toFixed(2)}`);
      seen.add(c.text);
    }
  }
  assert.ok(seen.has('🎬'), 'the first emoji appears on its own');
  assert.ok(seen.has('🎬🚀 Launch 👨‍👩‍👧'), 'the family emoji appears whole');
  assert.ok(seen.has(text));
  assert.equal(textAnimationState('typewriter', 10, 4, 3).chars, 3);
});
