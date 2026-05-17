'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};

  function requireEthers() {
    if (!root.ethers) throw new Error('ethers.js is not loaded.');
    return root.ethers;
  }

  function cfg() {
    if (!CashX.config) throw new Error('CashX config is not loaded.');
    return CashX.config;
  }

  function getProvider(options = {}) {
    const ethers = requireEthers();
    const walletProvider = CashX.wallet && CashX.wallet.getEthereum
      ? CashX.wallet.getEthereum()
      : root.ethereum;
    if (!options.readOnly && walletProvider) {
      return new ethers.providers.Web3Provider(walletProvider);
    }
    return new ethers.providers.JsonRpcProvider(cfg().chain.rpcUrl);
  }

  async function getSigner() {
    const provider = getProvider();
    await provider.send('eth_requestAccounts', []);
    return provider.getSigner();
  }

  function getReadOnlyContract(address, abi) {
    const ethers = requireEthers();
    return new ethers.Contract(address, abi, getProvider({ readOnly: true }));
  }

  function getCashXContract(signerOrProvider) {
    const ethers = requireEthers();
    const runner = signerOrProvider || getProvider({ readOnly: true });
    return new ethers.Contract(cfg().addresses.cashxToken, CashX.abis.ERC20, runner);
  }

  function resolveContractAddress(nameOrAddress) {
    const contracts = cfg().contracts || {};
    return contracts[nameOrAddress] || nameOrAddress;
  }

  function resolveAbi(abiOrKey) {
    if (Array.isArray(abiOrKey)) return abiOrKey;
    return (CashX.abis || {})[abiOrKey] || (CashX.abis || {})[String(abiOrKey || '').toUpperCase()];
  }

  function getCasinoContract(nameOrAddress, abiOrKey, signerOrProvider) {
    const ethers = requireEthers();
    const address = resolveContractAddress(nameOrAddress);
    const abi = resolveAbi(abiOrKey);
    if (!address) throw new Error('Missing contract address.');
    if (!abi) throw new Error('Missing contract ABI.');
    return new ethers.Contract(address, abi, signerOrProvider || getProvider({ readOnly: true }));
  }

  function buildExplorerTxLink(txHash) {
    return cfg().chain.explorerBaseUrl.replace(/\/$/, '') + '/tx/' + txHash;
  }

  function buildExplorerAddressLink(address) {
    return cfg().chain.explorerBaseUrl.replace(/\/$/, '') + '/address/' + address;
  }

  CashX.contracts = {
    getProvider,
    getSigner,
    getCashXContract,
    getCasinoContract,
    getReadOnlyContract,
    buildExplorerTxLink,
    buildExplorerAddressLink,
  };
}(window));
