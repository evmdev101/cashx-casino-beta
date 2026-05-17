// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title  DiceGame — CASHX Casino solo dice game on PulseChain
/// @notice Players bet OVER or UNDER 50 on a 1-99 roll.
/// Winners receive 195% of their bet; 3% is burned.
/// Losing bets burn 3%, with the remainder staying in the prize pool.
/// Beta randomness uses a commit/reveal plus a future block hash.
contract DiceGame {

    // Constants
    IERC20  public  cashx        = IERC20(0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665);
    address public  constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // State
    address public owner;
    uint256 public minBet     = 1       * 1e18;   // 1 CASHX
    uint256 public maxBet     = 5_000   * 1e18;   // 5,000 CASHX
    uint256 public totalBurned;
    uint256 public betCount;
    uint256 public constant REVEAL_DEADLINE_BLOCKS = 250;
    bool    private _locked;

    struct PendingBet {
        address player;
        bool    over;
        uint256 amount;
        bytes32 commitHash;
        uint256 targetBlock;
        bool    settled;
    }

    mapping(uint256 => PendingBet) public pendingBets;

    // Events
    event BetPlaced(
        uint256 indexed betId,
        address indexed player,
        bool            over,
        uint256         bet,
        uint256         targetBlock
    );
    event Roll(
        uint256 indexed betId,
        address indexed player,
        uint8           result,
        bool            over,
        uint256         bet,
        bool            won
    );
    event Burned(uint256 amount);
    event BetRevealed(
        uint256 indexed betId,
        address indexed player,
        bytes32         secret,
        bytes32         targetBlockHash
    );

    // Modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier noReentrant() {
        require(!_locked, "Reentrant call");
        _locked = true;
        _;
        _locked = false;
    }

    // Constructor
    constructor() {
        owner = msg.sender;
    }

    // Core
    /// @notice Place a committed bet. Reveal after `targetBlock` using the original secret.
    /// @param  betOver    true = bet the roll lands above 50; false = bet below 50.
    /// @param  betAmount  Wager in CASHX (18 decimals). Must be within [minBet, maxBet].
    /// @param  commitHash keccak256(abi.encodePacked(player, secret)).
    function placeBet(bool betOver, uint256 betAmount, bytes32 commitHash)
        external
        noReentrant
        returns (uint256 betId)
    {
        require(betAmount >= minBet, "Bet below minimum");
        require(betAmount <= maxBet, "Bet above maximum");
        require(commitHash != bytes32(0), "Commit required");

        require(
            cashx.transferFrom(msg.sender, address(this), betAmount),
            "Token transfer failed - did you approve?"
        );

        betId = ++betCount;
        uint256 targetBlock = block.number + 1;
        pendingBets[betId] = PendingBet({
            player: msg.sender,
            over: betOver,
            amount: betAmount,
            commitHash: commitHash,
            targetBlock: targetBlock,
            settled: false
        });

        emit BetPlaced(betId, msg.sender, betOver, betAmount, targetBlock);
    }

    /// @notice Reveal a committed bet after its target block has been mined.
    function revealBet(uint256 betId, bytes32 secret) external noReentrant {
        PendingBet storage bet = pendingBets[betId];
        require(bet.player == msg.sender, "Not your bet");
        require(!bet.settled, "Already settled");
        require(block.number > bet.targetBlock, "Target block not mined");
        require(block.number <= bet.targetBlock + REVEAL_DEADLINE_BLOCKS, "Reveal expired");
        require(
            keccak256(abi.encodePacked(msg.sender, secret)) == bet.commitHash,
            "Bad reveal"
        );

        bytes32 entropy = blockhash(bet.targetBlock);
        require(entropy != bytes32(0), "Block hash unavailable");

        bet.settled = true;
        emit BetRevealed(betId, msg.sender, secret, entropy);

        // Roll: 1-99 inclusive from committed player secret + future block hash.
        uint8 result = uint8(
            (uint256(
                keccak256(
                    abi.encodePacked(
                        entropy,
                        msg.sender,
                        secret,
                        betId,
                        address(this)
                    )
                )
            ) % 99) + 1
        );

        // result == 50 fails both conditions → loss (house edge on the tie).
        bool won = bet.over ? (result > 50) : (result < 50);

        if (won) {
            uint256 profit     = bet.amount * 95 / 100;
            uint256 burnAmount = bet.amount *  3 / 100;
            uint256 payout     = bet.amount + profit;

            require(
                cashx.balanceOf(address(this)) >= payout + burnAmount,
                "Prize pool too low to cover payout"
            );

            require(cashx.transfer(msg.sender, payout), "Payout failed");
            require(cashx.transfer(BURN_ADDRESS, burnAmount), "Burn failed");
            totalBurned += burnAmount;
            emit Burned(burnAmount);
        } else {
            uint256 burnAmount = bet.amount * 3 / 100;
            require(cashx.transfer(BURN_ADDRESS, burnAmount), "Burn failed");
            totalBurned += burnAmount;
            emit Burned(burnAmount);
        }

        emit Roll(betId, msg.sender, result, bet.over, bet.amount, won);
    }

    /// @notice Burn an unrevealed bet after the reveal window closes.
    /// @dev This prevents players from only revealing winning bets.
    function forfeitExpiredBet(uint256 betId) external noReentrant {
        PendingBet storage bet = pendingBets[betId];
        require(bet.player != address(0), "Unknown bet");
        require(!bet.settled, "Already settled");
        require(block.number > bet.targetBlock + REVEAL_DEADLINE_BLOCKS, "Reveal still open");

        bet.settled = true;
        uint256 burnAmount = bet.amount * 3 / 100;
        require(cashx.transfer(BURN_ADDRESS, burnAmount), "Burn failed");
        totalBurned += burnAmount;
        emit Burned(burnAmount);
    }

    // View
    /// @notice Returns the current CASHX balance of the prize pool.
    function prizePool() external view returns (uint256) {
        return cashx.balanceOf(address(this));
    }

    // Owner
    /// @notice Deposit CASHX into the prize pool. Requires prior approval on the token contract.
    function fundPool(uint256 amount) external onlyOwner {
        require(
            cashx.transferFrom(msg.sender, address(this), amount),
            "Transfer failed"
        );
    }

    /// @notice Update bet limits. Amounts in wei (multiply CASHX value by 1e18).
    function setBetLimits(uint256 newMin, uint256 newMax) external onlyOwner {
        require(newMin > 0,      "Min must be > 0");
        require(newMax > newMin, "Max must be > min");
        minBet = newMin;
        maxBet = newMax;
    }

    /// @notice Withdraw the full prize pool to the owner wallet.
    function emergencyWithdraw() external onlyOwner {
        uint256 balance = cashx.balanceOf(address(this));
        require(balance > 0, "Nothing to withdraw");
        require(cashx.transfer(owner, balance), "Withdraw failed");
    }

    /// @notice Transfer contract ownership to a new address.
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Cannot be zero address");
        owner = newOwner;
    }
}
