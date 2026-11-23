const loadWalletSdk = () => import('/assets/wallet-onboard.js');

/**
 * The connector owns only wallet selection. It never reads private balances,
 * signs application messages, switches chains or submits transactions.
 * The optional loader/timeout are injectable so cancellation can be tested
 * without browser extensions or a network connection.
 */
export function createWalletConnector(config, { loadSdk = loadWalletSdk, timeoutMs = 120_000 } = {}) {
  const chainId = BigInt(config.chainId);
  if (chainId <= 0n) throw new Error('Некорректная сеть подключения кошелька.');
  let onboard;
  let loading;
  let attempt;
  let cleanup = Promise.resolve();

  const ensureOnboard = () => {
    loading ??= Promise.resolve().then(loadSdk).then((module) => {
      if (typeof module.createOnboard !== 'function') throw new Error('Не удалось загрузить модуль выбора кошелька. Обновите страницу.');
      onboard = module.createOnboard({ chainId: chainId.toString(), networkName: config.networkName });
      return onboard;
    }).catch((error) => { loading = undefined; throw error; });
    return loading;
  };

  function finish(current, value, error) {
    if (current.finished) return;
    current.finished = true;
    clearTimeout(current.timer);
    if (attempt === current) attempt = undefined;
    if (error) current.reject(error);
    else current.resolve(value);
  }

  function cancel() {
    const current = attempt;
    if (!current) return;
    // Invalidate before closing the modal: the SDK close callback may resolve
    // its promise synchronously. Its late result cannot become our selection.
    finish(current, null);
    onboard?.cancelConnect?.();
  }

  async function disconnectKnownWallets(sdk, current) {
    const labels = [...new Set((sdk.state?.get?.().wallets ?? []).map((wallet) => wallet.label))];
    for (const label of labels) {
      if (current?.finished) return;
      await sdk.disconnectWallet({ label });
    }
  }

  function connect() {
    if (attempt) return attempt.promise;
    const current = { finished: false };
    current.promise = new Promise((resolve, reject) => { current.resolve = resolve; current.reject = reject; });
    attempt = current;
    current.timer = setTimeout(() => {
      if (current.finished) return;
      finish(current, null, new Error('Время подключения истекло. Проверьте открытый запрос в кошельке и попробуйте подключиться снова.'));
      onboard?.cancelConnect?.();
    }, timeoutMs);
    current.timer?.unref?.();
    void (async () => {
      try {
        const sdk = await ensureOnboard();
        if (current.finished) return;
        // A fresh explicit selection must not reuse a hidden SDK connection.
        // Wait for an earlier Disconnect too: a delayed SDK cleanup must finish
        // before a new connection with the same wallet label can be selected.
        const preparing = cleanup.then(() => disconnectKnownWallets(sdk, current));
        cleanup = preparing.catch(() => undefined);
        await preparing;
        if (current.finished) return;
        const wallets = await sdk.connectWallet();
        if (current.finished) return;
        const wallet = wallets?.[0];
        if (!wallet) { finish(current, null); return; }
        if (typeof wallet.provider?.request !== 'function') throw new Error('Выбранный кошелёк не предоставил Ethereum provider.');
        finish(current, { provider: wallet.provider, label: String(wallet.label || 'Ethereum-кошелёк') });
      } catch (error) {
        if (!current.finished) finish(current, null, error);
      }
    })();
    return current.promise;
  }

  async function disconnect() {
    cancel();
    // Disconnecting before the first connect must not download or initialize
    // a wallet SDK. An in-flight loader cannot start a cancelled connection.
    if (onboard) {
      onboard.cancelConnect?.();
      const sdk = onboard;
      const disconnecting = cleanup.then(() => disconnectKnownWallets(sdk));
      cleanup = disconnecting.catch(() => undefined);
      await disconnecting;
    }
  }

  return { connect, disconnect, cancel };
}
