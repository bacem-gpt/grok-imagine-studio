// Pure pixel adjustments for the Ingredients image editor (no DOM; works on any RGBA Uint8ClampedArray such as
// ImageData.data). The live preview and the saved image run the same code, so what you see is what you save.
// Unit-tested in tests/unit/ingredients.test.mjs.

/**
 * Slider values. Brightness, contrast and saturation are percentages of the original (100 = untouched) with the
 * same ranges and maths as the Edit tab's clip looks (CSS brightness() / contrast() / saturate()), so "120%"
 * means the same thing on an ingredient and on a clip. Warmth -100..100 (0 = untouched), sharpen 0..100%.
 */
export const ADJUST_DEFAULTS = Object.freeze({ brightness: 100, contrast: 100, saturation: 100, warmth: 0, sharpen: 0 });

const pct = (v) => `${Math.round(v)}%`;
const signed = (v) => (Math.round(v) > 0 ? `+${Math.round(v)}` : String(Math.round(v) || 0));

/** Sliders of the Adjust section; `format` gives the readout. */
export const ADJUST_FIELDS = [
  { key: 'brightness', label: 'Brightness', min: 0, max: 200, format: pct },
  { key: 'contrast', label: 'Contrast', min: 0, max: 200, format: pct },
  { key: 'saturation', label: 'Saturation', min: 0, max: 300, format: pct },
  { key: 'warmth', label: 'Warmth', min: -100, max: 100, format: signed },
  { key: 'sharpen', label: 'Sharpen', min: 0, max: 100, format: pct },
];

/** One-click looks (merged over ADJUST_DEFAULTS). */
export const ADJUST_LOOKS = [
  { id: 'none', label: 'Original', adjust: {} },
  { id: 'punch', label: 'Punchy', adjust: { contrast: 135, saturation: 125, sharpen: 25 } },
  { id: 'bright', label: 'Bright', adjust: { brightness: 115, contrast: 110 } },
  { id: 'warm', label: 'Warm', adjust: { warmth: 40, saturation: 110 } },
  { id: 'cool', label: 'Cool', adjust: { warmth: -40 } },
  { id: 'soft', label: 'Soft', adjust: { contrast: 80, brightness: 105, saturation: 90 } },
  { id: 'mono', label: 'Mono', adjust: { saturation: 0, contrast: 120 } },
  { id: 'crisp', label: 'Crisp', adjust: { sharpen: 60, contrast: 115 } },
];

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** One adjustment's value; missing or invalid = its neutral value. */
export function adjustValue(adj, key) {
  const v = adj?.[key];
  return v == null || v === '' || !Number.isFinite(Number(v)) ? ADJUST_DEFAULTS[key] : Number(v);
}

/** True when two adjustment sets look the same (missing keys are neutral). */
export function adjustEqual(a, b) {
  return Object.keys(ADJUST_DEFAULTS).every((k) => adjustValue(a, k) === adjustValue(b, k));
}

/** True when every adjustment is at its neutral value. */
export function adjustIsNeutral(adj) {
  return adjustEqual(adj, ADJUST_DEFAULTS);
}

/**
 * Per-channel lookup table for brightness then contrast, both in % (100 = untouched; index = input 0..255).
 * Same formulas as CSS brightness() (multiply) followed by contrast() (around mid grey), each clamped.
 */
export function toneCurve(brightness = 100, contrast = 100) {
  const bf = clamp(brightness / 100, 0, 2);
  const cf = clamp(contrast / 100, 0, 2);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(clamp255((clamp255(v * bf) - 127.5) * cf + 127.5));
  return lut;
}

/**
 * Applies brightness, contrast, saturation, warmth and sharpen in place to RGBA pixels (alpha untouched).
 * Returns `data` for chaining.
 */
export function adjustPixels(data, width, height, adj) {
  if (adjustIsNeutral(adj)) return data;
  const lut = toneCurve(adjustValue(adj, 'brightness'), adjustValue(adj, 'contrast'));
  const sat = clamp(adjustValue(adj, 'saturation') / 100, 0, 3); // like CSS saturate()
  const warm = clamp(adjustValue(adj, 'warmth') / 100, -1, 1);
  const wr = 22 * warm;
  const wg = 5 * warm;
  const wb = -22 * warm;
  const doSat = sat !== 1;
  const doWarm = warm !== 0;
  const n = width * height * 4;
  for (let i = 0; i < n; i += 4) {
    let r = lut[data[i]];
    let g = lut[data[i + 1]];
    let b = lut[data[i + 2]];
    if (doSat) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * sat;
      g = l + (g - l) * sat;
      b = l + (b - l) * sat;
    }
    if (doWarm) {
      r += wr;
      g += wg;
      b += wb;
    }
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  const sharpen = adjustValue(adj, 'sharpen');
  if (sharpen > 0) sharpenPixels(data, width, height, sharpen / 100);
  return data;
}

/**
 * 3x3 unsharp kernel (centre 1 + 4a, neighbours -a) on RGB, in place. amount 0..1. Edge pixels reuse their
 * nearest neighbour, so a flat image is unchanged.
 */
export function sharpenPixels(data, width, height, amount) {
  const a = Math.max(0, Math.min(1, amount)) * 1.2;
  if (!a || width < 2 || height < 2) return data;
  const src = new Uint8ClampedArray(data); // copy: the kernel must read unmodified neighbours
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const up = y > 0 ? -row : 0;
    const down = y < height - 1 ? row : 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const left = x > 0 ? -4 : 0;
      const right = x < width - 1 ? 4 : 0;
      for (let ch = 0; ch < 3; ch++) {
        const k = i + ch;
        const c = src[k];
        const lap = 4 * c - src[k + up] - src[k + down] - src[k + left] - src[k + right];
        data[k] = c + a * lap;
      }
    }
  }
  return data;
}
