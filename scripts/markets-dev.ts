import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Contract, HDNodeWallet, JsonRpcProvider, NonceManager } from 'ethers';
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
const DEMO_MNEMONIC = 'test test test test test test test test test test test junk';
const demoWallet = (index: number) => HDNodeWallet.fromPhrase(DEMO_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);

/** Local demo only: three pause roles, an admission desk key and a monitor key from the public Anvil mnemonic. */
async function configureRiskControls(runtime: Awaited<ReturnType<typeof createLocalMarkets>>, guardians: HDNodeWallet[], desk: HDNodeWallet) {
  for (const wallet of [...guardians, desk]) await runtime.provider.send('anvil_setBalance', [wallet.address, '0x56bc75e2d63100000']);
  const admin = new NonceManager(runtime.local.wallets[0].connect(runtime.provider));
  for (const market of runtime.markets) {
    const vault = new Contract(market.config.vaultAddress, ['function setAdmissionSigner(address)', 'function setPauseGuardians(address[3],uint256)'], admin);
    await (await vault.setAdmissionSigner(desk.address)).wait();
    await (await vault.setPauseGuardians(guardians.map((wallet) => wallet.address), 0)).wait();
  }
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
  const guardians = [5, 6, 7].map(demoWallet), desk = demoWallet(8);
  process.env.ADMISSION_SIGNER_PRIVATE_KEY ??= desk.privateKey;
  process.env.MONITOR_PRIVATE_KEY ??= guardians[0].privateKey;
  process.env.MONITOR_INTERVAL_MS ??= '5000';
  try {
    runtime = await createLocalMarkets(directory, { port, log: (message) => {
      if (stopRequested) throw new Error('LOCAL_MARKETS_STOPPED');
      log(message);
    } });
    if (stopRequested) return;
    await configureRiskControls(runtime, guardians, desk);
    serving = await serveMarkets(runtime.markets, runtime.manifest, runtime.keys, runtime.settings);
    if (stopRequested) return;
    log(`RUBA three-market UI: http://127.0.0.1:${port}/`);
    log(`Isolated local RPC ${runtime.local.rpcUrl}; Chain ID31337. RUBA/USDT, RUBA/WETH, WETH/WBTC are independent Vaults.`);
    log(`Local test wallet ${runtime.local.wallets[4].address}; public Anvil test private key (local-only):`);
    log(runtime.local.wallets[4].privateKey);
    log(`Local admin ${runtime.manifest.roles.admin}; arbitrage disabled until an admin enables it. Ctrl+C removes this temporary chain.`);
    log(`Pause roles (public Anvil keys, local-only): ${guardians.map((wallet) => `${wallet.address} ${wallet.privateKey}`).join(' | ')}`);
    log(`Admission desk ${desk.address}; KYC stub accepts IDs like TEST-0001. Monitor bot uses the first pause role.`);
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
