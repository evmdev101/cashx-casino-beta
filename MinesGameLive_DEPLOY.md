# CASHX Instant Mines Deploy

This is the premium fast Mines version:

1. Backend creates a hidden server seed and gives the app its hash.
2. Player starts the game on-chain with that seed hash.
3. Backend reveals clicked tiles instantly in the browser.
4. Player can cash out after safe reveals.
5. Backend reveals the server seed and signs the final result.
6. Contract verifies the seed, signature, mine layout, payout, and burn.
7. Contract pays CASHX and burns 3% of the original bet.

## Contract

1. Open `MinesGameLive.sol` in Remix.
2. Compiler: `0.8.19` or newer.
3. Enable optimizer.
4. Deploy `MinesGameLive`.
5. Constructor argument: backend signer wallet address.
6. Fund the contract with CASHX using `fundPool`.
7. Deployed contract address:

```text
0x684e6B760FC931BB858b3bf3dFC056e550b13D90
```

File:

```text
mines-game/main-live.js
```

## Backend

Copy `server/.env.example` to `server/.env`, then set:

```text
MINES_CONTRACT_ADDRESS=deployed contract address
GAME_SIGNER_PRIVATE_KEY=private key for the backend signer wallet
AUTO_SETTLE=false
```

If `AUTO_SETTLE=true`, the backend can submit final settlement transactions itself. That is smoother, but the backend signer wallet needs PLS for gas.

## Player Feel

Starting the game still needs a wallet transaction because CASHX moves into the contract. After that, tile clicks reveal instantly from the backend. Cashout can be either backend-settled or wallet-confirmed depending on `AUTO_SETTLE`.
