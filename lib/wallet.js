'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};
  let selectedProvider = null;
  const announcedProviders = [];

  function cfg() {
    if (!CashX.config) throw new Error('CashX config is not loaded.');
    return CashX.config;
  }

  function eth() {
    return selectedProvider || root.ethereum || null;
  }

  function hasWallet() {
    return !!eth();
  }

  function rememberProvider(provider) {
    if (!provider || announcedProviders.some(entry => entry.provider === provider)) return;
    const info = provider.__cashxInfo || {};
    announcedProviders.push({
      provider,
      info: {
        name: info.name || walletName(provider),
        icon: info.icon || '',
        rdns: info.rdns || '',
      },
    });
  }

  function walletName(provider) {
    if (!provider) return 'Browser Wallet';
    if (provider.isRabby) return 'Rabby';
    if (provider.isInternetMoney || provider.isIMWallet || provider.isInternetMoneyWallet) return 'Internet Money';
    if (provider.isMetaMask) return 'MetaMask';
    if (provider.isBraveWallet) return 'Brave Wallet';
    if (provider.isCoinbaseWallet) return 'Coinbase Wallet';
    return 'Browser Wallet';
  }

  function collectLegacyProviders() {
    const ethProvider = root.ethereum;
    if (!ethProvider) return;
    const providers = Array.isArray(ethProvider.providers) ? ethProvider.providers : [ethProvider];
    providers.forEach(provider => rememberProvider(provider));
  }

  function getWalletProviders() {
    collectLegacyProviders();
    try { root.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
    return announcedProviders.slice();
  }

  function listWalletProviders(waitMs = 250) {
    getWalletProviders();
    return new Promise(resolve => {
      setTimeout(() => resolve(getWalletProviders()), waitMs);
    });
  }

  function selectProvider(provider) {
    selectedProvider = provider || null;
    if (provider) rememberProvider(provider);
    return selectedProvider;
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

  async function connectWallet(providerOverride) {
    if (providerOverride) selectProvider(providerOverride);
    if (!hasWallet()) throw new Error(formatWalletError());
    try {
      bindWalletEvents();
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
    const provider = eth();
    if (!provider || provider.__cashxBound) return;
    provider.__cashxBound = true;
    provider.on && provider.on('accountsChanged', accounts => {
      if (!accounts || !accounts.length) {
        try { root.localStorage.removeItem('cashx:walletConnected'); } catch (_) {}
        dispatchWalletEvent('disconnected', {});
        return;
      }
      dispatchWalletEvent('accountsChanged', { accounts, address: accounts[0] });
    });
    provider.on && provider.on('chainChanged', chainId => {
      dispatchWalletEvent('chainChanged', { chainId });
    });
  }

  root.addEventListener && root.addEventListener('eip6963:announceProvider', event => {
    const detail = event && event.detail;
    if (!detail || !detail.provider) return;
    detail.provider.__cashxInfo = detail.info || {};
    rememberProvider(detail.provider);
  });
  collectLegacyProviders();
  try { root.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}

  CashX.wallet = {
    hasWallet,
    getEthereum: eth,
    getWalletProviders,
    listWalletProviders,
    selectProvider,
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
