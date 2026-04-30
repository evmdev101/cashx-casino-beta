# MinesGame Deployment Packet

## Contract

- File: `MinesGame.sol`
- Contract name: `MinesGame`
- Deployed address: `0xF5Ba5129dD41acb8aF5050aF1EcA84dD497E3095`
- Compiler: Solidity `0.8.19`
- Optimizer: off, unless you intentionally recompile every artifact with optimizer on
- Constructor args: none
- CASHX token: `0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665`
- Burn address: `0x000000000000000000000000000000000000dEaD`

## Current Safety Settings

- Min bet: `500 CASHX`
- Max bet: `5,000 CASHX`
- Max payout: `25,000 CASHX`
- Minimum pool reserve: `25,000 CASHX`
- Burn / house edge: `3%`
- Max selected tiles per round: `10`
- Reveal deadline: `250 blocks`

## Fairness Model

The live contract is manual-only.

The player commits before the future block hash exists:

```text
commitHash = keccak256(abi.encode(player, mineCount, picks, secret))
```

Then the player reveals:

```text
revealGame(gameId, picks, secret)
```

This is intentionally different from a fully interactive off-chain-looking Mines board. It prevents a player from waiting until the randomness block is public and then choosing only safe tiles.

## Compile Command

```powershell
npx -y solc@0.8.19 --bin --abi MinesGame.sol
```

Expected artifacts:

- `MinesGame_sol_MinesGame.bin`
- `MinesGame_sol_MinesGame.abi`

## Deploy Steps

1. Deploy `MinesGame` on PulseChain.
2. Verify source on PulseScan using:
   - compiler `v0.8.19`
   - optimizer disabled
   - no constructor arguments
3. Fund the prize pool with CASHX:
   - approve CASHX to the Mines contract
   - call `fundPool(amount)`
4. Confirm safety values:
   - `minBet()`
   - `maxBet()`
   - `maxPayout()`
   - `minPoolReserve()`
5. Only then wire the deployed address into the Mines frontend.
6. Paste the deployed address into `MINES_GAME_ADDRESS` in `verifier.html`. Done: `0xF5Ba5129dD41acb8aF5050aF1EcA84dD497E3095`.

## Frontend Work After Deployment

- Add `MINES_GAME_ADDRESS`
- Add `MINES_ABI`
- Add wallet connect / PulseChain switch
- Add CASHX allowance + approval flow
- On start:
  - store selected tiles locally
  - generate secret locally
  - submit `placeGame(betAmount, mineCount, pickCount, commitHash)`
- On cashout/reveal:
  - call `revealGame(gameId, picks, secret)`
- Add transaction links and verifier links

## Do Not Ship Without

- Prize pool funded above `minPoolReserve`
- Small first max payout
- Small max bet during beta
- Manual test with one win and one loss
- Source verified on PulseScan
