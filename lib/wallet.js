'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};

  function cfg() {
    if (!CashX.config) throw new Error('CashX config is not loaded.');
    return CashX.config;
  }

  function eth() {
    return root.ethereum || null;
  }

  function hasWallet() {
    return !!eth();
  }

  function formatWalletError(err) {
    const raw = String(err && (err.reason || err.message || err.data && err.data.message) || '');
    if (!hasWallet()) return 'No wallet detected. Install MetaMask, Internet Money, or Rabby.';
    if (err && err.code === 4001) return 'Wallet request rejected.';
    if (/insufficient funds/i.test(raw)) return 'This wallet needs a little PLS for gas.';
    if (/user rejected/i.test(raw)) return 'Wallet request rejected.';
    if (/chain/i.test(raw) && /not|wrong|unsupported/i.test(raw)) return 'Switch your wallet to PulseChain.';
    return raw || 'Wallet error. Please try again.';
  }

  function networkParams() {
    const chain = cfg().chain;
    return {
      chainId: chain.hexId,
      chainName: chain.name,
      nativeCurrency: chain.nativeCurrency,
      rpcUrls: [chain.rpcUrl],
      blockExplorerUrls: [chain.explorerBaseUrl],
    };
  }

  async function detectPulseChain(provider) {
    const ethersProvider = provider || CashX.contracts.getProvider();
    const net = await ethersProvider.getNetwork();
    return Number(net.chainId) === cfg().chain.id;
  }

  async function switchToPulseChain() {
    if (!hasWallet()) throw new Error(formatWalletError());
    try {
      await eth().request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: cfg().chain.hexId }],
      });
    } catch (err) {
      if (err && err.code === 4902) return addPulseChainNetwork();
      throw new Error(formatWalletError(err));
    }
  }

  async function addPulseChainNetwork() {
    if (!hasWallet()) throw new Error(formatWalletError());
    try {
      await eth().request({
        method: 'wallet_addEthereumChain',
        params: [networkParams()],
      });
    } catch (err) {
      throw new Error(formatWalletError(err));
    }
  }

  async function connectWallet() {
    if (!hasWallet()) throw new Error(formatWalletError());
    try {
      await eth().request({ method: 'eth_requestAccounts' });
      let provider = CashX.contracts.getProvider();
      if (!await detectPulseChain(provider)) {
        await switchToPulseChain();
        provider = CashX.contracts.getProvider();
      }
      const signer = provider.getSigner();
      const address = await signer.getAddress();
      try { root.localStorage.setItem('cashx:walletConnected', '1'); } catch (_) {}
      dispatchWalletEvent('connected', { provider, signer, address });
      return { provider, signer, address };
    } catch (err) {
      throw new Error(formatWalletError(err));
    }
  }

  async function getConnectedAccount() {
    if (!hasWallet()) return null;
    const accounts = await eth().request({ method: 'eth_accounts' });
    return accounts && accounts.length ? accounts[0] : null;
  }

  async function reconnect() {
    let shouldReconnect = false;
    try { shouldReconnect = root.localStorage.getItem('cashx:walletConnected') === '1'; } catch (_) {}
    if (!shouldReconnect || !hasWallet()) return null;
    const account = await getConnectedAccount();
    if (!account) return null;
    const provider = CashX.contracts.getProvider();
    const signer = provider.getSigner();
    dispatchWalletEvent('connected', { provider, signer, address: account });
    return { provider, signer, address: account };
  }

  async function getPlsBalance(address) {
    const provider = CashX.contracts.getProvider({ readOnly: !hasWallet() });
    const account = address || await getConnectedAccount();
    if (!account) return null;
    return provider.getBalance(account);
  }

  async function getCashXBalance(address) {
    const account = address || await getConnectedAccount();
    if (!account) return null;
    return CashX.contracts.getCashXContract().balanceOf(account);
  }

  function dispatchWalletEvent(type, detail) {
    root.dispatchEvent(new CustomEvent('cashx:wallet:' + type, { detail }));
  }

  function bindWalletEvents() {
    if (!hasWallet() || eth().__cashxBound) return;
    eth().__cashxBound = true;
    eth().on && eth().on('accountsChanged', accounts => {
      if (!accounts || !accounts.length) {
        try { root.localStorage.removeItem('cashx:walletConnected'); } catch (_) {}
        dispatchWalletEvent('disconnected', {});
        return;
      }
      dispatchWalletEvent('accountsChanged', { accounts, address: accounts[0] });
    });
    eth().on && eth().on('chainChanged', chainId => {
      dispatchWalletEvent('chainChanged', { chainId });
    });
  }

  CashX.wallet = {
    hasWallet,
    getEthereum: eth,
    connectWallet,
    detectPulseChain,
    switchToPulseChain,
    addPulseChainNetwork,
    getConnectedAccount,
    getPlsBalance,
    getCashXBalance,
    reconnect,
    bindWalletEvents,
    formatWalletError,
  };

  bindWalletEvents();
}(window));
