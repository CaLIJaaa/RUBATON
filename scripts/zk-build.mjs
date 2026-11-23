import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, rename, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { powersOfTau, curves, zKey } from 'snarkjs';
import { ContractFactory, keccak256 } from 'ethers';
import { poseidonContract } from 'circomlibjs';
import { startLocalChain } from './local-deploy.ts';

const directory = resolve('zk/artifacts');
const args = new Set(process.argv.slice(2));
const powerOption = process.argv.find((arg) => arg.startsWith('--power='));
const ptauOption = process.argv.find((arg) => arg.startsWith('--ptau='));
const power = powerOption ? Number(powerOption.slice(8)) : 18;
if (!Number.isInteger(power) || power < 12 || power > 20) throw new Error('Local setup power must be 12..20');
const logger = { log: (...v) => console.log(...v), info: (...v) => console.log(...v), warn: (...v) => console.warn(...v), error: (...v) => console.error(...v), debug() {} };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
function run(file, childArgs) {
  const r = spawnSync(process.execPath, [file, ...childArgs], { cwd: process.cwd(), stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`ZK build stage failed: ${file}`);
}
await mkdir(directory, { recursive: true });
const ptau = ptauOption ? resolve(ptauOption.slice(7)) : join(directory, `local_test_pot${power}_final.ptau`);
if (ptauOption && !await exists(ptau)) throw new Error('Supplied Powers of Tau file is missing');
if (ptau.endsWith('hermez18_download.ptau')) {
  const expected = '7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e';
  if (createHash('blake2b512').update(await readFile(ptau)).digest('hex') !== expected) throw new Error('Published Powers of Tau checksum mismatch');
}
let curve;
try {
  if (!args.has('--compile-only') && !await exists(ptau)) {
    console.log(`Creating LOCAL TEST setup 2^${power}; this is not a production ceremony.`);
    curve = await curves.getCurveFromName('bn128');
    const initial = join(directory, `local_test_pot${power}_initial.ptau`);
    const contributed = join(directory, `local_test_pot${power}_contributed.ptau`);
    await powersOfTau.newAccumulator(curve, power, initial, logger);
    console.log('Applying fresh local contribution. Entropy is not saved.');
    await powersOfTau.contribute(initial, contributed, 'RUBA local test setup', randomBytes(64).toString('hex'), logger);
    console.log('Preparing phase 2.');
    const prepared = ptau + '.partial';
    await powersOfTau.preparePhase2(contributed, prepared, logger);
    await rename(prepared, ptau);
    await rm(initial, { force: true }); await rm(contributed, { force: true });
  }
  if (args.has('--phase1-only')) { console.log(`Local test phase 1 ready: ${ptau}`); process.exitCode = 0; }
  else {
    run('node_modules/circom2/cli.js', ['zk/circuits/transition.circom', '--r1cs', '--wasm', '--sym', '--O2', '-l', 'node_modules', '-o', directory]);
    if (!args.has('--compile-only')) {
      curve ??= await curves.getCurveFromName('bn128');
      const r1cs = join(directory, 'transition.r1cs');
      const initZkey = join(directory, 'transition_initial.zkey');
      const finalZkey = join(directory, 'transition_final.zkey');
      console.log('Generating circuit-specific LOCAL TEST proving key.');
      await zKey.newZKey(r1cs, ptau, initZkey, logger);
      await zKey.contribute(initZkey, finalZkey, 'RUBA local circuit contribution', randomBytes(64).toString('hex'), logger);
      const vk = await zKey.exportVerificationKey(finalZkey, logger);
      const vkBytes = Buffer.from(JSON.stringify(vk, null, 2) + '\n');
      await writeFile(join(directory, 'verification_key.json'), vkBytes);
      const template = await readFile('node_modules/snarkjs/templates/verifier_groth16.sol.ejs', 'utf8');
      let verifier = await zKey.exportSolidityVerifier(finalZkey, { groth16: template }, logger);
      verifier = verifier.replace(/pragma solidity[^;]+;/, 'pragma solidity ^0.8.24;');
      await mkdir('src/generated', { recursive: true });
      await writeFile('src/generated/Groth16Verifier.sol', verifier);
      await rm(initZkey, { force: true });
      const poseidon = { abi: poseidonContract.generateABI(2), bytecode: poseidonContract.createCode(2) };
      const local = await startLocalChain();
      try {
        const deployed = await new ContractFactory(poseidon.abi, poseidon.bytecode, local.wallets[0]).deploy();
        await deployed.waitForDeployment();
        poseidon.runtimeBytecode = await local.provider.getCode(await deployed.getAddress());
        poseidon.runtimeCodeHash = keccak256(poseidon.runtimeBytecode);
      } finally { await local.close(); }
      await writeFile(join(directory, 'poseidon2.json'), JSON.stringify(poseidon, null, 2));
      const built = spawnSync('forge', ['build'], { cwd: process.cwd(), stdio: 'inherit' });
      if (built.error || built.status !== 0) throw built.error ?? new Error('Solidity build failed');
      const artifact = JSON.parse(await readFile('out/Groth16Verifier.sol/Groth16Verifier.json', 'utf8'));
      const runtime = artifact.deployedBytecode.object.startsWith('0x') ? artifact.deployedBytecode.object : '0x' + artifact.deployedBytecode.object;
      const manifest = {
        version: 2, circuit: 'ruba-transition-v2', testSetup: true, power,
        wasm: 'transition_js/transition.wasm', zkey: 'transition_final.zkey', verificationKey: 'verification_key.json',
        verificationKeyHash: keccak256(vkBytes), verificationKeySha256: sha256(vkBytes),
        wasmSha256: sha256(await readFile(join(directory, 'transition_js/transition.wasm'))),
        zkeySha256: sha256(await readFile(finalZkey)), r1csSha256: sha256(await readFile(r1cs)),
        verifierRuntimeCodeHash: keccak256(runtime), poseidonRuntimeCodeHash: poseidon.runtimeCodeHash,
      };
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      console.log('ZK circuit, test proving key, pinned verifier and Poseidon artifacts are ready.');
    }
  }
} finally { if (curve) await curve.terminate(); }
