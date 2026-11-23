import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JsonRpcProvider } from 'ethers';
import { startLocalChain } from './local-deploy.ts';
import { loadPrivateMarketKeys } from './sepolia-config.ts';
import type { SepoliaSettings, RoleKey } from './sepolia-config.ts';
import { prepareDeployment, deployPreparedMarkets } from './sepolia-deploy.ts';
import { serveMarkets, closeMarketRuntimes } from './sepolia-runtime.ts';

/** Reusable actual-EVM factory, shared by the three-market UI and integration tests. */
export async function createLocalMarkets(directory: string, options: { port?: number; log?: (message: string) => void } = {}) {
  const local = await startLocalChain();
  const settings: SepoliaSettings = { directory, rpcUrl: local.rpcUrl, port: options.port ?? 3001, confirmations: 0, artifactsDir: resolve('zk/artifacts'), testWallet: local.wallets[4].address };
  const role = (index: number): RoleKey => ({ address: local.wallets[index].address, privateKey: local.wallets[index].privateKey });
  const keys = loadPrivateMarketKeys(directory, 31337n, true, { lp: role(2), bot: role(3), prover: role(1) });
  const provider = new JsonRpcProvider(local.rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 }); provider.pollingInterval = 50;
  try {
    // Exercise the same initially unfunded economic roles as a fresh Sepolia
    // deployment; only the dedicated deployer starts with Anvil test ETH.
    for (const role of Object.values(keys.roles)) await provider.send('anvil_setBalance', [role.address, '0x0']);
    const env = await prepareDeployment(settings, provider, role(0), keys, 31337n);
    const markets = await deployPreparedMarkets(env, options.log ?? (() => {}));
    // A proof-only prover has no reason to send Ethereum transactions.
    await provider.send('anvil_setBalance', [keys.roles.prover.address, '0x0']);
    let closed = false;
    return { local, provider, settings, keys, manifest: env.manifest, env, markets,
      async close() { if (closed) return; closed = true; await closeMarketRuntimes(markets); provider.destroy(); await local.close(); } };
  } catch (error) { provider.destroy(); await local.close(); throw error; }
}
export async function runMarketsDevelopment(log: (message: string) => void = console.log) {
  const port = Number(process.env.PORT ?? '3001');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const directory = await mkdtemp(join(tmpdir(), 'ruba-markets-'));
  let runtime: Awaited<ReturnType<typeof createLocalMarkets>> | undefined;
  let serving: Awaited<ReturnType<typeof serveMarkets>> | undefined;
  let stopRequested = false, resolveStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const stop = () => { stopRequested = true; resolveStop?.(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    runtime = await createLocalMarkets(directory, { port, log: (message) => {
      if (stopRequested) throw new Error('LOCAL_MARKETS_STOPPED');
      log(message);
    } });
    if (stopRequested) return;
    serving = await serveMarkets(runtime.markets, runtime.manifest, runtime.keys, runtime.settings);
    if (stopRequested) return;
    log(`RUBA three-market UI: http://127.0.0.1:${port}/`);
    log(`Isolated local RPC ${runtime.local.rpcUrl}; Chain ID31337. RUBA/USDT, RUBA/WETH, WETH/WBTC are independent Vaults.`);
    log(`Local test wallet ${runtime.local.wallets[4].address}; public Anvil test private key (local-only):`);
    log(runtime.local.wallets[4].privateKey);
    log(`Local admin ${runtime.manifest.roles.admin}; arbitrage disabled until an admin enables it. Ctrl+C removes this temporary chain.`);
    await stopped;
  } catch (error) {
    if (!(error instanceof Error && error.message === 'LOCAL_MARKETS_STOPPED')) throw error;
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    if (serving) { await serving.close(); runtime!.markets.length = 0; }
    await runtime?.close(); await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMarketsDevelopment().catch(() => { console.error('Local multi-market demo failed; check the pinned artifacts and local Anvil availability.'); process.exitCode = 1; });
