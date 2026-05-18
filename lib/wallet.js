'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};
  let selectedProvider = null;
  const announcedProviders = [];

  function cfg() {
    if (!CashX.config) throw new Error('CashX config is not loaded.');
    return CashX.config;
  }

  function findMetaMaskProvider() {
    collectLegacyProviders();
    const announced = announcedProviders.find(entry => providerKey(entry.provider) === 'metamask');
    if (announced) return announced.provider;
    const ethProvider = root.ethereum;
    if (!ethProvider) return null;
    if (ethProvider.isMetaMask) return ethProvider;
    return null;
  }

  function eth() {
    return selectedProvider || findMetaMaskProvider();
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
    if (provider.isMetaMask) return 'MetaMask';
    if (provider.isBraveWallet) return 'Brave Wallet';
    if (provider.isCoinbaseWallet) return 'Coinbase Wallet';
    return 'Browser Wallet';
  }

  function providerKey(provider) {
    const info = provider && provider.__cashxInfo ? provider.__cashxInfo : {};
    const text = [
      info.name,
      info.rdns,
      walletName(provider),
    ].join(' ').toLowerCase();
    if (/rabby|internet money|internetmoney|coinbase|phantom|uniswap/.test(text)) return '';
    if (/metamask/.test(text) || (provider && provider.isMetaMask)) return 'metamask';
    return '';
  }

  function restoreSelectedProvider() {
    let saved = '';
    try { saved = root.localStorage.getItem('cashx:selectedWallet') || ''; } catch (_) {}
    if (saved && saved !== 'metamask') {
      try { root.localStorage.removeItem('cashx:selectedWallet'); } catch (_) {}
      saved = '';
    }
    if (!saved || selectedProvider) return;
    const match = announcedProviders.find(entry => providerKey(entry.provider) === saved);
    if (match) selectedProvider = match.provider;
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
    restoreSelectedProvider();
    return announcedProviders.slice();
  }

  function listWalletProviders(waitMs = 250) {
    getWalletProviders();
    return new Promise(resolve => {
      setTimeout(() => resolve(getWalletProviders()), waitMs);
    });
  }

  function selectProvider(provider) {
    const key = providerKey(provider);
    selectedProvider = key === 'metamask' ? provider : null;
    if (selectedProvider) rememberProvider(selectedProvider);
    try {
      if (key) root.localStorage.setItem('cashx:selectedWallet', key);
      else root.localStorage.removeItem('cashx:selectedWallet');
    } catch (_) {}
    return selectedProvider;
  }

  function formatWalletError(err) {
    const raw = String(err && (err.reason || err.message || err.data && err.data.message) || '');
    if (!hasWallet()) return 'No MetaMask wallet detected. Install or enable MetaMask, then refresh.';
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

  async function requestWalletAccounts(provider) {
    try {
      await provider.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      });
    } catch (err) {
      if (err && err.code === 4001) throw err;
      // Some wallets do not support wallet_requestPermissions. Fall back to eth_requestAccounts.
    }
    return provider.request({ method: 'eth_requestAccounts' });
  }

  async function connectWallet(providerOverride) {
    if (providerOverride) selectProvider(providerOverride);
    if (!hasWallet()) throw new Error(formatWalletError());
    try {
      bindWalletEvents();
      await requestWalletAccounts(eth());
      let provider = CashX.contracts.getProvider();
      if (!await detectPulseChain(provider)) {
        await switchToPulseChain();
        provider = CashX.contracts.getProvider();
      }
      const signer = provider.getSigner();
      const address = await signer.getAddress();
      try { root.localStorage.setItem('cashx:walletConnected', '1'); } catch (_) {}
      try { root.localStorage.removeItem('cashx:walletDisconnected'); } catch (_) {}
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
        try { root.localStorage.setItem('cashx:walletDisconnected', '1'); } catch (_) {}
        try { root.localStorage.removeItem('cashx:selectedWallet'); } catch (_) {}
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
  restoreSelectedProvider();

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
