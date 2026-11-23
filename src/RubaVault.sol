// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Custody and audit commitments for a trusted, offchain RUBA/USDT market.
/// @dev The operator controls withdrawal authorizations and state commitments. This
/// contract does NOT prove balances, AMM execution, solvency per account, or ZK proofs.
contract RubaVault is Ownable2Step, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Withdrawal {
        address account;
        address token;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        uint256 signerEpoch;
    }

    struct Batch {
        uint256 batchId;
        bytes32 previousStateRoot;
        bytes32 newStateRoot;
        bytes32 receiptsRoot;
        uint256 firstTradeId;
        uint256 tradeCount;
    }

    bytes32 public constant WITHDRAWAL_TYPEHASH = keccak256(
        "Withdrawal(address account,address token,uint256 amount,uint256 nonce,uint256 deadline,uint256 signerEpoch)"
    );
    bytes32 public constant PUBLISH_BATCH_TYPEHASH = keccak256(
        "BatchPublication(uint256 batchId,bytes32 previousStateRoot,bytes32 newStateRoot,bytes32 receiptsRoot,uint256 firstTradeId,uint256 tradeCount,uint256 deadline,uint256 signerEpoch)"
    );
    uint256 public constant MIN_TRADES_PER_BATCH = 4;
    uint256 public constant MAX_TRADES_PER_BATCH = 4;
    /// @dev All publication-limit getters describe the fixed four-trade batch.
    uint256 public constant TRADES_PER_BATCH = MAX_TRADES_PER_BATCH;

    // Preserve the getter names used by the server and browser ABI.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable ruba;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable usdt;
    address public operator;
    uint256 public signerEpoch = 1;
    uint256 public nextDepositId = 1;
    bool public marketPaused;

    mapping(address account => bool allowed) public whitelist;
    mapping(address token => bool paused) public withdrawalsPaused;
    mapping(address account => mapping(uint256 nonce => bool used)) public usedWithdrawalNonces;

    bytes32 public stateRoot;
    uint256 public lastBatchId;
    uint256 public lastTradeId;
    mapping(uint256 batchId => Batch commitment) public batches;

    error InvalidAddress();
    error UnsupportedToken();
    error InvalidAmount();
    error NotWhitelisted();
    error MarketPaused();
    error TokenWithdrawalsPaused();
    error UnsupportedTransferBehavior();
    error UnauthorizedOperator();
    error UnauthorizedAccount();
    error ExpiredWithdrawal();
    error ExpiredBatchPublication();
    error InvalidSignerEpoch();
    error WithdrawalAlreadyUsed();
    error InvalidSignature();
    error InvalidBatch();

    event Deposited(
        uint256 indexed depositId, address indexed account, address indexed token, uint256 amount
    );
    event Withdrawn(
        address indexed account,
        address indexed token,
        uint256 amount,
        uint256 indexed nonce,
        uint256 signerEpoch
    );
    event WhitelistUpdated(address indexed account, bool allowed);
    event MarketPauseUpdated(bool paused);
    event TokenWithdrawalPauseUpdated(address indexed token, bool paused);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator, uint256 signerEpoch);
    event BatchPublished(
        uint256 indexed batchId,
        bytes32 previousStateRoot,
        bytes32 newStateRoot,
        bytes32 receiptsRoot,
        uint256 firstTradeId,
        uint256 tradeCount
    );

    constructor(address ruba_, address usdt_, address initialOwner, address initialOperator)
        Ownable(initialOwner)
        EIP712("RubaVault", "1")
    {
        if (
            ruba_ == address(0) || usdt_ == address(0) || ruba_ == usdt_ || initialOperator == address(0)
                || initialOperator.code.length != 0 || ruba_.code.length == 0 || usdt_.code.length == 0
        ) revert InvalidAddress();
        ruba = ruba_;
        usdt = usdt_;
        operator = initialOperator;
    }

    /// @dev A deposit creates an event for the server's confirmed-event indexer.
    /// It never changes AMM reserves or creates LP shares by itself.
    function deposit(address token, uint256 amount) external nonReentrant returns (uint256 depositId) {
        return _depositFrom(msg.sender, msg.sender, token, amount);
    }

    /// @dev Shared accounting for normal deposits and constructor-only test seeding.
    /// External deposit always binds both payer and beneficiary to msg.sender.
    function _depositFrom(address payer, address account, address token, uint256 amount)
        internal
        returns (uint256 depositId)
    {
        _requireSupportedToken(token);
        _checkDepositAccess(account);
        if (amount == 0) revert InvalidAmount();

        IERC20 asset = IERC20(token);
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(payer, address(this), amount);
        uint256 afterBalance = asset.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) {
            revert UnsupportedTransferBehavior();
        }
        depositId = nextDepositId++;
        emit Deposited(depositId, account, token, amount);
        _afterDeposit(depositId, account, token, amount);
    }

    /// @notice Redeems a one-use operator authorization, always to its owner.
    /// @dev Revoking access and pausing the market do not confiscate existing
    /// balances. Emergency payout restrictions are separate and per token.
    function withdraw(Withdrawal calldata request, bytes calldata signature) external virtual nonReentrant {
        _requireSupportedToken(request.token);
        if (msg.sender != request.account) revert UnauthorizedAccount();
        if (request.amount == 0) revert InvalidAmount();
        if (withdrawalsPaused[request.token]) revert TokenWithdrawalsPaused();
        if (block.timestamp > request.deadline) revert ExpiredWithdrawal();
        if (request.signerEpoch != signerEpoch) revert InvalidSignerEpoch();
        if (usedWithdrawalNonces[request.account][request.nonce]) revert WithdrawalAlreadyUsed();
        if (ECDSA.recover(withdrawalDigest(request), signature) != operator) revert InvalidSignature();

        usedWithdrawalNonces[request.account][request.nonce] = true;
        IERC20(request.token).safeTransfer(request.account, request.amount);
        emit Withdrawn(request.account, request.token, request.amount, request.nonce, request.signerEpoch);
        _afterWithdrawal(request);
    }

    /// @dev Derived proof-backed vaults may record successful bridge accounting.
    /// Hooks run only after the unchanged transfer and authorization checks.
    function _afterDeposit(uint256, address, address, uint256) internal virtual {}

    function _afterWithdrawal(Withdrawal calldata) internal virtual {}

    /// @dev Legacy policy remains unchanged; proof-backed descendants can require accepted registration.
    function _checkDepositAccess(address account) internal view virtual {
        if (marketPaused) revert MarketPaused();
        if (!whitelist[account]) revert NotWhitelisted();
    }

    function withdrawalDigest(Withdrawal calldata request) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    WITHDRAWAL_TYPEHASH,
                    request.account,
                    request.token,
                    request.amount,
                    request.nonce,
                    request.deadline,
                    request.signerEpoch
                )
            )
        );
    }

    /// @notice Appends the trusted operator's next immutable batch commitment.
    /// @dev Chaining commits prevents overwrite; it does not validate the AMM.
    function publishBatch(Batch calldata batch) external virtual {
        if (msg.sender != operator) revert UnauthorizedOperator();
        _publishBatch(batch);
    }

    /// @notice Anyone may pay gas to append an operator-authorized batch.
    /// @dev The authorization binds this chain, vault, batch, deadline and signer
    /// epoch. It remains a trusted operator commitment, not an AMM or ZK proof.
    function publishSignedBatch(
        Batch calldata batch,
        uint256 deadline,
        uint256 publicationSignerEpoch,
        bytes calldata signature
    ) external virtual {
        if (block.timestamp > deadline) revert ExpiredBatchPublication();
        if (publicationSignerEpoch != signerEpoch) revert InvalidSignerEpoch();
        if (
            ECDSA.recover(batchPublicationDigest(batch, deadline, publicationSignerEpoch), signature)
                != operator
        ) revert InvalidSignature();
        _publishBatch(batch);
    }

    function batchPublicationDigest(Batch calldata batch, uint256 deadline, uint256 publicationSignerEpoch)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PUBLISH_BATCH_TYPEHASH,
                    batch.batchId,
                    batch.previousStateRoot,
                    batch.newStateRoot,
                    batch.receiptsRoot,
                    batch.firstTradeId,
                    batch.tradeCount,
                    deadline,
                    publicationSignerEpoch
                )
            )
        );
    }

    function _publishBatch(Batch calldata batch) internal {
        if (
            batch.batchId != lastBatchId + 1 || batch.previousStateRoot != stateRoot
                || batch.newStateRoot == bytes32(0) || batch.receiptsRoot == bytes32(0)
                || batch.firstTradeId != lastTradeId + 1 || batch.tradeCount != TRADES_PER_BATCH
        ) revert InvalidBatch();

        batches[batch.batchId] = batch;
        stateRoot = batch.newStateRoot;
        lastBatchId = batch.batchId;
        lastTradeId += batch.tradeCount;
        emit BatchPublished(
            batch.batchId,
            batch.previousStateRoot,
            batch.newStateRoot,
            batch.receiptsRoot,
            batch.firstTradeId,
            batch.tradeCount
        );
    }

    function verifyReceipt(uint256 batchId, bytes32 leaf, bytes32[] calldata proof)
        external
        view
        virtual
        returns (bool)
    {
        if (batchId == 0 || batchId > lastBatchId) return false;
        Batch storage batch = batches[batchId];
        uint256 count = batch.tradeCount;
        if (count != TRADES_PER_BATCH || proof.length != 2) return false;
        return MerkleProof.verifyCalldata(proof, batch.receiptsRoot, leaf);
    }

    function setWhitelist(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        whitelist[account] = allowed;
        emit WhitelistUpdated(account, allowed);
    }

    function setMarketPaused(bool paused) external onlyOwner {
        marketPaused = paused;
        emit MarketPauseUpdated(paused);
    }

    function setTokenWithdrawalsPaused(address token, bool paused) external onlyOwner {
        _requireSupportedToken(token);
        withdrawalsPaused[token] = paused;
        emit TokenWithdrawalPauseUpdated(token, paused);
    }

    function setOperator(address nextOperator) external onlyOwner {
        if (nextOperator == address(0) || nextOperator.code.length != 0) revert InvalidAddress();
        address previousOperator = operator;
        operator = nextOperator;
        ++signerEpoch;
        emit OperatorUpdated(previousOperator, nextOperator, signerEpoch);
    }

    function _requireSupportedToken(address token) internal view {
        if (token != ruba && token != usdt) revert UnsupportedToken();
    }
}
