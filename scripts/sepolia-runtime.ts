import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { Contract, JsonRpcProvider, NonceManager, Wallet, Interface } from 'ethers';
import type { ServerConfig } from '../server/config.ts';
import type { Operation, ZkOperation, ActionRequest } from '../server/api.ts';
import { RubaApi } from '../server/api.ts';
import { ZkRubaEngine } from '../server/zk/engine.ts';
import { ZkVaultChain, ZK_VAULT_ABI } from '../server/zk/chain.ts';
import type { MarketRuntime } from '../server/market-types.ts';
import { ASSETS, POOLS, readJson, writePrivateJson, atomic } from './sepolia-config.ts';
import type { DeploymentManifest, PrivateMarketKeys, SepoliaSettings, RoleKey } from './sepolia-config.ts';
import { DeploymentTransactions, SerialTransactionQueue } from './sepolia-transactions.ts';
import { deriveOwnerRecoveryKey, signedZkLocalRequest, zkPublicationArguments } from './zk-local-deploy.ts';

export async function createMarketRuntimes(manifest: DeploymentManifest, keys: PrivateMarketKeys, settings: SepoliaSettings): Promise<MarketRuntime[]> {
  const markets: MarketRuntime[] = [];
  const probe = new JsonRpcProvider(settings.rpcUrl, undefined, { cacheTimeout: -1 });
  try {
    if ((await probe.getNetwork()).chainId.toString() !== manifest.network.chainId) throw new Error('Market runtime RPC chain differs from manifest');
    const identity = manifest.network.identityCheckpoint;
    if (identity && (await probe.getBlock(identity.blockNumber))?.hash !== identity.blockHash) throw new Error('Market runtime network identity checkpoint changed or is unavailable');
    if (!identity && manifest.network.genesisHash && (await probe.getBlock(0))?.hash !== manifest.network.genesisHash) throw new Error('Market runtime genesis differs from deployment');
    for (const definition of POOLS) {
      const pool = manifest.pools[definition.id];
      if (pool.deploymentBlock === undefined) throw new Error('Market Vault deployment is incomplete');
      const path = keys.databasePaths[definition.id];
      for (let attempt = 0; ; attempt++) {
        const head = await probe.getBlock('latest');
        if (head && head.number - manifest.network.confirmations >= pool.deploymentBlock) break;
        if (attempt >= 180) throw new Error('Vault deployment is still awaiting the configured confirmation depth');
        await delay(1000);
      }
      const acceptedVersion = BigInt(await new Contract(pool.vault, ZK_VAULT_ABI, probe).stateVersion());
      if (!existsSync(path) && acceptedVersion !== 0n) throw new Error(`Missing live database for ${definition.id}; restore it instead of creating a new genesis`);
      mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
      const [base, quote] = definition.assets.map((symbol) => manifest.tokens[symbol]);
      const config: ServerConfig = {
        rpcUrl: settings.rpcUrl, chainId: BigInt(manifest.network.chainId), ...(manifest.network.chainId === '11155111' ? { chainMode: 'sepolia' as const } : {}),
        marketId: definition.id, marketLabel: pool.label,
        tokenMetadata: { RUBA: { symbol: base.symbol, decimals: base.decimals }, USDT: { symbol: quote.symbol, decimals: quote.decimals } },
        vaultAddress: pool.vault, rubaAddress: base.address, usdtAddress: quote.address,
        operatorPrivateKey: keys.roles.prover.privateKey, deploymentBlock: pool.deploymentBlock,
        confirmations: manifest.network.confirmations, withdrawalTtl: 900n, dbPath: path,
        host: '127.0.0.1', port: settings.port, syncIntervalMs: manifest.network.chainId === '31337' ? 1000 : 8000,
        proofMode: 'zk', zkArtifactsDir: settings.artifactsDir, zkPoolRecoveryKey: BigInt(keys.poolKeys[definition.id]),
      };
      const engine = new ZkRubaEngine(config, config.zkPoolRecoveryKey);
      chmodSync(path, 0o600);
      const chain = new ZkVaultChain(config, engine);
      try { await chain.initialize(); } catch (error) { await chain.prover.close(); chain.provider.destroy(); engine.close(); throw error; }
      markets.push({ id: definition.id, label: pool.label, config, engine, chain, api: new RubaApi(engine, chain, config) });
    }
    return markets;
  } catch (error) { await closeMarketRuntimes(markets); throw error; }
  finally { probe.destroy(); }
}
export async function closeMarketRuntimes(markets: MarketRuntime[]) {
  for (const market of markets) { await market.api.drain(); await market.chain.prover.close(); market.chain.provider.destroy(); market.engine.close(); }
}

/** Owner authorization + witness mutation + replay marker form one durable economic transaction. */
async function bootstrapAction(market: MarketRuntime, signer: Wallet, operation: Operation | ZkOperation, step: string, directory: string) {
  const marker = `bootstrap:${step}`;
  if (market.engine.getMetadata(marker)) return;
  const path = join(directory, 'actions.json');
  const actions = existsSync(path) ? readJson<Record<string, ActionRequest>>(path) : {};
  let request = actions[step];
  if (!request) { request = await signedZkLocalRequest(market.engine, market.chain, signer, operation); actions[step] = request; writePrivateJson(path, actions); }
  if (JSON.stringify(request.operation) !== JSON.stringify(operation)) throw new Error('Bootstrap authorization differs from its immutable operation plan');
  // The wallet signature binds the one-use economic commitment. HTTP deadline
  // can be refreshed on resume without ever reserving/applying the operation twice.
  request.intent.deadline = (await market.chain.latestTimestamp() + 600n).toString();
  request.intent.nonce = market.engine.getActionNonce(signer.address).toString();
  writePrivateJson(path, actions);
  await market.api.execute(request, { beforeApply() {
    if (market.engine.getMetadata(marker)) throw new Error('Bootstrap operation already committed');
  }, onCommit() { market.engine.setMetadata(marker, 'committed'); } });
}
async function publishBootstrap(market: MarketRuntime, payer: Wallet, transactions: DeploymentTransactions, phase: string, log: (message: string) => void) {
  for (let i = 0; i < 32; i++) {
    await market.api.sync();
    const offer = await market.chain.getPublicationRequest();
    if (offer.status === 'idle') return;
    if (offer.status !== 'ready' || offer.request?.kind !== 'zk') throw new Error(`Market ${market.id} is awaiting confirmed publication; resume bootstrap later`);
    const ticket = offer.request;
    log(`${market.label}: публикую доказанный переход ${ticket.publicSignals[1]}`);
    const data = new Interface(ZK_VAULT_ABI).encodeFunctionData('publishProvenTransition', zkPublicationArguments(ticket));
    await transactions.run(`${market.id}:publication:${ticket.publicSignals[1]}`, payer, { to: market.config.vaultAddress, data });
    await market.api.sync();
  }
  throw new Error('Bootstrap publication queue exceeded its bound');
}
export async function fundBootstrapRoles(manifest: DeploymentManifest, lp: Wallet, bot: Wallet, transactions: DeploymentTransactions, deployer: Wallet) {
  for (const [roleName, role] of [['lp', lp], ['bot', bot]] as const) {
    const funding = manifest.budget?.roleFundingByRoleWei?.[roleName] !== undefined
      ? BigInt(manifest.budget.roleFundingByRoleWei[roleName])
      : BigInt(manifest.budget?.roleFundingWei ?? '0') / 2n;
    // Creating a fresh recipient can consume state gas as well as execution
    // gas. Estimate the exact transfer on this network before signing it.
    if (funding > 0n) await transactions.run(`fund:${role.address}`, deployer, { to: role.address, value: funding });
  }
}
export async function bootstrapMarkets(markets: MarketRuntime[], manifest: DeploymentManifest, keys: PrivateMarketKeys, settings: SepoliaSettings, transactions: DeploymentTransactions, deployer: Wallet, log: (message: string) => void = () => {}) {
  const provider = deployer.provider as JsonRpcProvider;
  const lp = new Wallet(keys.roles.lp.privateKey, provider), bot = new Wallet(keys.roles.bot.privateKey, provider);
  const whitelist = new Interface(['function setWhitelist(address,bool)']);
  const erc20 = new Interface(['function mint(address,uint256)', 'function approve(address,uint256)']);
  const vaultAbi = new Interface(ZK_VAULT_ABI);
  await fundBootstrapRoles(manifest, lp, bot, transactions, deployer);
  for (const market of markets) {
    const definition = POOLS.find((pool) => pool.id === market.id)!;
    const pool = manifest.pools[market.id];
    for (const owner of [...new Set([lp.address, bot.address, ...(manifest.roles.authorizedTestWallets ?? []), ...(manifest.roles.testWallet ? [manifest.roles.testWallet] : [])])]) {
      await transactions.run(`${market.id}:whitelist:${owner}`, deployer, { to: pool.vault, data: whitelist.encodeFunctionData('setWhitelist', [owner, true]) });
    }
    for (const role of [lp, bot]) {
      const state = market.engine.getZkAccount(role.address);
      const recoveryKey = await deriveOwnerRecoveryKey(market.config, role);
      await bootstrapAction(market, role, { kind: 'zkRegister', recoveryKey: recoveryKey.toString(), slot: state.slot.toString() }, `${market.id}:register:${role.address}`, settings.directory);
    }
    // Deposits are impossible until the owner registration has been proven.
    await publishBootstrap(market, lp, transactions, 'registration', log);
    for (const [roleName, signer, amounts] of [['lp', lp, pool.seedAmounts], ['bot', bot, pool.botAmounts]] as const) {
      for (let index = 0; index < 2; index++) {
        const symbol = definition.assets[index];
        const token = manifest.tokens[symbol].address;
        const amount = BigInt(amounts[index]);
        // Mint once per (market, role, asset). Replay uses its original signed
        // transaction, so existing funds are never used as an idempotency guess.
        await transactions.run(`${market.id}:mint:${roleName}:${symbol}`, deployer, { to: token, data: erc20.encodeFunctionData('mint', [signer.address, amount]) });
        await transactions.run(`${market.id}:approve:${roleName}:${symbol}`, signer, { to: token, data: erc20.encodeFunctionData('approve', [pool.vault, amount]) });
        const depositInterface = new Interface(['function deposit(address,uint256)']);
        await transactions.run(`${market.id}:deposit:${roleName}:${symbol}`, signer, { to: pool.vault, data: depositInterface.encodeFunctionData('deposit', [token, amount]) });
      }
    }
    await market.api.sync();
    await bootstrapAction(market, lp, { kind: 'addLiquidity', rubaDesired: pool.seedAmounts[0], usdtDesired: pool.seedAmounts[1], rubaMin: pool.seedAmounts[0], usdtMin: pool.seedAmounts[1] }, `${market.id}:seed-liquidity`, settings.directory);
    await publishBootstrap(market, lp, transactions, 'liquidity', log);
    const accepted = market.engine.getAcceptedCheckpoint();
    pool.acceptedStateVersion = accepted.stateVersion.toString(); pool.acceptedRoot = `0x${accepted.root.toString(16).padStart(64, '0')}`;
    transactions.saveManifest();
  }
  manifest.status = 'ready'; transactions.saveManifest();
}

export async function serveMarkets(markets: MarketRuntime[], manifest: DeploymentManifest, keys: PrivateMarketKeys, settings: SepoliaSettings) {
  const { MarketsServer } = await import('../server/markets.ts');
  const { ArbitrageWorker } = await import('../server/arbitrage.ts');
  const server = new MarketsServer({ markets, adminAddress: manifest.roles.admin, settingsPath: join(settings.directory, 'settings.sqlite'),
    defaultMarketId: 'ruba-usdt', network: { name: manifest.network.name, explorerUrl: manifest.network.explorerUrl } });
  const provider = new JsonRpcProvider(settings.rpcUrl, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = manifest.network.chainId === '31337' ? 50 : 2000;
  const botSigner = new Wallet(keys.roles.bot.privateKey, provider);
  const transactionQueue = new SerialTransactionQueue();
  const arb = new ArbitrageWorker({ markets, botSigner, transactionSigner: new NonceManager(botSigner), settings: () => server.getSettings(), transactionQueue });
  server.setArbitrageController(arb);
  const http = server.createHttpServer();
  try {
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(settings.port, '127.0.0.1', () => { http.off('error', reject); resolve(); }); });
  } catch (error) { provider.destroy(); await server.close(); throw error; }
  const stopWorkers = server.startWorkers();
  return { server, arb, http, async close() {
    arb.stop(); stopWorkers();
    await new Promise<void>((resolve) => { http.close(() => resolve()); http.closeIdleConnections(); });
    await arb.drain(); await server.drain(); await transactionQueue.drain(); await server.close();
    provider.destroy(); await closeMarketRuntimes(markets);
  } };
}
