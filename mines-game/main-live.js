'use strict';

const TILE_COUNT = 25;
const MAX_MINE_COUNT = 16;
const HOUSE_EDGE_BPS = 300;
const BPS = 10000;
const UI_MIN_BET = 1;
const UI_MAX_BET = 5000;
const UI_BET_STEP = 1;
const MINES_LIVE_ADDRESS = '0x684e6B760FC931BB858b3bf3dFC056e550b13D90';
const CASHX_ADDRESS = '0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665';
const BACKEND_URL = window.CASHX_MINES_BACKEND_URL || 'https://cashx-mines-backend.onrender.com';
const PULSECHAIN_ID = 369;
const RPC_URL = 'https://rpc.pulsechain.com';

const LIVE_MINES_ABI = [
  'function startGame(uint256 betAmount, uint8 mineCount, bytes32 serverSeedHash) external returns (uint256)',
  'function settleGame(uint256 gameId, uint256 revealedMask, bool won, bytes32 serverSeed, bytes signature) external',
  'function games(uint256) view returns (address player, uint256 amount, uint8 mineCount, bytes32 serverSeedHash, bool settled)',
  'function getPlayerGames(address player) view returns (uint256[])',
  'function totalBurned() view returns (uint256)',
  'function minBet() view returns (uint256)',
  'function maxBet() view returns (uint256)',
  'event GameStarted(uint256 indexed gameId, address indexed player, uint256 bet, uint8 mineCount, bytes32 serverSeedHash)',
  'event GameSettled(uint256 indexed gameId, address indexed player, bool won, uint256 bet, uint256 payout, uint256 burned, uint256 multiplierBps, uint256 revealedMask, uint256 mineMask, bytes32 serverSeed)',
];

const CASHX_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const roProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
const liveMinesRO = isLiveConfigured()
  ? new ethers.Contract(MINES_LIVE_ADDRESS, LIVE_MINES_ABI, roProvider)
  : null;

const state = {
  provider: null,
  signer: null,
  player: null,
  minesContract: null,
  cashxContract: null,
  bet: 500,
  minBet: ethers.utils.parseUnits('1', 18),
  maxBet: ethers.utils.parseUnits('5000', 18),
  mines: 3,
  activeGame: null,
  safeTiles: [],
  mineTiles: [],
  forceCashout: false,
  transacting: false,
  selectedApproval: getStoredApprovalPreset(),
  preparedSession: null,
  sessionPromise: null,
  sessionKey: '',
};

const els = {
  board: document.getElementById('board'),
  balance: document.getElementById('balanceOutput'),
  betInput: document.getElementById('betInput'),
  previewTotalPot: document.getElementById('previewTotalPot'),
  previewBurn: document.getElementById('previewBurn'),
  previewWinnerGets: document.getElementById('previewWinnerGets'),
  mineSelect: document.getElementById('mineSelect'),
  startBtn: document.getElementById('startBtn'),
  cashoutBtn: document.getElementById('cashoutBtn'),
  connectBtn: document.getElementById('connectBtn'),
  networkLabel: document.getElementById('networkLabel'),
  pickCount: document.getElementById('pickCountOutput'),
  multiplier: document.getElementById('multiplierOutput'),
  nextMultiplier: document.getElementById('nextMultiplierOutput'),
  profit: document.getElementById('profitOutput'),
  betLimits: document.getElementById('betLimitsDisplay'),
  banner: document.getElementById('roundBanner'),
  roundResult: document.getElementById('roundResult'),
  roundResultLabel: document.getElementById('roundResultLabel'),
  roundResultTitle: document.getElementById('roundResultTitle'),
  roundResultBurn: document.getElementById('roundResultBurn'),
  roundResultPayout: document.getElementById('roundResultPayout'),
  roundResultNote: document.getElementById('roundResultNote'),
  totalBurned: document.getElementById('totalBurned'),
  recentGamesBody: document.getElementById('recentGamesBody'),
  yourGamesBody: document.getElementById('yourGamesBody'),
};

function init() {
  renderBoard();
  bindEvents();
  refreshPublicStats();
  updateUi();
  if (isLiveConfigured()) tryAutoReconnect();
  setInterval(refreshPublicStats, 30000);
}

function bindEvents() {
  els.connectBtn.addEventListener('click', connectWallet);
  els.startBtn.addEventListener('click', startGame);
  els.cashoutBtn.addEventListener('click', cashOut);

  els.betInput.addEventListener('input', () => {
    useThisBetApproval();
    updateUi(false);
  });

  els.betInput.addEventListener('change', () => {
    normalizeBetInput();
    updateUi(false);
  });

  document.querySelectorAll('[data-quick-bet]').forEach(button => {
    button.addEventListener('click', () => {
      const quickBet = button.dataset.quickBet === 'max'
        ? Number(ethers.utils.formatUnits(state.maxBet, 18))
        : Number(button.dataset.quickBet);
      setBetAmount(quickBet, true);
    });
  });

  els.mineSelect.addEventListener('change', () => {
    state.mines = Number(els.mineSelect.value);
    clearPreparedSession();
    updateUi();
    prepareMinesSession().catch(() => {});
  });
}

function setBetAmount(amount, confirmed) {
  const next = clampBet(Number(amount));
  state.bet = next;
  els.betInput.value = next;
  useThisBetApproval();
  updateUi(!!confirmed);
}

function normalizeBetInput() {
  const value = Number(String(els.betInput.value || '').trim());
  if (!Number.isFinite(value) || value <= 0) return 0;
  const next = clampBet(value);
  state.bet = next;
  els.betInput.value = next;
  return next;
}

function renderBoard() {
  els.board.innerHTML = '';
  for (let i = 0; i < TILE_COUNT; i++) {
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.type = 'button';
    tile.dataset.index = String(i);
    tile.setAttribute('aria-label', 'Tile ' + (i + 1));
    tile.addEventListener('click', () => revealTile(i));
    els.board.appendChild(tile);
  }
}

async function connectWallet() {
  if (!isLiveConfigured()) {
    updateBanner('Deploy MinesGameLive, then paste its address into main-live.js', 'loss');
    return;
  }
  if (!window.showWalletModal) {
    updateBanner('Wallet modal failed to load', 'loss');
    return;
  }

  try {
    const result = await window.showWalletModal();
    state.provider = result.provider;
    state.signer = result.signer;
    state.player = result.address;
    await initContracts();
  } catch (err) {
    if (err.message !== 'dismissed') updateBanner('Wallet connection failed', 'loss');
  }
}

async function tryAutoReconnect() {
  if (!window.ethereum) return;
  try {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (!accounts.length) return;
    state.provider = new ethers.providers.Web3Provider(window.ethereum);
    state.signer = state.provider.getSigner();
    state.player = await state.signer.getAddress();
    const network = await state.provider.getNetwork();
    if (network.chainId !== PULSECHAIN_ID) return;
    await initContracts();
  } catch (_) {}
}

async function initContracts() {
  state.minesContract = new ethers.Contract(MINES_LIVE_ADDRESS, LIVE_MINES_ABI, state.signer);
  state.cashxContract = new ethers.Contract(CASHX_ADDRESS, CASHX_ABI, state.signer);

  els.connectBtn.textContent = shortAddress(state.player);
  els.connectBtn.classList.add('connected');
  els.networkLabel.textContent = 'PulseChain';

  await Promise.all([refreshLimits(), refreshBalance(), loadPlayerGames()]);
  updateBanner('Start a game, then reveal tiles instantly');
  updateUi();
  prepareMinesSession().catch(() => {});

  if (window.ethereum) {
    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged', () => location.reload());
  }
}

async function refreshLimits() {
  if (!liveMinesRO) return;
  try {
    const [min, max] = await Promise.all([liveMinesRO.minBet(), liveMinesRO.maxBet()]);
    state.minBet = min;
    state.maxBet = max.lt(ethers.utils.parseUnits(String(UI_MAX_BET), 18))
      ? max
      : ethers.utils.parseUnits(String(UI_MAX_BET), 18);
    els.betInput.min = String(UI_MIN_BET);
    els.betInput.max = String(UI_MAX_BET);
    els.betInput.step = String(UI_BET_STEP);
    if (els.betLimits) {
      els.betLimits.textContent = 'Min ' + fmtCashx(state.minBet) + ' · Max ' + fmtCashx(state.maxBet) + ' CASHX';
    }
  } catch (_) {}
}

async function refreshBalance() {
  if (!state.cashxContract || !state.player) return;
  try {
    const balance = await state.cashxContract.balanceOf(state.player);
    if (els.balance) els.balance.textContent = fmtCashx(balance) + ' CASHX';
  } catch (_) {}
}

async function refreshPublicStats() {
  if (!liveMinesRO) {
    els.totalBurned.textContent = 'Deploy V2 first';
    updateBanner('Instant Mines contract and backend are ready to wire');
    return;
  }
  try {
    const burned = await liveMinesRO.totalBurned();
    els.totalBurned.textContent = fmtCashx(burned) + ' CASHX';
    await loadRecentGames();
  } catch (_) {
    els.totalBurned.textContent = 'Unavailable';
  }
}

function currentSessionKey() {
  if (!state.player) return '';
  return state.player.toLowerCase() + ':' + Number(els.mineSelect.value || state.mines || 0);
}

function clearPreparedSession() {
  state.preparedSession = null;
  state.sessionPromise = null;
  state.sessionKey = '';
}

function prepareMinesSession() {
  if (!state.player || state.activeGame) return Promise.resolve(null);
  const key = currentSessionKey();
  if (state.preparedSession && state.sessionKey === key) return Promise.resolve(state.preparedSession);
  if (state.sessionPromise && state.sessionKey === key) return state.sessionPromise;

  state.sessionKey = key;
  state.sessionPromise = api('/api/mines/session', {
    player: state.player,
    mineCount: Number(els.mineSelect.value),
  }).then(session => {
    if (state.sessionKey === key) state.preparedSession = session;
    return session;
  }).catch(err => {
    if (state.sessionKey === key) clearPreparedSession();
    throw err;
  });
  return state.sessionPromise;
}

async function takePreparedMinesSession() {
  const key = currentSessionKey();
  const session = await prepareMinesSession();
  if (!session || state.sessionKey !== key) throw new Error('Could not prepare Mines seed.');
  clearPreparedSession();
  return session;
}

async function startGame() {
  window._minesStopDemo?.();
  if (state.transacting || state.activeGame) return;
  if (!state.signer) {
    await connectWallet();
    if (!state.signer) return;
  }

  const betAmount = parseBetAmount();
  if (!betAmount) return;

  state.transacting = true;
  updateUi();

  try {
    const mineCount = Number(els.mineSelect.value);
    const sessionPromise = prepareMinesSession();
    setWalletFlow('start', 'Checking approval and preparing game seed...');
    updateBanner('Checking approval and preparing game seed...', 'pending');
    const allowance = await state.cashxContract.allowance(state.player, MINES_LIVE_ADDRESS);
    if (allowance.lt(betAmount)) {
      const approvalAmount = approvalAmountWei(betAmount);
      setWalletFlow('approve', 'Step 1 of 2: Approve CASHX spend in MetaMask...');
      updateBanner('Step 1 of 2: Approve up to ' + fmtCashx(approvalAmount) + ' CASHX in MetaMask...', 'pending');
      const approveTx = await state.cashxContract.approve(
        MINES_LIVE_ADDRESS,
        approvalAmount,
        await txOptions(state.cashxContract, 'approve', [MINES_LIVE_ADDRESS, approvalAmount])
      );
      updateBanner('Step 1 of 2: Waiting for approval confirmation...', 'pending');
      await waitForTx(approveTx);
      if (window.CashXNav && window.CashXNav.refreshApprovalAllowance) {
        window.CashXNav.refreshApprovalAllowance();
      }
      updateBanner('Approval confirmed.', 'win');
    }

    const session = await sessionPromise.then(() => takePreparedMinesSession());

    setWalletFlow('start', allowance.lt(betAmount)
      ? 'Step 2 of 2: Confirm game start in MetaMask...'
      : 'Step 1 of 1: Confirm game start in MetaMask...');
    updateBanner(allowance.lt(betAmount)
      ? 'Step 2 of 2: Confirm game start in MetaMask...'
      : 'Step 1 of 1: Confirm game start in MetaMask...', 'pending');
    const startArgs = [betAmount, mineCount, session.serverSeedHash];
    const tx = await state.minesContract.startGame(
      ...startArgs,
      await txOptions(state.minesContract, 'startGame', startArgs)
    );
    updateBanner('Starting instant Mines... waiting for block confirmation.', 'pending');
    const receipt = await waitForTx(tx);
    if (window.CashXNav && window.CashXNav.refreshApprovalAllowance) {
      window.CashXNav.refreshApprovalAllowance();
    }
    const started = parseGameStarted(receipt);
    if (!started) throw new Error('GameStarted event not found');

    await api('/api/mines/attach', {
      sessionId: session.sessionId,
      gameId: started.gameId,
      betAmount: betAmount.toString(),
      contractAddress: MINES_LIVE_ADDRESS,
    });

    state.activeGame = {
      sessionId: session.sessionId,
      gameId: started.gameId,
      betAmount: betAmount.toString(),
      mineCount,
    };
    state.safeTiles = [];
    state.mineTiles = [];
    state.forceCashout = false;
    resetGrid();
    hideRoundResult();
    updateBanner('Game live. Pick a tile.', 'live');
    setWalletFlow('reveal', 'Game started. Pick tiles instantly; cash out or hit a mine to settle.');
    await Promise.all([refreshBalance(), refreshPublicStats(), loadPlayerGames()]);
  } catch (err) {
    updateBanner(readableError(err), 'loss');
  } finally {
    state.transacting = false;
    updateUi();
  }
}

async function revealTile(index) {
  if (state.transacting) return;
  if (!state.activeGame) {
    updateBanner('Start a game first');
    return;
  }
  if (state.safeTiles.includes(index) || state.mineTiles.includes(index)) return;
  if (state.forceCashout) {
    updateBanner('Cash out this round before picking again', 'win');
    return;
  }

  state.transacting = true;
  markPending(index);
  updateUi();

  try {
    const result = await api('/api/mines/reveal', {
      sessionId: state.activeGame.sessionId,
      tile: index,
    });

    if (result.hitMine) {
      state.mineTiles = result.mineTiles || [index];
      revealMines(state.mineTiles);
      updateBanner('Mine hit. Settling game...', 'loss');
      await settleResult(result);
      showRoundResult(result);
      finishGame();
      return;
    }

    state.safeTiles = result.safeTiles;
    state.forceCashout = !!result.forceCashout;
    markSafe(index);
    updateBanner(state.forceCashout ? 'Safe. Max reveal reached - cash out now.' : 'Safe. Cash out or pick again.', 'win');
  } catch (err) {
    clearPending(index);
    updateBanner(readableError(err), 'loss');
  } finally {
    state.transacting = false;
    updateUi();
  }
}

async function cashOut() {
  if (state.transacting || !state.activeGame || !state.safeTiles.length) return;

  state.transacting = true;
  updateUi();

  try {
    updateBanner('Locking cash out result...');
    const result = await api('/api/mines/cashout', {
      sessionId: state.activeGame.sessionId,
    });
    state.mineTiles = result.mineTiles || [];
    revealMines(state.mineTiles);
    await settleResult(result);
    updateBanner('Cashed out · ' + (Number(result.multiplierBps) / BPS).toFixed(2) + 'x', 'win');
    showRoundResult(result);
    finishGame();
  } catch (err) {
    updateBanner(readableError(err), 'loss');
  } finally {
    state.transacting = false;
    updateUi();
  }
}

async function settleResult(result) {
  if (result.txHash) {
    updateBanner('Settlement submitted by server');
    setWalletFlow('complete', 'Settlement complete. Payout and burn applied.');
    await Promise.all([refreshBalance(), refreshPublicStats(), loadPlayerGames()]);
    return;
  }

  setWalletFlow('payout', result.won ? 'Step 1 of 1: Confirm cash out payout in MetaMask...' : 'Step 1 of 1: Confirm final settlement in MetaMask...');
  updateBanner(result.won ? 'Confirm cash out payout' : 'Confirm final settlement');
  const settleArgs = [
    state.activeGame.gameId,
    result.revealedMask,
    !!result.won,
    result.serverSeed,
    result.signature
  ];
  const tx = await state.minesContract.settleGame(
    ...settleArgs,
    await txOptions(state.minesContract, 'settleGame', settleArgs)
  );
  await waitForTx(tx);
  setWalletFlow('complete', 'Settlement complete. Payout and burn applied.');
  await Promise.all([refreshBalance(), refreshPublicStats(), loadPlayerGames()]);
}

function finishGame() {
  state.activeGame = null;
  state.safeTiles = [];
  state.forceCashout = false;
  clearPreparedSession();
  prepareMinesSession().catch(() => {});
}

function resetGrid() {
  document.querySelectorAll('.tile').forEach(tile => {
    tile.className = 'tile';
    tile.textContent = '';
  });
}

async function loadRecentGames() {
  if (!liveMinesRO) return;
  try {
    const current = await roProvider.getBlockNumber();
    const fromBlock = Math.max(0, current - 120000);
    const events = await liveMinesRO.queryFilter(liveMinesRO.filters.GameSettled(), fromBlock, current);
    const recent = events.slice(-20).reverse();
    if (!recent.length) {
      els.recentGamesBody.innerHTML = '<tr><td colspan="7" class="empty-cell">No recent instant Mines games found.</td></tr>';
      return;
    }
    els.recentGamesBody.innerHTML = recent.map(event => {
      const args = event.args;
      const multiplier = args.multiplierBps.toNumber() / BPS;
      const verifyUrl = '../verifier.html?mode=mines&tx=' + event.transactionHash;
      return '<tr>' +
        '<td>#' + args.gameId.toString() + '</td>' +
        '<td>' + shortAddress(args.player) + '</td>' +
        '<td><span class="result-pill ' + (args.won ? 'win' : 'loss') + '">' + (args.won ? 'Cashout' : 'Mine') + '</span></td>' +
        '<td>' + fmtCashx(args.bet) + ' CASHX</td>' +
        '<td>' + (args.won ? multiplier.toFixed(2) + 'x' : '0x') + '</td>' +
        '<td>' + fmtCashx(args.burned) + ' CASHX</td>' +
        '<td><a class="tx-placeholder verify-link" href="' + verifyUrl + '">Verify</a></td>' +
      '</tr>';
    }).join('');
  } catch (_) {
    els.recentGamesBody.innerHTML = '<tr><td colspan="7" class="empty-cell">Could not load recent instant Mines games.</td></tr>';
  }
}

async function loadPlayerGames() {
  if (!state.player || !liveMinesRO) return;
  try {
    const ids = await liveMinesRO.getPlayerGames(state.player);
    if (!ids.length) {
      els.yourGamesBody.innerHTML = '<tr><td colspan="5" class="empty-cell">No instant Mines games for this wallet yet.</td></tr>';
      return;
    }
    els.yourGamesBody.innerHTML = ids.slice(-20).reverse().map(id => (
      '<tr>' +
        '<td>#' + id.toString() + '</td>' +
        '<td><span class="result-pill pending">Started</span></td>' +
        '<td>On-chain</td>' +
        '<td>Check settlement</td>' +
        '<td><a class="tx-placeholder" href="../verifier.html?mode=mines&id=' + id.toString() + '">Verify</a></td>' +
      '</tr>'
    )).join('');
  } catch (_) {
    els.yourGamesBody.innerHTML = '<tr><td colspan="5" class="empty-cell">Could not load your instant Mines games.</td></tr>';
  }
}

function parseGameStarted(receipt) {
  const iface = new ethers.utils.Interface(LIVE_MINES_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MINES_LIVE_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'GameStarted') {
        return { gameId: parsed.args.gameId.toString() };
      }
    } catch (_) {}
  }
  return null;
}

async function api(path, payload) {
  let response;
  try {
    response = await fetch(BACKEND_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (_) {
    throw new Error('Instant Mines server is not running');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Backend request failed');
  return data;
}

async function txOptions(contract, method, args) {
  // PulseChain gas price cap — some RPCs return inflated values; 500 Gwei is a safe ceiling
  const MAX_GAS_PRICE_GWEI = ethers.utils.parseUnits('500', 'gwei');
  const FALLBACK_GAS_LIMIT = ethers.BigNumber.from(350000);

  let gasPrice;
  try {
    const raw = await state.provider.getGasPrice();
    gasPrice = raw.gt(MAX_GAS_PRICE_GWEI) ? MAX_GAS_PRICE_GWEI : raw.mul(130).div(100);
  } catch (_) {
    gasPrice = ethers.utils.parseUnits('10', 'gwei'); // safe default for PulseChain
  }

  try {
    const estimate = await contract.estimateGas[method](...args);
    return { gasLimit: estimate.mul(130).div(100), gasPrice };
  } catch (estimateErr) {
    // Gas estimation failed — tx may revert. Use a capped fallback so MetaMask
    // doesn't invent an absurd gas limit that triggers false "insufficient funds".
    const reason = estimateErr.reason || estimateErr.message || '';
    if (/revert|invalid|already settled|not open/i.test(reason)) {
      throw new Error('Cannot settle: ' + (estimateErr.reason || 'the game may already be settled on-chain.'));
    }
    return { gasLimit: FALLBACK_GAS_LIMIT, gasPrice };
  }
}

function parseBetAmount() {
  if (!els.betInput.value.trim()) {
    updateBanner('Enter a valid bet amount', 'loss');
    return null;
  }
  state.bet = clampBet(Number(els.betInput.value));
  els.betInput.value = state.bet;
  const raw = String(state.bet);
  if (!raw || Number(raw) <= 0) {
    updateBanner('Enter a valid bet amount', 'loss');
    return null;
  }
  try {
    const amount = ethers.utils.parseUnits(raw, 18);
    if (amount.lt(state.minBet)) {
      updateBanner('Bet below minimum', 'loss');
      return null;
    }
    if (amount.gt(state.maxBet)) {
      updateBanner('Bet above maximum', 'loss');
      return null;
    }
    return amount;
  } catch (_) {
    updateBanner('Enter a valid bet amount', 'loss');
    return null;
  }
}

function selectApproval(value) {
  state.selectedApproval = normalizeApprovalPreset(value);
}

function useThisBetApproval() {
  state.selectedApproval = 'bet';
  try { localStorage.removeItem('cashx:approvalPreset'); } catch (_) {}
  window.dispatchEvent(new CustomEvent('cashx:approvalPresetChanged', { detail: { value: 'bet' } }));
}

function getStoredApprovalPreset() {
  try { localStorage.removeItem('cashx:approvalPreset'); } catch (_) {}
  return 'bet';
}

function normalizeApprovalPreset(value) {
  const raw = String(value || 'bet').trim().replace(/,/g, '');
  if (raw === 'bet' || raw.toLowerCase() === 'this bet') return 'bet';
  if (!/^\d+(\.\d)?\d*$/.test(raw)) return 'bet';
  const amount = Math.max(100, Math.min(1000000, Math.floor(Number(raw))));
  if (!Number.isFinite(amount)) return 'bet';
  return String(amount);
}

function approvalAmountWei(requiredWei) {
  if (state.selectedApproval === 'bet') return requiredWei;
  const presetWei = ethers.utils.parseUnits(String(state.selectedApproval), 18);
  return presetWei.gt(requiredWei) ? presetWei : requiredWei;
}

window.addEventListener('cashx:approvalPresetChanged', event => {
  selectApproval(event.detail && event.detail.value);
});

function calculateMultiplier(safePicks, mines) {
  if (!safePicks) return 1;
  let probability = 1;
  for (let i = 0; i < safePicks; i++) {
    probability *= (TILE_COUNT - mines - i) / (TILE_COUNT - i);
  }
  const fair = 1 / probability;
  return Math.max(1, fair * (BPS - HOUSE_EDGE_BPS) / BPS);
}

function updateUi(confirmed) {
  const rawBet = Number(els.betInput.value);
  state.bet = Number.isFinite(rawBet) && rawBet > 0 ? clampBet(rawBet) : 0;
  if (Number(els.betInput.value) > UI_MAX_BET) els.betInput.value = clampBet(Number(els.betInput.value));
  state.mines = Number(els.mineSelect.value);
  if (state.mines > MAX_MINE_COUNT) {
    state.mines = MAX_MINE_COUNT;
    els.mineSelect.value = String(MAX_MINE_COUNT);
  }
  const safePicks = state.safeTiles.length;
  const multiplier = calculateMultiplier(safePicks, state.mines);
  const next = state.forceCashout ? multiplier : calculateMultiplier(safePicks + 1, state.mines);
  const liveProfit = Math.max(0, Math.floor(state.bet * multiplier - state.bet));

  els.pickCount.textContent = safePicks + ' safe';
  els.multiplier.textContent = multiplier.toFixed(2) + 'x';
  els.nextMultiplier.textContent = next.toFixed(2) + 'x';
  els.profit.textContent = formatNumber(liveProfit) + ' CASHX';
  updateBetPreview(!!confirmed, multiplier);

  els.startBtn.textContent = state.activeGame ? 'Game Running' : 'Start Game';
  els.startBtn.disabled = state.transacting || !!state.activeGame || !isLiveConfigured();
  els.cashoutBtn.disabled = state.transacting || !state.activeGame || !safePicks;

  const controlsLocked = state.transacting || !!state.activeGame;
  els.betInput.disabled = controlsLocked;
  els.mineSelect.disabled = controlsLocked;
  document.querySelectorAll('[data-quick-bet]').forEach(button => {
    button.disabled = controlsLocked;
    const quickAmount = button.dataset.quickBet === 'max'
      ? Number(ethers.utils.formatUnits(state.maxBet, 18))
      : Number(button.dataset.quickBet);
    button.classList.toggle('active', !controlsLocked && state.bet > 0 && quickAmount === state.bet);
  });

  document.querySelectorAll('.tile').forEach(tile => {
    const index = Number(tile.dataset.index);
    tile.disabled = state.transacting || !state.activeGame || state.forceCashout || state.safeTiles.includes(index) || state.mineTiles.includes(index);
  });
}

function updateBetPreview(confirmed, multiplier) {
  const valid = Number.isFinite(state.bet) && state.bet > 0;
  const activeMultiplier = Number.isFinite(multiplier) ? multiplier : 1;
  const burn = valid ? state.bet * HOUSE_EDGE_BPS / BPS : 0;
  const payout = valid ? state.bet * activeMultiplier : 0;

  if (els.previewTotalPot) els.previewTotalPot.textContent = valid ? formatNumber(payout) + ' CASHX' : '—';
  if (els.previewBurn) els.previewBurn.textContent = valid ? formatNumber(burn) + ' CASHX' : '—';
  if (els.previewWinnerGets) els.previewWinnerGets.textContent = valid ? formatNumber(payout) + ' CASHX' : '—';
}

function markPending(index) {
  const tile = getTile(index);
  if (!tile) return;
  tile.className = 'tile pending';
  tile.textContent = '?';
}

function clearPending(index) {
  const tile = getTile(index);
  if (!tile) return;
  tile.className = 'tile';
  tile.textContent = '';
}

function markSafe(index) {
  const tile = getTile(index);
  if (!tile) return;
  tile.className = 'tile safe';
  tile.textContent = '◆';
}

function revealMines(mines) {
  mines.forEach(index => {
    const tile = getTile(index);
    if (!tile) return;
    tile.className = 'tile mine';
    tile.textContent = '✹';
  });
}

function getTile(index) {
  return els.board.querySelector('[data-index="' + index + '"]');
}

function updateBanner(text, type = '') {
  const isStep = text && text.toLowerCase().includes('step');
  if (isStep) {
    els.banner.innerHTML =
      '<div class="status-main">' + escapeHtml(text) + '</div>' +
      '<div class="status-tip">If the transaction is slow, use <strong>Speed Up</strong> in MetaMask.</div>';
  } else {
    els.banner.textContent = text;
  }
  els.banner.className = 'round-banner ' + type;
}

function setWalletFlow(stage, note) {
  const steps = ['approve', 'start', 'reveal', 'payout'];
  const isComplete = stage === 'complete';
  const activeIndex = isComplete ? steps.length : steps.indexOf(stage);
  document.querySelectorAll('[data-tx-step]').forEach(step => {
    const index = steps.indexOf(step.dataset.txStep);
    step.classList.toggle('done', index > -1 && (isComplete || index < activeIndex));
    step.classList.toggle('active', !isComplete && step.dataset.txStep === stage);
  });
  const noteEl = document.getElementById('txProgressNote');
  if (noteEl && note) noteEl.textContent = note;
}

async function waitForTx(tx) {
  try {
    return await tx.wait();
  } catch (waitErr) {
    if (waitErr && waitErr.code === 'TRANSACTION_REPLACED') {
      if (waitErr.cancelled) {
        const cancelled = new Error('Transaction cancelled in wallet.');
        cancelled.code = 4001;
        throw cancelled;
      }
      return waitErr.receipt;
    }
    throw waitErr;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showRoundResult(result) {
  const betAmount = state.activeGame ? BigInt(state.activeGame.betAmount) : 0n;
  const burnAmount = (betAmount * BigInt(HOUSE_EDGE_BPS)) / BigInt(BPS);
  const multiplierBps = BigInt(result.multiplierBps || 0);
  const payout = result.won ? (betAmount * multiplierBps) / BigInt(BPS) : 0n;

  updateBanner(
    result.won ? 'Cashout complete. Play again when ready.' : 'Mine hit. Burn submitted. Play again when ready.',
    result.won ? 'win' : 'loss'
  );
  els.roundResult.hidden = false;
  els.roundResult.className = 'round-result ' + (result.won ? 'win' : 'loss');
  els.roundResultLabel.textContent = result.won ? 'Cashout Complete' : 'Mine Hit';
  els.roundResultTitle.textContent = result.won
    ? 'You won ' + fmtCashx(payout.toString()) + ' CASHX'
    : 'You lost this round';
  els.roundResultBurn.textContent = fmtCashx(burnAmount.toString()) + ' CASHX';
  els.roundResultPayout.textContent = fmtCashx(payout.toString()) + ' CASHX';
  els.roundResultNote.textContent = result.won
    ? 'Payout submitted. Start another game when you are ready.'
    : '3% was burned and the rest stayed in the game reserve. You can play again now.';
}

function hideRoundResult() {
  els.roundResult.hidden = true;
  els.roundResult.className = 'round-result';
}

function isLiveConfigured() {
  return ethers.utils.isAddress(MINES_LIVE_ADDRESS);
}

function clampBet(value) {
  if (!Number.isFinite(value)) return UI_MIN_BET;
  const stepped = Math.round(Math.floor(value) / UI_BET_STEP) * UI_BET_STEP;
  return Math.min(UI_MAX_BET, Math.max(UI_MIN_BET, stepped));
}

function fmtCashx(value) {
  const n = parseFloat(ethers.utils.formatUnits(value, 18));
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function shortAddress(address) {
  if (!address) return '-';
  return address.slice(0, 6) + '...' + address.slice(-4);
}

function readableError(err) {
  const msg = err.reason || (err.data && err.data.message) || err.message || 'Transaction failed';
  if (err.code === 'TRANSACTION_REPLACED' && err.cancelled) return 'Transaction was cancelled in MetaMask.';
  if (err.code === 'INSUFFICIENT_FUNDS' || /INTERNAL_ERROR.*insufficient funds|insufficient funds for intrinsic/i.test(msg)) {
    return 'Settlement error — the server settlement wallet is out of gas. A server update is needed to fix this.';
  }
  if (/Transfer failed|ERC20.*balance|transfer amount exceeds/i.test(msg)) {
    return 'CASHX transfer failed. Your balance may be too low for this bet.';
  }
  if (/user rejected|user denied/i.test(msg)) return 'Transaction rejected in MetaMask.';
  return msg.replace('execution reverted: ', '');
}

init();
