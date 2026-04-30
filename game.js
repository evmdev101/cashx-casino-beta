'use strict';


const DICE_GAME_ADDRESS = '0x15A8C0D554D3e6971A46D696F69e8cBB8CF07977';

const CASHX_ADDRESS     = '0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665';
const PULSECHAIN_ID     = 369;
const PULSECHAIN_HEX    = '0x171';

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
let minBet = ethers.BigNumber.from('500').mul(ethers.BigNumber.from('10').pow(18));
let maxBet = ethers.BigNumber.from('5000').mul(ethers.BigNumber.from('10').pow(18));
let rolling = false;

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
            chainName:       'PulseChain',
            nativeCurrency:  { name: 'Pulse', symbol: 'PLS', decimals: 18 },
            rpcUrls:         ['https://rpc.pulsechain.com'],
            blockExplorerUrls: ['https://scan.pulsechain.com'],
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

  // Show truncated address, disable connect button
  document.getElementById('addressDisplay').textContent =
    playerAddress.slice(0, 6) + '…' + playerAddress.slice(-4);

  const btn = document.getElementById('connectBtn');
  btn.textContent = 'CONNECTED';
  btn.classList.add('connected');
  btn.style.position = 'relative';
  btn.onclick = () => showWalletMenu(playerAddress);

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
    document.getElementById('playerBalance').textContent = fmtCashx(bal)    + ' CASHX';
    const burnedText = fmtCashx(burned) + ' CASHX';
    document.getElementById('totalBurnedStat').textContent = burnedText;
    document.getElementById('totalBurned').textContent     = burnedText;
  } catch (_) {
    // Keep the previous values if the RPC request fails.
  }
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
  disableButtons();
  resetDice();

  try {
    // Step 1: Approve CASHX spend (only if allowance is insufficient)
    const allowance = await cashxContract.allowance(playerAddress, DICE_GAME_ADDRESS);
    if (allowance.lt(betAmount)) {
      setStatus('Step 1 of 3: Approve CASHX spend in MetaMask…', 'pending');
      const approveTx = await cashxContract.approve(DICE_GAME_ADDRESS, betAmount);
      setStatus('Step 1 of 3: Waiting for approval confirmation…', 'pending');
      await waitForTx(approveTx);
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

    setStatus('Waiting for the reveal block…', 'pending');
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

    if (err.code === 4001 || err.code === 'ACTION_REJECTED') {
      setStatus('Transaction rejected.', 'error');
    } else if (err.code === 'TRANSACTION_REPLACED' && err.cancelled) {
      setStatus('Transaction cancelled.', 'error');
    } else {
      const msg = err.reason || err.data?.message || err.message || 'Unknown error';
      setStatus('Error: ' + msg, 'error');
    }
  }

  rolling = false;
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
  if (isStep) {
    el.innerHTML =
      '<div class="status-main">' + msg + '</div>' +
      '<div class="status-tip">If the transaction is slow, use <strong>Speed Up</strong> in MetaMask.</div>';
  } else {
    el.textContent = msg;
  }
  el.className = type || '';
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
  document.getElementById('betAmount').value = amount;
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

function showAddressPopover(event, address) {
  event.preventDefault();
  event.stopPropagation();
  closeAddressPopover();

  const card = document.createElement('div');
  card.className = 'address-popover';
  card.id = 'addressPopover';
  card.innerHTML =
    '<div class="address-popover-short">' + shortAddress(address) + '</div>' +
    '<a class="address-popover-action" href="https://scan.pulsechain.com/address/' + address + '" target="_blank" rel="noopener">🔍 PulseScan</a>' +
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
    '<a class="address-popover-action" href="https://scan.pulsechain.com/tx/' + txHash + '" target="_blank" rel="noopener">🔍 PulseScan</a>' +
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
  location.reload();
}

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
