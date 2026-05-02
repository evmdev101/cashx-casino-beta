# PvPWager deploy notes

`PvPWager.sol` is the first CASHX PvP escrow contract for games like Connect Four and Vanishing Tic Tac Toe.

## What it does

- Player 1 creates a match and deposits the wager.
- Player 2 joins and deposits the same wager.
- The backend runs the fast game off-chain, then signs the winner.
- The winner claims the pot minus burn.
- 5% of the total pot is sent to the burn address.
- There is no house payout and no prize pool.

Example:

- Player 1 wager: 100,000 CASHX
- Player 2 wager: 100,000 CASHX
- Total pot: 200,000 CASHX
- Burn: 10,000 CASHX
- Winner payout: 190,000 CASHX

## Constructor

Deploy with the backend signer:

```text
0x31ae1cE932BEE70Bc7e654438082cA2C5Ff36C7E
```

If `address(0)` is used, the deployer becomes the signer.

## Frontend flow

1. Player creates a Connect Four room in the app.
2. Player approves CASHX for `PvPWager`.
3. Player calls `createMatch(ConnectFour, wager)`.
4. Player 2 opens invite link.
5. Player 2 approves CASHX for `PvPWager`.
6. Player 2 calls `joinMatch(matchId)`.
7. The game plays normally through the backend, with no wallet popup for each move.
8. Backend signs the final winner.
9. Winner or backend calls `settleMatch(matchId, winner, resultDataHash, signature)`.

## App config after deploy

Add the deployed contract address before `connect4.html` runs:

```html
<script>
  window.CASHX_PVP_WAGER_ADDRESS = '0x344e72a3F4972154B1dbd014ae936816ef34DF9f';
</script>
```

Set these on the PvP backend:

```text
PVP_WAGER_ADDRESS=0x344e72a3F4972154B1dbd014ae936816ef34DF9f
PVP_CHAIN_ID=369
PVP_SIGNER_PRIVATE_KEY=BACKEND_SIGNER_PRIVATE_KEY
```

Without the contract address, Connect Four stays in test-room mode.

## Result signature

The backend signs:

```text
keccak256(abi.encode(
  contractAddress,
  chainId,
  matchId,
  gameType,
  player1,
  player2,
  wager,
  winner,
  resultDataHash
))
```

`resultDataHash` can be a hash of the room id, final board, move history, timeout reason, or final game state.

## Refund paths

- `cancelUnmatched(matchId)` returns Player 1's wager if nobody joins.
- `refundExpired(matchId)` refunds both players if a funded match never receives a signed result.
- In-game timeout wins should still use `settleMatch` with a signed timeout winner.

## Current game ids

```text
0 = ConnectFour
1 = VanishingTicTacToe
```
