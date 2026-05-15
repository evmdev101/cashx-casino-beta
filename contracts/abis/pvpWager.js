'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};
  CashX.abis = CashX.abis || {};

  CashX.abis.PVP_WAGER = [
    'function createMatch(uint8 gameType, uint256 wager) external returns (uint256)',
    'function joinMatch(uint256 matchId) external',
    'function cancelUnmatched(uint256 matchId) external',
    'function requestCancel(uint256 matchId) external',
    'function revokeCancel(uint256 matchId) external',
    'function claimCancelTimeout(uint256 matchId) external',
    'function settleMatch(uint256 matchId, address winner, bytes32 resultDataHash, bytes signature) external',
    'function matches(uint256) view returns (uint8 gameType, uint8 status, address player1, address player2, uint256 wager, uint256 createdAt, uint256 startedAt, address winner, uint256 settledAt)',
    'function totalBurned() view returns (uint256)',
    'event MatchCreated(uint256 indexed matchId, uint8 indexed gameType, address indexed player1, uint256 wager)',
    'event MatchJoined(uint256 indexed matchId, address indexed player2)',
    'event MatchSettled(uint256 indexed matchId, address indexed winner, uint256 payout, uint256 burned, bytes32 resultHash)',
  ];
}(window));
