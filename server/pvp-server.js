import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { AbiCoder, Wallet, getAddress, getBytes, keccak256, toUtf8Bytes } from 'ethers';

const PORT = Number(process.env.PORT || process.env.PVP_PORT || 8790);
const BURN_BPS = 500n;
const BPS = 10000n;
const MAX_MARKS_PER_PLAYER = 3;
const CONNECT4_COLUMNS = 7;
const CONNECT4_ROWS = 6;
const PVP_CHAIN_ID = Number(process.env.PVP_CHAIN_ID || 369);
const PVP_WAGER_ADDRESS = process.env.PVP_WAGER_ADDRESS || '';
const PVP_SIGNER_PRIVATE_KEY = process.env.PVP_SIGNER_PRIVATE_KEY || '';
const abiCoder = AbiCoder.defaultAbiCoder();
const rooms = new Map();

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

app.get('/api/pvp/health', (_, res) => {
  res.json({
    ok: true,
    mode: 'prototype',
    games: ['tictactoe', 'connect4'],
    burnBps: Number(BURN_BPS),
    rooms: rooms.size,
    chainId: PVP_CHAIN_ID,
    contractAddress: PVP_WAGER_ADDRESS || null,
    signerReady: Boolean(PVP_SIGNER_PRIVATE_KEY),
  });
});

app.post('/api/pvp/rooms', (req, res) => {
  try {
    const game = normalizeGame(req.body.game);
    const creator = normalizePlayer(req.body.creator);
    const wager = normalizeWager(req.body.wager);
    const clockSeconds = normalizeClock(req.body.clockSeconds);
    const room = {
      id: crypto.randomUUID(),
      game,
      variant: game === 'connect4' ? 'classic' : 'vanishing',
      status: 'waiting',
      players: [
        { address: creator, mark: 'X' },
      ],
      wager,
      board: createBoard(game),
      markHistory: { X: [], O: [] },
      turn: 'X',
      winner: null,
      winReason: null,
      winningCells: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastMoveAt: null,
      clockSeconds,
      moves: [],
      chain: normalizeChain(req.body.chain),
    };
    rooms.set(room.id, room);
    res.json(publicRoom(room));
  } catch (err) {
    sendError(res, err);
  }
});

app.get('/api/pvp/rooms/:id', (req, res) => {
  try {
    const room = getRoom(req.params.id);
    settleExpiredRoom(room);
    res.json(publicRoom(room));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/pvp/rooms/:id/join', (req, res) => {
  try {
    const room = getRoom(req.params.id);
    const player = normalizePlayer(req.body.player);
    if (room.status !== 'waiting') throw new Error('Room is not open');
    if (room.players.some(entry => entry.address === player)) throw new Error('Player already joined');
    if (room.players.length >= 2) throw new Error('Room is full');
    room.players.push({ address: player, mark: 'O' });
    if (room.chain) {
      room.chain.player2 = normalizeOptionalAddress(req.body.chainPlayer2) || player;
    }
    room.status = 'active';
    room.updatedAt = Date.now();
    room.lastMoveAt = Date.now();
    res.json(publicRoom(room));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/pvp/rooms/:id/move', (req, res) => {
  try {
    const room = getRoom(req.params.id);
    const player = normalizePlayer(req.body.player);
    const move = normalizeMove(room.game, req.body);
    if (room.status !== 'active') throw new Error('Room is not active');
    if (settleExpiredRoom(room)) return res.json(publicRoom(room));

    const seat = room.players.find(entry => entry.address === player);
    if (!seat) throw new Error('Player is not in this room');
    if (seat.mark !== room.turn) throw new Error('Not your turn');
    const appliedMove = applyGameMove(room, seat.mark, move);
    room.moves.push({ player, mark: seat.mark, ...appliedMove, at: Date.now() });
    room.lastMoveAt = Date.now();
    room.updatedAt = Date.now();

    const result = getGameResult(room);
    if (result) {
      room.status = 'settled';
      room.winner = result.winner ? room.players.find(entry => entry.mark === result.winner).address : null;
      room.winReason = result.winner ? 'connect' : 'draw';
      room.winningCells = result.winningCells || [];
      return res.json(publicRoom(room));
    }

    room.turn = room.turn === 'X' ? 'O' : 'X';
    res.json(publicRoom(room));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/pvp/rooms/:id/timeout', (req, res) => {
  try {
    const room = getRoom(req.params.id);
    if (room.status !== 'active') throw new Error('Room is not active');
    if (!settleExpiredRoom(room)) throw new Error('Move clock has not expired yet');
    res.json(publicRoom(room));
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/pvp/rooms/:id/sign-result', async (req, res) => {
  try {
    if (!PVP_SIGNER_PRIVATE_KEY) throw new Error('Result signer is not configured');
    const room = getRoom(req.params.id);
    if (room.status !== 'settled') throw new Error('Room is not settled');
    if (!room.winner) throw new Error('Draws do not have a winner to sign');
    if (!room.chain || !room.chain.matchId) throw new Error('Room is not linked to an on-chain match');

    const contractAddress = normalizeAddress(req.body.contractAddress || room.chain.contractAddress || PVP_WAGER_ADDRESS);
    const chainId = Number(req.body.chainId || room.chain.chainId || PVP_CHAIN_ID);
    const matchId = String(room.chain.matchId);
    const player1 = normalizeAddress(room.chain.player1 || room.players[0]?.address);
    const player2 = normalizeAddress(room.chain.player2 || room.players[1]?.address);
    const winner = normalizeAddress(room.winner);
    const wagerWei = String(room.chain.wagerWei || req.body.wagerWei || '');
    if (!/^\d+$/.test(wagerWei) || BigInt(wagerWei) <= 0n) throw new Error('Missing on-chain wager');

    const finalState = {
      roomId: room.id,
      game: room.game,
      board: room.board,
      moves: room.moves,
      winner,
      winReason: room.winReason,
      winningCells: room.winningCells,
    };
    const resultDataHash = keccak256(toUtf8Bytes(JSON.stringify(finalState)));
    const resultHash = buildResultHash({
      contractAddress,
      chainId,
      matchId,
      gameType: gameTypeId(room.game),
      player1,
      player2,
      wagerWei,
      winner,
      resultDataHash,
    });
    const wallet = new Wallet(PVP_SIGNER_PRIVATE_KEY);
    const signature = await wallet.signMessage(getBytes(resultHash));

    res.json({
      ok: true,
      contractAddress,
      chainId,
      matchId,
      gameType: gameTypeId(room.game),
      winner,
      wagerWei,
      resultDataHash,
      resultHash,
      signature,
      signer: wallet.address,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`CashX PvP prototype server listening on http://localhost:${PORT}`);
});

function publicRoom(room) {
  const pot = room.wager * 2n;
  const burn = pot * BURN_BPS / BPS;
  return {
    id: room.id,
    game: room.game,
    variant: room.variant,
    status: room.status,
    players: room.players,
    wager: room.wager.toString(),
    pot: pot.toString(),
    burn: burn.toString(),
    payout: (pot - burn).toString(),
    board: room.board,
    markHistory: room.markHistory,
    maxMarksPerPlayer: MAX_MARKS_PER_PLAYER,
    columns: room.game === 'connect4' ? CONNECT4_COLUMNS : 3,
    rows: room.game === 'connect4' ? CONNECT4_ROWS : 3,
    turn: room.turn,
    winner: room.winner,
    winReason: room.winReason,
    winningCells: room.winningCells,
    clockSeconds: room.clockSeconds,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    lastMoveAt: room.lastMoveAt,
    moveExpiresAt: room.status === 'active' && room.lastMoveAt
      ? room.lastMoveAt + room.clockSeconds * 1000
      : null,
    lastMove: room.moves.length ? room.moves[room.moves.length - 1] : null,
    moveCount: room.moves.length,
    chain: room.chain,
  };
}

function settleExpiredRoom(room) {
  if (room.status !== 'active' || !room.lastMoveAt) return false;
  if (Date.now() <= room.lastMoveAt + room.clockSeconds * 1000) return false;

  const winnerSeat = room.players.find(entry => entry.mark !== room.turn);
  room.status = 'settled';
  room.winner = winnerSeat ? winnerSeat.address : null;
  room.winReason = 'timeout';
  room.winningCells = [];
  room.updatedAt = Date.now();
  return true;
}

function createBoard(game) {
  return Array(game === 'connect4' ? CONNECT4_COLUMNS * CONNECT4_ROWS : 9).fill('');
}

function applyGameMove(room, mark, move) {
  if (room.game === 'connect4') {
    const cell = applyConnect4Move(room, mark, move.column);
    return { column: move.column, cell };
  }

  if (room.board[move.cell]) throw new Error('Cell already played');
  const vanishedCell = applyVanishingMove(room, mark, move.cell);
  return { cell: move.cell, vanishedCell };
}

function applyVanishingMove(room, mark, cell) {
  room.board[cell] = mark;
  room.markHistory[mark].push(cell);
  if (room.markHistory[mark].length <= MAX_MARKS_PER_PLAYER) return null;

  const vanishedCell = room.markHistory[mark].shift();
  if (room.board[vanishedCell] === mark) {
    room.board[vanishedCell] = '';
  }
  return vanishedCell;
}

function applyConnect4Move(room, mark, column) {
  for (let row = CONNECT4_ROWS - 1; row >= 0; row--) {
    const cell = row * CONNECT4_COLUMNS + column;
    if (!room.board[cell]) {
      room.board[cell] = mark;
      return cell;
    }
  }
  throw new Error('Column is full');
}

function getGameResult(room) {
  return room.game === 'connect4'
    ? getConnect4Result(room.board)
    : getTicTacToeResult(room.board);
}

function getTicTacToeResult(board) {
  const wins = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  for (const line of wins) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], winningCells: line };
    }
  }
  return null;
}

function getConnect4Result(board) {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];

  for (let row = 0; row < CONNECT4_ROWS; row++) {
    for (let col = 0; col < CONNECT4_COLUMNS; col++) {
      const start = row * CONNECT4_COLUMNS + col;
      const mark = board[start];
      if (!mark) continue;

      for (const [dc, dr] of directions) {
        const cells = [start];
        for (let step = 1; step < 4; step++) {
          const nextCol = col + dc * step;
          const nextRow = row + dr * step;
          if (nextCol < 0 || nextCol >= CONNECT4_COLUMNS || nextRow < 0 || nextRow >= CONNECT4_ROWS) break;
          const next = nextRow * CONNECT4_COLUMNS + nextCol;
          if (board[next] !== mark) break;
          cells.push(next);
        }
        if (cells.length === 4) return { winner: mark, winningCells: cells };
      }
    }
  }

  if (board.every(Boolean)) return { winner: null, winningCells: [] };
  return null;
}

function getRoom(id) {
  const room = rooms.get(String(id || ''));
  if (!room) throw new Error('Room not found');
  return room;
}

function normalizeGame(value) {
  const game = String(value || 'tictactoe').toLowerCase();
  if (!['tictactoe', 'connect4'].includes(game)) throw new Error('Unsupported game');
  return game;
}

function normalizePlayer(value) {
  const player = String(value || '').trim();
  if (!player) throw new Error('Player is required');
  return player.toLowerCase();
}

function normalizeWager(value) {
  if (!/^\d+$/.test(String(value || ''))) throw new Error('Wager must be a whole number');
  const wager = BigInt(String(value || '0'));
  if (wager <= 0n) throw new Error('Wager must be greater than zero');
  return wager;
}

function normalizeClock(value) {
  const clock = Number(value || 30);
  if (!Number.isInteger(clock) || clock < 5 || clock > 300) throw new Error('Clock must be 5 to 300 seconds');
  return clock;
}

function normalizeChain(value) {
  if (!value || typeof value !== 'object') return null;
  const matchId = String(value.matchId || '').trim();
  const wagerWei = String(value.wagerWei || '').trim();
  if (!/^\d+$/.test(matchId) || !/^\d+$/.test(wagerWei)) throw new Error('Bad on-chain match data');
  return {
    matchId,
    wagerWei,
    chainId: Number(value.chainId || PVP_CHAIN_ID),
    contractAddress: normalizeOptionalAddress(value.contractAddress) || null,
    player1: normalizeOptionalAddress(value.player1) || null,
    player2: normalizeOptionalAddress(value.player2) || null,
  };
}

function normalizeOptionalAddress(value) {
  if (!value) return null;
  return normalizeAddress(value);
}

function normalizeAddress(value) {
  try {
    return getAddress(String(value || '').trim());
  } catch (_) {
    throw new Error('Bad wallet address');
  }
}

function gameTypeId(game) {
  return game === 'connect4' ? 0 : 1;
}

function buildResultHash({ contractAddress, chainId, matchId, gameType, player1, player2, wagerWei, winner, resultDataHash }) {
  return keccak256(abiCoder.encode(
    ['address', 'uint256', 'uint256', 'uint8', 'address', 'address', 'uint256', 'address', 'bytes32'],
    [contractAddress, chainId, matchId, gameType, player1, player2, wagerWei, winner, resultDataHash]
  ));
}

function normalizeMove(game, body) {
  if (game === 'connect4') {
    const column = Number(body.column ?? body.cell);
    if (!Number.isInteger(column) || column < 0 || column >= CONNECT4_COLUMNS) throw new Error('Column must be 0 to 6');
    return { column };
  }

  const cell = Number(body.cell);
  if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw new Error('Cell must be 0 to 8');
  return { cell };
}

function sendError(res, err) {
  res.status(400).json({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}
