// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20InstantMines {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title MinesGameLive - instant CASHX Mines with provably fair backend commits
/// @notice The contract holds funds, burns fees, and settles signed backend results.
///         The backend commits to a hidden server seed before play, reveals tiles
///         instantly during play, then signs the final result for on-chain payout.
contract MinesGameLive {

    IERC20InstantMines public constant CASHX = IERC20InstantMines(0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665);
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint8   public constant TILE_COUNT = 25;
    uint8   public constant MAX_SAFE_PICKS = 10;
    uint16  public constant HOUSE_EDGE_BPS = 300;
    uint16  public constant BPS = 10_000;

    address public owner;
    address public gameSigner;
    uint256 public minBet = 500 * 1e18;
    uint256 public maxBet = 5_000 * 1e18;
    uint256 public maxPayout = 25_000 * 1e18;
    uint256 public minPoolReserve = 25_000 * 1e18;
    uint256 public totalBurned;
    uint256 public gameCount;
    bool    public paused;
    bool    private locked;

    struct Game {
        address player;
        uint256 amount;
        uint8 mineCount;
        bytes32 serverSeedHash;
        bool settled;
    }

    struct SettlementData {
        uint8 safePicks;
        uint256 mineMask;
        uint256 burnAmount;
        uint256 payout;
        uint256 multiplierBps;
    }

    mapping(uint256 => Game) public games;
    mapping(address => uint256[]) private playerGameIds;
    mapping(bytes32 => bool) public usedResultHashes;

    event GameStarted(
        uint256 indexed gameId,
        address indexed player,
        uint256 bet,
        uint8 mineCount,
        bytes32 serverSeedHash
    );
    event GameSettled(
        uint256 indexed gameId,
        address indexed player,
        bool won,
        uint256 bet,
        uint256 payout,
        uint256 burned,
        uint256 multiplierBps,
        uint256 revealedMask,
        uint256 mineMask,
        bytes32 serverSeed
    );
    event Burned(uint256 amount);
    event GameSignerUpdated(address signer);
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

    constructor(address initialGameSigner) {
        owner = msg.sender;
        gameSigner = initialGameSigner == address(0) ? msg.sender : initialGameSigner;
        emit GameSignerUpdated(gameSigner);
    }

    /// @notice Starts a fast Mines game using a backend seed commitment.
    /// @dev Get serverSeedHash from the backend before calling this.
    function startGame(uint256 betAmount, uint8 mineCount, bytes32 serverSeedHash)
        external
        noReentrant
        whenNotPaused
        returns (uint256 gameId)
    {
        require(betAmount >= minBet, "Bet below minimum");
        require(betAmount <= maxBet, "Bet above maximum");
        require(mineCount >= 1 && mineCount <= TILE_COUNT - 1, "Bad mine count");
        require(serverSeedHash != bytes32(0), "Seed hash required");
        require(calculatePayout(betAmount, mineCount, 1) <= maxPayout, "Payout above cap");
        require(CASHX.transferFrom(msg.sender, address(this), betAmount), "Transfer failed");

        gameId = ++gameCount;
        games[gameId] = Game({
            player: msg.sender,
            amount: betAmount,
            mineCount: mineCount,
            serverSeedHash: serverSeedHash,
            settled: false
        });
        playerGameIds[msg.sender].push(gameId);

        emit GameStarted(gameId, msg.sender, betAmount, mineCount, serverSeedHash);
    }

    /// @notice Settles a game after the backend signs the final result.
    /// @dev The signature prevents players from changing the final revealed tiles
    ///      after the backend reveals the server seed.
    function settleGame(
        uint256 gameId,
        uint256 revealedMask,
        bool won,
        bytes32 serverSeed,
        bytes calldata signature
    )
        external
        noReentrant
    {
        Game storage game = games[gameId];
        require(game.player != address(0), "Unknown game");
        require(!game.settled, "Already settled");
        require(msg.sender == game.player || msg.sender == gameSigner, "Not allowed");
        require(keccak256(abi.encodePacked(serverSeed)) == game.serverSeedHash, "Bad server seed");

        SettlementData memory data;
        data.safePicks = _countBits(revealedMask);
        require(data.safePicks <= MAX_SAFE_PICKS, "Too many safe picks");

        data.mineMask = generateMineMask(gameId, game.player, game.mineCount, serverSeed);
        require(won != ((revealedMask & data.mineMask) != 0), "Result mismatch");
        require(won || data.safePicks > 0 || revealedMask != 0, "No result");

        _validateSignature(gameId, game, revealedMask, won, serverSeed, signature);

        game.settled = true;

        _payAndBurn(game, won, data);
        _emitSettlement(gameId, game, won, revealedMask, serverSeed, data);
    }

    function _validateSignature(
        uint256 gameId,
        Game storage game,
        uint256 revealedMask,
        bool won,
        bytes32 serverSeed,
        bytes calldata signature
    )
        internal
    {
        bytes32 resultHash = keccak256(abi.encode(
            address(this),
            block.chainid,
            gameId,
            _gameHash(game),
            revealedMask,
            won,
            serverSeed
        ));
        require(!usedResultHashes[resultHash], "Result already used");
        usedResultHashes[resultHash] = true;
        require(_recoverSigner(resultHash, signature) == gameSigner, "Bad signature");
    }

    function _gameHash(Game storage game) internal view returns (bytes32) {
        return keccak256(abi.encode(game.player, game.amount, game.mineCount));
    }

    function _payAndBurn(
        Game storage game,
        bool won,
        SettlementData memory data
    )
        internal
    {
        data.burnAmount = _burnAmount(game.amount);

        if (won) {
            require(data.safePicks > 0, "No safe picks");
            data.payout = calculatePayout(game.amount, game.mineCount, data.safePicks);
            data.multiplierBps = data.payout * BPS / game.amount;
            require(data.payout <= maxPayout, "Payout above cap");
            require(
                CASHX.balanceOf(address(this)) >= data.payout + data.burnAmount + minPoolReserve,
                "Prize pool reserve protected"
            );
            require(CASHX.transfer(game.player, data.payout), "Payout failed");
        }

        require(CASHX.transfer(BURN_ADDRESS, data.burnAmount), "Burn failed");
        totalBurned += data.burnAmount;

        emit Burned(data.burnAmount);
    }

    function _emitSettlement(
        uint256 gameId,
        Game storage game,
        bool won,
        uint256 revealedMask,
        bytes32 serverSeed,
        SettlementData memory data
    )
        internal
    {
        emit GameSettled(
            gameId,
            game.player,
            won,
            game.amount,
            data.payout,
            data.burnAmount,
            data.multiplierBps,
            revealedMask,
            data.mineMask,
            serverSeed
        );
    }

    function calculatePayout(
        uint256 betAmount,
        uint8 mineCount,
        uint8 safePicks
    )
        public
        pure
        returns (uint256)
    {
        require(mineCount >= 1 && mineCount <= TILE_COUNT - 1, "Bad mine count");
        require(safePicks >= 1 && safePicks <= MAX_SAFE_PICKS, "Bad pick count");
        require(safePicks <= TILE_COUNT - mineCount, "Too many picks");

        uint256 safeNumerator = 1;
        uint256 safeDenominator = 1;
        for (uint8 i = 0; i < safePicks; i++) {
            safeNumerator *= TILE_COUNT - mineCount - i;
            safeDenominator *= TILE_COUNT - i;
        }

        return betAmount * safeDenominator * (BPS - HOUSE_EDGE_BPS) / safeNumerator / BPS;
    }

    function generateMineMask(
        uint256 gameId,
        address player,
        uint8 mineCount,
        bytes32 serverSeed
    )
        public
        view
        returns (uint256 mineMask)
    {
        uint8 placed = 0;
        uint256 nonce = 0;

        while (placed < mineCount) {
            uint8 tile = uint8(uint256(keccak256(abi.encodePacked(
                serverSeed,
                gameId,
                player,
                mineCount,
                address(this),
                nonce
            ))) % TILE_COUNT);

            uint256 bit = uint256(1) << tile;
            if ((mineMask & bit) == 0) {
                mineMask |= bit;
                placed++;
            }
            nonce++;
        }
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

    function setGameSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "Zero signer");
        gameSigner = newSigner;
        emit GameSignerUpdated(newSigner);
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

    function _burnAmount(uint256 amount) internal pure returns (uint256) {
        return amount * HOUSE_EDGE_BPS / BPS;
    }

    function _countBits(uint256 mask) internal pure returns (uint8 count) {
        while (mask != 0) {
            if ((mask & 1) == 1) count++;
            mask >>= 1;
        }
    }

    function _recoverSigner(bytes32 resultHash, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "Bad signature length");

        bytes32 ethHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            resultHash
        ));

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Bad signature v");

        return ecrecover(ethHash, v, r, s);
    }
}
