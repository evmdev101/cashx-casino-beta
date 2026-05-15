'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};
  CashX.abis = CashX.abis || {};

  CashX.abis.ASYNC_GAMES = [
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
}(window));
