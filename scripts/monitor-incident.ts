import { pathToFileURL } from 'node:url';
import { Contract, Interface, NonceManager } from 'ethers';
import { deployArtifact, startLocalChain } from './local-deploy.ts';
import { MonitorBot, type MonitorEvent, type TokenRole } from '../server/monitor-bot.ts';

/**
 * Test incident on a local chain: the issuer blocks the vault in RUBA, the monitor bot
 * pauses by itself, the block is lifted, two pause roles resume the market.
 */
export async function runMonitorIncident(log: (line: string) => void = console.log) {
  const chain = await startLocalChain();
  try {
    const [ownerWallet, admin, guardian, bot, alice] = chain.wallets;
    const owner = new NonceManager(ownerWallet);
    const ruba = await deployArtifact('BlockableToken', 'BlockableToken', owner, ['Demo RUBA', 'RUBA']) as Contract;
    const usdt = await deployArtifact('BlockableToken', 'BlockableToken', owner, ['Demo USDT', 'USDT']) as Contract;
    const vault = await deployArtifact('RubaVault', 'RubaVault', owner,
      [await ruba.getAddress(), await usdt.getAddress(), ownerWallet.address, admin.address]) as Contract;
    const vaultAddress = await vault.getAddress();
    const addresses: Record<TokenRole, string> = { RUBA: await ruba.getAddress(), USDT: await usdt.getAddress() };
    await (await vault.setPauseGuardians([admin.address, guardian.address, bot.address], 0)).wait();
    await (await vault.setWhitelist(alice.address, true)).wait();
    for (const [token, amount] of [[ruba, 10_000n * 10n ** 18n], [usdt, 1_000n * 10n ** 18n]] as const) {
      await (await token.mint(alice.address, amount)).wait();
      await (await (token.connect(alice) as Contract).approve(vaultAddress, amount)).wait();
      await (await (vault.connect(alice) as Contract).deposit(await token.getAddress(), amount)).wait();
    }

    const botVault = vault.connect(new NonceManager(bot)) as Contract;
    const transfer = new Interface(['function transfer(address,uint256) returns(bool)']);
    const custody: Record<TokenRole, bigint> = { RUBA: 10_000n * 10n ** 18n, USDT: 1_000n * 10n ** 18n };
    const monitor = new MonitorBot({
      market: 'ruba-usdt', vaultAddress, tokenAddresses: addresses, decimals: { RUBA: 18, USDT: 18 },
      reads: {
        marketPaused: () => vault.marketPaused(),
        withdrawalsPaused: (role) => vault.withdrawalsPaused(addresses[role]),
        vaultBalance: async (role) => BigInt(await (role === 'RUBA' ? ruba : usdt).balanceOf(vaultAddress)),
        async probeTransfer(role, amount) {
          try {
            await chain.provider.call({ from: vaultAddress, to: addresses[role], data: transfer.encodeFunctionData('transfer', [bot.address, amount]) });
            return true;
          } catch { return false; }
        },
        chainRoot: async () => BigInt(await vault.stateRoot()),
        unappliedPayouts: async () => ({ RUBA: 0n, USDT: 0n }),
      },
      actions: {
        pauseMarket: async () => { const tx = await botVault.setMarketPaused(true); await tx.wait(); return tx.hash; },
        pauseWithdrawals: async (role) => { const tx = await botVault.setTokenWithdrawalsPaused(addresses[role], true); await tx.wait(); return tx.hash; },
      },
      ledger: {
        custody: () => ({ ...custody }), knownRoots: () => [0n], pendingVersions: () => [],
        reserves: () => ({ RUBA: 0n, USDT: 0n }), nextTradeId: () => 1n,
      },
    });
    const show = (events: MonitorEvent[]) => events.forEach((event) => log(`  бот: ${event.criterion} ${event.severity} ${event.detail}`));
    const status = async () => `рынок ${await vault.marketPaused() ? 'на паузе' : 'открыт'}, вывод RUBA ${await vault.withdrawalsPaused(addresses.RUBA) ? 'на паузе' : 'открыт'}, вывод USDT ${await vault.withdrawalsPaused(addresses.USDT) ? 'на паузе' : 'открыт'}`;

    log('1. Обычная работа');
    show(await monitor.check());
    log(`  ${await status()}`);

    log('2. Эмитент блокирует Vault в RUBA');
    await (await ruba.setBlocked(vaultAddress, true)).wait();
    show(await monitor.check());
    log(`  ${await status()}`);

    log('3. Повторная проверка ничего не дублирует');
    show(await monitor.check());

    log('4. Эмитент снимает блокировку');
    await (await ruba.setBlocked(vaultAddress, false)).wait();
    show(await monitor.check());
    log(`  ${await status()}`);

    log('5. Возобновление: одна роль не может, две могут');
    await (await (vault.connect(admin) as Contract).approveMarketResume()).wait();
    log(`  после первой роли: ${await status()}`);
    await (await (vault.connect(guardian) as Contract).approveMarketResume()).wait();
    await (await (vault.connect(admin) as Contract).approveTokenWithdrawalsResume(addresses.RUBA)).wait();
    await (await (vault.connect(guardian) as Contract).approveTokenWithdrawalsResume(addresses.RUBA)).wait();
    log(`  после второй роли: ${await status()}`);

    const journal = monitor.events();
    monitor.close();
    return { journal, marketPaused: await vault.marketPaused(), rubaPaused: await vault.withdrawalsPaused(addresses.RUBA) };
  } finally { await chain.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMonitorIncident().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
