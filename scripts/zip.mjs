// Packages extension/ into dist/grok-imagine-studio-<version>.zip (for "Load unpacked" from a zip or a store upload).
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const out = join(dist, `grok-imagine-studio-${version}.zip`);
if (existsSync(out)) rmSync(out);
execFileSync('zip', ['-r', '-q', '-X', out, '.', '-x', '*.DS_Store'], { cwd: join(root, 'extension'), stdio: 'inherit' });
console.log('wrote', out);
