'use strict';

// Constants
const CX_CONFIG = window.CashX && window.CashX.config;
const CX_TX = window.CashX && window.CashX.transactions;
const ASYNC_GAMES_ADDRESS = CX_CONFIG ? CX_CONFIG.contracts.asyncGames : '0x54896B009b229DB1630d01D7D92bB1a5C78EEDc2';
const CASHX_ADDRESS       = CX_CONFIG ? CX_CONFIG.addresses.cashxToken : '0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665';
const PULSECHAIN_ID       = CX_CONFIG ? CX_CONFIG.chain.id : 369;
const PULSECHAIN_HEX      = CX_CONFIG ? CX_CONFIG.chain.hexId : '0x171';
const RPC_URL             = CX_CONFIG ? CX_CONFIG.chain.rpcUrl : 'https://rpc.pulsechain.com';

// Converts raw chain errors into readable messages.
function friendlyChainError(err) {
  const raw = String(
    err && (err.reason || err.errorName || (err.data && err.data.message) ||
    (err.error && err.error.message) || err.message) || ''
  );
  if (/insufficient funds|not enough funds/i.test(raw))
    return new Error('This wallet needs a little PLS for gas.');
  if (/transfer failed|ERC20|balance/i.test(raw))
    return new Error('CASHX transfer failed — check your CASHX balance and try again.');
  if (/entry out of range/i.test(raw))
    return new Error('Entry amount is outside the allowed range (100 - 1,000,000 CASHX).');
  if (/game is full/i.test(raw))
    return new Error('This game just filled up — pick another table.');
  if (/already in/i.test(raw))
    return new Error('You are already in this game.');
  if (/not active/i.test(raw))
    return new Error('This game is no longer active.');
  if (raw) return new Error(raw);
  return err || new Error('Unknown error');
}

// Simulates the call with callStatic so any revert is surfaced before MetaMask opens.
async function preflightCall(contract, method, args) {
  try {
    await contract.callStatic[method](...args);
  } catch (err) {
    throw friendlyChainError(err);
  }
}

// Dynamic gas options — estimates gas per call and boosts gas price 1.5× so
// PulseChain's EIP-1559 nodes always include the transaction promptly.
// Throws (with a friendly message) if the call would revert, so MetaMask is
// never given a doomed transaction.
async function getTxOptions(contract, method, args) {
  try {
    const [estimate, gasPrice] = await Promise.all([
      contract.estimateGas[method](...args),
      provider.getGasPrice(),
    ]);
    return {
      gasLimit: estimate.mul(130).div(100),  // 30% safety buffer
      gasPrice: gasPrice.mul(150).div(100),  // 1.5× boost
    };
  } catch (err) {
    throw friendlyChainError(err);
  }
}

const MIN_ENTRY_CASHX = 100;
const MAX_ENTRY_CASHX = 1_000_000;

// ABIs
const ASYNC_ABI = [
  'function createGame(uint8 gameType, uint8 maxPlayers, uint256 entryAmount) external',
  'function joinGame(uint256 gameId) external',
  'function settleGame(uint256 gameId) external',
  'function leaveGame(uint256 gameId) external',
  'function refundGame(uint256 gameId) external',
  'function refundExpiredSettle(uint256 gameId) external',
  'function requestCancel(uint256 gameId) external',
  'function cancelRequests(uint256 gameId, address player) view returns (bool)',
  'function getGame(uint256 gameId) view returns (tuple(uint8 gameType, uint8 maxPlayers, uint8 playerCount, uint256 entryAmount, uint256 createdAt, bool resolved, bool cancelled, bool readyToSettle, uint256 settleBlock, address[5] players, uint8[5] results, address winner))',
  'function getActiveGames() view returns (uint256[])',
  'function getPlayerGames(address player) view returns (uint256[])',
  'event GameCreated(uint256 indexed gameId, uint8 gameType, uint8 maxPlayers, uint256 entryAmount)',
  'event GameReadyToSettle(uint256 indexed gameId, uint256 settleBlock)',
  'event GameResolved(uint256 indexed gameId, address indexed winner, uint256 payout, uint256 burned)',
  'event PlayerRefunded(uint256 indexed gameId, address indexed player, uint256 amount)',
];

const CASHX_ABI = [
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

// State
let provider, signer, playerAddress;
let asyncContractSigned, cashxContractSigned;
let activeTab            = 0;
let selectedTier         = 1;
let selectedPlayers      = 2;
let selectedApproval     = getStoredApprovalPreset();
let transacting          = false;
let currentView          = 'BC';
let latestKnownBlock     = 0;
let pendingInviteGameId  = null;
let pendingJoinFromLobby = null; // { id, gameType } — set when user clicks JOIN IN from live lobby

// Burn totals per game type — populated by the burn IIFE, displayed on tab switch
let asyncBurnByType = { 0: null, 1: null };

// Animation tracking 
const seenResolvedGames       = new Set();
const forceRevealGames        = new Set();
let   initialPlayerGamesLoaded = false;

// Read-only provider (no wallet needed)
const rpcProvider     = new ethers.providers.JsonRpcProvider(RPC_URL);
const asyncContractRO = new ethers.Contract(ASYNC_GAMES_ADDRESS, ASYNC_ABI, rpcProvider);
const cashxContractRO = new ethers.Contract(CASHX_ADDRESS, CASHX_ABI, rpcProvider);

// View management
function showViewA() {
  // Selection screen removed — go back to all games page
  location.href = 'all-games.html';
}

function showPlayView(gameType) {
  activeTab   = 0;
  currentView = 'BC';
  // Card War is the active multiplayer game. Legacy Dice Battle history remains readable.
  document.body.classList.add('cardwar-bg');
  document.body.classList.remove('dicebattle-bg');

  // Update banner + section titles
  const isCW = true;
  const copy = gameCopy();
  const _set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  _set('playViewIcon',  isCW ? '🃏' : '🎲');
  _set('playViewTitle', isCW ? 'CARD WAR' : 'DICE BATTLE');
  _set('playViewSub', copy.sub);
  _set('createPanelTitle', copy.createTitle);
  _set('entryTierLabel', copy.entryTier);
  _set('playersLabel', copy.playersLabel);
  _set('createBtn', copy.createBtn);
  _set('activeLobbiesTitle', copy.lobbiesTitle);
  _set('myGamesTitle', copy.myGamesTitle);
  _set('resultsSectionTitle', copy.resultsTitle);
  _set('lobbyEntryHead', copy.entryHead);
  _set('lobbyPlayersHead', copy.playersHead);
  _set('lobbyPotHead', copy.potHead);
  _set('resultValueHead', copy.resultHead);
  _set('resultPotHead', copy.potHead);
  updateAsyncGamePreview();
  _updatePotEstimate();

  // Reset animation state when switching game types so re-entering re-triggers
  initialPlayerGamesLoaded = false;

  // Show my games section if wallet is connected
  if (playerAddress) {
    document.getElementById('myGamesSection').style.display = 'block';
  }

  // Update burn display for this game type
  updateBurnDisplay();

  // Load data for this view
  refreshFilteredActiveGames();
  refreshFilteredResults();
  if (playerAddress) refreshFilteredPlayerGames();
  renderInvitePanel();
}

function updateBurnDisplay() {
  const el    = document.getElementById('asyncTotalBurned');
  const label = document.getElementById('burnGameLabel');
  if (!el) return;
  const isCW = activeTab === 0;
  if (label) label.textContent = isCW ? 'Card War' : 'Dice Battle';
  const bn = asyncBurnByType[activeTab];
  if (!bn) return; // still loading — leave as "—"
  const formatted = parseFloat(ethers.utils.formatEther(bn));
  const display   = formatted.toLocaleString('en-US', { maximumFractionDigits: 2 });
  el.textContent  = display + ' CASHX';
}

function gameCopy(gameType = activeTab) {
  const isCW = gameType === 0;
  return isCW ? {
    sub: 'Draw cards · Highest card wins · Winner takes 95% · 5% burned',
    createTitle: 'Create War Table',
    entryTier: 'Ante Tier',
    playersLabel: 'Duelists',
    createBtn: 'CREATE WAR TABLE',
    lobbiesTitle: 'Card War — War Tables',
    myGamesTitle: 'Your War Tables',
    resultsTitle: 'Recent Card Draws',
    entryHead: 'Ante',
    playersHead: 'Duelists',
    potHead: 'Prize',
    resultHead: 'Card',
    join: 'JOIN IN',
    settle: 'REVEAL WAR',
    leave: 'FOLD',
    refund: 'CLAIM ANTE',
    entryMeta: 'Ante',
    playersMeta: 'Duelists',
  } : {
    sub: 'Roll 2 dice · Highest total wins · Winner takes 95% · 5% burned',
    createTitle: 'Create Battle Arena',
    entryTier: 'Entry Tier',
    playersLabel: 'Rollers',
    createBtn: 'CREATE ARENA',
    lobbiesTitle: 'Dice Battle — Battle Arenas',
    myGamesTitle: 'Your Dice Battles',
    resultsTitle: 'Recent Dice Rolls',
    entryHead: 'Entry',
    playersHead: 'Rollers',
    potHead: 'Pot',
    resultHead: 'Roll',
    join: 'ROLL IN',
    settle: 'ROLL DICE',
    leave: 'EXIT',
    refund: 'CLAIM ENTRY',
    entryMeta: 'Entry',
    playersMeta: 'Rollers',
  };
}

// Wallet
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
      setStatus('Connection failed: ' + err.message, 'error');
    }
  }
}

async function switchToPulseChain() {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: PULSECHAIN_HEX }],
    });
  } catch (e) {
    if (e.code === 4902) {
      try {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId:           PULSECHAIN_HEX,
            chainName:         CX_CONFIG ? CX_CONFIG.chain.name : 'PulseChain',
            nativeCurrency:    CX_CONFIG ? CX_CONFIG.chain.nativeCurrency : { name: 'Pulse', symbol: 'PLS', decimals: 18 },
            rpcUrls:           [CX_CONFIG ? CX_CONFIG.chain.rpcUrl : 'https://rpc.pulsechain.com'],
            blockExplorerUrls: [CX_CONFIG ? CX_CONFIG.chain.explorerBaseUrl : 'https://scan.pulsechain.com'],
          }],
        });
      } catch (addErr) {
        setStatus('Failed to add PulseChain: ' + addErr.message, 'error');
        return;
      }
    } else {
      setStatus('Failed to switch network: ' + e.message, 'error');
      return;
    }
  }
  provider = new ethers.providers.Web3Provider(window.ethereum);
  await initContracts();
}

async function initContracts() {
  signer        = provider.getSigner();
  playerAddress = await signer.getAddress();

  asyncContractSigned = new ethers.Contract(ASYNC_GAMES_ADDRESS, ASYNC_ABI, signer);
  cashxContractSigned = new ethers.Contract(CASHX_ADDRESS, CASHX_ABI, signer);

  const addrEl = document.getElementById('addressDisplay');
  if (addrEl) addrEl.textContent = playerAddress.slice(0, 6) + '…' + playerAddress.slice(-4);

  const btn = document.getElementById('connectBtn');
  if (btn) {
    btn.textContent = 'CONNECTED';
    btn.classList.add('connected');
    btn.style.position = 'relative';
    btn.onclick = () => showWalletMenu(playerAddress);
  }

  _updateCreateBtn();

  // Show My Games section in whichever view is active
  if (currentView === 'BC') {
    document.getElementById('myGamesSection').style.display = 'block';
  }

  await Promise.all([
    refreshBalance(),
    currentView === 'A' ? refreshAllActiveGames() : refreshFilteredActiveGames(),
    currentView === 'BC' ? refreshFilteredPlayerGames() : Promise.resolve(),
    currentView === 'BC' ? refreshFilteredResults() : Promise.resolve(),
  ]);

  // Wallet-specific polling
  setInterval(refreshBalance, 30_000);
  setInterval(() => { if (playerAddress) refreshFilteredPlayerGames(); }, 10_000);

  window.ethereum.on('accountsChanged', () => location.reload());
  window.ethereum.on('chainChanged',    () => location.reload());

  setStatus('', '');
}

// Balance
async function refreshBalance() {
  if (!playerAddress) return;
  try {
    const bal = await cashxContractRO.balanceOf(playerAddress);
    const el  = document.getElementById('cashxBalance');
    if (el) el.textContent = fmtCashx(bal) + ' CASHX';
  } catch (_) {}
}

// Active games
async function refreshAllActiveGames() {
  const tbody = document.getElementById('allGamesBody');
  if (!tbody) return;

  try {
    const ids = await asyncContractRO.getActiveGames();
    if (ids.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No open games — be the first!</td></tr>';
      return;
    }

    const limited = ids.slice(-30);
    const games   = await Promise.all(limited.map(id => asyncContractRO.getGame(id)));

    tbody.innerHTML = games.map((g, i) => {
      const id     = limited[i];
      const idStr  = id.toString();
      const isCW   = Number(g.gameType) === 0;
      const copy   = gameCopy(Number(g.gameType));
      const pot    = g.entryAmount.mul(g.maxPlayers);
      const inGame = playerAddress && g.players.some(p => p.toLowerCase() === playerAddress.toLowerCase());
      const canJoin = !inGame && !!playerAddress && !transacting;

      return '<tr>' +
        '<td class="num">#' + idStr + '</td>' +
        '<td><span class="type-badge ' + (isCW ? 'type-cw' : 'type-db') + '">' +
          (isCW ? 'CARD WAR' : 'DICE BATTLE') + '</span></td>' +
        '<td>' + fmtEntry(g.entryAmount) + '</td>' +
        '<td>' + g.playerCount + '/' + g.maxPlayers + '</td>' +
        '<td class="num">' + fmtEntry(pot) + '</td>' +
        '<td>' + (
          inGame
            ? '<span class="badge-in">IN GAME</span>'
            : canJoin
              ? '<button class="btn-join" onclick="showJoinPanel(' + idStr + ',' + Number(g.gameType) + ')">' + copy.join + '</button>'
              : '<button class="btn-join" disabled>' + copy.join + '</button>'
        ) + '</td>' +
      '</tr>';
    }).join('');

  } catch (e) {
    console.warn('refreshAllActiveGames:', e);
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">Could not load games — RPC may be busy</td></tr>';
  }
}

// Filtered active games
async function refreshFilteredActiveGames() {
  const tbody = document.getElementById('filteredActiveBody');
  if (!tbody) return;

  try {
    const ids = await asyncContractRO.getActiveGames();
    if (ids.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No open games — create one above!</td></tr>';
      return;
    }

    const games    = await Promise.all(ids.map(id => asyncContractRO.getGame(id)));
    const filtered = games
      .map((g, i) => ({ id: ids[i], g }))
      .filter(({ g }) => Number(g.gameType) === activeTab)
      .slice(-30);

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">No open ' +
        (activeTab === 0 ? 'Card War' : 'Dice Battle') + ' games. Create one!</td></tr>';
      return;
    }

    tbody.innerHTML = filtered.map(({ id, g }) => {
      const idStr  = id.toString();
      const copy   = gameCopy(Number(g.gameType));
      const pot    = g.entryAmount.mul(g.maxPlayers);
      const inGame = playerAddress && g.players.some(p => p.toLowerCase() === playerAddress.toLowerCase());
      const canJoin = !inGame && !!playerAddress && !transacting;

      return '<tr>' +
        '<td class="num">#' + idStr + '</td>' +
        '<td>' + fmtEntry(g.entryAmount) + '</td>' +
        '<td>' + g.playerCount + '/' + g.maxPlayers + '</td>' +
        '<td class="num">' + fmtEntry(pot) + '</td>' +
        '<td>' + timeAgo(g.createdAt.toNumber()) + '</td>' +
        '<td>' + (
          inGame
            ? '<span class="badge-in">IN GAME</span>'
            : canJoin
              ? '<button class="btn-join" onclick="showJoinPanel(' + idStr + ',' + Number(g.gameType) + ')">' + copy.join + '</button>'
              : '<button class="btn-join" disabled>' + copy.join + '</button>'
        ) + '</td>' +
      '</tr>';
    }).join('');

  } catch (e) {
    console.warn('refreshFilteredActiveGames:', e);
    tbody.innerHTML = '<tr><td colspan="6" class="empty-cell">Could not load — RPC may be busy</td></tr>';
  }
}

// Player games with reveal animations
async function refreshFilteredPlayerGames() {
  const container = document.getElementById('filteredMyGamesBody');
  if (!container || !playerAddress) return;

  try {
    const allIds = await asyncContractRO.getPlayerGames(playerAddress);
    latestKnownBlock = await rpcProvider.getBlockNumber().catch(() => latestKnownBlock);
    if (allIds.length === 0) {
      container.innerHTML = '<div class="empty-msg">You haven\'t played any ' +
        (activeTab === 0 ? 'Card War' : 'Dice Battle') + ' games yet.</div>';
      syncInviteFromPlayerGames([]);
      return;
    }

    const recentIds = allIds.slice(-60).reverse();
    const games     = await Promise.all(recentIds.map(id => asyncContractRO.getGame(id)));

    // Filter by current game type
    const filtered = games
      .map((g, i) => ({ id: recentIds[i], g }))
      .filter(({ g }) => Number(g.gameType) === activeTab)
      .slice(0, 20);

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-msg">No ' +
        (activeTab === 0 ? 'Card War' : 'Dice Battle') + ' games yet.</div>';
      syncInviteFromPlayerGames([]);
      return;
    }

    syncInviteFromPlayerGames(filtered);

    // Determine which games are newly resolved (for animation)
    const pendingAnimations = []; // { idStr, gameType }

    if (!initialPlayerGamesLoaded) {
      // First load: mark all already-resolved as seen, no animation
      filtered.forEach(({ id, g }) => {
        const idStr = id.toString();
        if (g.resolved && forceRevealGames.has(idStr)) {
          pendingAnimations.push({ idStr, gameType: Number(g.gameType) });
        } else if (g.resolved) {
          seenResolvedGames.add(idStr);
        }
      });
      initialPlayerGamesLoaded = true;
    } else {
      // Subsequent loads: detect newly resolved
      filtered.forEach(({ id, g }) => {
        const idStr = id.toString();
        if (g.resolved && !seenResolvedGames.has(idStr)) {
          pendingAnimations.push({ idStr, gameType: Number(g.gameType) });
          // Don't add to seenResolvedGames yet — happens after render
        }
      });
    }

    // Render all game rows
    container.innerHTML = filtered.map(({ id, g }) => {
      const idStr       = id.toString();
      const isNewlyResolved = pendingAnimations.some(p => p.idStr === idStr);
      return renderGameRow(g, id.toNumber(), isNewlyResolved);
    }).join('');

    // Trigger animations for newly resolved games
    pendingAnimations.forEach(({ idStr, gameType }) => {
      seenResolvedGames.add(idStr);
      forceRevealGames.delete(idStr);
      if (gameType === 0) {
        animateCardFlip(idStr);
      } else {
        animateDiceReveal(idStr);
      }
    });

  } catch (e) {
    console.warn('refreshFilteredPlayerGames:', e);
    container.innerHTML = '<div class="empty-msg">Could not load your games.</div>';
  }
}

// Render a single game row (cards or dice)
function renderGameRow(g, gameId, isNewlyResolved) {
  const idStr    = String(gameId);
  const isCW     = Number(g.gameType) === 0;
  const copy      = gameCopy(Number(g.gameType));
  const now      = Math.floor(Date.now() / 1000);
  const timedOut = now >= g.createdAt.toNumber() + 7 * 24 * 3600;
  const n        = Number(g.playerCount);

  // Hoist settle-block state so rowClass can use it
  const readyToSettle    = !!g.readyToSettle;
  const settleBlockReady = readyToSettle && latestKnownBlock > Number(g.settleBlock);
  const settleExpired    = readyToSettle && latestKnownBlock > Number(g.settleBlock) + 250;
  const isSettling       = !g.resolved && !g.cancelled && readyToSettle && !settleExpired;

  // Status badge
  let badge, badgeClass, actions = '';
  if (g.resolved) {
    const won  = g.winner.toLowerCase() === (playerAddress || '').toLowerCase();
    badge      = won ? 'WON' : 'LOST';
    badgeClass = won ? 'badge-won' : 'badge-lost';
  } else if (g.cancelled) {
    badge      = 'CANCELLED';
    badgeClass = 'badge-cancelled';
  } else {
    const playerIdx = Array.from(g.players).findIndex(
      p => p.toLowerCase() === (playerAddress || '').toLowerCase()
    );
    if (playerIdx >= 0 && readyToSettle) {
      badge      = settleExpired ? 'EXPIRED' : (settleBlockReady ? 'READY' : 'SETTLING');
      badgeClass = 'badge-waiting';
      const mainAction = settleExpired
        ? '<button class="btn-action-sm btn-refund" onclick="refundExpiredSettle(' + idStr + ')">' + copy.refund + '</button>'
        : settleBlockReady
        ? '<button class="btn-action-sm btn-refund" onclick="settleGame(' + idStr + ')">' + copy.settle + '</button>'
        : '';
      // Mutual cancel button — available whenever the game is full and awaiting settlement
      const cancelAction = !settleExpired
        ? '<button class="btn-action-sm btn-cancel-game" onclick="requestCancelGame(' + idStr + ')" title="All players must request to get full refunds">⇌ Request Cancel</button>'
        : '';
      actions = mainAction + cancelAction;
    } else if (playerIdx >= 0 && timedOut) {
      badge      = 'TIMEOUT';
      badgeClass = 'badge-timeout';
      actions    = '<button class="btn-action-sm btn-refund" onclick="refundGame(' + idStr + ')">' + copy.refund + '</button>';
    } else if (playerIdx >= 0) {
      badge      = 'WAITING';
      badgeClass = 'badge-waiting';
      if (n < Number(g.maxPlayers)) {
        actions =
          '<button class="btn-action-sm btn-join" onclick="showInviteForGame(' + idStr + ')">Invite</button>' +
          '<button class="btn-action-sm btn-leave" onclick="leaveGame(' + idStr + ')">' + copy.leave + '</button>';
      }
    } else {
      badge      = 'LEFT';
      badgeClass = 'badge-cancelled';
    }
  }

  // Cards or dice visual
  let visualHtml = '';
  if (isCW) {
    visualHtml = renderCardWarVisual(g, gameId, isNewlyResolved);
  } else {
    visualHtml = renderDiceBattleVisual(g, gameId, isNewlyResolved);
  }

  const rowClass = 'my-game-row' +
    (isNewlyResolved ? ' reveal-live' : '') +
    (isSettling      ? ' settling-state' : '');
  const revealCopy  = isCW ? 'Dealing cards...' : 'Rolling dice...';
  const settlingMsg = settleBlockReady
    ? (isCW ? 'Ready — confirm reveal in wallet' : 'Ready — confirm roll in wallet')
    : 'Waiting for reveal block · hold tight';

  return '<div class="' + rowClass + '" data-game-id="' + idStr + '">' +
    '<div class="my-game-header">' +
      '<span class="game-id">' + (isCW ? '🃏' : '🎲') + ' #' + idStr + '</span>' +
      '<span class="game-type-lbl">' + (isCW ? 'Card War' : 'Dice Battle') + '</span>' +
      '<span class="' + badgeClass + '">' + badge + '</span>' +
    '</div>' +
    '<div class="my-game-meta">' +
      '<span>' + copy.entryMeta + ': ' + fmtEntry(g.entryAmount) + '</span>' +
      '<span>' + n + '/' + g.maxPlayers + ' ' + copy.playersMeta.toLowerCase() + '</span>' +
    '</div>' +
    '<div class="settling-banner">' +
      'SETTLING <span class="settling-dots">' +
        '<span>.</span><span>.</span><span>.</span>' +
        '<span>.</span><span>.</span><span>.</span>' +
      '</span>&nbsp; ' + settlingMsg +
    '</div>' +
    '<div class="reveal-banner">' + revealCopy + '</div>' +
    visualHtml +
    (actions ? '<div class="my-game-actions">' + actions + '</div>' : '') +
  '</div>';
}

// Card War visual
// Face-down while waiting; flip animation reveals all cards when resolved.

function renderCardWarVisual(g, gameId, isNewlyResolved) {
  const ranks      = ['','','2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const suits      = ['♠','♥','♦','♣'];
  const suitChars  = ['S','H','D','C'];
  const n      = Number(g.playerCount);
  const max    = Number(g.maxPlayers);

  let html = '<div class="cards-row">';

  // Filled player slots
  for (let i = 0; i < n; i++) {
    const player   = g.players[i];
    const result   = Number(g.results[i]);
    const rank     = ranks[result] || String(result);
    const suitIdx  = i % 4;
    const suit     = suits[suitIdx];
    const suitChar = suitChars[suitIdx];
    const isRed    = suit === '♥' || suit === '♦';
    const isMe     = player.toLowerCase() === (playerAddress || '').toLowerCase();
    const isWinner = g.resolved && g.winner.toLowerCase() === player.toLowerCase();
    const isLoser  = g.resolved && !isWinner;
    const isCrownCard = g.resolved && result === 14;

    // If already seen as resolved (not newly resolving), start flipped
    const startFlipped = g.resolved && !isNewlyResolved;

    const frontClass = 'card-face card-front-face' +
      (isRed ? ' card-red' : ' card-black') +
      (isWinner ? ' card-winner' : '') +
      (isLoser  ? ' card-loser'  : '') +
      (isCrownCard ? ' crown-card' : '');

    const title = isMe ? 'YOU' : player.slice(0, 6) + '…' + player.slice(-4);
    const imgFile = rank ? (suitChar + rank + '.png') : null;
    const frontContent = imgFile
      ? '<img src="cards/png/' + imgFile + '" alt="' + rank + ' of ' + suit + '" class="card-img">' +
        (isCrownCard ? '<div class="special-hook">CROWN</div>' : '')
      : '<div class="c-rank">' + rank + '</div>' +
        '<div class="c-suit">' + suit + '</div>' +
        (isCrownCard ? '<div class="special-hook">CROWN</div>' : '');

    html +=
      '<div class="card-flip-container" title="' + title + '" style="--deal-rot:' + ((i - 2) * 3) + 'deg">' +
        '<div class="card-inner' + (startFlipped ? ' flipped' : '') + '">' +
          '<div class="card-face card-back-face"><img src="cards/card-back.png" alt=""></div>' +
          '<div class="' + frontClass + '">' +
            frontContent +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // Empty slots
  for (let i = n; i < max; i++) {
    html += '<div class="card-empty"></div>';
  }

  html += '</div>';
  return html;
}

// Reveal cards with a staggered flip animation.
function animateCardFlip(gameId) {
  const gameRow = document.querySelector('[data-game-id="' + gameId + '"]');
  const row = gameRow && gameRow.querySelector('.cards-row');
  if (!row || !gameRow) return;
  const banner = gameRow.querySelector('.reveal-banner');
  if (banner) banner.textContent = 'Dealing cards...';
  const containers = row.querySelectorAll('.card-flip-container');
  const cards = row.querySelectorAll('.card-inner');
  containers.forEach((container, i) => {
    setTimeout(() => container.classList.add('dealt'), 180 + i * 140);
  });
  cards.forEach((card, i) => {
    setTimeout(() => {
      if (banner) banner.textContent = i === cards.length - 1 ? 'Final card...' : 'Revealing card ' + (i + 1) + '...';
      card.classList.add('flipped');
      // After flip transition completes, spawn gold particles on winner card
      setTimeout(() => {
        const front = card.querySelector('.card-front-face');
        if (front && front.classList.contains('card-winner')) {
          spawnWinnerParticles(card.closest('.card-flip-container'));
        }
      }, 640);
    }, 900 + i * 420);
  });
  setTimeout(() => finishRevealRow(gameRow, 'Cards revealed'), 1250 + cards.length * 420);
}

// Winner-card particle effect.
function spawnWinnerParticles(container) {
  if (!container) return;
  const count = 8;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * 360;
    const dist  = 30 + Math.random() * 20;
    const tx    = Math.round(Math.cos(angle * Math.PI / 180) * dist);
    const ty    = Math.round(Math.sin(angle * Math.PI / 180) * dist);
    const p     = document.createElement('div');
    p.className = 'winner-particle';
    p.style.setProperty('--tx', tx + 'px');
    p.style.setProperty('--ty', ty + 'px');
    p.style.animationDelay = (Math.random() * 0.08).toFixed(2) + 's';
    container.appendChild(p);
    setTimeout(() => p.remove(), 800);
  }
}

// Dice Battle visual
// Hide dice values until the game resolves.

function renderDiceBattleVisual(g, gameId, isNewlyResolved) {
  const n   = Number(g.playerCount);
  const max = Number(g.maxPlayers);
  let html  = '<div class="dice-players-row">';

  for (let i = 0; i < n; i++) {
    const player   = g.players[i];
    const total    = Number(g.results[i]);
    const isMe     = player.toLowerCase() === (playerAddress || '').toLowerCase();
    const isWinner = g.resolved && g.winner.toLowerCase() === player.toLowerCase();
    const isLoser  = g.resolved && !isWinner;

    // Decompose total into two plausible die values
    const [d1, d2] = decomposeRoll(total);
    const isDoubles = g.resolved && d1 === d2;

    // Show actual values if already resolved and seen; show ? if newly resolving or not resolved
    const showValues = g.resolved && !isNewlyResolved;
    const d1Display  = showValues ? String(d1) : '❓';
    const d2Display  = showValues ? String(d2) : '❓';
    const totDisplay = showValues ? String(total) : '?';

    const dieClass    = 'die' + (showValues ? ' revealed' : '') +
                        (showValues && isWinner ? ' die-winner' : '') +
                        (showValues && isLoser  ? ' die-loser'  : '');
    const totalClass  = 'dice-total-display' +
                        (showValues && isWinner ? ' total-winner' : '') +
                        (showValues && isLoser  ? ' total-loser'  : '');
    const setClass = 'player-dice-set' +
                     (showValues && isWinner ? ' set-winner' : '') +
                     (showValues && isLoser ? ' set-loser' : '') +
                     (showValues && isDoubles ? ' power-roll' : '');

    const label = isMe ? 'YOU' : 'P' + (i + 1);

    html +=
      '<div class="' + setClass + '" data-outcome="' + (isWinner ? 'winner' : 'loser') + '" title="' + player.slice(0, 6) + '…' + player.slice(-4) + '">' +
        '<div class="player-dice-label">' + label + '</div>' +
        '<div class="dice-pair">' +
          '<div class="' + dieClass + '" data-final="' + d1 + '">' + d1Display + '</div>' +
          '<div class="' + dieClass + '" data-final="' + d2 + '">' + d2Display + '</div>' +
        '</div>' +
        '<div class="' + totalClass + '" data-final="' + total + '">' + totDisplay + '</div>' +
        (showValues && isDoubles ? '<div class="special-hook">POWER ROLL</div>' : '') +
      '</div>';
  }

  html += '</div>';
  return html;
}

// Reveal dice with a staggered shake animation.
function animateDiceReveal(gameId) {
  const gameRow = document.querySelector('[data-game-id="' + gameId + '"]');
  const row = gameRow && gameRow.querySelector('.dice-players-row');
  if (!row || !gameRow) return;
  const banner = gameRow.querySelector('.reveal-banner');
  if (banner) banner.textContent = 'Rolling dice...';
  const sets = row.querySelectorAll('.player-dice-set');
  sets.forEach((set, i) => {
    setTimeout(() => {
      set.classList.add('rolling');
      if (banner) banner.textContent = 'Rolling player ' + (i + 1) + '...';
      const dice = set.querySelectorAll('.die');
      dice.forEach(die => die.classList.add('shaking'));

      // Wait for 1s shake animation to finish before revealing values
      setTimeout(() => {
        const isWinner = set.dataset.outcome === 'winner';
        const isPowerRoll = dice.length >= 2 && dice[0].dataset.final === dice[1].dataset.final;
        set.classList.remove('rolling');
        set.classList.add(isWinner ? 'set-winner' : 'set-loser');
        if (isPowerRoll) set.classList.add('power-roll');
        dice.forEach(die => {
          die.textContent = die.dataset.final;
          die.classList.remove('shaking');
          die.classList.add('revealed');
          die.classList.add(isWinner ? 'die-winner' : 'die-loser');
        });
        const totalEl = set.querySelector('.dice-total-display');
        if (totalEl) {
          totalEl.textContent = totalEl.dataset.final;
          totalEl.classList.add(isWinner ? 'total-winner' : 'total-loser');
        }
        if (isPowerRoll && !set.querySelector('.special-hook')) {
          const hook = document.createElement('div');
          hook.className = 'special-hook';
          hook.textContent = 'POWER ROLL';
          set.appendChild(hook);
        }
        if (isWinner) spawnWinnerParticles(set);
      }, 1050);
    }, 1500 + i * 380);
  });
  setTimeout(() => finishRevealRow(gameRow, 'Dice settled'), 1850 + sets.length * 380);
}

function finishRevealRow(gameRow, text) {
  if (!gameRow) return;
  const banner = gameRow.querySelector('.reveal-banner');
  gameRow.classList.remove('reveal-live');
  gameRow.classList.add('reveal-finished');
  if (banner) banner.textContent = text;
  setTimeout(() => {
    gameRow.classList.remove('reveal-finished');
  }, 5000);
}

// Decompose a dice total (2-12) into two plausible individual die values (1-6 each)
function decomposeRoll(total) {
  const d1 = Math.max(1, Math.min(6, Math.floor(total / 2)));
  const d2 = total - d1;
  if (d2 >= 1 && d2 <= 6) return [d1, d2];
  if (d2 < 1) return [1, total - 1];
  return [6, total - 6];
}

// Filtered recent results
async function refreshFilteredResults() {
  const container = document.getElementById('filteredResultsBody');
  if (!container) return;

  try {
    const currentBlock = await rpcProvider.getBlockNumber();
    const fromBlock    = Math.max(0, currentBlock - 4900); // PublicNode max is 5000 blocks

    const events = await asyncContractRO.queryFilter(
      asyncContractRO.filters.GameResolved(),
      fromBlock,
      currentBlock
    );

    const recent = events.slice(-80).reverse();

    if (recent.length === 0) {
      container.innerHTML = '<tr><td colspan="6" class="empty-cell">No resolved games yet — be the first!</td></tr>';
      return;
    }

    const gameDetails = await Promise.all(recent.map(e => asyncContractRO.getGame(e.args.gameId)));

    // Filter to current tab game type before trimming the display list. Otherwise
    // one busy game type can make the other tab appear empty.
    const filteredEvents = recent
      .map((e, i) => ({ e, g: gameDetails[i] }))
      .filter(({ g }) => Number(g.gameType) === activeTab)
      .slice(0, 10);

    const blocks = await Promise.all(filteredEvents.map(({ e }) => rpcProvider.getBlock(e.blockNumber)));

    const filtered = filteredEvents
      .map((item, i) => ({ ...item, block: blocks[i] }));

    if (filtered.length === 0) {
      container.innerHTML = '<tr><td colspan="6" class="empty-cell">No ' +
        (activeTab === 0 ? 'Card War' : 'Dice Battle') + ' results yet.</td></tr>';
      return;
    }

    container.innerHTML = filtered.map(({ e, g, block }) => {
      const { gameId, winner, payout, burned } = e.args;
      const txHash       = e.transactionHash;
      const winnerIndex  = Array.from(g.players).findIndex(p => p.toLowerCase() === winner.toLowerCase());
      const winnerResult = winnerIndex >= 0 ? Number(g.results[winnerIndex]) : 0;
      const resultLabel  = formatResultForTable(g.gameType, winnerResult, gameId);
      const resultHook   = resultHookForTable(g.gameType, winnerResult);
      const pot          = g.entryAmount.mul(g.playerCount);

      return '<tr>' +
        '<td class="num">#' + gameId.toString() + '</td>' +
        '<td>' + addressButton(winner) + '</td>' +
        '<td class="num">' + resultLabel + resultHook + '</td>' +
        '<td class="num">' + fmtCashx(pot) + ' CASHX</td>' +
        '<td class="num">' + fmtCashx(burned) + ' CASHX</td>' +
        '<td>' + txButton(txHash, 'multi') + '</td>' +
      '</tr>';
    }).join('');

  } catch (e) {
    console.warn('refreshFilteredResults:', e);
    container.innerHTML = '<tr><td colspan="6" class="empty-cell">Could not load results — RPC may be busy.</td></tr>';
  }
}

// Create game
async function createGame() {
  if (!signer) { setStatus('Connect your wallet first.', 'error'); return; }
  if (transacting) return;

  try {
    const pendingNonce   = await provider.getTransactionCount(playerAddress, 'pending');
    const confirmedNonce = await provider.getTransactionCount(playerAddress, 'latest');
    if (pendingNonce > confirmedNonce) {
      setStatus('You have a pending transaction. Please wait for it to confirm before placing another.', 'error');
      return;
    }
  } catch (_) {}

  transacting = true;
  _disableActions();

  try {
    const entry = getEntryWei();
    const copy = gameCopy();

    await approveAsyncIfNeeded(entry);

    setStatus('Approval confirmed. Confirm ' + copy.createTitle.toLowerCase() + ' in MetaMask…', 'pending');
    await preflightCall(asyncContractSigned, 'createGame', [activeTab, selectedPlayers, entry]);
    const tx = await asyncContractSigned.createGame(activeTab, selectedPlayers, entry, await getTxOptions(asyncContractSigned, 'createGame', [activeTab, selectedPlayers, entry]));
    setStatus('Creating ' + (activeTab === 0 ? 'war table' : 'battle arena') + '… waiting for block confirmation…', 'pending');
    let receipt = null;
    try {
      receipt = await tx.wait();
    } catch (waitErr) {
      if (waitErr.code === 'TRANSACTION_REPLACED' && !waitErr.cancelled) {
        // Speed Up — replacement confirmed, continue normally
        receipt = waitErr.receipt || null;
      } else {
        throw waitErr;
      }
    }

    const createdId = findCreatedGameId(receipt);
    if (createdId) {
      pendingInviteGameId = createdId;
      renderInvitePanel(createdId);
    }

    setStatus((activeTab === 0 ? 'War table' : 'Battle arena') + ' created! Waiting for players.', 'success');
    await Promise.all([
      refreshAllActiveGames(),
      refreshFilteredActiveGames(),
      refreshFilteredPlayerGames(),
      refreshBalance(),
    ]);

  } catch (err) {
    _handleTxError(err);
  }

  transacting = false;
  _enableActions();
}

// Join game
async function joinGame(gameId) {
  if (!signer) { setStatus('Connect your wallet first.', 'error'); return; }
  if (transacting) return;

  try {
    const pendingNonce   = await provider.getTransactionCount(playerAddress, 'pending');
    const confirmedNonce = await provider.getTransactionCount(playerAddress, 'latest');
    if (pendingNonce > confirmedNonce) {
      setStatus('You have a pending transaction. Please wait for it to confirm before placing another.', 'error');
      return;
    }
  } catch (_) {}

  transacting = true;
  _disableActions();

  try {
    const g     = await asyncContractRO.getGame(gameId);
    const entry = g.entryAmount;
    const copy  = gameCopy(Number(g.gameType));

    await approveAsyncIfNeeded(entry);

    setStatus('Approval confirmed. Confirm ' + copy.join.toLowerCase() + ' in MetaMask…', 'pending');
    await preflightCall(asyncContractSigned, 'joinGame', [gameId]);
    const tx = await asyncContractSigned.joinGame(gameId, await getTxOptions(asyncContractSigned, 'joinGame', [gameId]));
    setStatus((Number(g.gameType) === 0 ? 'Taking your seat at the war table' : 'Entering the dice arena') + '… waiting for confirmation…', 'pending');
    let receipt;
    try {
      receipt = await tx.wait();
    } catch (waitErr) {
      if (waitErr.code === 'TRANSACTION_REPLACED' && !waitErr.cancelled) {
        receipt = waitErr.receipt; // Speed Up — use replacement receipt
      } else {
        throw waitErr;
      }
    }

    // Detect whether the game filled in this tx. Filled games settle after a future block.
    const iface    = new ethers.utils.Interface(ASYNC_ABI);
    let   readyToSettle = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed.name === 'GameReadyToSettle') {
          readyToSettle = parsed.args.settleBlock;
          break;
        }
      } catch (_) {}
    }

    if (readyToSettle) {
      setStatus((Number(g.gameType) === 0 ? 'War table is full. Waiting to reveal cards…' : 'Arena is full. Waiting to roll dice…'), 'pending');
      await waitForBlockAfter(readyToSettle.toNumber());
      await settleGame(gameId);
    } else {
      setStatus((Number(g.gameType) === 0 ? 'Joined war table #' : 'Joined dice battle #') + gameId + '. Waiting for players…', 'success');
    }

    // Switch to the right play view so player sees their game
    const gameType = Number(g.gameType);
    showPlayView(gameType);

    await Promise.all([
      refreshAllActiveGames(),
      refreshFilteredActiveGames(),
      refreshFilteredPlayerGames(),
      refreshBalance(),
    ]);

  } catch (err) {
    _handleTxError(err);
  }

  transacting = false;
  _enableActions();
}

async function settleGame(gameId) {
  if (!signer) { setStatus('Connect your wallet first.', 'error'); return; }

  try {
    const g = await asyncContractRO.getGame(gameId);
    const copy = gameCopy(Number(g.gameType));
    setStatus('Confirm ' + copy.settle.toLowerCase() + ' in MetaMask…', 'pending');
    const tx = await asyncContractSigned.settleGame(gameId, await getTxOptions(asyncContractSigned, 'settleGame', [gameId]));
    setStatus((Number(g.gameType) === 0 ? 'Revealing cards' : 'Rolling dice') + '… waiting for confirmation…', 'pending');

    let receipt;
    try {
      receipt = await tx.wait();
    } catch (waitErr) {
      if (waitErr.code === 'TRANSACTION_REPLACED' && !waitErr.cancelled) {
        receipt = waitErr.receipt;
      } else {
        throw waitErr;
      }
    }

    const iface = new ethers.utils.Interface(ASYNC_ABI);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed.name === 'GameResolved') {
          forceRevealGames.add(String(gameId));
          const won = parsed.args.winner.toLowerCase() === playerAddress.toLowerCase();
          if (won) {
            setStatus(
              'YOU WIN! +' + fmtCashx(parsed.args.payout) +
              ' CASHX. ' + fmtCashx(parsed.args.burned) + ' burned.', 'win'
            );
          } else {
            setStatus((Number(g.gameType) === 0 ? 'Cards revealed.' : 'Dice rolled.') + ' Check Your Games below for results.', 'show');
          }
          break;
        }
      } catch (_) {}
    }

    await Promise.all([
      refreshAllActiveGames(),
      refreshFilteredActiveGames(),
      refreshFilteredPlayerGames(),
      refreshFilteredResults(),
      refreshBalance(),
    ]);
  } catch (err) {
    _handleTxError(err);
  }
}

// Leave game
async function leaveGame(gameId) {
  if (!signer || transacting) return;

  try {
    const pendingNonce   = await provider.getTransactionCount(playerAddress, 'pending');
    const confirmedNonce = await provider.getTransactionCount(playerAddress, 'latest');
    if (pendingNonce > confirmedNonce) {
      setStatus('You have a pending transaction. Please wait for it to confirm before placing another.', 'error');
      return;
    }
  } catch (_) {}

  transacting = true;
  _disableActions();

  try {
    setStatus('Confirm leaving game #' + gameId + ' in MetaMask…', 'pending');
    const tx = await asyncContractSigned.leaveGame(gameId, await getTxOptions(asyncContractSigned, 'leaveGame', [gameId]));
    setStatus('Leaving game… waiting for confirmation…', 'pending');
    await tx.wait();
    setStatus('Left game #' + gameId + '. Entry refunded.', 'success');
    await Promise.all([
      refreshAllActiveGames(),
      refreshFilteredActiveGames(),
      refreshFilteredPlayerGames(),
      refreshBalance(),
    ]);
  } catch (err) {
    _handleTxError(err);
  }

  transacting = false;
  _enableActions();
}

// Refund game
async function refundGame(gameId) {
  if (!signer || transacting) return;

  try {
    const pendingNonce   = await provider.getTransactionCount(playerAddress, 'pending');
    const confirmedNonce = await provider.getTransactionCount(playerAddress, 'latest');
    if (pendingNonce > confirmedNonce) {
      setStatus('You have a pending transaction. Please wait for it to confirm before placing another.', 'error');
      return;
    }
  } catch (_) {}

  transacting = true;
  _disableActions();

  try {
    setStatus('Confirm refund claim in MetaMask…', 'pending');
    const tx = await asyncContractSigned.refundGame(gameId, await getTxOptions(asyncContractSigned, 'refundGame', [gameId]));
    setStatus('Claiming refund… waiting for confirmation…', 'pending');
    await tx.wait();
    setStatus('Refund claimed for game #' + gameId + '!', 'success');
    await Promise.all([refreshFilteredPlayerGames(), refreshBalance()]);
  } catch (err) {
    _handleTxError(err);
  }

  transacting = false;
  _enableActions();
}

async function refundExpiredSettle(gameId) {
  if (!signer || transacting) return;

  transacting = true;
  _disableActions();

  try {
    setStatus('Confirm expired-game refund in MetaMask…', 'pending');
    const tx = await asyncContractSigned.refundExpiredSettle(gameId, await getTxOptions(asyncContractSigned, 'refundExpiredSettle', [gameId]));
    setStatus('Refunding players… waiting for confirmation…', 'pending');
    await tx.wait();
    setStatus('Expired game refunded.', 'success');

    await Promise.all([
      refreshFilteredPlayerGames(),
      refreshFilteredActiveGames(),
      refreshBalance(),
    ]);
  } catch (err) {
    _handleTxError(err);
  }

  transacting = false;
  _enableActions();
}

// Request mutual cancel for a full game (all players must also request)
async function requestCancelGame(gameId) {
  if (!signer || transacting) return;

  try {
    const pendingNonce   = await provider.getTransactionCount(playerAddress, 'pending');
    const confirmedNonce = await provider.getTransactionCount(playerAddress, 'latest');
    if (pendingNonce > confirmedNonce) {
      setStatus('You have a pending transaction. Please wait for it to confirm.', 'error');
      return;
    }
  } catch (_) {}

  transacting = true;
  _disableActions();

  try {
    setStatus('Confirm cancel request in MetaMask…', 'pending');
    const tx = await asyncContractSigned.requestCancel(gameId, await getTxOptions(asyncContractSigned, 'requestCancel', [gameId]));
    setStatus('Submitting cancel request…', 'pending');
    const receipt = await waitForTx(tx);

    // Check if game was mutually cancelled (all players had already requested)
    const iface = new ethers.utils.Interface(ASYNC_ABI);
    let mutuallyCancelled = false;
    for (const log of (receipt ? receipt.logs : [])) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed.name === 'GameMutuallyCancelled') { mutuallyCancelled = true; break; }
      } catch (_) {}
    }

    if (mutuallyCancelled) {
      setStatus('All players agreed — game #' + gameId + ' cancelled. Full refunds sent.', 'success');
    } else {
      setStatus('Cancel request submitted for game #' + gameId + '. Waiting for all other players to request too.', 'success');
    }

    await Promise.all([
      refreshFilteredActiveGames(),
      refreshFilteredPlayerGames(),
      refreshBalance(),
    ]);
  } catch (err) {
    _handleTxError(err);
  }

  transacting = false;
  _enableActions();
}

// Selection
const TIER_VALUES = { 1: 100, 2: 500000, 3: 1000000 };

// Returns the entry amount as a BigNumber (wei), reading from the custom input.
function getEntryWei() {
  const input = document.getElementById('tierCustomInput');
  const raw   = parseFloat(input ? input.value : '0') || MIN_ENTRY_CASHX;
  const clamped = Math.max(MIN_ENTRY_CASHX, Math.min(MAX_ENTRY_CASHX, Math.floor(raw)));
  return ethers.utils.parseUnits(String(clamped), 18);
}

function selectTier(tier) {
  selectedTier = tier;
  document.querySelectorAll('#tierBtns .sel-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.tier) === tier);
  });
  // Set the input to the chosen quick-select amount
  const input = document.getElementById('tierCustomInput');
  if (input) input.value = TIER_VALUES[tier];
  _updatePotEstimate();
}

// Wire up the custom amount input.
// While typing: pot estimate updates live; tier buttons go dark.
// On blur / Enter: clamp to valid range (no forced snap to a tier preset).
(function () {
  const input = document.getElementById('tierCustomInput');
  if (!input) return;

  function clampInput() {
    const raw     = parseFloat(input.value) || MIN_ENTRY_CASHX;
    const clamped = Math.max(MIN_ENTRY_CASHX, Math.min(MAX_ENTRY_CASHX, Math.floor(raw)));
    input.value   = clamped;
    // Re-highlight a tier button only if the value exactly matches a preset
    const matchTier = Object.entries(TIER_VALUES).find(([, v]) => v === clamped);
    if (matchTier) {
      selectedTier = Number(matchTier[0]);
      document.querySelectorAll('#tierBtns .sel-btn').forEach(b => {
        b.classList.toggle('active', Number(b.dataset.tier) === selectedTier);
      });
    } else {
      selectedTier = 0;
      document.querySelectorAll('#tierBtns .sel-btn').forEach(b => b.classList.remove('active'));
    }
    _updatePotEstimate();
  }

  // Live pot estimate while typing; clear tier button highlights
  input.addEventListener('input', () => {
    document.querySelectorAll('#tierBtns .sel-btn').forEach(b => b.classList.remove('active'));
    _updatePotEstimate();
  });

  // Clamp on blur (click away / tab out)
  input.addEventListener('blur', clampInput);

  // Clamp on Enter key too
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { input.blur(); }
  });
})();

function selectPlayers(n) {
  selectedPlayers = n;
  document.querySelectorAll('#playersBtns .sel-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.p) === n);
  });
  _updatePotEstimate();
  updateAsyncGamePreview();
}

function selectApproval(value) {
  selectedApproval = normalizeApprovalPreset(value);
}

function approvalAmountWei(requiredWei) {
  if (selectedApproval === 'bet') return requiredWei;
  const presetWei = ethers.utils.parseUnits(String(selectedApproval), 18);
  return presetWei.gt(requiredWei) ? presetWei : requiredWei;
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

async function approveAsyncIfNeeded(requiredWei) {
  const allowance = await cashxContractRO.allowance(playerAddress, ASYNC_GAMES_ADDRESS);
  if (allowance.gte(requiredWei)) {
    setStatus('Approval already covers this table.', 'pending');
    return;
  }

  const approvalWei = approvalAmountWei(requiredWei);
  setStatus('Step 1/2: Approve up to ' + fmtCashx(approvalWei) + ' CASHX in MetaMask…', 'pending');
  const approveTx = await cashxContractSigned.approve(
    ASYNC_GAMES_ADDRESS,
    approvalWei,
    await getTxOptions(cashxContractSigned, 'approve', [ASYNC_GAMES_ADDRESS, approvalWei])
  );
  setStatus('Step 1/2: Waiting for approval confirmation…', 'pending');
  await waitForTx(approveTx);
}

function updateAsyncGamePreview() {
  const stage = document.getElementById('asyncGamePreview');
  if (!stage) return;

  if (activeTab === 0) {
    const ranks = ['A', 'K', 'Q', 'J', '10'];
    stage.innerHTML = '<div class="preview-deck">' +
      ranks.map((rank, i) =>
        '<div class="preview-card' + (i >= selectedPlayers ? ' inactive' : '') + '">' + rank + '</div>'
      ).join('') +
    '</div>';
    return;
  }

  const diceFaces = [
    [2, 5],
    [6, 3],
    [4, 4],
    [1, 6],
    [5, 2],
  ];
  stage.innerHTML = '<div class="preview-dice-board">' +
    diceFaces.map((pair, i) =>
      '<div class="preview-dice-seat' + (i >= selectedPlayers ? ' inactive' : '') + '">' +
        '<div class="preview-label">P' + (i + 1) + '</div>' +
        '<div class="preview-dice-pair">' +
          '<div class="preview-die">' + pair[0] + '</div>' +
          '<div class="preview-die">' + pair[1] + '</div>' +
        '</div>' +
      '</div>'
    ).join('') +
  '</div>';
}

// Format helpers
function fmtCashx(bigNum) {
  const n = parseFloat(ethers.utils.formatUnits(bigNum, 18));
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtEntry(entryAmount) {
  const n = parseFloat(ethers.utils.formatUnits(entryAmount, 18));
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(0) + 'M CASHX';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K CASHX';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' CASHX';
}

function shortAddress(address) {
  return address.slice(0, 6) + '…' + address.slice(-4);
}

function shortHash(hash) {
  return hash.slice(0, 6) + '…' + hash.slice(-4);
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

function addressButton(address) {
  return '<button class="address-link" type="button" onclick="showAddressPopover(event, \'' +
    address + '\')">' + shortAddress(address) + '</button>';
}

function txButton(txHash, verifyMode) {
  return '<button class="tx-link" type="button" onclick="showTxPopover(event, \'' +
    txHash + '\', \'' + (verifyMode || 'multi') + '\')">' + shortHash(txHash) + '</button>';
}

function formatResultForTable(gameType, result, gameId) {
  if (Number(gameType) === 0) {
    const ranks = ['','','2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const suits = ['♠','♥','♦','♣'];
    return (ranks[result] || String(result)) + suits[Number(gameId) % 4];
  }
  return String(result);
}

function resultHookForTable(gameType, result) {
  if (Number(gameType) === 0 && Number(result) === 14) {
    return '<span class="table-hook crown">Crown Card</span>';
  }
  if (Number(gameType) === 1) {
    const dice = decomposeRoll(Number(result));
    if (dice[0] === dice[1]) return '<span class="table-hook power">Power Roll</span>';
  }
  return '';
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
    '<button class="address-popover-action copy" type="button" onclick="copyPopoverValue(event, \'' + address + '\')">Copy Address</button>';

  document.body.appendChild(card);
  positionPopover(card, event.currentTarget);
  setTimeout(() => document.addEventListener('click', closeAddressPopover), 10);
}

function showTxPopover(event, txHash, verifyMode) {
  event.preventDefault();
  event.stopPropagation();
  closeAddressPopover();

  const card = document.createElement('div');
  card.className = 'address-popover';
  card.id = 'addressPopover';
  card.innerHTML =
    '<div class="address-popover-short">' + shortHash(txHash) + '</div>' +
    '<a class="address-popover-action" href="' + explorerTxLink(txHash) + '" target="_blank" rel="noopener">🔍 PulseScan</a>' +
    '<a class="address-popover-action" href="verifier.html?mode=' + (verifyMode || 'multi') + '&tx=' + txHash + '">✅ Verify Result</a>' +
    '<button class="address-popover-action copy" type="button" onclick="copyPopoverValue(event, \'' + txHash + '\')">Copy TX Hash</button>';

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
  const card = document.getElementById('addressPopover');
  if (card) card.remove();
  document.removeEventListener('click', closeAddressPopover);
}

function copyPopoverValue(event, value) {
  event.preventDefault();
  event.stopPropagation();
  navigator.clipboard.writeText(value).catch(() => {});
  closeAddressPopover();
}

function inviteLinkForGame(gameId) {
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace(/[^/]*$/, 'games.html');
  url.search = '';
  url.searchParams.set('game', '0');
  url.searchParams.set('join', String(gameId));
  url.hash = 'war-table-' + String(gameId);
  return url.toString();
}

function renderInvitePanel(gameId) {
  const panel = document.getElementById('invitePanel');
  if (!panel) return;
  const id = gameId || pendingInviteGameId;
  if (!id) {
    panel.classList.remove('visible', 'invite-join');
    panel.innerHTML = '';
    pendingJoinFromLobby = null;
    return;
  }

  const link = inviteLinkForGame(id);
  const fromLobby = pendingJoinFromLobby && pendingJoinFromLobby.id === String(id);
  const isJoinInvite = getInviteGameIdFromUrl() === String(id) || fromLobby;

  // Button label: "Join War Table #X" for Card War (gameType 0), "Join Battle Arena #X" for Dice Battle
  const joinLabel = fromLobby && pendingJoinFromLobby.gameType !== 0
    ? 'Join Battle Arena #' + String(id)
    : 'Join War Table #' + String(id);

  panel.classList.toggle('invite-join', isJoinInvite);
  panel.classList.add('visible');
  panel.innerHTML =
    '<b>' + (isJoinInvite ? 'Invited Table' : 'Invite') + '</b>' +
    '<span class="invite-link">' + escapeHtml(link) + '</span>' +
    '<div class="invite-actions' + (isJoinInvite ? ' single' : '') + '">' +
      (isJoinInvite
        ? '<button class="invite-btn invite-primary" type="button" onclick="joinInvitedGame(' + String(id) + ')">' + joinLabel + '</button>'
        : '<button class="invite-btn" type="button" onclick="copyInviteLink(' + String(id) + ')">Copy Link</button>' +
          '<button class="invite-btn" type="button" onclick="openInviteLink(' + String(id) + ')">Open Tab</button>') +
    '</div>';
}

function syncInviteFromPlayerGames(games) {
  if (getInviteGameIdFromUrl()) {
    renderInvitePanel();
    return;
  }

  const open = games.find(({ g }) => {
    const playerIdx = Array.from(g.players).findIndex(
      p => p.toLowerCase() === (playerAddress || '').toLowerCase()
    );
    return playerIdx >= 0 &&
      !g.resolved &&
      !g.cancelled &&
      !g.readyToSettle &&
      Number(g.playerCount) < Number(g.maxPlayers);
  });

  pendingInviteGameId = open ? open.id.toString() : null;
  renderInvitePanel();
}

function showInviteForGame(gameId) {
  pendingInviteGameId = String(gameId);
  renderInvitePanel(gameId);
  const panel = document.getElementById('invitePanel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Called when user clicks JOIN IN from the live lobby — shows the panel with a join button
function showJoinPanel(gameId, gameType) {
  pendingJoinFromLobby = { id: String(gameId), gameType: Number(gameType) };
  pendingInviteGameId = String(gameId);
  renderInvitePanel(gameId);
  const panel = document.getElementById('invitePanel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function copyInviteLink(gameId) {
  navigator.clipboard.writeText(inviteLinkForGame(gameId)).catch(() => {});
  setStatus('Invite link copied for war table #' + String(gameId) + '.', 'success');
}

function openInviteLink(gameId) {
  window.open(inviteLinkForGame(gameId), '_blank', 'noopener');
}

function joinInvitedGame(gameId) {
  pendingJoinFromLobby = null;
  joinGame(gameId);
}

function getInviteGameIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('join') || params.get('table') || params.get('gameId');
  return id && /^\d+$/.test(id) ? id : null;
}

function findCreatedGameId(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  const iface = new ethers.utils.Interface(ASYNC_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed.name === 'GameCreated') return parsed.args.gameId.toString();
    } catch (_) {}
  }
  return null;
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function timeAgo(timestampSec) {
  const diff = Math.floor(Date.now() / 1000) - timestampSec;
  if (diff < 60)    return diff + 's ago';
  if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    if (err && err.code === 'TRANSACTION_REPLACED') {
      if (err.cancelled) {
        const cancelled = new Error('Transaction cancelled in wallet.');
        cancelled.code = 4001;
        throw cancelled;
      }
      return err.receipt;
    }
    throw err;
  }
}

// Internal helpers
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
  el.className = 'status-box ' + (type || '');
  updateWalletFlowFromStatus(msg, type);
}

function updateWalletFlowFromStatus(msg, type) {
  const steps = ['approve', 'fund', 'join', 'claim'];
  const stepEls = [...document.querySelectorAll('[data-tx-step]')];
  const note = document.getElementById('txProgressNote');
  if (!stepEls.length || !note) return;

  const text = String(msg || '').toLowerCase();
  let active = '';
  let doneThrough = -1;

  if (/approve/.test(text)) active = 'approve';
  else if (/confirm|place|creating|created|war table|dice battle/.test(text)) active = 'fund';
  else if (/join|draw in|roll in/.test(text)) active = 'join';
  else if (/claim|refund|settle/.test(text)) active = 'claim';

  if (/approval confirmed/.test(text)) doneThrough = 0;
  if (/created|joined|confirmed|complete|claimed|settled|refunded/.test(text) || type === 'success' || type === 'win') {
    doneThrough = Math.max(doneThrough, active ? steps.indexOf(active) : -1);
  }

  stepEls.forEach(step => {
    const idx = steps.indexOf(step.dataset.txStep);
    step.classList.toggle('active', step.dataset.txStep === active && doneThrough < idx);
    step.classList.toggle('done', idx > -1 && idx <= doneThrough);
  });

  if (msg) note.textContent = msg;
  if (type === 'error') note.textContent = 'Wallet step stopped. Check MetaMask, then try again.';
}

function _updatePotEstimate() {
  const entry  = getEntryWei();
  const pot    = entry.mul(selectedPlayers);
  const winner = pot.mul(95).div(100);
  const burned = pot.sub(winner);
  const el = document.getElementById('potEstimate');
  if (!el) return;
  el.innerHTML =
    '<div class="estimate-row"><span>Total Pot</span><b>' + fmtCashx(pot) + ' CASHX</b></div>' +
    '<div class="estimate-row"><span>Burn</span><b class="burn-value">' + fmtCashx(burned) + ' CASHX</b></div>' +
    '<div class="estimate-row"><span>Winner Gets</span><b class="winner-value">' + fmtCashx(winner) + ' CASHX</b></div>';
}

function _updateCreateBtn() {
  const btn = document.getElementById('createBtn');
  if (btn) btn.disabled = !signer || transacting;
}

function _disableActions() {
  const btn = document.getElementById('createBtn');
  if (btn) btn.disabled = true;
  document.querySelectorAll('.btn-join, .btn-leave, .btn-refund').forEach(b => b.disabled = true);
}

function _enableActions() {
  _updateCreateBtn();
  if (currentView === 'A') refreshAllActiveGames();
  else refreshFilteredActiveGames();
}

function _handleTxError(err) {
  if (err.code === 4001 || err.code === 'ACTION_REJECTED') {
    setStatus('Transaction rejected.', 'error');
  } else {
    const msg = err.reason || (err.data && err.data.message) || err.message || 'Unknown error';
    setStatus('Error: ' + msg, 'error');
  }
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
  location.reload();
}

// Init
selectTier(1);
selectPlayers(2);

// Multiplayer now opens Card War by default. Legacy Dice Battle links redirect here.
(function() {
  window.addEventListener('cashx:approvalPresetChanged', event => {
    selectApproval(event.detail && event.detail.value);
  });
  pendingInviteGameId = getInviteGameIdFromUrl();
  showPlayView(0);
  if (pendingInviteGameId) {
    setStatus('Invite loaded for war table #' + pendingInviteGameId + '. Connect your wallet, then join the table.', 'show');
  }
})();

// Polling
setInterval(() => { refreshFilteredActiveGames(); }, 15_000);

setInterval(() => {
  if (currentView === 'BC') refreshFilteredResults();
}, 30_000);

// Fetch burns per game type (Card War vs Dice Battle)
// Uses gameCount() + getGame() only — no event queries, no block-range limits.
// Mirrors the contract's exact payout math to compute burned per game.
(async () => {
  try {
    const roProvider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const roContract = new ethers.Contract(ASYNC_GAMES_ADDRESS, [
      'function gameCount() view returns (uint256)',
      'function getGame(uint256 gameId) view returns (tuple(uint8 gameType, uint8 maxPlayers, uint8 playerCount, uint256 entryAmount, uint256 createdAt, bool resolved, bool cancelled, bool readyToSettle, uint256 settleBlock, address[5] players, uint8[5] results, address winner))',
    ], roProvider);

    const count = (await roContract.gameCount()).toNumber();

    const burns = { 0: ethers.BigNumber.from(0), 1: ethers.BigNumber.from(0) };

    if (count > 0) {
      const ids      = Array.from({ length: count }, (_, i) => i + 1);
      const allGames = await Promise.all(ids.map(id => roContract.getGame(id)));

      allGames.forEach((g, idx) => {
        if (!g.resolved) return;
        const gType    = Number(g.gameType);
        const totalPot = g.entryAmount.mul(g.maxPlayers);
        const payout   = totalPot.mul(95).div(100); // mirrors _payout() exactly
        const burned   = totalPot.sub(payout);
        if (gType === 0 || gType === 1) burns[gType] = burns[gType].add(burned);
      });
    }

    asyncBurnByType = burns;
    updateBurnDisplay();

  } catch (e) {
    console.warn('asyncBurnByType fetch error:', e);
  }
})();

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
