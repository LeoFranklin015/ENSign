// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { ReentrancyGuard } from "solady/utils/ReentrancyGuard.sol";

import { MultiOwnable } from "@account/MultiOwnable.sol";

import { IRecoveryProvider } from "./IRecoveryProvider.sol";

/// @title ENSignRecoveryManager
/// @notice M-of-N, time-locked recovery for ENSign smart accounts. A non-ownable,
///         non-upgradeable singleton: one deployment serves every account.
///
///         An account opts in by (1) adding this manager as a `MultiOwnable` owner
///         (`addOwnerAddress(manager)`) and (2) registering one or more recoveries —
///         `(provider, commitment, delay)` triples. Providers are stateless verifiers
///         (see {IRecoveryProvider}); this manager owns the commitments, the threshold,
///         and the per-account replay nonce.
///
///         Recovery is a two-step, time-locked flow:
///           1. `requestRecovery` verifies one proof per recovery for the account's
///              threshold of distinct recoveries — all over the same new-owner
///              `subject` at the current nonce — then queues a request with
///              `executeAt = now + max(delay)` among the approvers.
///           2. After the delay, anyone may call `executeRecoveryRequest`, which
///              installs the new owner on the account. During the window the account
///              itself may `cancelRecoveryRequest` (the veto).
contract ENSignRecoveryManager is ReentrancyGuard {

    using EnumerableSet for EnumerableSet.Bytes32Set;

    // ─────────────────────────────────────────── ERRORS ──────────────────────────────────────────

    error ENSignRecoveryManager_ZeroProvider();
    error ENSignRecoveryManager_ProviderNotContract(address provider);
    error ENSignRecoveryManager_EmptyCommitment();
    error ENSignRecoveryManager_RecoveryAlreadyAdded(bytes32 recoveryId);
    error ENSignRecoveryManager_RecoveryNotRegistered(bytes32 recoveryId);
    error ENSignRecoveryManager_DuplicateRecovery(bytes32 recoveryId);
    error ENSignRecoveryManager_InvalidThreshold(uint256 requested, uint256 count);
    error ENSignRecoveryManager_RemovalBelowThreshold(uint256 newCount, uint256 threshold);
    error ENSignRecoveryManager_InvalidApprovalCount(uint256 submitted, uint256 required);
    error ENSignRecoveryManager_ManagerNotAccountOwner(address account);
    error ENSignRecoveryManager_InvalidSubjectLength(uint256 length);
    error ENSignRecoveryManager_InvalidSubject(bytes subject);
    error ENSignRecoveryManager_SubjectAlreadyOwner(bytes subject);
    error ENSignRecoveryManager_RequestNotPending(bytes32 requestId);
    error ENSignRecoveryManager_RequestNotReady(bytes32 requestId, uint64 executeAt);
    error ENSignRecoveryManager_NotAccount(address caller, address account);

    // ─────────────────────────────────────────── TYPES ───────────────────────────────────────────

    /// @notice A registered recovery factor.
    struct Recovery {
        address provider;   // stateless verifier contract
        bytes commitment;   // provider-specific identity (e.g. abi.encode(registry, resource))
        uint32 delay;       // per-recovery time-lock in seconds
    }

    /// @notice One recovery's approval submitted to `requestRecovery`.
    struct Approval {
        bytes32 recoveryId;
        bytes proof;
    }

    /// @notice A queued recovery awaiting execution. `account == address(0)` = not present.
    struct RecoveryRequest {
        address account;
        uint64 executeAt;
        bytes subject;      // abi.encode(address) (32B) or abi.encode(x, y) (64B passkey)
    }

    // ─────────────────────────────────────────── STORAGE ─────────────────────────────────────────

    mapping(address account => EnumerableSet.Bytes32Set ids) internal _recoveryIds;
    mapping(address account => mapping(bytes32 recoveryId => Recovery recovery)) internal _recoveries;
    mapping(address account => uint256 threshold) internal _threshold; // 0 => default of 1
    mapping(address account => uint256 nonce) internal _nonce;
    mapping(bytes32 requestId => RecoveryRequest request) internal _requests;

    // ─────────────────────────────────────────── EVENTS ──────────────────────────────────────────

    event RecoveryAdded(address indexed account, bytes32 indexed recoveryId, address provider, uint32 delay);
    event RecoveryRemoved(address indexed account, bytes32 indexed recoveryId);
    event RecoveryThresholdChanged(address indexed account, uint256 oldThreshold, uint256 newThreshold);
    event RecoveryRequested(
        address indexed account, bytes32 indexed requestId, bytes32[] recoveryIds, bytes subject, uint64 executeAt
    );
    event RecoveryRequestExecuted(address indexed account, bytes32 indexed requestId, bytes subject);
    event RecoveryRequestCancelled(address indexed account, bytes32 indexed requestId);

    // ─────────────────────────────────────────── RECOVERY ADMIN ──────────────────────────────────
    // All admin functions act on `msg.sender` as the account: only the account itself
    // (via an owner-signed userOp) can change its own recovery configuration.

    /// @notice Register a recovery for the calling account.
    function addRecovery(
        address provider,
        bytes calldata commitment,
        uint32 delay
    ) external returns (bytes32 recoveryId) {
        if (provider == address(0)) revert ENSignRecoveryManager_ZeroProvider();
        if (provider.code.length == 0) revert ENSignRecoveryManager_ProviderNotContract(provider);
        if (commitment.length == 0) revert ENSignRecoveryManager_EmptyCommitment();

        recoveryId = computeRecoveryId(msg.sender, provider, commitment);
        if (!_recoveryIds[msg.sender].add(recoveryId)) {
            revert ENSignRecoveryManager_RecoveryAlreadyAdded(recoveryId);
        }
        _recoveries[msg.sender][recoveryId] = Recovery(provider, commitment, delay);

        emit RecoveryAdded(msg.sender, recoveryId, provider, delay);
    }

    /// @notice Unregister a recovery for the calling account. Rejected if it would drop
    ///         the count below the threshold, unless it removes the last one (full
    ///         opt-out, which also resets the threshold).
    function removeRecovery(bytes32 recoveryId) external {
        if (!_recoveryIds[msg.sender].remove(recoveryId)) {
            revert ENSignRecoveryManager_RecoveryNotRegistered(recoveryId);
        }
        uint256 newCount = _recoveryIds[msg.sender].length();
        uint256 threshold = recoveryThreshold(msg.sender);
        if (newCount > 0 && newCount < threshold) {
            revert ENSignRecoveryManager_RemovalBelowThreshold(newCount, threshold);
        }
        if (newCount == 0) _threshold[msg.sender] = 0;
        delete _recoveries[msg.sender][recoveryId];

        emit RecoveryRemoved(msg.sender, recoveryId);
    }

    /// @notice Set the calling account's approval threshold, bounded to `[1, count]`.
    function setRecoveryThreshold(uint256 threshold) external {
        uint256 count = _recoveryIds[msg.sender].length();
        if (threshold == 0 || threshold > count) {
            revert ENSignRecoveryManager_InvalidThreshold(threshold, count);
        }
        emit RecoveryThresholdChanged(msg.sender, recoveryThreshold(msg.sender), threshold);
        _threshold[msg.sender] = threshold;
    }

    // ─────────────────────────────────────────── EXECUTION ───────────────────────────────────────

    /// @notice Queue a recovery once the threshold of distinct recoveries have approved
    ///         the same new owner. Unrestricted caller — the proofs carry authorization.
    function requestRecovery(
        address account,
        bytes calldata subject,
        Approval[] calldata approvals
    ) external nonReentrant returns (bytes32 requestId) {
        uint256 required = recoveryThreshold(account);
        if (_recoveryIds[account].length() == 0 || approvals.length != required) {
            revert ENSignRecoveryManager_InvalidApprovalCount(approvals.length, required);
        }
        // Fail fast if the account never opted in (or later evicted the manager):
        // execution would revert after the delay, when the user can least afford it.
        if (!MultiOwnable(account).isOwnerAddress(address(this))) {
            revert ENSignRecoveryManager_ManagerNotAccountOwner(account);
        }
        _validateSubject(account, subject);

        uint256 currentNonce = _nonce[account];
        uint32 maxDelay;
        bytes32[] memory ids = new bytes32[](approvals.length);

        for (uint256 i; i < approvals.length; ++i) {
            bytes32 id = approvals[i].recoveryId;
            for (uint256 j; j < i; ++j) {
                if (ids[j] == id) revert ENSignRecoveryManager_DuplicateRecovery(id);
            }
            ids[i] = id;

            Recovery storage recovery = _recoveries[account][id];
            if (recovery.provider == address(0)) {
                revert ENSignRecoveryManager_RecoveryNotRegistered(id);
            }
            IRecoveryProvider(recovery.provider).verify(
                account, subject, currentNonce, recovery.commitment, approvals[i].proof
            );
            if (recovery.delay > maxDelay) maxDelay = recovery.delay;
        }

        _nonce[account] = currentNonce + 1; // proofs are single-use
        requestId = keccak256(abi.encode(account, subject, currentNonce));
        uint64 executeAt = uint64(block.timestamp) + maxDelay;
        _requests[requestId] = RecoveryRequest(account, executeAt, subject);

        emit RecoveryRequested(account, requestId, ids, subject, executeAt);
    }

    /// @notice Finalize a queued request whose delay has elapsed. Unrestricted caller.
    function executeRecoveryRequest(bytes32 requestId) external nonReentrant {
        RecoveryRequest memory request = _requests[requestId];
        if (request.account == address(0)) revert ENSignRecoveryManager_RequestNotPending(requestId);
        if (block.timestamp < request.executeAt) {
            revert ENSignRecoveryManager_RequestNotReady(requestId, request.executeAt);
        }

        delete _requests[requestId]; // checks-effects-interactions

        if (request.subject.length == 64) {
            (bytes32 x, bytes32 y) = abi.decode(request.subject, (bytes32, bytes32));
            MultiOwnable(request.account).addOwnerPublicKey(x, y);
        } else {
            MultiOwnable(request.account).addOwnerAddress(abi.decode(request.subject, (address)));
        }

        emit RecoveryRequestExecuted(request.account, requestId, request.subject);
    }

    /// @notice Abort a queued request. Callable only by the account it targets — this
    ///         is the veto during the time-lock window.
    function cancelRecoveryRequest(bytes32 requestId) external nonReentrant {
        RecoveryRequest storage request = _requests[requestId];
        if (request.account == address(0)) revert ENSignRecoveryManager_RequestNotPending(requestId);
        if (msg.sender != request.account) {
            revert ENSignRecoveryManager_NotAccount(msg.sender, request.account);
        }

        address account = request.account;
        delete _requests[requestId];
        emit RecoveryRequestCancelled(account, requestId);
    }

    // ─────────────────────────────────────────── VIEWS ───────────────────────────────────────────

    function computeRecoveryId(
        address account,
        address provider,
        bytes calldata commitment
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(account, provider, commitment));
    }

    function hasRecovery(address account, bytes32 recoveryId) external view returns (bool) {
        return _recoveryIds[account].contains(recoveryId);
    }

    function getRecovery(address account, bytes32 recoveryId) external view returns (Recovery memory) {
        return _recoveries[account][recoveryId];
    }

    function getRecoveries(address account) external view returns (Recovery[] memory recoveries) {
        bytes32[] memory ids = _recoveryIds[account].values();
        recoveries = new Recovery[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            recoveries[i] = _recoveries[account][ids[i]];
        }
    }

    function recoveryCount(address account) external view returns (uint256) {
        return _recoveryIds[account].length();
    }

    /// @notice Effective threshold: defaults to 1 when never set.
    function recoveryThreshold(address account) public view returns (uint256) {
        uint256 threshold = _threshold[account];
        return threshold == 0 ? 1 : threshold;
    }

    /// @notice Current replay nonce — bind this into proofs for `requestRecovery`.
    function recoveryNonce(address account) external view returns (uint256) {
        return _nonce[account];
    }

    function recoveryRequest(bytes32 requestId) external view returns (RecoveryRequest memory) {
        return _requests[requestId];
    }

    // ─────────────────────────────────────────── INTERNAL ────────────────────────────────────────

    /// @dev Fail-fast subject validation at request time, so a queued request cannot
    ///      silently revert at execution: 64 bytes = passkey (x, y); 32 bytes = a
    ///      canonical, non-zero EOA address. Rejects subjects already registered as
    ///      owners (best effort — the owner set can change during the delay).
    function _validateSubject(address account, bytes calldata subject) internal view {
        if (subject.length == 32) {
            uint256 word = uint256(bytes32(subject));
            if (word == 0 || word > type(uint160).max) {
                revert ENSignRecoveryManager_InvalidSubject(subject);
            }
        } else if (subject.length != 64) {
            revert ENSignRecoveryManager_InvalidSubjectLength(subject.length);
        }
        if (MultiOwnable(account).isOwnerBytes(subject)) {
            revert ENSignRecoveryManager_SubjectAlreadyOwner(subject);
        }
    }
}
