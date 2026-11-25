// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RubaVault} from "./RubaVault.sol";
import {IPoseidon2} from "./interfaces/IPoseidon2.sol";
import {IZkTransitionVerifier} from "./interfaces/IZkTransitionVerifier.sol";

/// @notice Proof-checked private accounting with canonical bridge events and calldata DA.
/// @dev Payouts consume owner-authorized reservations accepted by a real transition proof.
/// Proof generation and publication remain necessary; there is no offline emergency exit.
contract ZkRubaVault is RubaVault {
    using SafeERC20 for IERC20;

    uint256 public constant FIELD_MODULUS =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant ZK_VERSION = 2;
    uint256 public constant MAX_OPERATIONS = 8;
    uint256 public constant ACCOUNT_COUNT = 16;
    // The inherited batch-limit getters describe the retired fixed-size legacy publisher.
    uint256 public constant MIN_ZK_TRADES_PER_BATCH = 1;
    uint256 public constant MAX_ZK_TRADES_PER_BATCH = 4;
    bytes32 public constant PRIVATE_OPERATION_TYPEHASH = keccak256("PrivateOperation(uint256 commitment)");
    bytes32 public constant TIMED_OPERATION_TYPEHASH =
        keccak256("TimedPrivateOperation(uint256 commitment,uint256 deadline)");
    bytes32 public constant ZK_PUBLICATION_TYPEHASH =
        keccak256("ZkPublication(uint256 headerDigest,uint256 deadline,uint256 signerEpoch)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    struct OperationMetadata {
        uint256 kind;
        uint256 slot;
        address owner;
        uint256 commitment;
        uint256 eventId;
        uint256 token;
        uint256 amount;
        uint256 referenceId;
        bytes signature;
    }

    struct AccountDA {
        uint256 kind;
        uint256 slot;
        address owner;
        uint256 newLeaf;
        uint256[7] ciphertext;
    }

    struct PoolDA {
        uint256 poolHash;
        uint256[6] poolCiphertext;
    }

    struct Groth16Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    struct PublicationAuthorization {
        uint256 deadline;
        uint256 signerEpoch;
        bytes signature;
    }

    struct ProvenWithdrawal {
        address account;
        address token;
        uint256 amount;
        uint256 nonce;
        uint256 spendNonce;
        uint256 salt;
    }

    struct WithdrawalClaim {
        address owner;
        uint256 slot;
        uint256 stateVersion;
    }

    struct InboxMessage {
        uint256 kind;
        address owner;
        uint256 tokenIndex;
        uint256 amount;
        uint256 referenceId;
    }

    IZkTransitionVerifier public immutable verifier;
    IPoseidon2 public immutable poseidon2;
    bytes32 public immutable verifierCodeHash;
    bytes32 public immutable poseidonCodeHash;
    uint256 public immutable poolKeyCommit;
    uint256 public immutable domain;
    uint256 public immutable emptyAccountsRoot;
    bytes32 public immutable genesisStateRoot;
    uint256 public stateVersion;
    uint256 public inboxCursor;
    uint256 public nextTradeId = 1;
    uint256 public nextInboxEventId = 1;
    mapping(uint256 eventId => InboxMessage message) public inbox;
    mapping(address owner => uint256 slotPlusOne) public ownerSlotPlusOne;
    mapping(uint256 slot => address owner) public slotOwners;
    mapping(uint256 version => uint256[13] signals) private _transitions;
    // Only canonical inbox credits count toward this cap; unsolicited ERC20 donations do not.
    mapping(address token => uint256 amount) private _inboxExposure;
    mapping(uint256 commitment => WithdrawalClaim claim) public withdrawalClaims;
    mapping(uint256 commitment => bool spent) public spentWithdrawalCommitments;

    error LegacyPublicationDisabled();
    error FieldElementOutOfRange();
    error InvalidZkTransition();
    error InvalidZkProof();
    error InvalidOperationMetadata();
    error InvalidDataAvailability();
    error InvalidInboxMessage();
    error InvalidRegistration();
    error InvalidOperationAuthorization();
    error OperationExpired();
    error LegacyWithdrawalDisabled();
    error InvalidWithdrawalOpening();
    error UnacceptedWithdrawal();

    event CanonicalInboxAppended(
        uint256 indexed eventId,
        uint256 kind,
        address indexed owner,
        uint256 tokenIndex,
        uint256 amount,
        uint256 referenceId
    );
    event ZkTransitionPublished(
        uint256 indexed stateVersion, uint256 indexed tradeBatchId, uint256[13] publicSignals
    );

    constructor(
        address ruba_,
        address usdt_,
        address initialOwner,
        address initialOperator,
        address verifier_,
        address poseidon2_,
        uint256 poolKeyCommit_
    ) RubaVault(ruba_, usdt_, initialOwner, initialOperator) {
        if (verifier_.code.length == 0 || poseidon2_.code.length == 0) revert InvalidAddress();
        if (poolKeyCommit_ == 0 || poolKeyCommit_ >= FIELD_MODULUS || block.chainid >= FIELD_MODULUS) {
            revert FieldElementOutOfRange();
        }
        verifier = IZkTransitionVerifier(verifier_);
        poseidon2 = IPoseidon2(poseidon2_);
        verifierCodeHash = verifier_.codehash;
        poseidonCodeHash = poseidon2_.codehash;
        poolKeyCommit = poolKeyCommit_;

        uint256 computedDomain = _hash(101, ZK_VERSION);
        computedDomain = _hash(computedDomain, block.chainid);
        computedDomain = _hash(computedDomain, uint256(uint160(address(this))));
        computedDomain = _hash(computedDomain, uint256(uint160(ruba_)));
        computedDomain = _hash(computedDomain, uint256(uint160(usdt_)));
        computedDomain = _hash(computedDomain, poolKeyCommit_);
        domain = computedDomain;

        uint256 accountsRoot = _emptyAccountsRoot();
        emptyAccountsRoot = accountsRoot;
        uint256 poolHash = 103;
        for (uint256 i; i < 6; ++i) {
            poolHash = _hash(poolHash, 0);
        }
        uint256 root = _hash(104, computedDomain);
        root = _hash(root, accountsRoot);
        root = _hash(root, poolHash);
        root = _hash(root, 0);
        root = _hash(root, 1);
        root = _hash(root, poolKeyCommit_);
        genesisStateRoot = bytes32(root);
        stateRoot = bytes32(root);
    }

    function proofMode() external pure returns (string memory) {
        return "groth16-bn254-v2";
    }

    function withdrawalMode() external pure returns (string memory) {
        return "proven-reservation-v1";
    }

    function transitions(uint256 version) external view returns (uint256[13] memory) {
        return _transitions[version];
    }

    function publishBatch(Batch calldata) external pure override {
        revert LegacyPublicationDisabled();
    }

    function publishSignedBatch(Batch calldata, uint256, uint256, bytes calldata) external pure override {
        revert LegacyPublicationDisabled();
    }

    function withdraw(Withdrawal calldata, bytes calldata) external pure override {
        revert LegacyWithdrawalDisabled();
    }

    /// @dev V2 uses ordered Poseidon membership, never the historical Keccak path.
    function verifyReceipt(uint256, bytes32, bytes32[] calldata) external pure override returns (bool) {
        revert LegacyPublicationDisabled();
    }

    function privateOperationDigest(uint256 commitment) public view returns (bytes32) {
        _requireField(commitment);
        return _typedDigest("RubaZkOperation", keccak256(abi.encode(PRIVATE_OPERATION_TYPEHASH, commitment)));
    }

    function timedOperationDigest(uint256 commitment, uint256 deadline) public view returns (bytes32) {
        _requireField(commitment);
        return _typedDigest(
            "RubaZkOperation", keccak256(abi.encode(TIMED_OPERATION_TYPEHASH, commitment, deadline))
        );
    }

    /// A 97-byte signature carries the owner's deadline in its first word. The proof
    /// does not cover signatures, so the deadline needs no circuit change.
    function _operationSigner(OperationMetadata calldata op) private view returns (address) {
        if (op.signature.length != 97) return ECDSA.recover(privateOperationDigest(op.commitment), op.signature);
        uint256 deadline = uint256(bytes32(op.signature[:32]));
        if (block.timestamp > deadline) revert OperationExpired();
        return ECDSA.recover(timedOperationDigest(op.commitment, deadline), op.signature[32:]);
    }

    function zkPublicationDigest(uint256[13] calldata signals, uint256 deadline, uint256 epoch)
        public
        view
        returns (bytes32)
    {
        return _typedDigest(
            "RubaZkPublication",
            keccak256(abi.encode(ZK_PUBLICATION_TYPEHASH, keccak256(abi.encode(signals)), deadline, epoch))
        );
    }

    /// @dev The retired operator-permit entry point cannot bypass proof-only publication.
    function publishZkTransition(
        uint256[13] calldata,
        OperationMetadata[8] calldata,
        AccountDA[8] calldata,
        PoolDA calldata,
        Groth16Proof calldata,
        PublicationAuthorization calldata
    ) external pure {
        revert LegacyPublicationDisabled();
    }

    /// @notice Anyone may publish a valid owner-authorized proof; no operator permit is required.
    function publishProvenTransition(
        uint256[13] calldata signals,
        OperationMetadata[8] calldata operations,
        AccountDA[8] calldata accountDA,
        PoolDA calldata poolDA,
        Groth16Proof calldata proof
    ) external nonReentrant {
        _publishProvenTransition(signals, operations, accountDA, poolDA, proof);
    }

    function publishProvenTransitionAndWithdraw(
        uint256[13] calldata signals,
        OperationMetadata[8] calldata operations,
        AccountDA[8] calldata accountDA,
        PoolDA calldata poolDA,
        Groth16Proof calldata proof,
        ProvenWithdrawal calldata withdrawal
    ) external nonReentrant {
        _publishProvenTransition(signals, operations, accountDA, poolDA, proof);
        _withdrawProven(withdrawal);
    }

    function withdrawProven(ProvenWithdrawal calldata withdrawal) external nonReentrant {
        _withdrawProven(withdrawal);
    }

    function _publishProvenTransition(
        uint256[13] calldata signals,
        OperationMetadata[8] calldata operations,
        AccountDA[8] calldata accountDA,
        PoolDA calldata poolDA,
        Groth16Proof calldata proof
    ) private {
        _validateHeader(signals);
        (uint256 authDigest, uint256 consumedCursor, uint256 swaps, uint256 active) =
            _checkOperations(operations, signals[1]);
        if (
            authDigest != signals[10] || consumedCursor != signals[6] || active == 0
                || (signals[2] == 0 ? swaps != 0 : swaps != signals[8] - signals[7])
        ) revert InvalidOperationMetadata();
        if (_dataAvailabilityDigest(operations, accountDA, poolDA, signals[1]) != signals[11]) {
            revert InvalidDataAvailability();
        }

        bool valid;
        try verifier.verifyProof(proof.a, proof.b, proof.c, signals) returns (bool verified) {
            valid = verified;
        } catch {
            revert InvalidZkProof();
        }
        if (!valid) revert InvalidZkProof();

        for (uint256 i; i < 8; ++i) {
            OperationMetadata calldata op = operations[i];
            if (op.kind == 6) {
                if (withdrawalClaims[op.commitment].owner != address(0)) revert InvalidWithdrawalOpening();
                withdrawalClaims[op.commitment] = WithdrawalClaim(op.owner, op.slot, signals[1]);
            }
        }

        stateVersion = signals[1];
        stateRoot = bytes32(signals[4]);
        inboxCursor = signals[6];
        nextTradeId = signals[8];
        _transitions[signals[1]] = signals;
        if (signals[2] == 1) {
            uint256 batchId = ++lastBatchId;
            lastTradeId = signals[8] - 1;
            Batch memory batch = Batch(
                batchId, bytes32(signals[3]), bytes32(signals[4]), bytes32(signals[9]), signals[7], swaps
            );
            batches[batchId] = batch;
            emit BatchPublished(
                batchId,
                batch.previousStateRoot,
                batch.newStateRoot,
                batch.receiptsRoot,
                batch.firstTradeId,
                batch.tradeCount
            );
        }
        emit ZkTransitionPublished(signals[1], lastBatchId, signals);
    }

    function _withdrawProven(ProvenWithdrawal calldata request) private {
        _requireSupportedToken(request.token);
        if (msg.sender != request.account) revert UnauthorizedAccount();
        if (request.amount == 0 || request.amount >= (uint256(1) << 96)) revert InvalidAmount();
        if (
            request.nonce > type(uint64).max || request.spendNonce > type(uint64).max
                || request.nonce != request.spendNonce || request.salt == 0
        ) revert InvalidWithdrawalOpening();
        _requireField(request.salt);
        if (withdrawalsPaused[request.token]) revert TokenWithdrawalsPaused();
        uint256 slotPlusOne = ownerSlotPlusOne[request.account];
        if (slotPlusOne == 0) revert InvalidRegistration();
        uint256 slot = slotPlusOne - 1;
        uint256 commitment = _hash(105, domain);
        commitment = _hash(commitment, 6);
        commitment = _hash(commitment, slot);
        commitment = _hash(commitment, uint256(uint160(request.account)));
        commitment = _hash(commitment, request.spendNonce);
        commitment = _hash(commitment, request.token == ruba ? 0 : 1);
        commitment = _hash(commitment, request.amount);
        commitment = _hash(commitment, request.nonce);
        commitment = _hash(commitment, 0);
        commitment = _hash(commitment, request.salt);
        WithdrawalClaim storage claim = withdrawalClaims[commitment];
        if (claim.owner != request.account || claim.slot != slot || claim.stateVersion == 0) {
            revert UnacceptedWithdrawal();
        }
        if (spentWithdrawalCommitments[commitment] || usedWithdrawalNonces[request.account][request.nonce]) {
            revert WithdrawalAlreadyUsed();
        }
        spentWithdrawalCommitments[commitment] = true;
        usedWithdrawalNonces[request.account][request.nonce] = true;
        IERC20(request.token).safeTransfer(request.account, request.amount);
        emit Withdrawn(request.account, request.token, request.amount, request.nonce, 0);
        _recordPayout(request.account, request.token, request.amount, request.nonce);
    }

    function verifyZkReceipt(uint256 batchId, uint256 tradeId, uint256 leaf, uint256[2] calldata siblings)
        external
        view
        returns (bool)
    {
        if (batchId == 0 || batchId > lastBatchId || leaf >= FIELD_MODULUS) return false;
        Batch storage batch = batches[batchId];
        if (tradeId < batch.firstTradeId || tradeId >= batch.firstTradeId + batch.tradeCount) return false;
        uint256 node = leaf;
        uint256 index = tradeId - batch.firstTradeId;
        for (uint256 i; i < 2; ++i) {
            if (siblings[i] >= FIELD_MODULUS) return false;
            node = (index & 1) == 0 ? _hash(node, siblings[i]) : _hash(siblings[i], node);
            index >>= 1;
        }
        return bytes32(node) == batch.receiptsRoot;
    }

    function _validateHeader(uint256[13] calldata signals) private view {
        for (uint256 i; i < 13; ++i) {
            _requireField(signals[i]);
        }
        if (
            signals[0] != domain || signals[1] != stateVersion + 1 || signals[2] > 1
                || signals[3] != uint256(stateRoot) || signals[5] != inboxCursor || signals[7] != nextTradeId
                || signals[12] != poolKeyCommit || signals[5] > type(uint64).max || signals[6] > type(uint64).max
                || signals[7] > type(uint64).max || signals[8] > type(uint64).max
        ) revert InvalidZkTransition();
        if (signals[2] == 0) {
            if (signals[8] != signals[7] || signals[9] != 0) revert InvalidZkTransition();
        } else if (
            signals[8] < signals[7] + MIN_ZK_TRADES_PER_BATCH
                || signals[8] > signals[7] + MAX_ZK_TRADES_PER_BATCH || signals[9] == 0
        ) {
            revert InvalidZkTransition();
        }
    }

    function _checkOperations(OperationMetadata[8] calldata operations, uint256 version)
        private
        returns (uint256 digest, uint256 cursor, uint256 swaps, uint256 active)
    {
        digest = _hash(_hash(106, domain), version);
        cursor = inboxCursor;
        bool padding;
        for (uint256 i; i < 8; ++i) {
            OperationMetadata calldata op = operations[i];
            _requireField(op.commitment);
            _requireField(op.eventId);
            _requireField(op.token);
            _requireField(op.amount);
            _requireField(op.referenceId);
            if (op.kind == 0) {
                padding = true;
                if (
                    op.slot != 0 || op.owner != address(0) || op.commitment != 0 || op.eventId != 0
                        || op.token != 0 || op.amount != 0 || op.referenceId != 0 || op.signature.length != 0
                ) revert InvalidOperationMetadata();
            } else {
                if (padding || op.kind > 7 || op.slot >= 16 || op.owner == address(0)) {
                    revert InvalidOperationMetadata();
                }
                ++active;
                if (op.kind == 1) {
                    if (!whitelist[op.owner]) revert NotWhitelisted();
                    if (ownerSlotPlusOne[op.owner] != 0 || slotOwners[op.slot] != address(0)) {
                        revert InvalidRegistration();
                    }
                    ownerSlotPlusOne[op.owner] = op.slot + 1;
                    slotOwners[op.slot] = op.owner;
                } else if (ownerSlotPlusOne[op.owner] != op.slot + 1 || slotOwners[op.slot] != op.owner) {
                    revert InvalidRegistration();
                }
                if (op.kind == 3 || op.kind == 4) {
                    if (marketPaused) revert MarketPaused();
                    if (!whitelist[op.owner]) revert NotWhitelisted();
                }

                if (op.kind == 2 || op.kind == 7) {
                    InboxMessage storage message = inbox[++cursor];
                    if (
                        op.signature.length != 0 || op.eventId != cursor || message.kind != op.kind
                            || message.owner != op.owner || message.tokenIndex != op.token
                            || message.amount != op.amount || message.referenceId != op.referenceId
                    ) revert InvalidInboxMessage();
                } else {
                    if (op.eventId != 0 || op.token != 0 || op.amount != 0 || op.referenceId != 0) {
                        revert InvalidOperationMetadata();
                    }
                    if (_operationSigner(op) != op.owner) {
                        revert InvalidOperationAuthorization();
                    }
                }
                if (op.kind == 3) ++swaps;
            }
            digest = _hash(digest, op.kind);
            digest = _hash(digest, op.slot);
            digest = _hash(digest, uint256(uint160(op.owner)));
            digest = _hash(digest, op.commitment);
            digest = _hash(digest, op.eventId);
            digest = _hash(digest, op.token);
            digest = _hash(digest, op.amount);
            digest = _hash(digest, op.referenceId);
        }
    }

    function _dataAvailabilityDigest(
        OperationMetadata[8] calldata operations,
        AccountDA[8] calldata accountDA,
        PoolDA calldata poolDA,
        uint256 version
    ) private view returns (uint256 digest) {
        digest = _hash(_hash(107, domain), version);
        for (uint256 i; i < 8; ++i) {
            AccountDA calldata record = accountDA[i];
            if (
                record.kind != operations[i].kind || record.slot != operations[i].slot
                    || record.owner != operations[i].owner
            ) {
                revert InvalidDataAvailability();
            }
            _requireField(record.newLeaf);
            digest = _hash(digest, record.kind);
            digest = _hash(digest, record.slot);
            digest = _hash(digest, uint256(uint160(record.owner)));
            digest = _hash(digest, record.newLeaf);
            for (uint256 j; j < 7; ++j) {
                _requireField(record.ciphertext[j]);
                if (record.kind == 0 && record.ciphertext[j] != 0) revert InvalidDataAvailability();
                digest = _hash(digest, record.ciphertext[j]);
            }
            if (record.kind == 0 && record.newLeaf != 0) revert InvalidDataAvailability();
        }
        _requireField(poolDA.poolHash);
        digest = _hash(digest, poolDA.poolHash);
        for (uint256 i; i < 6; ++i) {
            _requireField(poolDA.poolCiphertext[i]);
            digest = _hash(digest, poolDA.poolCiphertext[i]);
        }
    }

    function _afterDeposit(uint256 depositId, address account, address token, uint256 amount)
        internal
        override
    {
        // Bound both individual and outstanding canonical credits to the circuit's 96-bit range.
        uint256 maximum = (uint256(1) << 96) - 1;
        uint256 exposure = _inboxExposure[token];
        if (amount > maximum || amount > maximum - exposure) revert InvalidAmount();
        _inboxExposure[token] = exposure + amount;
        _appendInbox(2, account, token, amount, depositId);
    }

    function _afterWithdrawal(Withdrawal calldata request) internal override {
        _recordPayout(request.account, request.token, request.amount, request.nonce);
    }

    function _checkDepositAccess(address account) internal view override {
        if (marketPaused) revert MarketPaused();
        if (!whitelist[account]) revert NotWhitelisted();
        if (ownerSlotPlusOne[account] == 0) revert InvalidRegistration();
    }

    function _recordPayout(address account, address token, uint256 amount, uint256 nonce) private {
        uint256 exposure = _inboxExposure[token];
        _inboxExposure[token] = amount >= exposure ? 0 : exposure - amount;
        _appendInbox(7, account, token, amount, nonce);
    }

    function _appendInbox(uint256 kind, address account, address token, uint256 amount, uint256 referenceId)
        private
    {
        uint256 eventId = nextInboxEventId++;
        uint256 tokenIndex = token == ruba ? 0 : 1;
        inbox[eventId] = InboxMessage(kind, account, tokenIndex, amount, referenceId);
        emit CanonicalInboxAppended(eventId, kind, account, tokenIndex, amount, referenceId);
    }

    function _emptyAccountsRoot() private view returns (uint256) {
        uint256[16] memory nodes;
        for (uint256 slot; slot < 16; ++slot) {
            uint256 leaf = _hash(102, slot);
            for (uint256 field; field < 9; ++field) {
                leaf = _hash(leaf, 0);
            }
            nodes[slot] = leaf;
        }
        for (uint256 width = 16; width > 1; width >>= 1) {
            for (uint256 i; i < width / 2; ++i) {
                nodes[i] = _hash(nodes[i * 2], nodes[i * 2 + 1]);
            }
        }
        return nodes[0];
    }

    function _typedDigest(string memory name, bytes32 structHash) private view returns (bytes32) {
        bytes32 separator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256("2"), block.chainid, address(this))
        );
        return keccak256(abi.encodePacked(hex"1901", separator, structHash));
    }

    function _hash(uint256 left, uint256 right) private view returns (uint256 value) {
        value = poseidon2.poseidon([left, right]);
        _requireField(value);
    }

    function _requireField(uint256 value) private pure {
        if (value >= FIELD_MODULUS) revert FieldElementOutOfRange();
    }
}
