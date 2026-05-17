// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title  MinesGame - CASHX Casino solo mines game on PulseChain
/// @notice Manual-only Mines using commit/reveal. The player commits their tile picks
///         before the future block hash exists, then reveals those picks to settle.
contract MinesGame {

    IERC20 public constant CASHX = IERC20(0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665);
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint8   public constant TILE_COUNT = 25;
    uint8   public constant MAX_PICKS = 10;
    uint16  public constant HOUSE_EDGE_BPS = 300;
    uint16  public constant BPS = 10_000;
    uint256 public constant REVEAL_DEADLINE_BLOCKS = 250;

    address public owner;
    uint256 public minBet = 1 * 1e18;
    uint256 public maxBet = 5_000 * 1e18;
    uint256 public maxPayout = 25_000 * 1e18;
    uint256 public minPoolReserve = 25_000 * 1e18;
    uint256 public totalBurned;
    uint256 public gameCount;
    bool    public paused;
    bool    private locked;

    struct PendingGame {
        address player;
        uint256 amount;
        uint8   mineCount;
        uint8   pickCount;
        bytes32 commitHash;
        uint256 targetBlock;
        bool    settled;
    }

    mapping(uint256 => PendingGame) public pendingGames;
    mapping(address => uint256[]) private playerGameIds;

    event GamePlaced(
        uint256 indexed gameId,
        address indexed player,
        uint256 bet,
        uint8 mineCount,
        uint8 pickCount,
        uint256 targetBlock
    );
    event GameRevealed(
        uint256 indexed gameId,
        address indexed player,
        uint8[] picks,
        bytes32 secret,
        bytes32 targetBlockHash
    );
    event GameSettled(
        uint256 indexed gameId,
        address indexed player,
        bool won,
        uint256 bet,
        uint256 payout,
        uint256 burned,
        uint256 multiplierBps
    );
    event Burned(uint256 amount);
    event Paused(bool paused);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier noReentrant() {
        require(!locked, "Reentrant call");
        locked = true;
        _;
        locked = false;
    }

    modifier whenNotPaused() {
        require(!paused, "Contract is paused");
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Place a committed Mines bet.
    /// @dev commitHash = keccak256(abi.encode(player, mineCount, picks, secret)).
    ///      The picks are hidden until reveal, but pickCount is stored for payout preview.
    function placeGame(
        uint256 betAmount,
        uint8 mineCount,
        uint8 pickCount,
        bytes32 commitHash
    )
        external
        noReentrant
        whenNotPaused
        returns (uint256 gameId)
    {
        require(betAmount >= minBet, "Bet below minimum");
        require(betAmount <= maxBet, "Bet above maximum");
        require(mineCount >= 1 && mineCount <= TILE_COUNT - 1, "Bad mine count");
        require(pickCount >= 1 && pickCount <= MAX_PICKS, "Bad pick count");
        require(pickCount <= TILE_COUNT - mineCount, "Too many picks");
        require(commitHash != bytes32(0), "Commit required");

        uint256 previewPayout = calculatePayout(betAmount, mineCount, pickCount);
        require(previewPayout <= maxPayout, "Payout above cap");

        require(CASHX.transferFrom(msg.sender, address(this), betAmount), "Transfer failed");

        gameId = ++gameCount;
        uint256 targetBlock = block.number + 1;
        pendingGames[gameId] = PendingGame({
            player: msg.sender,
            amount: betAmount,
            mineCount: mineCount,
            pickCount: pickCount,
            commitHash: commitHash,
            targetBlock: targetBlock,
            settled: false
        });
        playerGameIds[msg.sender].push(gameId);

        emit GamePlaced(gameId, msg.sender, betAmount, mineCount, pickCount, targetBlock);
    }

    /// @notice Reveal the committed tile picks and settle after the target block is mined.
    function revealGame(
        uint256 gameId,
        uint8[] calldata picks,
        bytes32 secret
    )
        external
        noReentrant
    {
        PendingGame storage game = pendingGames[gameId];
        require(game.player == msg.sender, "Not your game");
        require(!game.settled, "Already settled");
        require(picks.length == game.pickCount, "Wrong pick count");
        require(block.number > game.targetBlock, "Target block not mined");
        require(block.number <= game.targetBlock + REVEAL_DEADLINE_BLOCKS, "Reveal expired");
        require(
            keccak256(abi.encode(msg.sender, game.mineCount, picks, secret)) == game.commitHash,
            "Bad reveal"
        );

        _validatePicks(picks);

        bytes32 entropy = blockhash(game.targetBlock);
        require(entropy != bytes32(0), "Block hash unavailable");

        game.settled = true;
        emit GameRevealed(gameId, msg.sender, picks, secret, entropy);

        bool won = !_hitMine(gameId, game.mineCount, picks, entropy);
        uint256 burnAmount = _burnAmount(game.amount);
        uint256 payout = 0;
        uint256 multiplierBps = 0;

        if (won) {
            payout = calculatePayout(game.amount, game.mineCount, game.pickCount);
            multiplierBps = payout * BPS / game.amount;
            require(payout <= maxPayout, "Payout above cap");
            require(
                CASHX.balanceOf(address(this)) >= payout + burnAmount + minPoolReserve,
                "Prize pool reserve protected"
            );
            require(CASHX.transfer(msg.sender, payout), "Payout failed");
        }

        require(CASHX.transfer(BURN_ADDRESS, burnAmount), "Burn failed");
        totalBurned += burnAmount;
        emit Burned(burnAmount);
        emit GameSettled(gameId, msg.sender, won, game.amount, payout, burnAmount, multiplierBps);
    }

    /// @notice Burn the fee on an unrevealed game after the reveal window closes.
    /// @dev The rest of the unrevealed bet remains in the prize pool.
    function forfeitExpiredGame(uint256 gameId) external noReentrant {
        PendingGame storage game = pendingGames[gameId];
        require(game.player != address(0), "Unknown game");
        require(!game.settled, "Already settled");
        require(block.number > game.targetBlock + REVEAL_DEADLINE_BLOCKS, "Reveal still open");

        game.settled = true;
        uint256 burnAmount = _burnAmount(game.amount);
        require(CASHX.transfer(BURN_ADDRESS, burnAmount), "Burn failed");
        totalBurned += burnAmount;
        emit Burned(burnAmount);
        emit GameSettled(gameId, game.player, false, game.amount, 0, burnAmount, 0);
    }

    function calculatePayout(
        uint256 betAmount,
        uint8 mineCount,
        uint8 pickCount
    )
        public
        pure
        returns (uint256)
    {
        require(mineCount >= 1 && mineCount <= TILE_COUNT - 1, "Bad mine count");
        require(pickCount >= 1 && pickCount <= MAX_PICKS, "Bad pick count");
        require(pickCount <= TILE_COUNT - mineCount, "Too many picks");

        uint256 safeNumerator = 1;
        uint256 safeDenominator = 1;
        for (uint8 i = 0; i < pickCount; i++) {
            safeNumerator *= TILE_COUNT - mineCount - i;
            safeDenominator *= TILE_COUNT - i;
        }

        return betAmount * safeDenominator * (BPS - HOUSE_EDGE_BPS) / safeNumerator / BPS;
    }

    function getPlayerGames(address player) external view returns (uint256[] memory) {
        return playerGameIds[player];
    }

    function prizePool() external view returns (uint256) {
        return CASHX.balanceOf(address(this));
    }

    function fundPool(uint256 amount) external onlyOwner {
        require(CASHX.transferFrom(msg.sender, address(this), amount), "Transfer failed");
    }

    function setBetLimits(uint256 newMin, uint256 newMax) external onlyOwner {
        require(newMin > 0, "Min must be > 0");
        require(newMax > newMin, "Max must be > min");
        minBet = newMin;
        maxBet = newMax;
    }

    function setSafetyLimits(uint256 newMaxPayout, uint256 newMinPoolReserve) external onlyOwner {
        require(newMaxPayout > 0, "Max payout must be > 0");
        maxPayout = newMaxPayout;
        minPoolReserve = newMinPoolReserve;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Paused(false);
    }

    function emergencyWithdraw() external onlyOwner {
        uint256 balance = CASHX.balanceOf(address(this));
        require(balance > 0, "Nothing to withdraw");
        require(CASHX.transfer(owner, balance), "Withdraw failed");
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    function _validatePicks(uint8[] calldata picks) internal pure {
        bool[TILE_COUNT] memory seen;
        for (uint256 i = 0; i < picks.length; i++) {
            uint8 pick = picks[i];
            require(pick < TILE_COUNT, "Pick out of range");
            require(!seen[pick], "Duplicate pick");
            seen[pick] = true;
        }
    }

    function _hitMine(
        uint256 gameId,
        uint8 mineCount,
        uint8[] calldata picks,
        bytes32 entropy
    )
        internal
        view
        returns (bool)
    {
        bool[TILE_COUNT] memory mines;
        uint8 placed = 0;
        uint256 nonce = 0;

        while (placed < mineCount) {
            uint8 tile = uint8(uint256(keccak256(abi.encodePacked(
                entropy,
                gameId,
                msg.sender,
                address(this),
                nonce
            ))) % TILE_COUNT);

            if (!mines[tile]) {
                mines[tile] = true;
                placed++;
            }
            nonce++;
        }

        for (uint256 i = 0; i < picks.length; i++) {
            if (mines[picks[i]]) return true;
        }

        return false;
    }

    function _burnAmount(uint256 amount) internal pure returns (uint256) {
        return amount * HOUSE_EDGE_BPS / BPS;
    }
}
