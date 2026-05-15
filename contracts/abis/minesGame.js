'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};
  CashX.abis = CashX.abis || {};

  CashX.abis.MINES_GAME = [
    'function pendingGames(uint256) view returns (address player, uint256 amount, uint8 mineCount, uint8 pickCount, bytes32 commitHash, uint256 targetBlock, bool settled)',
    'function calculatePayout(uint256 betAmount, uint8 mineCount, uint8 pickCount) view returns (uint256)',
    'function revealGame(uint256 gameId, uint8[] picks, bytes32 secret)',
    'event GamePlaced(uint256 indexed gameId, address indexed player, uint256 bet, uint8 mineCount, uint8 pickCount, uint256 targetBlock)',
    'event GameRevealed(uint256 indexed gameId, address indexed player, uint8[] picks, bytes32 secret, bytes32 targetBlockHash)',
    'event GameSettled(uint256 indexed gameId, address indexed player, bool won, uint256 bet, uint256 payout, uint256 burned, uint256 multiplierBps)',
  ];

  CashX.abis.LIVE_MINES_GAME = [
    'function games(uint256) view returns (address player, uint256 amount, uint8 mineCount, bytes32 serverSeedHash, bool settled)',
    'function generateMineMask(uint256 gameId, address player, uint8 mineCount, bytes32 serverSeed) view returns (uint256)',
    'function calculatePayout(uint256 betAmount, uint8 mineCount, uint8 safePicks) view returns (uint256)',
    'event GameStarted(uint256 indexed gameId, address indexed player, uint256 bet, uint8 mineCount, bytes32 serverSeedHash)',
    'event GameSettled(uint256 indexed gameId, address indexed player, bool won, uint256 bet, uint256 payout, uint256 burned, uint256 multiplierBps, uint256 revealedMask, uint256 mineMask, bytes32 serverSeed)',
  ];
}(window));
