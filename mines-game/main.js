'use strict';

const TILE_COUNT = 25;
const HOUSE_EDGE_BPS = 300;
const BPS = 10000;
const MINES_GAME_ADDRESS = '0xF5Ba5129dD41acb8aF5050aF1EcA84dD497E3095';
const CASHX_ADDRESS = '0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665';
const PULSECHAIN_ID = 369;
const RPC_URL = 'https://rpc.pulsechain.com';
const MINES_ABI = [
  'function placeGame(uint256 betAmount, uint8 mineCount, uint8 pickCount, bytes32 commitHash) external returns (uint256)',
  'function revealGame(uint256 gameId, uint8[] picks, bytes32 secret) external',
  'function pendingGames(uint256) view returns (address player, uint256 amount, uint8 mineCount, uint8 pickCount, bytes32 commitHash, uint256 targetBlock, bool settled)',
  'function calculatePayout(uint256 betAmount, uint8 mineCount, uint8 pickCount) view returns (uint256)',
  'function getPlayerGames(address player) view returns (uint256[])',
  'function totalBurned() view returns (uint256)',
  'function minBet() view returns (uint256)',
  'function maxBet() view returns (uint256)',
  'event GamePlaced(uint256 indexed gameId, address indexed player, uint256 bet, uint8 mineCount, uint8 pickCount, uint256 targetBlock)',
  'event GameRevealed(uint256 indexed gameId, address indexed player, uint8[] picks, bytes32 secret, bytes32 targetBlockHash)',
  'event GameSettled(uint256 indexed gameId, address indexed player, bool won, uint256 bet, uint256 payout, uint256 burned, uint256 multiplierBps)',
];

const CASHX_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const roProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
const minesRO = new ethers.Contract(MINES_GAME_ADDRESS, MINES_ABI, roProvider);

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
  selected: [],
  pending: null,
  transacting: false,
  resultShown: false,
  latestBlock: 0,
  selectedApproval: getStoredApprovalPreset(),
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
  betLimits: document.getElementById('betLimitsDisplay'),
  banner: document.getElementById('roundBanner'),
  totalBurned: document.getElementById('totalBurned'),
  recentGamesBody: document.getElementById('recentGamesBody'),
  yourGamesBody: document.getElementById('yourGamesBody'),
};

function init() {
  renderBoard();
  bindEvents();
  hydratePending();
  refreshPublicStats();
  updateUi();
  tryAutoReconnect();
  setInterval(refreshPublicStats, 30000);
}

function bindEvents() {
  els.connectBtn.addEventListener('click', connectWallet);
  els.startBtn.addEventListener('click', lockBet);
  els.cashoutBtn.addEventListener('click', revealPendingGame);

  els.betInput.addEventListener('change', () => {
    state.bet = clampBet(Number(els.betInput.value));
    els.betInput.value = state.bet;
    updateUi();
  });

  document.querySelectorAll('[data-quick-bet]').forEach(button => {
    button.addEventListener('click', () => {
      const quickBet = button.dataset.quickBet === 'max'
        ? Number(ethers.utils.formatUnits(state.maxBet, 18))
        : Number(button.dataset.quickBet);
      state.bet = clampBet(quickBet);
      els.betInput.value = state.bet;
      updateUi();
    });
  });

  els.mineSelect.addEventListener('change', () => {
    state.mines = Number(els.mineSelect.value);
    clearSelection();
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
    tile.addEventListener('click', () => togglePick(i));
    els.board.appendChild(tile);
  }
}

async function connectWallet() {
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
  state.minesContract = new ethers.Contract(MINES_GAME_ADDRESS, MINES_ABI, state.signer);
  state.cashxContract = new ethers.Contract(CASHX_ADDRESS, CASHX_ABI, state.signer);

  els.connectBtn.textContent = shortAddress(state.player);
  els.connectBtn.classList.add('connected');
  els.networkLabel.textContent = 'PulseChain';

  await Promise.all([
    refreshLimits(),
    refreshBalance(),
    loadPlayerGames(),
  ]);

  hydratePending();
  updateUi();
  updateBanner(state.pending ? 'Reveal your pending Mines game' : 'Choose tiles before locking');

  if (window.ethereum) {
    window.ethereum.on('accountsChanged', () => location.reload());
    window.ethereum.on('chainChanged', () => location.reload());
  }
}

async function refreshLimits() {
  try {
    const [min, max] = await Promise.all([minesRO.minBet(), minesRO.maxBet()]);
    state.minBet = min;
    state.maxBet = max;
    els.betInput.min = ethers.utils.formatUnits(min, 18);
    els.betInput.max = ethers.utils.formatUnits(max, 18);
    if (els.betLimits) {
      els.betLimits.textContent = 'Min ' + fmtCashx(min) + ' · Max ' + fmtCashx(max) + ' CASHX';
    }
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
  try {
    const [burned, blockNumber] = await Promise.all([
      minesRO.totalBurned(),
      roProvider.getBlockNumber(),
    ]);
    state.latestBlock = blockNumber;
    els.totalBurned.textContent = fmtCashx(burned) + ' CASHX';
    await loadRecentGames();
    updateUi();
  } catch (_) {
    els.totalBurned.textContent = 'Unavailable';
  }
}

function togglePick(index) {
  if (state.pending || state.transacting) return;
  if (state.resultShown) {
    state.resultShown = false;
    state.selected = [];
  }
  const existing = state.selected.indexOf(index);
  if (existing >= 0) {
    state.selected.splice(existing, 1);
  } else {
    const maxPicks = TILE_COUNT - state.mines;
    if (state.selected.length >= maxPicks) {
      updateBanner('Too many picks for this mine count', 'loss');
      return;
    }
    state.selected.push(index);
  }
  state.selected.sort((a, b) => a - b);
  updateTiles();
  updateUi();
}

async function lockBet() {
  if (state.transacting || state.pending) return;
  if (!state.signer) {
    await connectWallet();
    if (!state.signer) return;
  }
  if (!state.selected.length) {
    updateBanner('Select at least one tile first', 'loss');
    return;
  }

  const betAmount = parseBetAmount();
  if (!betAmount) return;

  state.transacting = true;
  state.resultShown = false;
  updateUi();

  try {
    const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const picks = state.selected.slice();
    const mineCount = Number(els.mineSelect.value);
    const commitHash = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
      ['address', 'uint8', 'uint8[]', 'bytes32'],
      [state.player, mineCount, picks, secret]
    ));

    const allowance = await state.cashxContract.allowance(state.player, MINES_GAME_ADDRESS);
    if (allowance.lt(betAmount)) {
      const approvalAmount = approvalAmountWei(betAmount);
      setWalletFlow('approve', 'Step 1 of 2: Approve CASHX spend in MetaMask...');
      updateBanner('Approve up to ' + fmtCashx(approvalAmount) + ' CASHX in your wallet');
      const approveTx = await state.cashxContract.approve(MINES_GAME_ADDRESS, approvalAmount);
      await approveTx.wait();
    }

    setWalletFlow('start', 'Step 2 of 2: Confirm Mines bet in MetaMask...');
    updateBanner('Confirm Mines bet in your wallet');
    const tx = await state.minesContract.placeGame(betAmount, mineCount, picks.length, commitHash);
    updateBanner('Locking bet on-chain...');
    const receipt = await tx.wait();
    const placed = parsePlacedEvent(receipt);
    if (!placed) throw new Error('GamePlaced event not found');

    state.pending = {
      gameId: placed.gameId,
      txHash: receipt.transactionHash,
      picks,
      secret,
      mineCount,
      betAmount: betAmount.toString(),
      targetBlock: placed.targetBlock,
    };
    savePending();
    updateBanner('Bet locked. Reveal after block ' + placed.targetBlock);
    setWalletFlow('reveal', 'Bet locked on-chain. Reveal when the block is ready.');
    await Promise.all([refreshBalance(), refreshPublicStats(), loadPlayerGames()]);
  } catch (err) {
    updateBanner(readableError(err), 'loss');
  } finally {
    state.transacting = false;
    updateUi();
  }
}

async function revealPendingGame() {
  if (!state.pending || state.transacting) return;
  if (!state.signer) {
    await connectWallet();
    if (!state.signer) return;
  }

  state.transacting = true;
  updateUi();

  try {
    const targetBlock = Number(state.pending.targetBlock);
    const currentBlock = await roProvider.getBlockNumber();
    if (currentBlock <= targetBlock) {
      updateBanner('Waiting for block ' + targetBlock + ' to mine');
      return;
    }

    setWalletFlow('reveal', 'Step 1 of 1: Confirm reveal transaction in MetaMask...');
    updateBanner('Confirm reveal in your wallet');
    const tx = await state.minesContract.revealGame(
      state.pending.gameId,
      state.pending.picks,
      state.pending.secret
    );
    updateBanner('Revealing result on-chain...');
    const receipt = await tx.wait();
    const settled = parseSettledEvent(receipt);
    const revealed = parseRevealedEvent(receipt);
    if (!settled) throw new Error('GameSettled event not found');

    applySettledResult(settled, revealed, receipt.transactionHash);
    setWalletFlow('payout', 'Reveal complete. Payout and burn settled.');
    clearPending();
    state.selected = [];
    await Promise.all([refreshBalance(), refreshPublicStats(), loadPlayerGames()]);
  } catch (err) {
    updateBanner(readableError(err), 'loss');
  } finally {
    state.transacting = false;
    updateUi();
  }
}

function applySettledResult(settled, revealed, txHash) {
  const gameId = Number(settled.gameId);
  const won = settled.won;
  const multiplier = settled.multiplierBps.toNumber() / BPS;
  const mineTiles = revealed
    ? generateMines(Number(settled.gameId), settled.player, state.pending.mineCount, revealed.targetBlockHash)
    : [];

  document.querySelectorAll('.tile').forEach(tile => {
    tile.disabled = true;
  });

  mineTiles.forEach(index => {
    const tile = getTile(index);
    if (tile) {
      tile.classList.add('mine');
      tile.textContent = '✹';
    }
  });

  state.pending.picks.forEach(index => {
    const tile = getTile(index);
    if (tile && !tile.classList.contains('mine')) {
      tile.classList.add('safe');
      tile.textContent = '◆';
    }
  });

  updateBanner(won ? 'You won · ' + multiplier.toFixed(2) + 'x' : 'Mine hit', won ? 'win' : 'loss');
  state.resultShown = true;
  addLocalRound({
    id: gameId,
    won,
    bet: settled.bet,
    payout: settled.payout,
    burn: settled.burned,
    mines: state.pending.mineCount,
    picks: state.pending.picks.length,
    multiplier,
    txHash,
    player: state.player,
  });
}

async function loadRecentGames() {
  try {
    const current = await roProvider.getBlockNumber();
    const fromBlock = Math.max(0, current - 120000);
    const events = await minesRO.queryFilter(minesRO.filters.GameSettled(), fromBlock, current);
    const recent = events.slice(-20).reverse();
    if (!recent.length) {
      els.recentGamesBody.innerHTML = '<tr><td colspan="7" class="empty-cell">No recent Mines settlements found.</td></tr>';
      return;
    }

    els.recentGamesBody.innerHTML = recent.map(event => {
      const args = event.args;
      const multiplier = args.multiplierBps.toNumber() / BPS;
      return '<tr>' +
        '<td>#' + args.gameId.toString() + '</td>' +
        '<td>' + shortAddress(args.player) + '</td>' +
        '<td><span class="result-pill ' + (args.won ? 'win' : 'loss') + '">' + (args.won ? 'Win' : 'Loss') + '</span></td>' +
        '<td>' + fmtCashx(args.bet) + ' CASHX</td>' +
        '<td>—</td>' +
        '<td>' + (args.won ? multiplier.toFixed(2) + 'x' : '0x') + '</td>' +
        '<td>' + fmtCashx(args.burned) + ' CASHX</td>' +
      '</tr>';
    }).join('');
  } catch (_) {
    els.recentGamesBody.innerHTML = '<tr><td colspan="7" class="empty-cell">Could not load recent Mines games.</td></tr>';
  }
}

async function loadPlayerGames() {
  if (!state.player) return;
  try {
    const ids = await minesRO.getPlayerGames(state.player);
    if (!ids.length) {
      els.yourGamesBody.innerHTML = '<tr><td colspan="7" class="empty-cell">No Mines games for this wallet yet.</td></tr>';
      return;
    }

    const recentIds = ids.slice(-20).reverse();
    const rows = await Promise.all(recentIds.map(async id => {
      const game = await minesRO.pendingGames(id);
      return { id, game };
    }));

    els.yourGamesBody.innerHTML = rows.map(({ id, game }) => {
      const pending = !game.settled;
      return '<tr>' +
        '<td>#' + id.toString() + '</td>' +
      '<td><span class="result-pill ' + (pending ? 'pending' : 'win') + '">' + (pending ? 'Pending' : 'Settled') + '</span></td>' +
        '<td>' + fmtCashx(game.amount) + ' CASHX</td>' +
        '<td>' + Number(game.pickCount) + '</td>' +
        '<td>Manual</td>' +
        '<td>' + (pending ? 'Reveal needed' : 'See verifier') + '</td>' +
        '<td><a class="tx-placeholder" href="../verifier.html?mode=mines&id=' + id.toString() + '">Verify</a></td>' +
      '</tr>';
    }).join('');
  } catch (_) {
    els.yourGamesBody.innerHTML = '<tr><td colspan="7" class="empty-cell">Could not load your Mines games.</td></tr>';
  }
}

function addLocalRound(round) {
  const resultClass = round.won ? 'win' : 'loss';
  const payout = round.won ? fmtCashx(round.payout) + ' CASHX' : '-';
  els.yourGamesBody.insertAdjacentHTML('afterbegin',
    '<tr>' +
      '<td>#' + round.id + '</td>' +
      '<td><span class="result-pill ' + resultClass + '">' + (round.won ? 'Win' : 'Loss') + '</span></td>' +
      '<td>' + fmtCashx(round.bet) + ' CASHX</td>' +
      '<td>' + round.picks + '</td>' +
      '<td>Manual</td>' +
      '<td>' + payout + '</td>' +
      '<td><a class="tx-placeholder" href="../verifier.html?mode=mines&tx=' + round.txHash + '">Verify</a></td>' +
    '</tr>'
  );
}

function parsePlacedEvent(receipt) {
  const iface = new ethers.utils.Interface(MINES_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MINES_GAME_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'GamePlaced') {
        return {
          gameId: parsed.args.gameId.toString(),
          targetBlock: parsed.args.targetBlock.toString(),
        };
      }
    } catch (_) {}
  }
  return null;
}

function parseSettledEvent(receipt) {
  const iface = new ethers.utils.Interface(MINES_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MINES_GAME_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'GameSettled') return parsed.args;
    } catch (_) {}
  }
  return null;
}

function parseRevealedEvent(receipt) {
  const iface = new ethers.utils.Interface(MINES_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MINES_GAME_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'GameRevealed') return parsed.args;
    } catch (_) {}
  }
  return null;
}

function generateMines(gameId, player, mineCount, entropy) {
  const mines = [];
  const seen = new Set();
  let nonce = 0;

  while (mines.length < mineCount) {
    const seed = ethers.utils.solidityKeccak256(
      ['bytes32', 'uint256', 'address', 'address', 'uint256'],
      [entropy, gameId, player, MINES_GAME_ADDRESS, nonce]
    );
    const tile = ethers.BigNumber.from(seed).mod(TILE_COUNT).toNumber();
    if (!seen.has(tile)) {
      seen.add(tile);
      mines.push(tile);
    }
    nonce++;
  }

  return mines;
}

function parseBetAmount() {
  const raw = els.betInput.value.trim();
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

function nextMultiplier() {
  const nextPick = state.selected.length + 1;
  if (nextPick > TILE_COUNT - state.mines) return calculateMultiplier(state.selected.length, state.mines);
  return calculateMultiplier(nextPick, state.mines);
}

function clearSelection() {
  state.selected = [];
  updateTiles();
  updateUi();
}

function updateTiles() {
  if (state.resultShown) return;
  document.querySelectorAll('.tile').forEach(tile => {
    const index = Number(tile.dataset.index);
    tile.className = state.selected.includes(index) ? 'tile selected' : 'tile';
    tile.textContent = state.selected.includes(index) ? '◆' : '';
    tile.disabled = !!state.pending || state.transacting;
  });
}

function getTile(index) {
  return els.board.querySelector('[data-index="' + index + '"]');
}

function updateUi() {
  const rawBet = Number(els.betInput.value);
  state.bet = Number.isFinite(rawBet) && rawBet > 0 ? clampBet(rawBet) : 0;
  state.mines = Number(els.mineSelect.value);

  const picks = state.pending ? state.pending.picks.length : state.selected.length;
  const multiplier = calculateMultiplier(picks, state.mines);
  const next = nextMultiplier();
  const liveProfit = Math.max(0, Math.floor(state.bet * multiplier - state.bet));
  const pendingCanReveal = state.pending && (!state.latestBlock || Number(state.pending.targetBlock) < state.latestBlock);

  els.pickCount.textContent = picks + ' selected';
  els.multiplier.textContent = multiplier.toFixed(2) + 'x';
  els.nextMultiplier.textContent = next.toFixed(2) + 'x';
  els.profit.textContent = formatNumber(liveProfit) + ' CASHX';

  els.startBtn.disabled = state.transacting || !!state.pending || !state.selected.length;
  els.cashoutBtn.disabled = state.transacting || !state.pending || !pendingCanReveal;
  els.cashoutBtn.textContent = state.pending && !pendingCanReveal ? 'Waiting Block' : 'Reveal Result';

  els.betInput.disabled = state.transacting || !!state.pending;
  els.mineSelect.disabled = state.transacting || !!state.pending;
  document.querySelectorAll('[data-quick-bet]').forEach(button => {
    button.disabled = els.betInput.disabled;
  });
  updateTiles();
}

function updateBanner(text, type = '') {
  els.banner.textContent = text;
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

function hydratePending() {
  if (!state.player) return;
  try {
    const raw = localStorage.getItem(pendingKey());
    state.pending = raw ? JSON.parse(raw) : null;
    if (state.pending) {
      state.selected = state.pending.picks.slice();
      els.mineSelect.value = String(state.pending.mineCount);
      state.mines = state.pending.mineCount;
      updateBanner('Reveal your pending Mines game');
    }
  } catch (_) {
    state.pending = null;
  }
}

function savePending() {
  if (state.player && state.pending) localStorage.setItem(pendingKey(), JSON.stringify(state.pending));
}

function clearPending() {
  if (state.player) localStorage.removeItem(pendingKey());
  state.pending = null;
}

function pendingKey() {
  return 'cashx-mines-pending-' + state.player.toLowerCase();
}

function clampBet(value) {
  if (!Number.isFinite(value)) return 500;
  return Math.max(1, Math.floor(value));
}

function fmtCashx(value) {
  const n = parseFloat(ethers.utils.formatUnits(value, 18));
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US');
}

function shortAddress(address) {
  if (!address) return '—';
  return address.slice(0, 6) + '...' + address.slice(-4);
}

function readableError(err) {
  const msg = err.reason || (err.data && err.data.message) || err.message || 'Transaction failed';
  return msg.replace('execution reverted: ', '');
}

init();
