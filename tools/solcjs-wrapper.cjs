#!/usr/bin/env node
// Forge-compatible standard-JSON entrypoint for the pinned npm solc package.
// Unlike solcjs's CLI, this waits for stdout to flush and emits JSON only.
const solc = require('solc');

if (process.argv.includes('--version')) {
  process.stdout.write(`solc, the solidity compiler commandline interface\nVersion: ${solc.version()}\n`);
} else if (process.argv.includes('--standard-json')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const output = solc.compile(input);
      process.stdout.write(output, error => { if (error) process.exitCode = 1; });
    } catch (error) {
      process.stderr.write(`${error.stack || error}\n`);
      process.exitCode = 1;
    }
  });
} else {
  process.stderr.write('Supported compiler modes: --version, --standard-json\n');
  process.exitCode = 1;
}
