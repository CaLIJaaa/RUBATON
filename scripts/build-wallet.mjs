import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const outfile = join(root, 'ui/vendor/wallet-onboard.js');
await mkdir(dirname(outfile), { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ['ui/wallet-onboard-entry.js'],
  outfile,
  bundle: true,
  splitting: false,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
  logLevel: 'warning',
});
const outputs = Object.values(result.metafile.outputs);
if (outputs.length !== 1 || outputs.some((output) => output.imports.length)) {
  throw new Error('Wallet SDK must be one self-contained local ESM bundle, without external imports or chunks.');
}
console.log(`Wallet SDK built: ui/vendor/wallet-onboard.js (${outputs[0].bytes} bytes).`);
