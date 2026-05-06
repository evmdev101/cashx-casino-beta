// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20PvP {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title PvPWager - two-player CASHX wager escrow for skill games
/// @notice Players fund both sides of the pot. A trusted game server signs the final winner.
///         The contract burns a fee and pays the rest of the pot to the winner.
///         Either player may request a mutual cancel at any time while a match is active.
///         If both players request, funds are returned in full with no burn.
///         If the other player ignores a cancel request for longer than cancelResponseWindow,
///         the requesting player may force a full refund unilaterally.
contract PvPWager {

    IERC20PvP public constant CASHX = IERC20PvP(0x4C450b3C2b89a2DAbE5A3eE39FF475134A30d665);
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint16  public constant BPS = 10_000;
    uint16  public constant BURN_BPS = 500;

    enum GameType { ConnectFour, VanishingTicTacToe }
    enum Status { None, Waiting, Active, Settled, Cancelled, Refunded }

    struct Match {
        GameType gameType;
        Status status;
        address player1;
        address player2;
        uint256 wager;
        uint256 createdAt;
        uint256 startedAt;
        address winner;
        uint256 settledAt;
    }

    address public owner;
    address public gameSigner;
    uint256 public minWager = 500 * 1e18;
    uint256 public maxWager = 1_000_000 * 1e18;
    uint256 public joinTimeout = 1 days;
    uint256 public matchTimeout = 1 days;
    uint256 public cancelResponseWindow = 24 hours; // how long the other player has to respond to a cancel request
    uint256 public totalBurned;
    uint256 public matchCount;
    bool    public paused;
    bool    private locked;

    mapping(uint256 => Match) public matches;
    mapping(address => uint256[]) private playerMatchIds;
    mapping(bytes32 => bool) public usedResultHashes;

    /// @notice Tracks which players have an active cancel request for a match.
    mapping(uint256 => mapping(address => bool)) public cancelRequests;
    /// @notice Timestamp of the earliest outstanding cancel request per match.
    mapping(uint256 => uint256) public cancelRequestedAt;

    event MatchCreated(
        uint256 indexed matchId,
        GameType indexed gameType,
        address indexed player1,
        uint256 wager
    );
    event MatchJoined(uint256 indexed matchId, address indexed player2);
    event MatchSettled(
        uint256 indexed matchId,
        address indexed winner,
        uint256 payout,
        uint256 burned,
        bytes32 resultHash
    );
    event MatchCancelled(uint256 indexed matchId);
    event MatchRefunded(uint256 indexed matchId, address indexed player, uint256 amount);
    event Burned(uint256 amount);
    event GameSignerUpdated(address signer);
    event Paused(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event CancelRequested(uint256 indexed matchId, address indexed requester);
    event CancelRevoked(uint256 indexed matchId, address indexed requester);
    event MatchMutuallyCancelled(uint256 indexed matchId);

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

        emit OwnershipTransferred(address(0), msg.sender);
        emit GameSignerUpdated(gameSigner);
    }

    // -------------------------------------------------------------------------
    // Core match lifecycle
    // -------------------------------------------------------------------------

    /// @notice Create a two-player wager match and escrow player one's CASHX.
    function createMatch(GameType gameType, uint256 wager)
        external
        noReentrant
        whenNotPaused
        returns (uint256 matchId)
    {
        require(wager >= minWager, "Wager below minimum");
        require(wager <= maxWager, "Wager above maximum");
        require(CASHX.transferFrom(msg.sender, address(this), wager), "Transfer failed");

        matchId = ++matchCount;
        matches[matchId] = Match({
            gameType: gameType,
            status: Status.Waiting,
            player1: msg.sender,
            player2: address(0),
            wager: wager,
            createdAt: block.timestamp,
            startedAt: 0,
            winner: address(0),
            settledAt: 0
        });
        playerMatchIds[msg.sender].push(matchId);

        emit MatchCreated(matchId, gameType, msg.sender, wager);
    }

    /// @notice Join an open match and escrow the matching wager.
    function joinMatch(uint256 matchId) external noReentrant whenNotPaused {
        Match storage m = matches[matchId];

        require(m.status == Status.Waiting, "Match not waiting");
        require(m.player1 != address(0), "Unknown match");
        require(msg.sender != m.player1, "Creator cannot join");
        require(CASHX.transferFrom(msg.sender, address(this), m.wager), "Transfer failed");

        m.player2 = msg.sender;
        m.status = Status.Active;
        m.startedAt = block.timestamp;
        playerMatchIds[msg.sender].push(matchId);

        emit MatchJoined(matchId, msg.sender);
    }

    /// @notice Settle an active match after the game backend signs the winner.
    /// @param resultDataHash Optional hash of room id, board, move log, timeout reason, or final state.
    function settleMatch(
        uint256 matchId,
        address winner,
        bytes32 resultDataHash,
        bytes calldata signature
    )
        external
        noReentrant
    {
        Match storage m = matches[matchId];

        require(m.status == Status.Active, "Match not active");
        require(winner == m.player1 || winner == m.player2, "Winner not in match");
        require(msg.sender == winner || msg.sender == gameSigner, "Not allowed");

        bytes32 signedHash = resultHash(matchId, winner, resultDataHash);
        require(!usedResultHashes[signedHash], "Result already used");
        usedResultHashes[signedHash] = true;
        require(_recoverSigner(signedHash, signature) == gameSigner, "Bad signature");

        m.status = Status.Settled;
        m.winner = winner;
        m.settledAt = block.timestamp;

        uint256 pot = m.wager * 2;
        uint256 burned = pot * BURN_BPS / BPS;
        uint256 payout = pot - burned;

        require(CASHX.transfer(winner, payout), "Payout failed");
        require(CASHX.transfer(BURN_ADDRESS, burned), "Burn failed");

        totalBurned += burned;

        emit Burned(burned);
        emit MatchSettled(matchId, winner, payout, burned, signedHash);
    }

    /// @notice Cancel a waiting match and return player one's escrow.
    /// @dev The creator may cancel anytime before a second player joins.
    ///      Anyone may cancel after the join timeout.
    function cancelUnmatched(uint256 matchId) external noReentrant {
        Match storage m = matches[matchId];

        require(m.status == Status.Waiting, "Match not waiting");
        require(
            msg.sender == m.player1 || block.timestamp >= m.createdAt + joinTimeout,
            "Only creator before timeout"
        );

        m.status = Status.Cancelled;
        require(CASHX.transfer(m.player1, m.wager), "Refund failed");

        emit MatchCancelled(matchId);
        emit MatchRefunded(matchId, m.player1, m.wager);
    }

    /// @notice Refund both players if a funded match never receives a signed result.
    /// @dev In-game clock forfeits should be settled by backend signature. This is a backup path.
    function refundExpired(uint256 matchId) external noReentrant {
        Match storage m = matches[matchId];

        require(m.status == Status.Active, "Match not active");
        require(block.timestamp >= m.startedAt + matchTimeout, "Match still active");

        m.status = Status.Refunded;

        require(CASHX.transfer(m.player1, m.wager), "Player1 refund failed");
        require(CASHX.transfer(m.player2, m.wager), "Player2 refund failed");

        emit MatchRefunded(matchId, m.player1, m.wager);
        emit MatchRefunded(matchId, m.player2, m.wager);
    }

    // -------------------------------------------------------------------------
    // Mutual cancel — either player may request at any time during an active match
    // -------------------------------------------------------------------------

    /// @notice Signal that you want to cancel an active match.
    ///         - If the other player has already requested, funds are returned to both immediately.
    ///         - Otherwise your request is recorded; the other player can accept or ignore it.
    function requestCancel(uint256 matchId) external noReentrant {
        Match storage m = matches[matchId];

        require(m.status == Status.Active, "Match not active");
        require(msg.sender == m.player1 || msg.sender == m.player2, "Not a player");
        require(!cancelRequests[matchId][msg.sender], "Cancel already requested");

        cancelRequests[matchId][msg.sender] = true;

        // Record timestamp of the FIRST outstanding request so the timeout starts here.
        if (cancelRequestedAt[matchId] == 0) {
            cancelRequestedAt[matchId] = block.timestamp;
        }

        emit CancelRequested(matchId, msg.sender);

        // If both players have now requested, execute the cancel in the same tx.
        address other = (msg.sender == m.player1) ? m.player2 : m.player1;
        if (cancelRequests[matchId][other]) {
            _executeMutualCancel(matchId);
        }
    }

    /// @notice Withdraw your cancel request if you change your mind.
    function revokeCancel(uint256 matchId) external {
        Match storage m = matches[matchId];

        require(m.status == Status.Active, "Match not active");
        require(cancelRequests[matchId][msg.sender], "No cancel request to revoke");

        cancelRequests[matchId][msg.sender] = false;

        // Reset the timer if neither player has an active request anymore.
        address other = (msg.sender == m.player1) ? m.player2 : m.player1;
        if (!cancelRequests[matchId][other]) {
            cancelRequestedAt[matchId] = 0;
        }

        emit CancelRevoked(matchId, msg.sender);
    }

    /// @notice Force a full mutual refund if you previously requested cancel and the other
    ///         player has not responded within cancelResponseWindow.
    ///         Both players receive their full wager back — no burn.
    function claimCancelTimeout(uint256 matchId) external noReentrant {
        Match storage m = matches[matchId];

        require(m.status == Status.Active, "Match not active");
        require(msg.sender == m.player1 || msg.sender == m.player2, "Not a player");
        require(cancelRequests[matchId][msg.sender], "Request cancel first");
        require(cancelRequestedAt[matchId] != 0, "No outstanding cancel request");
        require(
            block.timestamp >= cancelRequestedAt[matchId] + cancelResponseWindow,
            "Response window still open"
        );

        _executeMutualCancel(matchId);
    }

    /// @dev Refund both players in full. Called when both agree or after timeout.
    function _executeMutualCancel(uint256 matchId) internal {
        Match storage m = matches[matchId];

        m.status = Status.Refunded;

        require(CASHX.transfer(m.player1, m.wager), "Player1 refund failed");
        require(CASHX.transfer(m.player2, m.wager), "Player2 refund failed");

        emit MatchMutuallyCancelled(matchId);
        emit MatchRefunded(matchId, m.player1, m.wager);
        emit MatchRefunded(matchId, m.player2, m.wager);
    }

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------

    function resultHash(
        uint256 matchId,
        address winner,
        bytes32 resultDataHash
    )
        public
        view
        returns (bytes32)
    {
        Match storage m = matches[matchId];
        require(m.status == Status.Active, "Match not active");

        return keccak256(abi.encode(
            address(this),
            block.chainid,
            matchId,
            m.gameType,
            m.player1,
            m.player2,
            m.wager,
            winner,
            resultDataHash
        ));
    }

    function getPlayerMatches(address player) external view returns (uint256[] memory) {
        return playerMatchIds[player];
    }

    function previewPayout(uint256 wager) external pure returns (uint256 pot, uint256 burned, uint256 payout) {
        pot = wager * 2;
        burned = pot * BURN_BPS / BPS;
        payout = pot - burned;
    }

    function contractBalance() external view returns (uint256) {
        return CASHX.balanceOf(address(this));
    }

    // -------------------------------------------------------------------------
    // Owner admin
    // -------------------------------------------------------------------------

    function setGameSigner(address newSigner) external onlyOwner {
        require(newSigner != address(0), "Zero signer");
        gameSigner = newSigner;
        emit GameSignerUpdated(newSigner);
    }

    function setWagerLimits(uint256 newMin, uint256 newMax) external onlyOwner {
        require(newMin > 0, "Min must be > 0");
        require(newMax > newMin, "Max must be > min");
        minWager = newMin;
        maxWager = newMax;
    }

    function setTimeouts(uint256 newJoinTimeout, uint256 newMatchTimeout) external onlyOwner {
        require(newJoinTimeout >= 5 minutes, "Join timeout too short");
        require(newMatchTimeout >= 5 minutes, "Match timeout too short");
        joinTimeout = newJoinTimeout;
        matchTimeout = newMatchTimeout;
    }

    function setCancelResponseWindow(uint256 newWindow) external onlyOwner {
        require(newWindow >= 1 hours, "Window too short");
        cancelResponseWindow = newWindow;
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Paused(false);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function _recoverSigner(bytes32 signedHash, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "Bad signature length");

        bytes32 ethHash = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            signedHash
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
