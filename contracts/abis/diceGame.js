'use strict';

(function (root) {
  const CashX = root.CashX = root.CashX || {};
  CashX.abis = CashX.abis || {};

  CashX.abis.DICE_GAME = [
    'function pendingBets(uint256) view returns (address player, bool over, uint256 amount, bytes32 commitHash, uint256 targetBlock, bool settled)',
    'function placeBet(bool betOver, uint256 betAmount, bytes32 commitHash) external returns (uint256)',
    'function revealBet(uint256 betId, bytes32 secret) external',
    'function forfeitExpiredBet(uint256 betId) external',
    'function totalBurned() external view returns (uint256)',
    'function minBet() external view returns (uint256)',
    'function maxBet() external view returns (uint256)',
    'event BetPlaced(uint256 indexed betId, address indexed player, bool over, uint256 bet, uint256 targetBlock)',
    'event Roll(uint256 indexed betId, address indexed player, uint8 result, bool over, uint256 bet, bool won)',
    'event Burned(uint256 amount)',
    'event BetRevealed(uint256 indexed betId, address indexed player, bytes32 secret, bytes32 targetBlockHash)',
  ];
}(window));
