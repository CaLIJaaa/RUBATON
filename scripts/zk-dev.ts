import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { createZkLocalRuntime, seedZkLocalMarket } from './zk-local-deploy.ts';

export async function runZkDevelopment(log: (message: string) => void = console.log): Promise<void> {
  const rawPort = process.env.PORT ?? '3001';
  if (!/^[0-9]+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('PORT должен быть целым числом от 1 до 65535.');
  const directory = await mkdtemp(join(tmpdir(), 'ruba-zk-ui-'));
  let runtime: Awaited<ReturnType<typeof createZkLocalRuntime>> | undefined;
  let server: Server | undefined, stopWorker: (() => void) | undefined;
  let resolveStop: (() => void) | undefined, stopRequested = false;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const stop = () => { stopRequested = true; resolveStop?.(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    log('Разворачиваю локальный ZK Vault и настоящие Groth16/Poseidon контракты…');
    runtime = await createZkLocalRuntime(directory, Number(rawPort));
    if (stopRequested) return;
    await seedZkLocalMarket(runtime.local, runtime.fixture, runtime.engine, runtime.chain, runtime.api, log);
    if (stopRequested) return;
    server = runtime.api.createHttpServer();
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(Number(rawPort), '127.0.0.1', () => { server!.off('error', reject); resolve(); });
    });
    stopWorker = runtime.api.startWorker();
    const { fixture, local } = runtime;
    log(`RUBA ZK UI: http://127.0.0.1:${rawPort}/`);
    log(`Это новая временная сеть. RPC ${local.rpcUrl}; Chain ID 31337; валюта ETH.`);
    log(`RUBA: ${fixture.ruba.target}; USDT: ${fixture.usdt.target}; ZK Vault: ${fixture.vault.target}`);
    log(`Тестовый кошелёк: ${fixture.trader.address}`);
    log('Общедоступный тестовый ключ Anvil для импорта; только для этой локальной сети:');
    log(fixture.trader.privateKey);
    log('На кошельке 10 000 RUBA, 10 000 USDT и тестовый ETH. ZK-регистрация уже подтверждена; ключ восстановления браузер получит из вашей подписи.');
    log('Ликвидность 1 000 RUBA / 1 000 USDT подтверждена настоящим Groth16-доказательством. Газ публикаций платит пользователь; подпись оператора не требуется, оператор имеет 0 ETH.');
    log('Первые три свопа ждут четвёртый; готовый пакет публикуется отдельной транзакцией кошелька. Ctrl+C удалит временную сеть и журнал.');
    await stopped;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    stopWorker?.();
    if (server?.listening) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeIdleConnections(); });
    await runtime?.api.drain();
    await runtime?.chain.prover.close();
    runtime?.chain.provider.destroy(); runtime?.engine.close();
    await runtime?.local.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runZkDevelopment().catch((error: Error) => {
    console.error(`Локальный ZK RUBA не запущен: ${error.message}`);
    process.exitCode = 1;
  });
}
