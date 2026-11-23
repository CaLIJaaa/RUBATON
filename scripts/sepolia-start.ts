import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JsonRpcProvider } from 'ethers';
import { loadSepoliaSettings, loadPrivateMarketKeys, readJson, verifyManifest, artifactPins, SEPOLIA_CHAIN_ID } from './sepolia-config.ts';
import type { DeploymentManifest } from './sepolia-config.ts';
import { createMarketRuntimes, serveMarkets, closeMarketRuntimes } from './sepolia-runtime.ts';
export async function runSepoliaStart(log: (message: string) => void = console.log) {
  const settings = loadSepoliaSettings(), manifest = readJson<DeploymentManifest>(join(settings.directory, 'manifest.json'));
  const keys = loadPrivateMarketKeys(settings.directory, SEPOLIA_CHAIN_ID, false);
  verifyManifest(manifest, SEPOLIA_CHAIN_ID, keys, artifactPins(settings.artifactsDir));
  if (manifest.status !== 'ready') throw new Error('Finish resumable Sepolia deployment/bootstrap before starting its application');
  const markets = await createMarketRuntimes(manifest, keys, settings);
  let serving: Awaited<ReturnType<typeof serveMarkets>> | undefined;
  try {
    serving = await serveMarkets(markets, manifest, keys, settings);
    log(`Sepolia markets UI: http://127.0.0.1:${settings.port}/; confirmations=${manifest.network.confirmations}; independent per-Vault balances; demo assets.`);
    await new Promise<void>((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  } finally { if (serving) await serving.close(); else await closeMarketRuntimes(markets); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSepoliaStart().catch(() => { console.error('Sepolia application could not start. Restore the existing per-market state instead of creating new keys/databases.'); process.exitCode = 1; });
