const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { selectRuntime, childEnvironment } = require('./runtime.cjs');

const projectRoot = path.resolve(__dirname, '..');
const loader = pathToFileURL(path.join(__dirname, 'register-typescript.mjs')).href;

function main() {
  const mode = process.argv[2];
  const extra = process.argv.slice(3);
  const modes = ['doctor', 'typecheck', 'test:runtime', 'test:server', 'test:scripts', 'test:ui', 'test:contracts', 'build:contracts', 'test:integration', 'test:tenderly', 'dev', 'demo', 'start', 'tenderly', 'tenderly:direct', 'tenderly:setup', 'tenderly:fund', 'zk:build', 'test:zk', 'zk:dev', 'zk:demo', 'test:zk:integration', 'dev:legacy', 'sepolia:prepare', 'sepolia:deploy', 'sepolia:budget', 'sepolia:start', 'markets:dev', 'test:markets:integration'];
  if (!modes.includes(mode)) throw new Error('Неизвестная команда RUBA. Используйте npm run dev или npm test.');
  const runtime = selectRuntime();
  const env = childEnvironment(runtime);
  if (mode === 'doctor' || runtime.executable !== process.execPath) {
    console.log(`RUBA: Node.js ${runtime.version} (${runtime.executable}); SQLite доступен.`);
  }
  if (mode === 'doctor') return;

  function execute(executable, args, overrides = {}) {
    const child = spawnSync(executable, args, { cwd: projectRoot, env, stdio: 'inherit', ...overrides });
    if (child.error) throw new Error(`Не удалось запустить ${path.basename(executable)}: ${child.error.message}`);
    if (child.status !== 0) {
      process.exitCode = child.status === null ? 130 : child.status;
      return false;
    }
    return true;
  }
  const runNode = (args, overrides) => execute(runtime.executable, args, overrides);
  if (mode === 'zk:build') return runNode(['--import', loader, 'scripts/zk-build.mjs', ...extra]);
  if (['sepolia:prepare', 'sepolia:deploy', 'sepolia:budget', 'sepolia:start', 'markets:dev', 'test:markets:integration'].includes(mode)) {
    if (!['sepolia:start', 'sepolia:budget'].includes(mode) && !execute('forge', ['build'])) return;
    if (mode === 'test:markets:integration') return runNode(['--import', loader, '--test', ...extra, 'server/tests/markets.integration.test.ts'], { env: { ...env, RUBA_MARKETS_INTEGRATION: '1' } });
    const entry = { 'sepolia:prepare': 'scripts/sepolia-prepare.ts', 'sepolia:deploy': 'scripts/sepolia-deploy.ts', 'sepolia:budget': 'scripts/sepolia-budget.ts', 'sepolia:start': 'scripts/sepolia-start.ts', 'markets:dev': 'scripts/markets-dev.ts' }[mode];
    const envFile = mode.startsWith('sepolia:') ? ['--env-file-if-exists=.env.sepolia'] : [];
    return runNode([...envFile, '--import', loader, entry, ...extra]);
  }
  const testFiles = (directory, suffix) => readdirSync(path.join(projectRoot, directory))
    .filter((name) => name.endsWith(suffix)).sort().map((name) => path.join(directory, name));
  if (mode === 'test:zk') return runNode(['--import', loader, '--test', ...extra, ...testFiles('zk/tests', '.test.ts'), ...testFiles('zk/tests', '.test.js')]);
  if (['zk:dev', 'zk:demo', 'test:zk:integration'].includes(mode)) {
    if (!execute('forge', ['build'])) return;
    if (mode === 'test:zk:integration') return runNode(['--import', loader, '--test', ...extra, 'server/tests/zk-integration.test.ts'], { env: { ...env, RUBA_ZK_INTEGRATION: '1' } });
    return runNode(['--import', loader, mode === 'zk:dev' ? 'scripts/zk-dev.ts' : 'scripts/zk-demo.ts', ...extra]);
  }

  if (mode === 'typecheck') return runNode(['node_modules/typescript/bin/tsc', '--noEmit', ...extra]);
  if (mode === 'test:runtime') return runNode(['--test', ...extra, 'tools/runtime.test.cjs']);
  if (mode === 'test:server') return runNode(['--import', loader, '--test', ...extra, ...testFiles('server/tests', '.test.ts')]);
  if (mode === 'test:scripts') return runNode(['--import', loader, '--test', ...extra, ...testFiles('scripts/tests', '.test.ts')]);
  if (mode === 'test:ui') {
    if (!runNode(['--check', 'ui/app.js'])) return;
    return runNode(['--import', loader, '--test', ...extra, ...testFiles('ui/tests', '.test.js')]);
  }
  if (mode === 'test:contracts') return execute('forge', ['test', ...extra]);
  if (mode === 'build:contracts') return execute('forge', ['build', ...extra]);
  if (['dev', 'demo', 'test:integration', 'test:tenderly', 'tenderly', 'tenderly:direct', 'tenderly:setup'].includes(mode) && !execute('forge', ['build'])) return;
  if (mode === 'test:tenderly') {
    return runNode(['--env-file-if-exists=.env.tenderly', '--import', loader, 'scripts/tenderly-smoke.mjs', ...extra]);
  }
  if (mode === 'test:integration') {
    return runNode(['--import', loader, '--test', ...extra, 'server/tests/integration.test.ts', 'server/tests/tenderly-atomic.integration.test.ts'], { env: { ...env, RUBA_INTEGRATION: '1' } });
  }
  if (mode === 'tenderly') return runNode(['--import', loader, 'scripts/tenderly-ui.ts', ...extra]);
  if (mode.startsWith('tenderly:')) {
    const action = { 'tenderly:direct': 'serve', 'tenderly:setup': 'setup', 'tenderly:fund': 'fund' }[mode];
    return runNode(['--env-file-if-exists=.env.tenderly', '--import', loader, 'scripts/tenderly.ts', action, ...extra]);
  }
  const entrypoint = { dev: 'scripts/markets-dev.ts', 'dev:legacy': 'scripts/dev.ts', demo: 'scripts/demo.ts', start: 'server/main.ts' }[mode];
  const envFile = mode === 'start' ? ['--env-file=.env'] : [];
  return runNode([...envFile, '--import', loader, entrypoint, ...extra]);
}

try { main(); }
catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
