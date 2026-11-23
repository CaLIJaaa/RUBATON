import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ContractFactory, HDNodeWallet, JsonRpcProvider, NonceManager } from 'ethers';
import type { BaseContract, ContractRunner } from 'ethers';

/** Public test mnemonic. Used only in an isolated, loopback-only Anvil instance. */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

async function unusedPort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot allocate local port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

export async function startLocalChain() {
  const port = await unusedPort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const child = spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337',
    '--mnemonic', TEST_MNEMONIC, '--accounts', '5', '--silent',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let spawnError: Error | undefined;
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
  child.on('error', (error) => { spawnError = error; });
  const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 50;
  async function close() {
    provider.destroy();
    if (child.exitCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await Promise.race([exited, delay(2_000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw new Error(`Cannot start Anvil: ${spawnError.message}`);
      if (child.exitCode !== null) throw new Error(`Anvil stopped: ${stderr}`);
      try {
        await provider.send('eth_chainId', []);
        ready = true;
        break;
      } catch {
        await delay(100);
      }
    }
    if (!ready) throw new Error('Local Anvil did not start within 10 seconds');
    const wallets = Array.from({ length: 5 }, (_, index) =>
      HDNodeWallet.fromPhrase(TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider));
    return { rpcUrl, provider, wallets, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function deployArtifact(
  artifactName: string,
  contractName: string,
  signer: ContractRunner,
  args: readonly unknown[] = [],
): Promise<BaseContract> {
  const artifactUrl = new URL(`../out/${artifactName}.sol/${contractName}.json`, import.meta.url);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(artifactUrl, 'utf8'));
  } catch {
    throw new Error(`Missing ${fileURLToPath(artifactUrl)}. Run npm run build:contracts first.`);
  }
  const contract = await new ContractFactory(artifact.abi, artifact.bytecode.object, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

export async function deployLocalFixture(chain: Awaited<ReturnType<typeof startLocalChain>>) {
  const [admin, operator, lp, trader] = chain.wallets;
  const adminTransactions = new NonceManager(admin);
  const ruba = await deployArtifact('MockERC20', 'MockERC20', adminTransactions, ['Mock RUBA', 'RUBA', 18]);
  const usdt = await deployArtifact('MockUSDT', 'MockUSDT', adminTransactions);
  const vault = await deployArtifact('RubaVault', 'RubaVault', adminTransactions, [
    await ruba.getAddress(), await usdt.getAddress(), admin.address, operator.address,
  ]);
  const deploymentBlock = (await vault.deploymentTransaction()!.wait())!.blockNumber;
  return { admin, operator, lp, trader, adminTransactions, ruba, usdt, vault, deploymentBlock };
}
