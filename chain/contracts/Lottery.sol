// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

interface IHederaPRNG {
    function getPseudorandomSeed() external returns (bytes32);
}

/**
 * @title A Production-Ready Decentralized Prize Pool
 * @author HBET Team
 * @notice This contract implements a provably fair prize pool with robust, production-grade logic.
 * It features a "Smart Vending Machine" for entries, a two-stage draw trigger to prevent race conditions,
 * and a dynamic payout system based on the contract's real-time balance.
 */
contract Lottery {

    // --- STATE VARIABLES ---

    address payable public owner;

    // The minimum balance required to lock the pool and make it ready for a draw.
    // Use tinybars (8 decimals) for all readiness math.
    uint256 public constant POOL_TARGET = 10 * 10**8; // 10 HBAR (tinybars)
    // Minimum accepted entry per enter() (0.1 HBAR in tinybars).
    uint256 public constant MIN_ENTRY = 1 * 10**7; // 0.1 HBAR (tinybars)
    
    // The protocol fee is a percentage. We define the rate here: 25 / 1000 = 2.5%.
    uint256 public constant FEE_NUMERATOR = 25;
    uint256 public constant FEE_DENOMINATOR = 1000;

    // Hedera PRNG precompile binding (precompile address: 0x169)
    IHederaPRNG internal constant PRNG = IHederaPRNG(address(0x169));

    // Tinybar-native: msg.value and address(this).balance are treated as tinybars (8 decimals).
    
    // Stores the addresses of all participants for the current round.
    address payable[] public participants;

    // --- State-aware boolean flags for robust control ---
    
    // A flag to prevent re-entrancy attacks during the payout process.
    bool public isDrawing;
    
    // Minimal state machine for pool lifecycle.
    enum Stage { Filling, Ready, Drawing }
    Stage public stage;
    uint256 public currentRound;
  
    // Simple mutex for nonReentrant on enter()
    bool private locked;
    modifier nonReentrant() {
        require(!locked, "Reentrant call");
        locked = true;
        _;
        locked = false;
    }
  
    // Manually track the participant count for efficient off-chain queries.
    uint256 public participantCount;

    // Per-address stake (tinybars) and aggregate total stake used for weighted selection.
    mapping(address => uint256) public stakes;
    uint256 public totalStake;
 
    // Pending refunds credited for callers when immediate push fails or for contract callers.
    mapping(address => uint256) public pendingRefunds;
 
    // Track total pending refunds to exclude from readiness/payout math.
    uint256 public pendingRefundsTotal;

    // Net balance excludes credits earmarked for refunds.
    // Returns tinybars (8 decimals).
    function _netBalance() internal view returns (uint256) {
        uint256 bal = address(this).balance;
        uint256 net = bal > pendingRefundsTotal ? (bal - pendingRefundsTotal) : 0;
        return net;
    }
  
    // --- EVENTS ---
    
    event EnteredPool(address indexed player, uint256 amountEntered, uint256 indexed roundId);
    event WinnerPicked(address indexed winner, uint256 amountWon, uint256 indexed roundId);
    event OverageRefunded(address indexed player, uint256 amountRefunded);
    event PoolFilled(uint256 roundId, uint256 total);
    event RoundReset(uint256 roundId);
    event RoundStarted(uint256 indexed roundId);
    event RefundCredited(address indexed user, uint256 amount);
    event RefundFlushed(address indexed user, uint256 amount);

    // --- CONSTRUCTOR ---

    constructor() {
        owner = payable(msg.sender);
        // initialize state machine and round counter
        stage = Stage.Filling;
        currentRound = 1;
    }

    // --- FUNCTIONS ---

    /**
     * @dev The main function for users to enter the prize pool. Implements the "Smart Vending Machine" logic.
     * It accepts variable entry amounts, only keeps what's needed to fill the pool, and refunds any overage.
     * Reentrancy guarded; CEI preserved.
     */
    function enter() public payable nonReentrant {
        // Compute pre-balance in tinybars (exclude this msg.value)
        uint256 preTiny = address(this).balance - msg.value;
        // Clamp preNetTiny to avoid underflow when pendingRefundsTotal > preTiny
        uint256 preNetTiny = preTiny > pendingRefundsTotal ? (preTiny - pendingRefundsTotal) : 0;
 
        // Ensure the pool is currently accepting entries.
        require(stage == Stage.Filling, "Not accepting entries right now.");
 
        // Checks (use tinybars so the final, filling deposit is allowed)
        require(preNetTiny < POOL_TARGET, "The draw is ready and waiting to be triggered.");
        require(msg.value > 0, "Minimum entry is 0.1 HBAR.");
 
        // Compute remaining capacity in tinybars based on preNetTiny; clamp at zero.
        uint256 remainingTiny = preNetTiny < POOL_TARGET ? (POOL_TARGET - preNetTiny) : 0;
 
        // Determine how much to keep from this entry and the change to refund (tinybars).
        uint256 take = msg.value < remainingTiny ? msg.value : remainingTiny;
        uint256 change = msg.value - take;

        // Enforce a minimum accepted entry size (take == 0 allowed when nothing is accepted).
        require(take == 0 || take >= MIN_ENTRY, "Minimum entry is 0.1 HBAR.");
 
        // Effects: only count participant if we actually keep > 0
        if (take > 0) {
            // Keep one participants[] entry per unique wallet; accumulate stake for weighting.
            if (stakes[msg.sender] == 0) {
                participants.push(payable(msg.sender));
                participantCount++;
            }
            stakes[msg.sender] += take;
            totalStake += take;
            emit EnteredPool(msg.sender, take, currentRound);
        }
 
        // If this entry completed the pool, mark Ready and emit PoolFilled (tinybars)
        if (preNetTiny + take >= POOL_TARGET) {
            stage = Stage.Ready;
            emit PoolFilled(currentRound, preNetTiny + take);
        }
 
        // Interactions: hybrid refund model (push-or-credit) + auto-flush
        if (change > 0) {
            if (msg.sender.code.length == 0) {
                // EOA: attempt immediate refund
                (bool sent, ) = msg.sender.call{value: change}("");
                if (sent) {
                    emit OverageRefunded(msg.sender, change);
                } else {
                    // Credit on failure without reverting
                    pendingRefunds[msg.sender] += change;
                    pendingRefundsTotal += change;
                    emit RefundCredited(msg.sender, change);
                }
            } else {
                // Contract caller: skip push, credit instead
                pendingRefunds[msg.sender] += change;
                pendingRefundsTotal += change;
                emit RefundCredited(msg.sender, change);
            }
        }
 
        // Attempt an auto-flush for the caller's accumulated credit (best-effort, non-reverting)
        uint256 credit = pendingRefunds[msg.sender];
        if (credit > 0) {
            (bool flushed, ) = msg.sender.call{value: credit}("");
            if (flushed) {
                pendingRefunds[msg.sender] = 0;
                pendingRefundsTotal -= credit;
                emit RefundFlushed(msg.sender, credit);
            }
        }
 
        // Readiness is still derived from isReadyForDraw().
        // Post-state sync: ensure stage flips to Ready if net balance meets target
        uint256 netAfterTiny = _netBalance();
        if (stage == Stage.Filling && netAfterTiny >= POOL_TARGET) {
            stage = Stage.Ready;
            // Emit tinybars total
            emit PoolFilled(currentRound, netAfterTiny);
        }
    }

    /**
     * @dev Synchronize stage to Ready if net balance meets or exceeds target while Filling.
     * Emits PoolFilled when flipping.
     */
    function syncReady() public {
        if (stage == Stage.Filling) {
            uint256 netTiny = _netBalance();
            if (netTiny >= POOL_TARGET) {
                stage = Stage.Ready;
                // Emit tinybars total
                emit PoolFilled(currentRound, netTiny);
            }
        }
    }

    /**
     * @dev A separate, public function to trigger the winner selection and payout.
     * This two-stage model prevents race conditions by separating the final deposit from the payout logic.
     */
    function triggerDraw() public nonReentrant {
        // Pre-check sync: ensure stage flips to Ready if net >= target
        syncReady();
        // 1. Check if the contract is ready for the draw and not already drawing.
        require(isReadyForDraw(), "The draw is not ready to be triggered.");
        require(_netBalance() >= POOL_TARGET, "Pool balance below target.");
        require(participantCount > 0, "No participants");
        // Enforce explicit state machine readiness (must be in Ready stage).
        require(stage == Stage.Ready, "Pool not in Ready stage.");
        require(!isDrawing, "Draw is already in progress.");
  
        // 2. Lock the function to prevent re-entrancy.
        isDrawing = true;
        stage = Stage.Drawing;
  
        // 3. Select a winner (weighted by accepted stake).
        bytes32 seed = PRNG.getPseudorandomSeed();
        require(totalStake > 0, "No stake to draw from.");
        uint256 r = uint256(seed) % totalStake;
        uint256 cumulative = 0;
        address payable winner;
        for (uint256 i = 0; i < participants.length; i++) {
            address payable p = participants[i];
            cumulative += stakes[p];
            if (cumulative > r) {
                winner = p;
                break;
            }
        }
        // Fallback (should not occur if totalStake matches stakes sum): pick first participant.
        if (winner == address(0)) {
            winner = participants[0];
        }
  
        // 4. Perform the dynamic payout based on the contract's net balance.
        payWinnerAndFee(winner);
  
        // 5. Reset the contract's state for the next round.
        resetLottery();
    }
    
    /**
     * @dev Internal function to handle the dynamic payout logic.
     */
    function payWinnerAndFee(address payable winner) private {
        // Use net balance (tinybars) to exclude pending refunds from payout math.
        uint256 netTiny = _netBalance();
 
        // Calculate prize and fee in tinybars.
        uint256 prizeAmountTiny = (netTiny * (FEE_DENOMINATOR - FEE_NUMERATOR)) / FEE_DENOMINATOR;
        uint256 feeAmountTiny = netTiny - prizeAmountTiny;
 
        // Securely pay the calculated protocol fee to the owner (tinybars).
        (bool successFee, ) = owner.call{value: feeAmountTiny}("");
        require(successFee, "Failed to send protocol fee to owner.");
         
        // Securely pay the winner their prize (tinybars).
        if (prizeAmountTiny > 0) {
            (bool successPrize, ) = winner.call{value: prizeAmountTiny}("");
            require(successPrize, "Failed to send prize to winner.");
        }
         
        emit WinnerPicked(winner, prizeAmountTiny, currentRound);
    }
    
    /**
     * @dev Internal function to reset the lottery state after a draw.
     */
    function resetLottery() private {
        // Clear per-address stakes and aggregate totalStake.
        for (uint256 i = 0; i < participants.length; i++) {
            address payable p = participants[i];
            stakes[p] = 0;
        }
        totalStake = 0;

        // Reset the participants array for the next round.
        delete participants;
        participantCount = 0;
 
        // Release drawing lock and advance round. Readiness is derived by isReadyForDraw().
        isDrawing = false;
        stage = Stage.Filling;
 
        // Notify off-chain listeners that the round has been reset (before bumping to the next round).
        emit RoundReset(currentRound);
 
        // Advance to the next canonical round and notify listeners.
        currentRound++;
        emit RoundStarted(currentRound);
    }

    // Accept plain HBAR transfers and route to enter()
    receive() external payable { enter(); }
    fallback() external payable { enter(); }

    // --- View Functions ---

    /**
     * @dev Debug helper exposing tinybar-native diagnostics:
     * - balanceTiny: address(this).balance (tinybars, 8 decimals)
     * - pendingTiny: total pending refunds (tinybars, 8 decimals)
     * - netTiny: net balance (tinybars, 8 decimals)
     * - targetTiny: target (tinybars, 8 decimals)
     * - ready: readiness (tinybars comparison)
     */
    function debugUnits()
        public
        view
        returns (
            uint256 balanceTiny,
            uint256 pendingTiny,
            uint256 netTiny,
            uint256 targetTiny,
            bool ready
        )
    {
        balanceTiny = address(this).balance;
        pendingTiny = pendingRefundsTotal;
        netTiny = _netBalance();
        targetTiny = POOL_TARGET;
        ready = netTiny >= targetTiny;
    }
      
    function isReadyForDraw() public view returns (bool) {
        return _netBalance() >= POOL_TARGET;
    }
    
    function getParticipants() public view returns (address payable[] memory) {
        return participants;
    }

    function getParticipantCount() public view returns (uint256) {
        return participantCount;
    }
}