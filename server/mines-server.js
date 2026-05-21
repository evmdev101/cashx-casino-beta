import crypto from 'node:crypto';
import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { AbiCoder, Contract, JsonRpcProvider, Wallet, getBytes, getAddress, hexlify, isAddress, keccak256, solidityPackedKeccak256 } from 'ethers';

dotenv.config();

const PORT = Number(process.env.PORT || 8787);
const CHAIN_ID = BigInt(process.env.CHAIN_ID || 369);
const CONTRACT_ADDRESS = process.env.MINES_CONTRACT_ADDRESS || '';
const SIGNER_KEY = process.env.GAME_SIGNER_PRIVATE_KEY || '';
const RPC_URL = process.env.RPC_URL || 'https://rpc.pulsechain.com';
const AUTO_SETTLE = String(process.env.AUTO_SETTLE || 'false').toLowerCase() === 'true';
const TILE_COUNT = 25;
const MAX_SAFE_PICKS = 10;
const MAX_MINE_COUNT = 16;
const HOUSE_EDGE_BPS = 300n;
const BPS = 10000n;
const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

if (!isAddress(CONTRACT_ADDRESS)) {
  if (isProd) throw new Error('MINES_CONTRACT_ADDRESS must be a valid address in production');
  console.warn('MINES_CONTRACT_ADDRESS is not configured yet.');
}
if (!SIGNER_KEY) {
  if (isProd) throw new Error('GAME_SIGNER_PRIVATE_KEY is required in production');
  console.warn('GAME_SIGNER_PRIVATE_KEY is not configured yet.');
}

const signer = SIGNER_KEY ? new Wallet(SIGNER_KEY) : null;
const provider = new JsonRpcProvider(RPC_URL);
let rpcChainId = null;
let rpcChainIdMismatch = false;
provider.getNetwork()
  .then(net => {
    rpcChainId = BigInt(net.chainId);
    rpcChainIdMismatch = rpcChainId !== CHAIN_ID;
    if (rpcChainIdMismatch) {
      const msg = `RPC chainId ${rpcChainId} does not match configured CHAIN_ID ${CHAIN_ID}`;
      if (isProd) throw new Error(msg);
      console.warn(msg);
    }
  })
  .catch(err => {
    console.warn('Could not read RPC network chainId:', err && err.message ? err.message : String(err));
  });
const chainSigner = signer ? signer.connect(provider) : null;
const minesContract = isAddress(CONTRACT_ADDRESS) && chainSigner
  ? new Contract(CONTRACT_ADDRESS, [
      'function settleGame(uint256 gameId,uint256 revealedMask,bool won,bytes32 serverSeed,bytes signature) external',
    ], chainSigner)
  : null;
const sessions = new Map();
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PER_MINUTE || 120),
  standardHeaders: true,
  legacyHeaders: false,
}));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (!isProd) return cb(null, true);
    if (!allowedOrigins.length) return cb(new Error('CORS is not configured'), false);
    return cb(null, allowedOrigins.includes(origin));
  },
}));
app.use(express.json({ limit: '64kb' }));

app.get('/api/mines/health', (_, res) => {
  res.json({
    ok: true,
    signer: signer ? signer.address : null,
    contractAddress: CONTRACT_ADDRESS || null,
    autoSettle: AUTO_SETTLE,
    chainIdConfigured: CHAIN_ID.toString(),
    chainIdRpc: rpcChainId ? rpcChainId.toString() : null,
    chainIdMismatch: rpcChainIdMismatch,
  });
});

app.post('/api/mines/session', (req, res) => {
  try {
    const player = normalizeAddress(req.body.player);
    const mineCount = normalizeMineCount(req.body.mineCount);
    const serverSeed = randomBytes32();
    const sessionId = randomBytes32();
    const serverSeedHash = keccak256(serverSeed);

    sessions.set(sessionId, {
      sessionId,
      player,
      mineCount,
      serverSeed,
      serverSeedHash,
      gameId: null,
      betAmount: null,
      contractAddress: null,
      mineTiles: null,
      revealedTiles: [],
      settled: false,
      finalResult: null,
    });

    res.json({ sessionId, serverSeedHash, signer: signer ? signer.address : null });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/mines/attach', (req, res) => {
  try {
    const session = getSession(req.body.sessionId);
    const gameId = BigInt(req.body.gameId);
    const betAmount = BigInt(req.body.betAmount);
    if (!isAddress(CONTRACT_ADDRESS)) throw new Error('MINES_CONTRACT_ADDRESS is not configured');
    const contractAddress = normalizeAddress(CONTRACT_ADDRESS);

    session.gameId = gameId;
    session.betAmount = betAmount;
    session.contractAddress = contractAddress;
    session.mineTiles = generateMineTiles(gameId, session.player, session.mineCount, session.serverSeed, contractAddress);

    res.json({
      ok: true,
      gameId: gameId.toString(),
      safePicks: 0,
      nextMultiplier: multiplierBps(session.mineCount, 1).toString(),
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/mines/reveal', async (req, res) => {
  try {
    const session = getAttachedSession(req.body.sessionId);
    const tile = normalizeTile(req.body.tile);
    if (session.finalResult) return res.json(session.finalResult);
    requireOpen(session);
    if (session.revealedTiles.includes(tile)) throw new Error('Tile already revealed');

    const hitMine = session.mineTiles.includes(tile);
    if (hitMine) {
      const revealedTiles = [...session.revealedTiles, tile];
      const revealedMask = tilesToMask(revealedTiles);
      const signature = await signResult(session, revealedMask, false);
      const txHash = await autoSettle(session, revealedMask, false, signature);
      session.finalResult = {
        hitMine: true,
        won: false,
        tile,
        safeTiles: session.revealedTiles,
        revealedTiles,
        mineTiles: session.mineTiles,
        revealedMask: revealedMask.toString(),
        serverSeed: session.serverSeed,
        signature,
        txHash,
      };
      if (txHash) session.settled = true;
      return res.json(session.finalResult);
    }

    session.revealedTiles.push(tile);
    const safePicks = session.revealedTiles.length;
    const revealedMask = tilesToMask(session.revealedTiles);
    const maxSafeTiles = TILE_COUNT - session.mineCount;
    const forceCashout = safePicks >= maxSafeTiles || safePicks >= MAX_SAFE_PICKS;
    res.json({
      hitMine: false,
      won: false,
      tile,
      safeTiles: session.revealedTiles,
      revealedMask: revealedMask.toString(),
      multiplierBps: multiplierBps(session.mineCount, safePicks).toString(),
      forceCashout,
      nextMultiplierBps: !forceCashout
        ? multiplierBps(session.mineCount, safePicks + 1).toString()
        : null,
    });
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/api/mines/cashout', async (req, res) => {
  try {
    const session = getAttachedSession(req.body.sessionId);
    if (session.finalResult) return res.json(session.finalResult);
    requireOpen(session);
    if (!session.revealedTiles.length) throw new Error('Reveal at least one safe tile first');

    const revealedMask = tilesToMask(session.revealedTiles);
    const signature = await signResult(session, revealedMask, true);
    const txHash = await autoSettle(session, revealedMask, true, signature);

    session.finalResult = {
      won: true,
      safeTiles: session.revealedTiles,
      mineTiles: session.mineTiles,
      revealedMask: revealedMask.toString(),
      multiplierBps: multiplierBps(session.mineCount, session.revealedTiles.length).toString(),
      serverSeed: session.serverSeed,
      signature,
      txHash,
    };
    if (txHash) session.settled = true;
    res.json(session.finalResult);
  } catch (err) {
    sendError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`CashX instant Mines server listening on http://localhost:${PORT}`);
});

async function signResult(session, revealedMask, won) {
  if (!signer) throw new Error('Backend signer is not configured');
  const resultHash = AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'uint256', 'bytes32', 'uint256', 'bool', 'bytes32'],
    [
      session.contractAddress,
      CHAIN_ID,
      session.gameId,
      gameHash(session),
      revealedMask,
      won,
      session.serverSeed,
    ]
  );
  return signer.signMessage(getBytes(keccak256(resultHash)));
}

function gameHash(session) {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ['address', 'uint256', 'uint8'],
    [session.player, session.betAmount, session.mineCount]
  );
  return keccak256(encoded);
}

async function autoSettle(session, revealedMask, won, signature) {
  if (!AUTO_SETTLE || !minesContract) return null;
  const tx = await minesContract.settleGame(
    session.gameId,
    revealedMask,
    won,
    session.serverSeed,
    signature
  );
  return tx.hash;
}

function generateMineTiles(gameId, player, mineCount, serverSeed, contractAddress) {
  const mines = [];
  const seen = new Set();
  let nonce = 0n;

  while (mines.length < mineCount) {
    const hash = solidityPackedKeccak256(
      ['bytes32', 'uint256', 'address', 'uint8', 'address', 'uint256'],
      [serverSeed, gameId, player, mineCount, contractAddress, nonce]
    );
    const tile = Number(BigInt(hash) % BigInt(TILE_COUNT));
    if (!seen.has(tile)) {
      seen.add(tile);
      mines.push(tile);
    }
    nonce++;
  }

  return mines;
}

function multiplierBps(mineCount, safePicks) {
  let safeNumerator = 1n;
  let safeDenominator = 1n;
  for (let i = 0; i < safePicks; i++) {
    safeNumerator *= BigInt(TILE_COUNT - mineCount - i);
    safeDenominator *= BigInt(TILE_COUNT - i);
  }
  return safeDenominator * (BPS - HOUSE_EDGE_BPS) * BPS / safeNumerator / BPS;
}

function tilesToMask(tiles) {
  return tiles.reduce((mask, tile) => mask | (1n << BigInt(tile)), 0n);
}

function getSession(sessionId) {
  const session = sessions.get(String(sessionId || ''));
  if (!session) throw new Error('Session not found');
  return session;
}

function getAttachedSession(sessionId) {
  const session = getSession(sessionId);
  if (!session.gameId || !session.betAmount || !session.contractAddress || !session.mineTiles) {
    throw new Error('Game is not attached yet');
  }
  return session;
}

function requireOpen(session) {
  if (session.settled) throw new Error('Game already settled');
}

function normalizeAddress(value) {
  if (!isAddress(value)) throw new Error('Bad address');
  return getAddress(value);
}

function normalizeMineCount(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MINE_COUNT) {
    throw new Error('Mine count is capped at ' + MAX_MINE_COUNT + ' during beta');
  }
  return n;
}

function normalizeTile(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n >= TILE_COUNT) throw new Error('Bad tile');
  return n;
}

function randomBytes32() {
  return hexlify(crypto.randomBytes(32));
}

function sendError(res, err) {
  res.status(400).json({ error: err.message || 'Request failed' });
}
