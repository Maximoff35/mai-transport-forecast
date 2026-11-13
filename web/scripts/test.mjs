import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const testDir = path.join(root, 'tests');
const outDir = path.join(root, '.test-build');
await fs.mkdir(outDir, { recursive: true });
const files = (await fs.readdir(testDir)).filter(name => /\.test\.ts$/.test(name)).sort();
if (!files.length) throw new Error('No tests found');
const outputs = [];
for (const file of files) {
  const outfile = path.join(outDir, file.replace(/\.ts$/, '.mjs'));
  await build({ entryPoints: [path.join(testDir, file)], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: 'inline', tsconfig: path.join(root, 'tsconfig.json') });
  outputs.push(outfile);
}
const result = spawnSync(process.execPath, ['--test', ...outputs], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
