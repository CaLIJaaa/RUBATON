import { loadConfig } from './config.ts';
import { RubaEngine } from './engine.ts';
import { VaultChain } from './chain.ts';
import { RubaApi } from './api.ts';
import { ZkRubaEngine } from './zk/engine.ts';
import { ZkVaultChain } from './zk/chain.ts';
import { FIELD } from '../zk/crypto.js';
import { keccak256, toUtf8Bytes } from 'ethers';

async function main() {
  const config = loadConfig();
  const derivedPoolKey = BigInt(keccak256(toUtf8Bytes(`RUBA ZK pool recovery v2:${config.operatorPrivateKey}`))) % FIELD;
  const engine = config.proofMode === 'zk'
    ? new ZkRubaEngine(config, config.zkPoolRecoveryKey ?? (derivedPoolKey || 1n))
    : new RubaEngine(config);
  const chain = engine instanceof ZkRubaEngine ? new ZkVaultChain(config, engine) : new VaultChain(config, engine);
  await chain.initialize();
  const api = new RubaApi(engine, chain, config);
  const server = api.createHttpServer();
  const stopWorker = api.startWorker();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
  });
  console.log(`RUBA API listening on http://${config.host}:${config.port}; chain ${config.chainId}; ${config.proofMode === 'zk' ? 'ZK ledger, proof-authorized withdrawals' : 'legacy trusted operator mode'}`);
  const shutdown = () => {
    stopWorker();
    server.close(() => {
      void (async () => {
        await api.drain();
        if (chain instanceof ZkVaultChain) await chain.prover.close();
        chain.close(); engine.close(); process.exit(0);
      })();
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch(() => {
  // Avoid dumping RPC URLs or operator keys from underlying library errors.
  console.error('RUBA API startup failed. Check .env, RPC connectivity, vault addresses and operator authorization.');
  process.exitCode = 1;
});
