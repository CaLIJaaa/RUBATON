// This bootstrap intentionally runs on an older Node too. Only child processes
// use the supported runtime; the user's shell configuration is never changed.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function supportedVersion(version) {
  const parts = String(version).split('.').map(Number);
  return parts.length >= 3 && parts.every(Number.isInteger)
    && (parts[0] > 22 || (parts[0] === 22 && parts[1] >= 13));
}

function probeNode(executable) {
  const probe = `
    let sqlite = false;
    try { sqlite = typeof require('node:sqlite').DatabaseSync === 'function'; } catch {}
    process.stdout.write(JSON.stringify({
      version: process.versions.node, executable: process.execPath, sqlite,
      register: typeof require('node:module').register === 'function'
    }));
  `;
  const result = spawnSync(executable, ['-e', probe], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}

function selectRuntime(options = {}) {
  const env = options.env || process.env;
  const currentExecutable = options.currentExecutable || process.execPath;
  const probe = options.probe || probeNode;
  const configured = env.RUBA_NODE_BINARY;
  const candidates = configured ? [configured] : options.candidates || [
    currentExecutable, env.npm_node_execpath,
    '/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node', 'node',
  ];
  const observed = [];
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const runtime = probe(candidate);
    if (!runtime) continue;
    observed.push(runtime.version);
    if (supportedVersion(runtime.version) && runtime.sqlite && runtime.register) return runtime;
  }
  const detail = configured
    ? `RUBA_NODE_BINARY=${configured} не указывает на совместимый Node.js.`
    : `Обнаруженные версии: ${[...new Set(observed)].join(', ') || 'не найдены'}.`;
  throw new Error(
    `Для RUBA нужен Node.js 22.13+ с доступным node:sqlite. ${detail}\n`
    + 'Установите совместимый Node.js или задайте RUBA_NODE_BINARY=/полный/путь/к/node.\n'
    + 'Глобальные настройки Node.js проект не изменяет.',
  );
}

function childEnvironment(runtime, env = process.env) {
  // Forge invokes the compiler with /usr/bin/env node; it must see the same runtime.
  return { ...env, PATH: path.dirname(runtime.executable) + path.delimiter + (env.PATH || '') };
}

module.exports = { supportedVersion, probeNode, selectRuntime, childEnvironment };
