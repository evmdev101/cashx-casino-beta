'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};

  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
  const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

  const config = {
    chain: {
      id: 369,
      hexId: '0x171',
      name: 'PulseChain',
      nativeCurrency: { name: 'Pulse', symbol: 'PLS', decimals: 18 },
      rpcUrl: 'https://rpc.pulsechain.com',
      explorerBaseUrl: 'https://scan.pulsechain.com',
    },
    addresses: {
      cashxToken: '0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665',
      treasury: '0xEda3aa737947337b425227dB8174519f623C041F',
      dead: DEAD_ADDRESS,
      zero: ZERO_ADDRESS,
    },
    contracts: {
      diceGame: '0x15A8C0D554D3e6971A46D696F69e8cBB8CF07977',
      diceGameV1: '0xbd8505526cF22A9810d7644Fb4969b6ae643E05D',
      asyncGames: '0x68Fdb217f4979CE3d80eB09C1c35031D292185F3',
      minesGame: '0xF5Ba5129dD41acb8aF5050aF1EcA84dD497E3095',
      liveMinesGame: '0x684e6B760FC931BB858b3bf3dFC056e550b13D90',
      pvpWager: '0x7fEA5BB21c776f89Fb9561F7a121bFeC31EC2c80',
    },
    featureFlags: {
      modeKey: 'cashx:mode',
      defaultMode: 'mock',
      enableMockGames: true,
      enableLiveTransactions: false,
      pvpBackendUrl: root.CASHX_PVP_BACKEND_URL || 'http://localhost:8790',
    },
    economics: {
      decimals: 18,
      diceBurnBps: 300,
      multiplayerBurnBps: 500,
      pvpBurnBps: 500,
      defaultHouseFeeBps: 300,
    },
  };

  function getMode() {
    try {
      return root.localStorage.getItem(config.featureFlags.modeKey) ||
        config.featureFlags.defaultMode;
    } catch (_) {
      return config.featureFlags.defaultMode;
    }
  }

  function setMode(mode) {
    const next = mode === 'live' ? 'live' : 'mock';
    try {
      root.localStorage.setItem(config.featureFlags.modeKey, next);
    } catch (_) {}
    return next;
  }

  function isLiveMode() {
    return getMode() === 'live' && config.featureFlags.enableLiveTransactions;
  }

  function isMockMode() {
    return !isLiveMode();
  }

  CashX.config = Object.assign(config, {
    getMode,
    setMode,
    isLiveMode,
    isMockMode,
  });
}(window));
