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

    struct ResumeState {
        uint256 round;
        uint256 approvals;
        uint256 readyAt;
        uint256 guardianEpoch;
    }

    struct Admission {
        address account;
        bytes32 kycHash;
        bytes32 consentHash;
        uint256 deadline;
        uint256 nonce;
    }

    bytes32 public constant ADMISSION_TYPEHASH = keccak256(
        "Admission(address account,bytes32 kycHash,bytes32 consentHash,uint256 deadline,uint256 nonce)"
    );
    address public admissionSigner;
    mapping(uint256 nonce => bool used) public usedAdmissionNonces;
    mapping(address account => bytes32 kycHash) public kycHashOf;
    mapping(address account => bytes32 consentHash) public consentHashOf;
    mapping(address account => bool blocked) public admissionBlocked;

    uint256 public constant PAUSE_GUARDIAN_COUNT = 3;
    uint256 public constant RESUME_APPROVALS = 2;
    uint256 public constant MAX_RESUME_DELAY = 7 days;

    address[3] private _pauseGuardians;
    bool public pauseGuardiansConfigured;
    uint256 public resumeDelay;
    uint256 public guardianEpoch;
    ResumeState private _marketResume;
    mapping(address token => ResumeState state) private _tokenResume;
    mapping(bytes32 rotation => uint256 approvals) private _rotationApprovals;

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
    error OwnershipRenounceDisabled();
    error InvalidAdmission();
    error ExpiredAdmission();
    error AdmissionAlreadyUsed();
    error AdmissionBlocked();
    error PauseGuardiansAlreadyConfigured();
    error PauseGuardiansNotConfigured();
    error InvalidPauseGuardians();
    error UnauthorizedPauser();
    error UnauthorizedGuardian();
    error ResumeRequiresGuardians();
    error NothingToResume();
    error ResumeAlreadyApproved();
    error ResumeNotReady();
    error RotationAlreadyApproved();

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
    event AdmissionSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event Admitted(address indexed account, bytes32 kycHash, bytes32 consentHash, uint256 indexed nonce);
    event PauseGuardiansConfigured(address[3] guardians, uint256 resumeDelay);
    event ResumeApproved(
        address indexed token, uint256 indexed round, address indexed guardian, uint256 approvals
    );
    event ResumeScheduled(address indexed token, uint256 indexed round, uint256 readyAt);
    event PauseGuardianRotationApproved(
        uint256 indexed index, address indexed newGuardian, address indexed guardian
    );
    event PauseGuardianRotated(
        uint256 indexed index, address indexed previousGuardian, address indexed newGuardian
    );
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

    /// @notice Owner exclusion also blocks any admission approval issued earlier.
    function setWhitelist(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert InvalidAddress();
        whitelist[account] = allowed;
        admissionBlocked[account] = !allowed;
        emit WhitelistUpdated(account, allowed);
    }

    function setAdmissionSigner(address nextSigner) external onlyOwner {
        if (nextSigner.code.length != 0 || (nextSigner != address(0) && nextSigner == owner())) {
            revert InvalidAddress();
        }
        emit AdmissionSignerUpdated(admissionSigner, nextSigner);
        admissionSigner = nextSigner;
    }

    /// @notice The participant sends the admission desk approval and pays the gas.
    /// The approval binds this vault and chain, a KYC hash with salt and the accepted risk text.
    function admit(Admission calldata admission, bytes calldata signature) external {
        if (msg.sender != admission.account) revert UnauthorizedAccount();
        if (admission.kycHash == bytes32(0) || admission.consentHash == bytes32(0)) {
            revert InvalidAdmission();
        }
        if (block.timestamp > admission.deadline) revert ExpiredAdmission();
        if (usedAdmissionNonces[admission.nonce]) revert AdmissionAlreadyUsed();
        if (admissionBlocked[admission.account]) revert AdmissionBlocked();
        address signer = admissionSigner;
        if (signer == address(0) || ECDSA.recover(admissionDigest(admission), signature) != signer) {
            revert InvalidSignature();
        }
        usedAdmissionNonces[admission.nonce] = true;
        whitelist[admission.account] = true;
        kycHashOf[admission.account] = admission.kycHash;
        consentHashOf[admission.account] = admission.consentHash;
        emit Admitted(admission.account, admission.kycHash, admission.consentHash, admission.nonce);
        emit WhitelistUpdated(admission.account, true);
    }

    function admissionDigest(Admission calldata admission) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ADMISSION_TYPEHASH,
                    admission.account,
                    admission.kycHash,
                    admission.consentHash,
                    admission.deadline,
                    admission.nonce
                )
            )
        );
    }

    /// @notice Pause is open to the owner and every pause guardian. Before guardians are
    /// configured the owner also resumes; after that a resume needs two guardians.
    function setMarketPaused(bool paused) external {
        if (paused) {
            _checkPauser();
            marketPaused = true;
            _resetResume(_marketResume, true);
            emit MarketPauseUpdated(true);
            return;
        }
        _checkOwner();
        if (pauseGuardiansConfigured) revert ResumeRequiresGuardians();
        marketPaused = false;
        emit MarketPauseUpdated(false);
    }

    function setTokenWithdrawalsPaused(address token, bool paused) external {
        _requireSupportedToken(token);
        if (paused) {
            _checkPauser();
            withdrawalsPaused[token] = true;
            _resetResume(_tokenResume[token], true);
            emit TokenWithdrawalPauseUpdated(token, true);
            return;
        }
        _checkOwner();
        if (pauseGuardiansConfigured) revert ResumeRequiresGuardians();
        withdrawalsPaused[token] = false;
        emit TokenWithdrawalPauseUpdated(token, false);
    }

    /// @notice One-time setup of the three pause roles, for example admin, guardian and monitor bot.
    function setPauseGuardians(address[3] calldata guardians, uint256 delay) external onlyOwner {
        if (pauseGuardiansConfigured) revert PauseGuardiansAlreadyConfigured();
        if (delay > MAX_RESUME_DELAY) revert InvalidPauseGuardians();
        for (uint256 i; i < PAUSE_GUARDIAN_COUNT; ++i) {
            if (guardians[i] == address(0)) revert InvalidPauseGuardians();
            for (uint256 j; j < i; ++j) {
                if (guardians[i] == guardians[j]) revert InvalidPauseGuardians();
            }
            _pauseGuardians[i] = guardians[i];
        }
        pauseGuardiansConfigured = true;
        resumeDelay = delay;
        emit PauseGuardiansConfigured(guardians, delay);
    }

    function pauseGuardians() external view returns (address[3] memory) {
        return _pauseGuardians;
    }

    function isPauseGuardian(address account) public view returns (bool) {
        return pauseGuardiansConfigured && account != address(0)
            && (account == _pauseGuardians[0]
                || account == _pauseGuardians[1]
                || account == _pauseGuardians[2]);
    }

    function marketResumeStatus() external view returns (uint256 round, uint256 approvals, uint256 readyAt) {
        return _resumeStatus(_marketResume);
    }

    function tokenWithdrawalsResumeStatus(address token)
        external
        view
        returns (uint256 round, uint256 approvals, uint256 readyAt)
    {
        return _resumeStatus(_tokenResume[token]);
    }

    function approveMarketResume() external {
        if (!marketPaused) revert NothingToResume();
        if (_approveResume(_marketResume, address(0))) _resumeMarket();
    }

    function executeMarketResume() external {
        if (!marketPaused) revert NothingToResume();
        _requireResumeReady(_marketResume);
        _resumeMarket();
    }

    function approveTokenWithdrawalsResume(address token) external {
        _requireSupportedToken(token);
        if (!withdrawalsPaused[token]) revert NothingToResume();
        if (_approveResume(_tokenResume[token], token)) _resumeTokenWithdrawals(token);
    }

    function executeTokenWithdrawalsResume(address token) external {
        _requireSupportedToken(token);
        if (!withdrawalsPaused[token]) revert NothingToResume();
        _requireResumeReady(_tokenResume[token]);
        _resumeTokenWithdrawals(token);
    }

    /// @notice Replaces one guardian after two current guardians approve the same change.
    function approveGuardianRotation(uint256 index, address newGuardian) external {
        uint256 bit = _guardianBit(msg.sender);
        if (index >= PAUSE_GUARDIAN_COUNT || newGuardian == address(0) || isPauseGuardian(newGuardian)) {
            revert InvalidPauseGuardians();
        }
        bytes32 key = keccak256(abi.encode(guardianEpoch, index, newGuardian));
        uint256 approvals = _rotationApprovals[key];
        if (approvals & bit != 0) revert RotationAlreadyApproved();
        approvals |= bit;
        _rotationApprovals[key] = approvals;
        emit PauseGuardianRotationApproved(index, newGuardian, msg.sender);
        if (_countBits(approvals) < RESUME_APPROVALS) return;
        address previous = _pauseGuardians[index];
        _pauseGuardians[index] = newGuardian;
        ++guardianEpoch;
        emit PauseGuardianRotated(index, previous, newGuardian);
    }

    function renounceOwnership() public pure override {
        revert OwnershipRenounceDisabled();
    }

    function _checkPauser() internal view {
        if (msg.sender != owner() && !isPauseGuardian(msg.sender)) revert UnauthorizedPauser();
    }

    function _guardianBit(address account) private view returns (uint256) {
        if (!pauseGuardiansConfigured) revert PauseGuardiansNotConfigured();
        for (uint256 i; i < PAUSE_GUARDIAN_COUNT; ++i) {
            if (account == _pauseGuardians[i]) return 1 << i;
        }
        revert UnauthorizedGuardian();
    }

    function _resetResume(ResumeState storage state, bool newRound) private {
        if (newRound) ++state.round;
        state.approvals = 0;
        state.readyAt = 0;
        state.guardianEpoch = guardianEpoch;
    }

    function _resumeStatus(ResumeState storage state)
        private
        view
        returns (uint256 round, uint256 approvals, uint256 readyAt)
    {
        if (state.guardianEpoch != guardianEpoch) return (state.round, 0, 0);
        return (state.round, _countBits(state.approvals), state.readyAt);
    }

    function _approveResume(ResumeState storage state, address token) private returns (bool resumeNow) {
        uint256 bit = _guardianBit(msg.sender);
        if (state.guardianEpoch != guardianEpoch) _resetResume(state, false);
        if (state.approvals & bit != 0) revert ResumeAlreadyApproved();
        state.approvals |= bit;
        uint256 count = _countBits(state.approvals);
        emit ResumeApproved(token, state.round, msg.sender, count);
        if (count < RESUME_APPROVALS || state.readyAt != 0) return false;
        state.readyAt = block.timestamp + resumeDelay;
        emit ResumeScheduled(token, state.round, state.readyAt);
        return resumeDelay == 0;
    }

    function _requireResumeReady(ResumeState storage state) private view {
        if (
            !pauseGuardiansConfigured || state.guardianEpoch != guardianEpoch || state.readyAt == 0
                || block.timestamp < state.readyAt
        ) revert ResumeNotReady();
    }

    function _resumeMarket() private {
        marketPaused = false;
        _resetResume(_marketResume, false);
        emit MarketPauseUpdated(false);
    }

    function _resumeTokenWithdrawals(address token) private {
        withdrawalsPaused[token] = false;
        _resetResume(_tokenResume[token], false);
        emit TokenWithdrawalPauseUpdated(token, false);
    }

    function _countBits(uint256 value) private pure returns (uint256 count) {
        while (value != 0) {
            count += value & 1;
            value >>= 1;
        }
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
