'use strict';

const CX_CONFIG = window.CashX && window.CashX.config;
const CX_TX = window.CashX && window.CashX.transactions;

const DICE_GAME_ADDRESS = CX_CONFIG ? CX_CONFIG.contracts.diceGame : '0x15A8C0D554D3e6971A46D696F69e8cBB8CF07977';

const CASHX_ADDRESS     = CX_CONFIG ? CX_CONFIG.addresses.cashxToken : '0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665';
const PULSECHAIN_ID     = CX_CONFIG ? CX_CONFIG.chain.id : 369;
const PULSECHAIN_HEX    = CX_CONFIG ? CX_CONFIG.chain.hexId : '0x171';

// ABIs
// Human-readable ABI format — ethers.js v5 understands this directly.

const DICE_ABI = [
  'function placeBet(bool betOver, uint256 betAmount, bytes32 commitHash) external returns (uint256)',
  'function revealBet(uint256 betId, bytes32 secret) external',
  'function forfeitExpiredBet(uint256 betId) external',
  'function totalBurned() external view returns (uint256)',
  'function minBet() external view returns (uint256)',
  'function maxBet() external view returns (uint256)',
  'event BetPlaced(uint256 indexed betId, address indexed player, bool over, uint256 bet, uint256 targetBlock)',
  'event Roll(uint256 indexed betId, address indexed player, uint8 result, bool over, uint256 bet, bool won)',
  'event Burned(uint256 amount)',
  'event BetRevealed(uint256 indexed betId, address indexed player, bytes32 secret, bytes32 targetBlockHash)',
];

const CASHX_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

// STATE
let provider, signer, diceContract, cashxContract;
let playerAddress = null;
let minBet = ethers.BigNumber.from('1').mul(ethers.BigNumber.from('10').pow(18));
let maxBet = ethers.BigNumber.from('5000').mul(ethers.BigNumber.from('10').pow(18));
let rolling = false;
let selectedApproval = getStoredApprovalPreset();
let latestCashxBalanceText = '0 CASHX';
const REVEAL_BLOCK_WAIT_MESSAGE = 'Waiting for the reveal block. If it feels slow, use Speed Up in your wallet.';
const DICE_BURN_BPS = 300;
const DICE_WIN_MULTIPLIER_BPS = 19500;

function emitDiceGameActive(active) {
  document.body.classList.toggle('cashx-dice-live', !!active);
  window.dispatchEvent(new CustomEvent('cashx:dice-game-active', {
    detail: { active: !!active },
  }));
}

// WALLET
async function connectWallet() {
  if (!window.showWalletModal) {
    setStatus('Wallet modal not loaded — please refresh.', 'error');
    return;
  }
  try {
    const result = await window.showWalletModal();
    provider = result.provider;
    await initContracts();
  } catch (err) {
    if (err.message !== 'dismissed') {
      setStatus('Wallet connection failed: ' + err.message, 'error');
    }
  }
}

async function switchToPulseChain() {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: PULSECHAIN_HEX }],
    });
  } catch (switchErr) {
    if (switchErr.code === 4902) {
      // Chain not in MetaMask yet — add it
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId:         PULSECHAIN_HEX,
            chainName:       CX_CONFIG ? CX_CONFIG.chain.name : 'PulseChain',
            nativeCurrency:  CX_CONFIG ? CX_CONFIG.chain.nativeCurrency : { name: 'Pulse', symbol: 'PLS', decimals: 18 },
            rpcUrls:         [CX_CONFIG ? CX_CONFIG.chain.rpcUrl : 'https://rpc.pulsechain.com'],
            blockExplorerUrls: [CX_CONFIG ? CX_CONFIG.chain.explorerBaseUrl : 'https://scan.pulsechain.com'],
          }],
        });
      } catch (addErr) {
        setStatus('Failed to add PulseChain: ' + addErr.message, 'error');
        return;
      }
    } else {
      setStatus('Failed to switch network: ' + switchErr.message, 'error');
      return;
    }
  }

  // Re-initialise after network switch
  provider = new ethers.providers.Web3Provider(window.ethereum);
  await initContracts();
}

async function initContracts() {
  if (!DICE_GAME_ADDRESS) {
    setStatus(
      'Contract not configured. Set DICE_GAME_ADDRESS in game.js after deployment.',
      'error'
    );
    return;
  }

  signer        = provider.getSigner();
  playerAddress = await signer.getAddress();

  diceContract  = new ethers.Contract(DICE_GAME_ADDRESS, DICE_ABI,  signer);
  cashxContract = new ethers.Contract(CASHX_ADDRESS,     CASHX_ABI, signer);

  updateConnectedWalletUi();

  // Fetch live bet limits from contract and update UI
  try {
    const [min, max] = await Promise.all([diceContract.minBet(), diceContract.maxBet()]);
    minBet = min;
    maxBet = max;
    document.getElementById('betLimitsDisplay').textContent =
      'Min ' + fmtCashx(minBet) + ' · Max ' + fmtCashx(maxBet) + ' CASHX';
  } catch (_) {
    // Keep the default limits if the contract is unavailable.
  }

  await refreshStats();
  enableButtons();
  setStatus('', '');

  // Load game history
  loadRecentGames();
  loadYourGames();

  // Reload on account or network change.
  window.ethereum.on('accountsChanged', () => location.reload());
  window.ethereum.on('chainChanged',    () => location.reload());

  // Keep stats fresh
  setInterval(refreshStats, 30_000);
  setInterval(loadRecentGames, 30_000);
}

// STATS
async function refreshStats() {
  if (!diceContract || !cashxContract) return;
  try {
    const [bal, burned] = await Promise.all([
      cashxContract.balanceOf(playerAddress),
      diceContract.totalBurned(),
    ]);
    const playerBalanceEl = document.getElementById('playerBalance');
    if (playerBalanceEl) playerBalanceEl.textContent = fmtCashx(bal) + ' CASHX';
    updateCashxWalletBalance(bal);
    const burnedText = fmtCashx(burned) + ' CASHX';
    const totalBurnedStatEl = document.getElementById('totalBurnedStat');
    if (totalBurnedStatEl) totalBurnedStatEl.textContent = burnedText;
    document.getElementById('totalBurned').textContent     = burnedText;
  } catch (_) {
    // Keep the previous values if the RPC request fails.
  }
}

function updateConnectedWalletUi() {
  const shortAddress = playerAddress ? playerAddress.slice(0, 6) + '...' + playerAddress.slice(-4) : '';
  const addressDisplay = document.getElementById('addressDisplay');
  if (addressDisplay) {
    addressDisplay.textContent = '';
    addressDisplay.style.display = 'none';
  }

  const connectBtn = document.getElementById('connectBtn');
  if (connectBtn) connectBtn.style.display = 'none';

  const hub = document.getElementById('walletHub');
  if (hub) hub.classList.add('visible');

  const accountHub = document.getElementById('walletAccountHub');
  if (accountHub) accountHub.classList.add('visible');

  const menuAddress = document.getElementById('walletMenuAddress');
  if (menuAddress) menuAddress.textContent = shortAddress;

  const avatar = document.getElementById('walletAvatarBtn');
  if (avatar && playerAddress) avatar.title = 'Wallet ' + shortAddress;
}

function updateCashxWalletBalance(balance) {
  latestCashxBalanceText = fmtCashx(balance) + ' CASHX';
  [
    'topCashxBalance',
    'walletMenuBalance',
  ].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = latestCashxBalanceText;
  });
}

// BET FLOW
async function placeBet(betOver) {
  if (!signer || !diceContract) {
    setStatus('Connect your wallet first.', 'error');
    return;
  }
  if (rolling) return;

  // Validate input
  const raw = document.getElementById('betAmount').value.trim();
  if (!raw || isNaN(raw) || Number(raw) <= 0) {
    setStatus('Enter a valid bet amount.', 'error');
    return;
  }

  let betAmount;
  try {
    betAmount = ethers.utils.parseUnits(raw, 18);
  } catch {
    setStatus('Invalid bet amount.', 'error');
    return;
  }

  if (betAmount.lt(minBet)) {
    setStatus('Minimum bet is ' + fmtCashx(minBet) + ' CASHX.', 'error');
    return;
  }
  if (betAmount.gt(maxBet)) {
    setStatus('Maximum bet is ' + fmtCashx(maxBet) + ' CASHX.', 'error');
    return;
  }

  rolling = true;
  emitDiceGameActive(true);
  disableButtons();
  resetDice();

  try {
    // Step 1: Approve CASHX spend (only if allowance is insufficient)
    const allowance = await cashxContract.allowance(playerAddress, DICE_GAME_ADDRESS);
    if (allowance.lt(betAmount)) {
      const approvalAmount = approvalAmountWei(betAmount);
      setStatus('Step 1 of 3: Approve up to ' + fmtCashx(approvalAmount) + ' CASHX in MetaMask…', 'pending');
      const approveTx = await cashxContract.approve(DICE_GAME_ADDRESS, approvalAmount);
      setStatus('Step 1 of 3: Waiting for approval confirmation…', 'pending');
      await waitForTx(approveTx);
      if (window.CashXNav && window.CashXNav.refreshApprovalAllowance) {
        window.CashXNav.refreshApprovalAllowance();
      }
    }

    // Step 2: Place committed bet
    const direction = betOver ? 'OVER' : 'UNDER';
    const secret = randomBytes32();
    const commitHash = ethers.utils.solidityKeccak256(
      ['address', 'bytes32'],
      [playerAddress, secret]
    );

    setStatus(
      'Step 2 of 3: Confirm your ' + direction + ' bet in MetaMask…',
      'pending'
    );

    const placeTx = await diceContract.placeBet(betOver, betAmount, commitHash);

    setStatus('Bet placed… waiting for block confirmation…', 'pending');
    startRollAnimation();

    // Wait for confirmation; handle "Speed Up" in MetaMask gracefully —
    // ethers throws TRANSACTION_REPLACED when the tx is repriced, but the
    // replacement receipt still contains our Roll event.
    let receipt;
    try {
      receipt = await placeTx.wait();
    } catch (waitErr) {
      if (waitErr.code === 'TRANSACTION_REPLACED' && !waitErr.cancelled) {
        // Sped-up replacement confirmed — use its receipt
        receipt = waitErr.receipt;
      } else {
        throw waitErr; // genuine rejection or cancellation — bubble up
      }
    }

    const placed = parseBetPlacedEvent(receipt);
    if (!placed) {
      throw new Error('Bet placed, but BetPlaced event was not found');
    }
    if (window.CashXNav && window.CashXNav.refreshApprovalAllowance) {
      window.CashXNav.refreshApprovalAllowance();
    }

    setStatus(REVEAL_BLOCK_WAIT_MESSAGE, 'pending');
    await waitForBlockAfter(placed.targetBlock.toNumber());

    setStatus('Step 3 of 3: Reveal your roll in MetaMask…', 'pending');
    const revealTx = await diceContract.revealBet(placed.betId, secret);
    setStatus('Revealing roll… waiting for confirmation…', 'pending');

    let revealReceipt;
    try {
      revealReceipt = await revealTx.wait();
    } catch (waitErr) {
      if (waitErr.code === 'TRANSACTION_REPLACED' && !waitErr.cancelled) {
        revealReceipt = waitErr.receipt;
      } else {
        throw waitErr;
      }
    }

    const parsed = parseRollEvent(revealReceipt);

    if (parsed) {
      await revealResult(parsed.result, parsed.won, betOver, betAmount);
    } else {
      stopRollAnimation();
      setStatus('Transaction confirmed. Check PulseScan for your result.', '');
    }

  } catch (err) {
    stopRollAnimation();
    resetDice();
    const msg = CX_TX ? CX_TX.formatTransactionError(err) :
      (err.reason || err.data?.message || err.message || 'Unknown error');
    setStatus('Error: ' + msg, 'error');
  }

  rolling = false;
  emitDiceGameActive(false);
  enableButtons();
  await refreshStats();
}

// EVENT PARSING
function parseRollEvent(receipt) {
  const iface = new ethers.utils.Interface(DICE_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'Roll') {
        return {
          betId:  parsed.args.betId,
          result: parsed.args.result,  // uint8: 1–99
          won:    parsed.args.won,     // bool
        };
      }
    } catch (_) {
      // Not our event — skip
    }
  }
  return null;
}

function parseBetPlacedEvent(receipt) {
  const iface = new ethers.utils.Interface(DICE_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'BetPlaced') {
        return {
          betId: parsed.args.betId,
          targetBlock: parsed.args.targetBlock,
        };
      }
    } catch (_) {
      // Not our event — skip
    }
  }
  return null;
}

function randomBytes32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ethers.utils.hexlify(bytes);
}

async function waitForBlockAfter(targetBlock) {
  while ((await provider.getBlockNumber()) <= targetBlock) {
    await delay(2500);
  }
}

async function waitForTx(tx) {
  if (CX_TX) return CX_TX.waitForConfirmation(tx);
  try {
    return await tx.wait();
  } catch (err) {
    if (err.code === 'TRANSACTION_REPLACED' && !err.cancelled) {
      return err.receipt;
    }
    throw err;
  }
}

// ANIMATION
let rollInterval = null;

function startRollAnimation() {
  const el = document.getElementById('diceResult');
  const stage = document.getElementById('diceStage');
  const pointer = document.getElementById('rollPointer');
  const outcome = document.getElementById('rollOutcome');
  if (stage) stage.className = 'dice-stage stage-rolling';
  if (pointer) pointer.className = 'roll-pointer';
  if (outcome) {
    outcome.className = 'roll-outcome';
    outcome.textContent = 'Rolling...';
  }
  el.classList.add('rolling');
  el.classList.remove('win', 'loss');
  rollInterval = setInterval(() => {
    const preview = Math.floor(Math.random() * 99) + 1;
    el.textContent = preview;
    if (pointer) pointer.style.left = preview + '%';
  }, 75);
}

function stopRollAnimation() {
  if (rollInterval) {
    clearInterval(rollInterval);
    rollInterval = null;
  }
  const el = document.getElementById('diceResult');
  if (el) el.classList.remove('rolling');
  const stage = document.getElementById('diceStage');
  if (stage && stage.classList.contains('stage-rolling')) {
    stage.classList.remove('stage-rolling');
  }
}

async function revealResult(result, won, betOver, betAmount) {
  // Keep the spinner visible briefly so the result transition is readable.
  await delay(1600);
  stopRollAnimation();

  const el = document.getElementById('diceResult');
  const stage = document.getElementById('diceStage');
  const pointer = document.getElementById('rollPointer');
  const outcome = document.getElementById('rollOutcome');
  el.textContent = result;
  el.classList.add(won ? 'win' : 'loss');
  if (stage) stage.className = 'dice-stage ' + (won ? 'stage-win' : 'stage-loss');
  if (pointer) {
    pointer.style.left = Math.max(1, Math.min(99, Number(result))) + '%';
    pointer.className = 'roll-pointer ' + (won ? 'win' : 'loss');
  }
  if (outcome) {
    outcome.className = 'roll-outcome ' + (won ? 'win' : 'loss');
    outcome.textContent = won ? 'Winner' : 'House Wins';
  }
  burstResult(won);

  const direction = betOver ? 'OVER' : 'UNDER';

  if (won) {
    const profit     = betAmount.mul(95).div(100);
    const burnAmount = betAmount.mul(3).div(100);
    setStatus(
      '🏆 YOU WIN! Rolled ' + result + ' — ' + direction + ' 50. ' +
      '+' + fmtCashx(profit) + ' CASHX profit. ' +
      '🔥 ' + fmtCashx(burnAmount) + ' CASHX burned.',
      'win'
    );
  } else {
    const burnAmount = betAmount.mul(3).div(100);
    setStatus(
      '💀 YOU LOSE. Rolled ' + result + ' — ' + direction + ' 50. ' +
      '🔥 ' + fmtCashx(burnAmount) + ' CASHX burned.',
      'loss'
    );
  }
  // Refresh game history after each roll
  loadYourGames();
  loadRecentGames();
}

function resetDice() {
  const el = document.getElementById('diceResult');
  const stage = document.getElementById('diceStage');
  const pointer = document.getElementById('rollPointer');
  const outcome = document.getElementById('rollOutcome');
  el.textContent = '?';
  el.classList.remove('win', 'loss', 'rolling');
  if (stage) stage.className = 'dice-stage';
  if (pointer) {
    pointer.className = 'roll-pointer';
    pointer.style.left = '50%';
  }
  if (outcome) {
    outcome.className = 'roll-outcome';
    outcome.textContent = 'Pick a side';
  }
}

function burstResult(won) {
  const stage = document.getElementById('diceStage');
  if (!stage) return;
  const color = won ? 'var(--green)' : 'var(--red)';
  for (let i = 0; i < 14; i++) {
    const spark = document.createElement('div');
    const angle = (i / 14) * Math.PI * 2;
    const dist = 48 + Math.random() * 42;
    spark.className = 'result-spark';
    spark.style.background = color;
    spark.style.boxShadow = '0 0 12px ' + color;
    spark.style.setProperty('--tx', Math.round(Math.cos(angle) * dist) + 'px');
    spark.style.setProperty('--ty', Math.round(Math.sin(angle) * dist) + 'px');
    stage.appendChild(spark);
    setTimeout(() => spark.remove(), 780);
  }
}

// UI HELPERS
function setStatus(msg, type) {
  const el = document.getElementById('statusBox');
  if (!el) return;
  const isStep = msg && msg.toLowerCase().includes('step');
  const isRevealBlockWait = msg && msg.toLowerCase().includes('waiting for the reveal block');
  if (isStep || isRevealBlockWait) {
    el.innerHTML =
      '<div class="status-main">' + (isRevealBlockWait ? 'Waiting for the reveal block...' : msg) + '</div>' +
      '<div class="status-tip">If it feels slow, use <strong>Speed Up</strong> in your wallet.</div>';
  } else {
    el.textContent = msg;
  }
  el.className = type || '';
  updateWalletFlowFromStatus(msg, type);
}

function updateWalletFlowFromStatus(msg, type) {
  const steps = ['approve', 'bet', 'reveal', 'payout'];
  const stepEls = [...document.querySelectorAll('[data-tx-step]')];
  const note = document.getElementById('txProgressNote');
  if (!stepEls.length || !note) return;

  const text = String(msg || '').toLowerCase();
  let active = '';
  let doneThrough = -1;

  if (/approve/.test(text)) active = 'approve';
  else if (/confirm your .* bet|bet placed|block confirmation|place/.test(text)) active = 'bet';
  else if (/waiting for the reveal block|reveal|revealing roll/.test(text)) active = 'reveal';
  else if (/you win|you lose|transaction confirmed|result/.test(text) || type === 'win' || type === 'loss') active = 'payout';

  if (/approval confirmed/.test(text)) doneThrough = 0;
  if (active) {
    doneThrough = Math.max(doneThrough, steps.indexOf(active) - 1);
  }
  if (/transaction confirmed|check pulsescan|result|you win|you lose|won|lost/.test(text) || type === 'win' || type === 'loss') {
    doneThrough = 3;
  }

  stepEls.forEach(step => {
    const idx = steps.indexOf(step.dataset.txStep);
    step.classList.toggle('active', step.dataset.txStep === active && doneThrough < idx);
    step.classList.toggle('done', idx > -1 && idx <= doneThrough);
  });

  if (msg) note.textContent = /waiting for the reveal block/.test(text)
    ? REVEAL_BLOCK_WAIT_MESSAGE
    : msg;
  if (type === 'error') note.textContent = 'Wallet step stopped. Check MetaMask, then try again.';
}

function enableButtons() {
  document.getElementById('btnOver').disabled  = false;
  document.getElementById('btnUnder').disabled = false;
}

function disableButtons() {
  document.getElementById('btnOver').disabled  = true;
  document.getElementById('btnUnder').disabled = true;
}

function setQuickBet(amount) {
  setBetAmount(amount, true);
}

function setBetAmount(amount, confirmed) {
  const input = document.getElementById('betAmount');
  if (!input) return;
  const next = Math.max(1, Math.min(5000, Math.floor(Number(amount))));
  input.value = Number.isFinite(next) ? next : '';
  useThisBetApproval();
  updateBetPreview(!!confirmed);
}

function normalizeBetInput() {
  const input = document.getElementById('betAmount');
  if (!input) return 0;
  const value = Number(String(input.value || '').trim());
  if (!Number.isFinite(value) || value <= 0) return 0;
  const next = Math.max(1, Math.min(5000, Math.floor(value)));
  input.value = next;
  return next;
}

function updateBetPreview(confirmed) {
  const input = document.getElementById('betAmount');
  const potEl = document.getElementById('previewTotalPot');
  const burnEl = document.getElementById('previewBurn');
  const winnerEl = document.getElementById('previewWinnerGets');
  const amount = Number(input && input.value);
  const valid = Number.isFinite(amount) && amount > 0;

  if (potEl) potEl.textContent = valid ? formatPreviewAmount(amount * DICE_WIN_MULTIPLIER_BPS / 10000) + ' CASHX' : '—';
  if (burnEl) burnEl.textContent = valid ? formatPreviewAmount(amount * DICE_BURN_BPS / 10000) + ' CASHX' : '—';
  if (winnerEl) winnerEl.textContent = valid ? formatPreviewAmount(amount * DICE_WIN_MULTIPLIER_BPS / 10000) + ' CASHX' : '—';

  document.querySelectorAll('.qb').forEach(btn => {
    const quickAmount = Number((btn.textContent || '').replace(/[^0-9.]/g, '')) * (btn.textContent.includes('K') ? 1000 : 1);
    const isMax = btn.textContent.trim().toUpperCase() === 'MAX' && amount === 5000;
    btn.classList.toggle('active', valid && (quickAmount === amount || isMax));
  });
}

function formatPreviewAmount(value) {
  return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function useThisBetApproval() {
  selectedApproval = 'bet';
  try { localStorage.removeItem('cashx:approvalPreset'); } catch (_) {}
  window.dispatchEvent(new CustomEvent('cashx:approvalPresetChanged', { detail: { value: 'bet' } }));
}

function selectApproval(value) {
  selectedApproval = normalizeApprovalPreset(value);
}

function getStoredApprovalPreset() {
  try { localStorage.removeItem('cashx:approvalPreset'); } catch (_) {}
  return 'bet';
}

function approvalAmountWei(requiredWei) {
  if (selectedApproval === 'bet') return requiredWei;
  const presetWei = ethers.utils.parseUnits(String(selectedApproval), 18);
  return presetWei.gt(requiredWei) ? presetWei : requiredWei;
}

window.addEventListener('cashx:approvalPresetChanged', event => {
  selectApproval(event.detail && event.detail.value);
});

const betAmountInput = document.getElementById('betAmount');
if (betAmountInput) {
  betAmountInput.addEventListener('input', () => {
    useThisBetApproval();
    updateBetPreview(false);
  });
  betAmountInput.addEventListener('change', () => {
    normalizeBetInput();
    updateBetPreview(false);
  });
  updateBetPreview(false);
}

// Format a BigNumber (18 decimals) as a readable string with commas
function fmtCashx(bigNum) {
  const n = parseFloat(ethers.utils.formatUnits(bigNum, 18));
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Recent Dice Games (all players)
async function loadRecentGames() {
  const tbody = document.getElementById('recentGamesBody');
  if (!tbody || !diceContract) return;
  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock    = Math.max(0, currentBlock - 50000);
    const events       = await diceContract.queryFilter(diceContract.filters.Roll(), fromBlock, currentBlock);
    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No recent games found.</td></tr>';
      return;
    }
    const recent = events.slice().reverse().slice(0, 10);
    const blocks  = await Promise.all(recent.map(e => provider.getBlock(e.blockNumber).catch(() => null)));
    tbody.innerHTML = '';
    recent.forEach((ev, i) => {
      const { betId, player, result, over, bet, won } = ev.args;
      const betFmt    = parseFloat(ethers.utils.formatUnits(bet, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 });
      const direction = over ? 'OVER 50' : 'UNDER 50';
      const txHash    = ev.transactionHash;
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="num">#' + betId.toString() + '</td>' +
        '<td>' + addressButton(player) + '</td>' +
        '<td class="num">' + Number(result) + '</td>' +
        '<td class="num">' + betFmt + ' CASHX</td>' +
        '<td>' + direction + '</td>' +
        '<td>' + (won ? '<span class="pill-win">WIN</span>' : '<span class="pill-loss">LOSS</span>') + '</td>' +
        '<td>' + txButton(txHash) + '</td>';
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.warn('loadRecentGames error:', e.message);
  }
}

// Your Dice Games
async function loadYourGames() {
  if (!playerAddress || !diceContract) return;
  const section = document.getElementById('yourGamesSection');
  const tbody   = document.getElementById('yourGamesBody');
  if (!section || !tbody) return;

  try {
    const currentBlock = await provider.getBlockNumber();
    const fromBlock    = Math.max(0, currentBlock - 100000);
    const filter       = diceContract.filters.Roll(null, playerAddress);
    const events       = await diceContract.queryFilter(filter, fromBlock, currentBlock);

    if (!events.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No games found in recent blocks.</td></tr>';
      section.style.display = 'block';
      return;
    }

    // Sort newest first, take last 10
    const recent = events.slice().reverse().slice(0, 10);
    const blocks  = await Promise.all(recent.map(e => provider.getBlock(e.blockNumber).catch(() => null)));

    tbody.innerHTML = '';
    recent.forEach((ev, i) => {
      const { betId, result, over, bet, won } = ev.args;
      const direction = over ? 'OVER 50' : 'UNDER 50';
      const betFmt    = parseFloat(ethers.utils.formatUnits(bet, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 });
      const txHash    = ev.transactionHash;
      const ts        = blocks[i]?.timestamp;
      const timeStr   = ts ? timeAgo(ts) : '—';

      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="num">#' + betId.toString() + '</td>' +
        '<td class="num">' + Number(result) + '</td>' +
        '<td class="num">' + betFmt + ' CASHX</td>' +
        '<td>' + direction + '</td>' +
        '<td>' + (won ? '<span class="pill-win">WIN</span>' : '<span class="pill-loss">LOSS</span>') + '</td>' +
        '<td>' + txButton(txHash) + '</td>';
      tbody.appendChild(tr);
    });
    section.style.display = 'block';
  } catch (e) {
    console.warn('loadYourGames error:', e.message);
  }
}

function timeAgo(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)   return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  return Math.floor(diff / 3600) + 'h ago';
}

function shortAddress(address) {
  return address.slice(0, 6) + '…' + address.slice(-4);
}

function addressButton(address) {
  return '<button class="address-link" type="button" onclick="showAddressPopover(event, \'' +
    address + '\')">' + shortAddress(address) + '</button>';
}

function shortHash(hash) {
  return hash.slice(0, 6) + '…' + hash.slice(-4);
}

function txButton(txHash) {
  return '<button class="tx-link" type="button" onclick="showTxPopover(event, \'' +
    txHash + '\')">' + shortHash(txHash) + '</button>';
}

function explorerAddressLink(address) {
  return window.CashX && window.CashX.contracts
    ? window.CashX.contracts.buildExplorerAddressLink(address)
    : 'https://scan.pulsechain.com/address/' + address;
}

function explorerTxLink(txHash) {
  return window.CashX && window.CashX.contracts
    ? window.CashX.contracts.buildExplorerTxLink(txHash)
    : 'https://scan.pulsechain.com/tx/' + txHash;
}

function showAddressPopover(event, address) {
  event.preventDefault();
  event.stopPropagation();
  closeAddressPopover();

  const card = document.createElement('div');
  card.className = 'address-popover';
  card.id = 'addressPopover';
  card.innerHTML =
    '<div class="address-popover-short">' + shortAddress(address) + '</div>' +
    '<a class="address-popover-action" href="' + explorerAddressLink(address) + '" target="_blank" rel="noopener">🔍 PulseScan</a>' +
    '<button class="address-popover-action copy" type="button" onclick="copyPopoverAddress(event, \'' + address + '\')">Copy Address</button>';

  document.body.appendChild(card);
  positionPopover(card, event.currentTarget);
  setTimeout(() => document.addEventListener('click', closeAddressPopover), 10);
}

function showTxPopover(event, txHash) {
  event.preventDefault();
  event.stopPropagation();
  closeAddressPopover();

  const card = document.createElement('div');
  card.className = 'address-popover';
  card.id = 'addressPopover';
  card.innerHTML =
    '<div class="address-popover-short">' + shortHash(txHash) + '</div>' +
    '<a class="address-popover-action" href="' + explorerTxLink(txHash) + '" target="_blank" rel="noopener">🔍 PulseScan</a>' +
    '<a class="address-popover-action" href="verifier.html?mode=dice&tx=' + txHash + '">✅ Verify Result</a>' +
    '<button class="address-popover-action copy" type="button" onclick="copyPopoverAddress(event, \'' + txHash + '\')">Copy TX Hash</button>';

  document.body.appendChild(card);
  positionPopover(card, event.currentTarget);
  setTimeout(() => document.addEventListener('click', closeAddressPopover), 10);
}

function positionPopover(card, target) {
  const rect = target.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const left = Math.min(rect.right + 12, window.innerWidth - cardRect.width - 12);
  const top = Math.min(rect.top - 12, window.innerHeight - cardRect.height - 12);
  card.style.left = Math.max(12, left) + 'px';
  card.style.top = Math.max(12, top) + 'px';
}

function closeAddressPopover() {
  const existing = document.getElementById('addressPopover');
  if (existing) existing.remove();
  document.removeEventListener('click', closeAddressPopover);
}

function copyPopoverAddress(event, address) {
  event.preventDefault();
  event.stopPropagation();
  navigator.clipboard.writeText(address);
  event.currentTarget.textContent = 'Copied!';
  setTimeout(closeAddressPopover, 650);
}

// Wallet dropdown
function showWalletMenu(address) {
  closeWalletMenu();
  const btn = document.getElementById('connectBtn');
  if (!btn) return;
  const menu = document.createElement('div');
  menu.className = 'wallet-dropdown';
  menu.id = 'walletMenu';
  menu.innerHTML =
    '<div class="wallet-dropdown-item" onclick="event.stopPropagation();copyWalletAddress(\'' + address + '\')">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>' +
      'Copy Address' +
    '</div>' +
    '<div class="wallet-dropdown-sep"></div>' +
    '<div class="wallet-dropdown-item" onclick="event.stopPropagation();switchWallet()">' +
      'Switch Wallet' +
    '</div>' +
    '<div class="wallet-dropdown-sep"></div>' +
    '<div class="wallet-dropdown-item danger" onclick="event.stopPropagation();disconnectWallet()">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8v-2H4V5z"/></svg>' +
      'Disconnect' +
    '</div>';
  btn.appendChild(menu);
  setTimeout(() => document.addEventListener('click', _walletOutsideClick), 10);
}

function closeWalletMenu() {
  const m = document.getElementById('walletMenu');
  if (m) m.remove();
  document.removeEventListener('click', _walletOutsideClick);
}

function _walletOutsideClick(e) {
  if (!e.target.closest('#walletMenu') && !e.target.closest('#connectBtn')) closeWalletMenu();
}

function copyWalletAddress(address) {
  navigator.clipboard.writeText(address);
  const item = document.querySelector('#walletMenu .wallet-dropdown-item');
  if (item) { item.textContent = 'Copied!'; setTimeout(closeWalletMenu, 800); }
}

function disconnectWallet() {
  closeWalletMenu();
  closeBalanceMenu();
  closeAccountMenu();
  location.reload();
}

function toggleBalanceMenu(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById('walletBalanceMenu');
  if (menu && menu.classList.contains('open')) closeBalanceMenu();
  else openCashier(event);
}

function openCashier(event) {
  if (event) event.stopPropagation();
  const menu = document.getElementById('walletBalanceMenu');
  if (!menu) return;
  const backdrop = document.getElementById('cashierBackdrop');
  if (backdrop && backdrop.parentElement !== document.body) document.body.appendChild(backdrop);
  if (menu.parentElement !== document.body) document.body.appendChild(menu);
  selectedApproval = 'bet';
  try { localStorage.removeItem('cashx:approvalPreset'); } catch (_) {}
  syncApprovalButtons();
  menu.classList.add('open');
  if (backdrop) backdrop.classList.add('open');
  setTimeout(() => document.addEventListener('click', _balanceMenuOutsideClick), 10);
}

function bindApprovalButtons() {
  document.querySelectorAll('.wallet-approval-btn').forEach(btn => {
    if (btn.__cashxApprovalBound) return;
    btn.__cashxApprovalBound = true;
    btn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      selectApproval(btn.dataset.approval);
      syncApprovalButtons(true);
      window.dispatchEvent(new CustomEvent('cashx:approvalPresetChanged', { detail: { value: selectedApproval } }));
    });
  });
  const customInput = document.getElementById('walletApprovalCustom');
  const applyBtn = document.getElementById('walletApprovalApply');
  if (applyBtn && !applyBtn.__cashxApprovalBound) {
    applyBtn.__cashxApprovalBound = true;
    applyBtn.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      selectApproval(customInput ? customInput.value : 'bet');
      syncApprovalButtons(true);
      window.dispatchEvent(new CustomEvent('cashx:approvalPresetChanged', { detail: { value: selectedApproval } }));
    });
  }
  if (customInput && !customInput.__cashxApprovalBound) {
    customInput.__cashxApprovalBound = true;
    customInput.addEventListener('click', event => event.stopPropagation());
    customInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        selectApproval(customInput.value);
        syncApprovalButtons(true);
        window.dispatchEvent(new CustomEvent('cashx:approvalPresetChanged', { detail: { value: selectedApproval } }));
      }
    });
  }
}

function syncApprovalButtons(showFeedback) {
  document.querySelectorAll('.wallet-approval-btn').forEach(btn => {
    btn.classList.toggle('active', String(btn.dataset.approval) === selectedApproval);
  });
  const customInput = document.getElementById('walletApprovalCustom');
  if (customInput) {
    customInput.value = ['bet', '10000', '100000', '1000000'].includes(selectedApproval) ? '' : selectedApproval;
  }
  const summary = getApprovalSummary(selectedApproval);
  const selectedEl = document.getElementById('walletApprovalSelected');
  const descriptionEl = document.getElementById('walletApprovalDescription');
  const feedbackEl = document.getElementById('walletApprovalFeedback');
  if (selectedEl) selectedEl.textContent = summary.label;
  if (descriptionEl) descriptionEl.textContent = summary.description;
  if (feedbackEl) {
    feedbackEl.textContent = showFeedback ? summary.feedback : 'Custom approval must be 100 to 1,000,000 CASHX.';
    feedbackEl.classList.toggle('success', !!showFeedback);
  }
}

function normalizeApprovalPreset(value) {
  const raw = String(value || 'bet').trim().replace(/,/g, '');
  if (raw === 'bet' || raw.toLowerCase() === 'this bet') return 'bet';
  if (!/^\d+(\.\d+)?$/.test(raw)) return 'bet';
  const amount = Math.max(100, Math.min(1000000, Math.floor(Number(raw))));
  if (!Number.isFinite(amount)) return 'bet';
  return String(amount);
}

function getApprovalSummary(value) {
  if (value === 'bet') {
    return {
      label: 'This bet only',
      description: 'You will only approve the amount needed for the next game you start or join.',
      feedback: 'Approval limit set to this bet only.',
    };
  }
  const amount = Number(value || 0);
  const formatted = amount.toLocaleString();
  return {
    label: formatted + ' CASHX',
    description: 'You can play multiple games until your approved allowance is used. Unused CASHX remains in your wallet.',
    feedback: 'Approval limit set to ' + formatted + ' CASHX.',
  };
}

function closeBalanceMenu() {
  const menu = document.getElementById('walletBalanceMenu');
  if (menu) menu.classList.remove('open');
  const backdrop = document.getElementById('cashierBackdrop');
  if (backdrop) backdrop.classList.remove('open');
  document.removeEventListener('click', _balanceMenuOutsideClick);
}

function _balanceMenuOutsideClick(event) {
  if (!event.target.closest('#walletBalanceMenu') && !event.target.closest('#cashierBtn')) closeBalanceMenu();
}

function toggleAccountMenu(event) {
  event.stopPropagation();
  closeBalanceMenu();
  const menu = document.getElementById('walletAccountMenu');
  if (!menu) return;
  const isOpen = menu.classList.toggle('open');
  if (isOpen) {
    setTimeout(() => document.addEventListener('click', _accountMenuOutsideClick), 10);
  } else {
    document.removeEventListener('click', _accountMenuOutsideClick);
  }
}

function closeAccountMenu() {
  const menu = document.getElementById('walletAccountMenu');
  if (menu) menu.classList.remove('open');
  document.removeEventListener('click', _accountMenuOutsideClick);
}

function _accountMenuOutsideClick(event) {
  if (!event.target.closest('#walletHub')) closeAccountMenu();
}

function openAccountFromMenu() {
  closeAccountMenu();
  const fakeEvent = { stopPropagation() {} };
  toggleBalanceMenu(fakeEvent);
}

function copyConnectedWallet() {
  if (!playerAddress) return;
  navigator.clipboard.writeText(playerAddress);
  const copyBtn = document.querySelector('.wallet-menu-action:not(.danger)');
  if (copyBtn) {
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 850);
  }
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeBalanceMenu();
    closeAccountMenu();
  }
});

bindApprovalButtons();
syncApprovalButtons();

// Auto-connect on load (if MetaMask already has permission)
(async () => {
  if (!window.ethereum) return;
  try {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (!accounts.length) return;                          // not connected yet
    provider = new ethers.providers.Web3Provider(window.ethereum);
    const network = await provider.getNetwork();
    if (network.chainId !== PULSECHAIN_ID) return;         // wrong chain — let user connect manually
    await initContracts();
  } catch (_) {}
})();
