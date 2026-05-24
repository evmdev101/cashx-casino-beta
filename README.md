# CashX Casino (Beta)

Vanilla-JS frontend + Node/Express backends for CashX casino games on PulseChain.

## Quick start (local)

### Frontend
- Open `index.html` (or `games.html`, etc.) in a browser, or serve the repo with any static server.

### Backends
The repo contains two Node servers under `server/`:
- `mines-server.js` (instant Mines sessions / settlement signer)
- `pvp-server.js` (PvP matchmaker + result signer for tic-tac-toe / connect4 / 8ball)

From the repo root:
- `cd server`
- `npm install`
- `npm run start` (mines) or `npm run pvp` (pvp)

## Environment variables (server)

See `server/.env.example` for the full list.

Important notes:
- **Do not store real private keys in `server/.env`** inside this repo directory (especially if it’s synced via OneDrive). Use host/CI secrets and keep local files as placeholders.
- In **production**, set `NODE_ENV=production` and configure `CORS_ORIGINS` explicitly (comma-separated). The servers are intended to fail fast if `CORS_ORIGINS` is missing.

## Safety / launch checklist (high-level)

- Verify `CHAIN_ID` / `PVP_CHAIN_ID` and all contract addresses match the intended network.
- Review token allowance flows (`approve`) to ensure the UI only requests the minimum required allowance.
- Validate game fairness claims: commit/reveal + blockhash-based entropy is **not** VRF-grade unpredictability.

## Dev scripts

From repo root:
- `npm run lint` (when configured)
- `npm test`
- `npm run check:server`

