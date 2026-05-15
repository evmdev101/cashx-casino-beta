'use strict';

const TILE_COUNT = 25;
const MAX_MINE_COUNT = 16;
const HOUSE_EDGE_BPS = 300;
const BPS = 10000;
const UI_MIN_BET = 500;
const UI_MAX_BET = 1000;
const UI_BET_STEP = 100;
const MINES_LIVE_ADDRESS = '0x684e6B760FC931BB858b3bf3dFC056e550b13D90';
const CASHX_ADDRESS = '0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665';
const BACKEND_URL = window.CASHX_MINES_BACKEND_URL || 'http://localhost:8787';
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
  minBet: ethers.utils.parseUnits('500', 18),
  maxBet: ethers.utils.parseUnits('5000', 18),
  mines: 3,
  activeGame: null,
  safeTiles: [],
  mineTiles: [],
  forceCashout: false,
  transacting: false,
};

const els = {
  board: document.getElementById('board'),
  balance: document.getElementById('balanceOutput'),
  betInput: document.getElementById('betInput'),
  mineSelect: document.getElementById('mineSelect'),
  startBtn: document.getElementById('startBtn'),
  cashoutBtn: document.getElementById('cashoutBtn'),
  connectBtn: document.getElementById('connectBtn'),
  networkLabel: document.getElementById('networkLabel'),
  pickCount: document.getElementById('pickCountOutput'),
  multiplier: document.getElementById('multiplierOutput'),
  nextMultiplier: document.getElementById('nextMultiplierOutput'),
  profit: document.getElementById('profitOutput'),
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

  els.betInput.addEventListener('change', () => {
    state.bet = clampBet(Number(els.betInput.value));
    els.betInput.value = state.bet;
    updateUi();
  });

  els.betInput.addEventListener('input', () => {
    const raw = Math.floor(Number(els.betInput.value));
    if (Number.isFinite(raw) && raw > UI_MAX_BET) {
      els.betInput.value = UI_MAX_BET;
      state.bet = UI_MAX_BET;
      updateUi();
    }
  });

  document.getElementById('halveBetBtn').addEventListener('click', () => {
    state.bet = clampBet(state.bet - UI_BET_STEP);
    els.betInput.value = state.bet;
    updateUi();
  });

  document.getElementById('doubleBetBtn').addEventListener('click', () => {
    state.bet = clampBet(state.bet + UI_BET_STEP);
    els.betInput.value = state.bet;
    updateUi();
  });

  els.mineSelect.addEventListener('change', () => {
    state.mines = Number(els.mineSelect.value);
    updateUi();
  });
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
  } catch (_) {}
}

async function refreshBalance() {
  if (!state.cashxContract || !state.player) return;
  try {
    const balance = await state.cashxContract.balanceOf(state.player);
    els.balance.textContent = fmtCashx(balance) + ' CASHX';
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
    updateBanner('Getting provably fair seed commitment...');
    const session = await api('/api/mines/session', {
      player: state.player,
      mineCount,
    });

    const allowance = await state.cashxContract.allowance(state.player, MINES_LIVE_ADDRESS);
    if (allowance.lt(betAmount)) {
      setWalletFlow('approve', 'Step 1 of 2: Approve CASHX spend in MetaMask...');
      updateBanner('Step 1 of 2: Approve CASHX spend in MetaMask...', 'pending');
      const approveTx = await state.cashxContract.approve(MINES_LIVE_ADDRESS, betAmount);
      updateBanner('Step 1 of 2: Waiting for approval confirmation...', 'pending');
      await waitForTx(approveTx);
      updateBanner('Approval confirmed.', 'win');
    }

    setWalletFlow('start', allowance.lt(betAmount)
      ? 'Step 2 of 2: Confirm game start in MetaMask...'
      : 'Step 1 of 1: Confirm game start in MetaMask...');
    updateBanner(allowance.lt(betAmount)
      ? 'Step 2 of 2: Confirm game start in MetaMask...'
      : 'Step 1 of 1: Confirm game start in MetaMask...', 'pending');
    const tx = await state.minesContract.startGame(betAmount, mineCount, session.serverSeedHash);
    updateBanner('Starting instant Mines... waiting for block confirmation.', 'pending');
    const receipt = await waitForTx(tx);
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
    return;
  }

  setWalletFlow('payout', result.won ? 'Step 1 of 1: Confirm cash out payout in MetaMask...' : 'Step 1 of 1: Confirm final settlement in MetaMask...');
  updateBanner(result.won ? 'Confirm cash out payout' : 'Confirm final settlement');
  const tx = await state.minesContract.settleGame(
    state.activeGame.gameId,
    result.revealedMask,
    !!result.won,
    result.serverSeed,
    result.signature
  );
  await waitForTx(tx);
  setWalletFlow('payout', 'Settlement complete. Payout and burn applied.');
  await Promise.all([refreshBalance(), refreshPublicStats(), loadPlayerGames()]);
}

function finishGame() {
  state.activeGame = null;
  state.safeTiles = [];
  state.forceCashout = false;
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

function parseBetAmount() {
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

function calculateMultiplier(safePicks, mines) {
  if (!safePicks) return 1;
  let probability = 1;
  for (let i = 0; i < safePicks; i++) {
    probability *= (TILE_COUNT - mines - i) / (TILE_COUNT - i);
  }
  const fair = 1 / probability;
  return Math.max(1, fair * (BPS - HOUSE_EDGE_BPS) / BPS);
}

function updateUi() {
  state.bet = clampBet(Number(els.betInput.value));
  if (Number(els.betInput.value) > UI_MAX_BET) els.betInput.value = state.bet;
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

  els.startBtn.textContent = state.activeGame ? 'Game Running' : 'Start Game';
  els.startBtn.disabled = state.transacting || !!state.activeGame || !isLiveConfigured();
  els.cashoutBtn.disabled = state.transacting || !state.activeGame || !safePicks;

  const controlsLocked = state.transacting || !!state.activeGame;
  els.betInput.disabled = controlsLocked;
  els.mineSelect.disabled = controlsLocked;
  document.getElementById('halveBetBtn').disabled = controlsLocked;
  document.getElementById('doubleBetBtn').disabled = controlsLocked;

  document.querySelectorAll('.tile').forEach(tile => {
    const index = Number(tile.dataset.index);
    tile.disabled = state.transacting || !state.activeGame || state.forceCashout || state.safeTiles.includes(index) || state.mineTiles.includes(index);
  });
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
  const activeIndex = steps.indexOf(stage);
  document.querySelectorAll('[data-tx-step]').forEach(step => {
    const index = steps.indexOf(step.dataset.txStep);
    step.classList.toggle('done', index > -1 && index < activeIndex);
    step.classList.toggle('active', step.dataset.txStep === stage);
  });
  const noteEl = document.getElementById('txProgressNote');
  if (noteEl && note) noteEl.textContent = note;
}

async function waitForTx(tx) {
  try {
    return await tx.wait();
  } catch (waitErr) {
    if (waitErr.code === 'TRANSACTION_REPLACED' && !waitErr.cancelled) {
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
  return Number(value).toLocaleString('en-US');
}

function shortAddress(address) {
  if (!address) return '-';
  return address.slice(0, 6) + '...' + address.slice(-4);
}

function readableError(err) {
  const msg = err.reason || (err.data && err.data.message) || err.message || 'Transaction failed';
  if (err.code === 'TRANSACTION_REPLACED' && err.cancelled) return 'Transaction was cancelled in MetaMask.';
  return msg.replace('execution reverted: ', '');
}

init();
