import Onboard from '@web3-onboard/core';
import injectedWallets from '@web3-onboard/injected-wallets';

const russian = {
  connect: {
    selectingWallet: {
      header: 'Выберите кошелёк',
      sidebar: { subheading: 'Подключение кошелька', paragraph: 'Выберите установленный Ethereum-кошелёк.' },
      installWallet: 'В этом браузере не найден Ethereum-кошелёк. Откройте RUBA в браузере с MetaMask, Rabby или другим Ethereum-кошельком.',
      recommendedWalletsPart1: '{app} поддерживает',
      recommendedWalletsPart2: 'Выберите или установите совместимый кошелёк.',
    },
    connectingWallet: {
      header: '{connectionRejected, select, false {Подключение {wallet}…} other {Подключение отклонено}}',
      sidebar: { subheading: 'Подтвердите подключение', paragraph: 'Откройте кошелёк и разрешите доступ к выбранному аккаунту.' },
      mainText: 'Ожидаем кошелёк…',
      paragraph: 'Выберите аккаунт, которым хотите пользоваться в RUBA.',
      previousConnection: 'В {wallet} уже открыт запрос подключения. Откройте кошелёк и подтвердите или отклоните его.',
      rejectedText: 'Подключение отклонено',
      rejectedCTA: 'Попробовать снова',
      primaryButton: 'Вернуться к выбору кошелька',
    },
    connectedWallet: {
      header: 'Кошелёк подключён',
      sidebar: { subheading: 'Готово', paragraph: 'Кошелёк подключён к {app}.' },
      mainText: 'Подключено', accountSelected: 'Выбранный аккаунт', availableWallet: 'доступный кошелёк',
    },
  },
};

function cancelledConnection() {
  return Object.assign(new Error('Подключение кошелька отменено.'), { code: 4001 });
}

/**
 * Use the unmodified Web3-Onboard selection UI and injected/EIP-6963 modules.
 * The guard only invalidates SDK requests from a cancelled selection. Without
 * it, approving an extension popup after closing the SDK modal can add that
 * wallet to the SDK's state after the application has already disconnected.
 */
export function createOnboard(config) {
  let selection;
  const originals = new WeakMap();
  const injected = injectedWallets({ displayUnavailable: false, disable6963Support: false });
  const guardedInjected = (helpers) => {
    const modules = injected(helpers);
    if (!modules) return null;
    return modules.map((wallet) => ({
      ...wallet,
      async getInterface(...args) {
        const current = selection;
        if (!current || current.cancelled) throw cancelledConnection();
        const walletInterface = await wallet.getInterface(...args);
        if (current.cancelled) throw cancelledConnection();
        const original = walletInterface.provider;
        const provider = new Proxy(original, {
          get(target, key) {
            if (key === 'request') return async (request) => {
              if (current.cancelled) throw cancelledConnection();
              const result = await target.request(request);
              if (current.cancelled) throw cancelledConnection();
              return result;
            };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        originals.set(provider, original);
        return { ...walletInterface, provider };
      },
    }));
  };
  const chainId = BigInt(config.chainId);
  const sdk = Onboard({
    wallets: [guardedInjected],
    chains: [{ id: `0x${chainId.toString(16)}`, label: config.networkName || (chainId === 11155111n ? 'Ethereum Sepolia' : `Ethereum ${chainId}`), token: 'ETH' }],
    appMetadata: { name: 'RUBA', description: 'Обмен и пул ликвидности RUBA' },
    connect: {
      showSidebar: false, disableClose: false,
      autoConnectLastWallet: false, autoConnectAllPreviousWallet: false,
      removeWhereIsMyWalletWarning: true, removeIDontHaveAWalletInfoLink: true,
    },
    accountCenter: { desktop: { enabled: false }, mobile: { enabled: false }, hideTransactionProtectionBtn: true },
    notify: { enabled: false },
    disableFontDownload: true,
    i18n: { ru: russian },
    theme: { '--w3o-font-family': 'Arial, sans-serif', '--w3o-border-radius': '8px' },
  });
  sdk.state.actions.setLocale('ru');

  function closeModal(current) {
    if (selection !== current || !current?.cancelled) return;
    // Web3-Onboard 2.24.1 has no public imperative close API. Invoke its own
    // close control, whose selector is verified against this pinned release.
    // No provider permissions are revoked and no global provider is changed.
    globalThis.document?.querySelector('onboard-v2')?.shadowRoot?.querySelector('.button-container .close-button')?.click();
  }
  function cancelConnect() {
    const current = selection;
    if (!current) return;
    current.cancelled = true;
    closeModal(current);
    // Also cover cancellation between connectWallet() and Svelte's first render.
    queueMicrotask(() => closeModal(current));
  }

  return {
    state: sdk.state,
    disconnectWallet: sdk.disconnectWallet,
    cancelConnect,
    async connectWallet() {
      const current = { cancelled: false };
      selection = current;
      try {
        const wallets = await sdk.connectWallet();
        if (current.cancelled) return [];
        if (!wallets.length) current.cancelled = true;
        return wallets.map((wallet) => ({ ...wallet, provider: originals.get(wallet.provider) ?? wallet.provider }));
      } catch (error) {
        current.cancelled = true;
        throw error;
      }
    },
  };
}
