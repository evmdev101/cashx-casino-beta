// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract AsyncGames {

    IERC20 public constant CASHX = IERC20(0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665);
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant TIER_1 = 100_000 * 1e18;
    uint256 public constant TIER_2 = 500_000 * 1e18;
    uint256 public constant TIER_3 = 1_000_000 * 1e18;

    uint256 public constant TIMEOUT = 7 days;
    uint256 public constant SETTLE_BLOCK_WINDOW = 250;
    uint8   public constant MAX_TIE_ROUNDS = 20;

    enum GameType { CardWar, DiceBattle }

    struct Game {
        GameType  gameType;
        uint8     maxPlayers;
        uint8     playerCount;
        uint256   entryAmount;
        uint256   createdAt;
        bool      resolved;
        bool      cancelled;
        bool      readyToSettle;
        uint256   settleBlock;
        address[5] players;
        uint8[5]  results;
        address   winner;
    }

    mapping(uint256 => Game)                        public  games;
    mapping(uint256 => mapping(address => bool))    private inGame;
    mapping(address => uint256[])                   private playerGameIds;
    uint256[]                                       private activeGameIds;
    mapping(uint256 => uint256)                     private activeGameIndexPlusOne;

    uint256 public gameCount;
    address public owner;
    bool    public paused;
    bool    private locked;

    event GameCreated(
        uint256 indexed gameId,
        GameType        gameType,
        uint8           maxPlayers,
        uint256         entryAmount
    );
    event PlayerJoined(
        uint256 indexed gameId,
        address indexed player,
        uint8           result
    );
    event GameReadyToSettle(
        uint256 indexed gameId,
        uint256         settleBlock
    );
    event GameResolved(
        uint256 indexed gameId,
        address indexed winner,
        uint256         payout,
        uint256         burned
    );
    event PlayerRefunded(
        uint256 indexed gameId,
        address indexed player,
        uint256         amount
    );

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

    function createGame(GameType gameType, uint8 maxPlayers, uint8 tier)
        external
        noReentrant
        whenNotPaused
    {
        require(maxPlayers >= 2 && maxPlayers <= 5, "Players must be 2-5");
        require(tier >= 1 && tier <= 3, "Tier must be 1-3");

        uint256 entry = _tierAmount(tier);
        require(CASHX.transferFrom(msg.sender, address(this), entry), "Transfer failed");

        gameCount++;
        uint256 gameId = gameCount;

        Game storage g = games[gameId];
        g.gameType    = gameType;
        g.maxPlayers  = maxPlayers;
        g.entryAmount = entry;
        g.createdAt   = block.timestamp;
        g.players[0]  = msg.sender;
        g.playerCount = 1;

        inGame[gameId][msg.sender] = true;
        playerGameIds[msg.sender].push(gameId);
        _addActiveGame(gameId);

        emit GameCreated(gameId, gameType, maxPlayers, entry);
        emit PlayerJoined(gameId, msg.sender, 0);
    }

    function joinGame(uint256 gameId) external noReentrant whenNotPaused {
        Game storage g = games[gameId];

        require(!g.resolved && !g.cancelled,          "Game is not active");
        require(g.playerCount < g.maxPlayers,          "Game is full");
        require(g.maxPlayers >= 2,                     "Unknown game");
        require(!inGame[gameId][msg.sender],           "Already in this game");
        require(
            CASHX.transferFrom(msg.sender, address(this), g.entryAmount),
            "Transfer failed"
        );

        uint8 slot      = g.playerCount;
        g.players[slot] = msg.sender;
        g.playerCount++;

        inGame[gameId][msg.sender] = true;
        playerGameIds[msg.sender].push(gameId);

        emit PlayerJoined(gameId, msg.sender, 0);

        if (g.playerCount == g.maxPlayers) {
            g.readyToSettle = true;
            g.settleBlock = block.number + 1;
            _removeActiveGame(gameId);
            emit GameReadyToSettle(gameId, g.settleBlock);
        }
    }

    function settleGame(uint256 gameId) external noReentrant {
        Game storage g = games[gameId];

        require(!g.resolved && !g.cancelled, "Game is not active");
        require(g.readyToSettle, "Game is not full");
        require(block.number > g.settleBlock, "Settle block not mined");
        require(block.number <= g.settleBlock + SETTLE_BLOCK_WINDOW, "Settle block expired");

        bytes32 entropy = blockhash(g.settleBlock);
        require(entropy != bytes32(0), "Block hash unavailable");

        _resolveGame(gameId, entropy);
    }

    function leaveGame(uint256 gameId) external noReentrant {
        Game storage g = games[gameId];

        require(!g.resolved && !g.cancelled,  "Game is not active");
        require(g.playerCount < g.maxPlayers, "Game is full, cannot leave");
        require(inGame[gameId][msg.sender],   "Not in this game");

        uint8 n   = g.playerCount;
        uint8 idx = _findPlayerIndex(g, msg.sender, n);

        for (uint8 i = idx; i < n - 1; i++) {
            g.players[i] = g.players[i + 1];
            g.results[i] = g.results[i + 1];
        }
        g.players[n - 1] = address(0);
        g.results[n - 1] = 0;
        g.playerCount--;

        if (g.playerCount == 0) {
            g.cancelled = true;
            _removeActiveGame(gameId);
        }

        inGame[gameId][msg.sender] = false;

        require(CASHX.transfer(msg.sender, g.entryAmount), "Refund failed");
        emit PlayerRefunded(gameId, msg.sender, g.entryAmount);
    }

    function refundGame(uint256 gameId) external noReentrant {
        Game storage g = games[gameId];

        require(!g.resolved && !g.cancelled,                "Game is not active");
        require(block.timestamp >= g.createdAt + TIMEOUT,   "Timeout not reached");
        require(inGame[gameId][msg.sender],                  "Not in this game");

        g.cancelled = true;
        _removeActiveGame(gameId);

        uint8 n = g.playerCount;
        for (uint8 i = 0; i < n; i++) {
            address player = g.players[i];
            inGame[gameId][player] = false;
            require(CASHX.transfer(player, g.entryAmount), "Refund failed");
            emit PlayerRefunded(gameId, player, g.entryAmount);
        }
    }

    function refundExpiredSettle(uint256 gameId) external noReentrant {
        Game storage g = games[gameId];

        require(!g.resolved && !g.cancelled, "Game is not active");
        require(g.readyToSettle, "Game is not full");
        require(block.number > g.settleBlock + SETTLE_BLOCK_WINDOW, "Settle still open");

        g.cancelled = true;

        uint8 n = g.playerCount;
        for (uint8 i = 0; i < n; i++) {
            address player = g.players[i];
            inGame[gameId][player] = false;
            require(CASHX.transfer(player, g.entryAmount), "Refund failed");
            emit PlayerRefunded(gameId, player, g.entryAmount);
        }
    }

    function _resolveGame(uint256 gameId, bytes32 entropy) internal {
        Game storage g = games[gameId];
        uint8 n = g.playerCount;

        bool[5] memory active;
        for (uint8 i = 0; i < n; i++) {
            active[i] = true;
        }

        for (uint8 round = 0; round < MAX_TIE_ROUNDS; round++) {

            for (uint8 i = 0; i < n; i++) {
                if (active[i]) {
                    g.results[i] = _generateResult(g.gameType, gameId, g.players[i], round, entropy);
                }
            }

            uint8 maxResult = 0;
            for (uint8 i = 0; i < n; i++) {
                if (active[i] && g.results[i] > maxResult) {
                    maxResult = g.results[i];
                }
            }

            uint8 topCount = 0;
            for (uint8 i = 0; i < n; i++) {
                if (active[i]) {
                    if (g.results[i] < maxResult) {
                        active[i] = false;
                    } else {
                        topCount++;
                    }
                }
            }

            if (topCount == 1) {
                for (uint8 i = 0; i < n; i++) {
                    if (active[i]) {
                        _payout(gameId, g.players[i]);
                        return;
                    }
                }
            }
        }

        for (uint8 i = 0; i < n; i++) {
            if (active[i]) {
                _payout(gameId, g.players[i]);
                return;
            }
        }
    }

    function _payout(uint256 gameId, address winner) internal {
        Game storage g = games[gameId];

        uint256 totalPot     = g.entryAmount * g.maxPlayers;
        uint256 winnerPayout = totalPot * 95 / 100;
        uint256 burnAmount   = totalPot - winnerPayout;

        g.resolved = true;
        g.winner   = winner;

        require(CASHX.transfer(winner, winnerPayout), "Payout failed");
        require(CASHX.transfer(BURN_ADDRESS, burnAmount), "Burn failed");

        emit GameResolved(gameId, winner, winnerPayout, burnAmount);
    }

    function _generateResult(
        GameType gameType,
        uint256  gameId,
        address  player,
        uint8    round,
        bytes32  entropy
    ) internal view returns (uint8) {
        bytes32 seed = keccak256(abi.encodePacked(
            entropy,
            player,
            gameId,
            round,
            address(this)
        ));

        if (gameType == GameType.CardWar) {
            return uint8(uint256(seed) % 13) + 2;
        }

        uint8   die1  = uint8(uint256(seed) % 6) + 1;
        bytes32 seed2 = keccak256(abi.encodePacked(seed, uint8(2)));
        uint8   die2  = uint8(uint256(seed2) % 6) + 1;
        return die1 + die2;
    }

    function _tierAmount(uint8 tier) internal pure returns (uint256) {
        if (tier == 1) return TIER_1;
        if (tier == 2) return TIER_2;
        return TIER_3;
    }

    function _findPlayerIndex(
        Game storage g,
        address player,
        uint8 n
    ) internal view returns (uint8) {
        for (uint8 i = 0; i < n; i++) {
            if (g.players[i] == player) return i;
        }
        revert("Player not found");
    }

    function getGame(uint256 gameId) external view returns (Game memory) {
        return games[gameId];
    }

    function getActiveGames() external view returns (uint256[] memory) {
        uint256[] memory result = new uint256[](activeGameIds.length);
        for (uint256 i = 0; i < activeGameIds.length; i++) {
            result[i] = activeGameIds[i];
        }
        return result;
    }

    function getPlayerGames(address player) external view returns (uint256[] memory) {
        return playerGameIds[player];
    }

    function _addActiveGame(uint256 gameId) internal {
        if (activeGameIndexPlusOne[gameId] != 0) return;
        activeGameIds.push(gameId);
        activeGameIndexPlusOne[gameId] = activeGameIds.length;
    }

    function _removeActiveGame(uint256 gameId) internal {
        uint256 indexPlusOne = activeGameIndexPlusOne[gameId];
        if (indexPlusOne == 0) return;

        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = activeGameIds.length - 1;

        if (index != lastIndex) {
            uint256 lastGameId = activeGameIds[lastIndex];
            activeGameIds[index] = lastGameId;
            activeGameIndexPlusOne[lastGameId] = index + 1;
        }

        activeGameIds.pop();
        delete activeGameIndexPlusOne[gameId];
    }

    function pause() external onlyOwner {
        paused = true;
    }

    function unpause() external onlyOwner {
        paused = false;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }
}
