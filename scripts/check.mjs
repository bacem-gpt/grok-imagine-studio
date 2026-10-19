// Static checks for the unpacked extension (no build step means mistakes only show up at runtime otherwise):
//  1. manifest references existing files
//  2. every JS module parses
//  3. the module graphs (studio, content, background) link: every relative import resolves and every named import exists
//     (esbuild bundles in memory and reports "No matching export" / "Could not resolve")
//  4. extension pages contain no inline or remote scripts (MV3)
import { build } from 'esbuild';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
const problems = [];
const fail = (msg) => problems.push(msg);

// 1. manifest
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background?.service_worker,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
].filter(Boolean);
for (const f of referenced) if (!existsSync(join(ext, f))) fail(`manifest references missing file: ${f}`);
for (const war of manifest.web_accessible_resources || []) {
  for (const pattern of war.resources) {
    const dir = pattern.replace(/\/\*$/, '');
    if (!existsSync(join(ext, dir))) fail(`web_accessible_resources entry has no files: ${pattern}`);
  }
}

// 2. syntax
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(ext);
const jsFiles = files.filter((f) => /\.(m?js)$/.test(f) && !f.includes(`${join('extension', 'vendor')}`));
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail(`syntax error in ${relative(root, f)}:\n${String(e.stderr || e.message).split('\n').slice(0, 6).join('\n')}`);
  }
}

// 3. module graphs
const entries = [
  join(ext, 'studio', 'main.js'),
  join(ext, 'content', 'main.js'),
  join(ext, 'background.js'),
];
for (const entry of entries) {
  if (!existsSync(entry)) {
    fail(`missing entry ${relative(root, entry)}`);
    continue;
  }
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'chrome116',
      logLevel: 'silent',
      external: ['chrome'],
    });
  } catch (e) {
    for (const err of e.errors || [{ text: String(e) }]) {
      const loc = err.location ? `${err.location.file}:${err.location.line}: ` : '';
      fail(`link error (${relative(root, entry)}): ${loc}${err.text}`);
    }
  }
}

// 4. extension pages
for (const f of files.filter((p) => p.endsWith('.html'))) {
  const html = readFileSync(f, 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [, attrs, body] of scripts) {
    if (!/\bsrc=/.test(attrs) && body.trim()) fail(`inline script in ${relative(root, f)} (blocked by MV3 CSP)`);
    const src = /src="([^"]+)"/.exec(attrs)?.[1];
    if (src && /^(https?:)?\/\//.test(src)) fail(`remote script in ${relative(root, f)}: ${src}`);
  }
}

if (problems.length) {
  console.error(`✖ ${problems.length} problem(s):\n` + problems.map((p) => ` - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✔ extension checks passed (${jsFiles.length} modules, ${entries.length} graphs linked)`);
