import { existsSync } from 'node:fs';
import { JsonRpcProvider } from 'ethers';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSepoliaSettings, loadDeployer, loadPrivateMarketKeys, SEPOLIA_CHAIN_ID } from './sepolia-config.ts';
import { prepareDeployment } from './sepolia-deploy.ts';
import { acquireDeploymentLock } from './sepolia-lock.ts';
export async function runSepoliaPrepare(log: (message: string) => void = console.log) {
  const settings = loadSepoliaSettings(); const provider = new JsonRpcProvider(settings.rpcUrl, undefined, { cacheTimeout: -1 });
  let release: (() => void) | undefined;
  try {
    release = acquireDeploymentLock(settings.directory);
    const deployer = loadDeployer(settings.directory), keys = loadPrivateMarketKeys(settings.directory, SEPOLIA_CHAIN_ID, !existsSync(join(settings.directory, 'manifest.json')));
    const env = await prepareDeployment(settings, provider, deployer, keys);
    log(`Sepolia plan prepared: ${join(settings.directory, 'manifest.json')}`);
    log(`Dedicated deployer: ${deployer.address}; balance ${env.manifest.budget!.balanceWei} wei; provisional funding ceiling ${env.manifest.budget!.totalRequiredWei} wei; funded=${env.manifest.budget!.sufficient}.`);
    if (env.manifest.budget!.source.includes('placeholder')) log('Dependent-contract placeholders are not measured Sepolia costs. After confirming the shared verifier/Poseidon, preview an explicit RPC budget refresh before continuing Vault deployment.');
    log('No transaction was broadcast. Private role keys, pool recovery keys and databases stay in the local data directory.');
    return env.manifest;
  } finally { provider.destroy(); release?.(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSepoliaPrepare().catch(() => { console.error('Cannot prepare Sepolia plan; check RPC, dedicated local wallet and pinned artifacts.'); process.exitCode = 1; });
