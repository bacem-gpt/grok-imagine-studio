// Rebuilds the vendored third-party ES modules used by the extension (no runtime build step needed).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'extension', 'vendor');
mkdirSync(out, { recursive: true });

const entry = `
export { h, render, Component, Fragment, createContext, createRef, cloneElement, toChildArray } from 'preact';
export { useState, useReducer, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useContext, useErrorBoundary, useId, useImperativeHandle } from 'preact/hooks';
import { h } from 'preact';
import htm from 'htm';
export const html = htm.bind(h);
`;
const tmp = join(root, 'node_modules', '.vendor-entry.mjs');
writeFileSync(tmp, entry);
await build({
  entryPoints: [tmp],
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'chrome114',
  outfile: join(out, 'preact-htm.mjs'),
  legalComments: 'inline',
});
copyFileSync(join(root, 'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs'), join(out, 'mediabunny.min.mjs'));
console.log('vendor: wrote preact-htm.mjs and mediabunny.min.mjs to', out);

// @mediabunny/aac-encoder: AAC-LC encoder (FFmpeg compiled to WASM) for browsers without a native WebCodecs AAC
// encoder (e.g. Chrome on Linux). The package inlines its worker as a template literal and starts it from a blob:
// URL, which MV3 extension pages forbid (worker-src 'self'). Extract the worker into its own file, load it by URL,
// point the module at the vendored Mediabunny and drop the Node-only worker_threads fallback (never reached in a
// browser, but bundlers/link checks can't resolve it). The exporter registers it only when native AAC is missing.
const aacPkg = JSON.parse(readFileSync(join(root, 'node_modules/@mediabunny/aac-encoder/package.json'), 'utf8'));
let aac = readFileSync(join(root, 'node_modules/@mediabunny/aac-encoder/dist/bundles/mediabunny-aac-encoder.min.mjs'), 'utf8');
const marker = 'function a(){return n(`';
const at = aac.indexOf(marker);
if (at < 0) throw new Error('vendor: aac-encoder worker marker not found (package layout changed?)');
let end = at + marker.length;
while (end < aac.length && aac[end] !== '`') end += aac[end] === '\\' ? 2 : 1;
if (aac.slice(end, end + 3) !== '`)}') throw new Error('vendor: unexpected aac-encoder bundle shape');
// Evaluate just the template literal (in an empty sandbox: a substitution referencing anything would throw).
const workerSrc = vm.runInNewContext('`' + aac.slice(at + marker.length, end) + '`', Object.create(null), { timeout: 5000 });
const workerHeader =
  `/* Worker extracted from @mediabunny/aac-encoder ${aacPkg.version} (MPL-2.0, https://github.com/Vanilagy/mediabunny/tree/main/packages/aac-encoder).\n` +
  ` * Contains FFmpeg's native AAC encoder (libavcodec) compiled to WebAssembly — LGPL-2.1-or-later, https://ffmpeg.org/. */\n`;
writeFileSync(join(out, 'aac-encoder-worker.js'), workerHeader + workerSrc);
aac = aac.slice(0, at) + 'async function a(){return new Worker(new URL("./aac-encoder-worker.js",import.meta.url))}' + aac.slice(end + 3);
if (!/from"mediabunny"/.test(aac)) throw new Error('vendor: aac-encoder no longer imports "mediabunny"');
aac = aac.replace(/from"mediabunny"/g, 'from"./mediabunny.min.mjs"').replace('import("worker_threads")', 'Promise.reject(new Error("worker_threads is not available"))');
writeFileSync(join(out, 'mediabunny-aac-encoder.mjs'), aac);
console.log(`vendor: wrote mediabunny-aac-encoder.mjs + aac-encoder-worker.js (@mediabunny/aac-encoder ${aacPkg.version})`);
