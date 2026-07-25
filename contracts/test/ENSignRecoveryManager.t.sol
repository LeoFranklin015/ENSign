// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { SmartAccount } from "../src/account/SmartAccount.sol";
import { SmartAccountFactory } from "../src/account/SmartAccountFactory.sol";
import { ENSignRecoveryManager } from "../src/recovery/ENSignRecoveryManager.sol";
import { IRecoveryProvider } from "../src/recovery/IRecoveryProvider.sol";

/// @dev Deterministic mock: the proof must be `abi.encode(account, nonce, subject, commitment)`,
///      so a proof is inherently bound to the nonce — replay at a bumped nonce fails,
///      exactly like a real provider.
contract MockProvider is IRecoveryProvider {
    bool public reject;

    function setReject(bool r) external {
        reject = r;
    }

    function verify(
        address account,
        bytes calldata subject,
        uint256 nonce,
        bytes calldata commitment,
        bytes calldata proof
    ) external view {
        require(!reject, "MockProvider: rejected");
        require(
            keccak256(proof) == keccak256(abi.encode(account, nonce, subject, commitment)),
            "MockProvider: bad proof"
        );
    }
}

contract ENSignRecoveryManagerTest is Test {
    ENSignRecoveryManager internal manager;
    MockProvider internal providerA;
    MockProvider internal providerB;
    SmartAccountFactory internal factory;
    SmartAccount internal account;

    address internal constant ENTRYPOINT = address(0x4337);
    address internal ownerEOA;
    uint256 internal ownerPk;

    bytes internal commitmentA = abi.encode(uint256(0xAAAA));
    bytes internal commitmentB = abi.encode(uint256(0xBBBB));

    // The new passkey installed by recovery.
    bytes32 internal constant NEW_QX = keccak256("new-qx");
    bytes32 internal constant NEW_QY = keccak256("new-qy");

    function setUp() public {
        manager = new ENSignRecoveryManager();
        providerA = new MockProvider();
        providerB = new MockProvider();
        factory = new SmartAccountFactory(ENTRYPOINT);

        (ownerEOA, ownerPk) = makeAddrAndKey("owner");
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(ownerEOA);
        account = SmartAccount(payable(address(factory.createAccount(owners, 0))));

        // Opt in: the account adds the manager as an owner.
        vm.prank(ownerEOA);
        account.addOwnerAddress(address(manager));
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _addRecovery(MockProvider p, bytes memory commitment, uint32 delay) internal returns (bytes32) {
        vm.prank(address(account));
        return manager.addRecovery(address(p), commitment, delay);
    }

    function _proof(bytes memory subject, uint256 nonce, bytes memory commitment)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(address(account), nonce, subject, commitment);
    }

    function _passkeySubject() internal pure returns (bytes memory) {
        return abi.encode(NEW_QX, NEW_QY);
    }

    function _requestWithTwo(bytes memory subject) internal returns (bytes32 requestId) {
        bytes32 idA = _addRecovery(providerA, commitmentA, 1 days);
        bytes32 idB = _addRecovery(providerB, commitmentB, 2 days);
        vm.prank(address(account));
        manager.setRecoveryThreshold(2);

        uint256 nonce = manager.recoveryNonce(address(account));
        ENSignRecoveryManager.Approval[] memory approvals = new ENSignRecoveryManager.Approval[](2);
        approvals[0] = ENSignRecoveryManager.Approval(idA, _proof(subject, nonce, commitmentA));
        approvals[1] = ENSignRecoveryManager.Approval(idB, _proof(subject, nonce, commitmentB));

        requestId = manager.requestRecovery(address(account), subject, approvals);
    }

    // ───────────────────────────── admin ─────────────────────────────

    function test_addRecovery_registers() public {
        bytes32 id = _addRecovery(providerA, commitmentA, 1 days);
        assertTrue(manager.hasRecovery(address(account), id));
        assertEq(manager.recoveryCount(address(account)), 1);
        ENSignRecoveryManager.Recovery memory r = manager.getRecovery(address(account), id);
        assertEq(r.provider, address(providerA));
        assertEq(r.delay, 1 days);
    }

    function test_addRecovery_rejectsNonContractProvider() public {
        vm.prank(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(
                ENSignRecoveryManager.ENSignRecoveryManager_ProviderNotContract.selector, ownerEOA
            )
        );
        manager.addRecovery(ownerEOA, commitmentA, 0);
    }

    function test_addRecovery_rejectsDuplicate() public {
        _addRecovery(providerA, commitmentA, 1 days);
        vm.prank(address(account));
        vm.expectRevert();
        manager.addRecovery(address(providerA), commitmentA, 5 days); // same (provider, commitment)
    }

    function test_removeRecovery_cannotDropBelowThreshold() public {
        bytes32 idA = _addRecovery(providerA, commitmentA, 0);
        _addRecovery(providerB, commitmentB, 0);
        vm.prank(address(account));
        manager.setRecoveryThreshold(2);

        vm.prank(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(
                ENSignRecoveryManager.ENSignRecoveryManager_RemovalBelowThreshold.selector, 1, 2
            )
        );
        manager.removeRecovery(idA);
    }

    function test_removeRecovery_fullOptOutResetsThreshold() public {
        bytes32 idA = _addRecovery(providerA, commitmentA, 0);
        vm.startPrank(address(account));
        manager.setRecoveryThreshold(1);
        manager.removeRecovery(idA); // count -> 0: allowed, threshold resets
        vm.stopPrank();
        assertEq(manager.recoveryCount(address(account)), 0);
        assertEq(manager.recoveryThreshold(address(account)), 1); // back to default
    }

    function test_setRecoveryThreshold_bounds() public {
        _addRecovery(providerA, commitmentA, 0);
        vm.prank(address(account));
        vm.expectRevert(
            abi.encodeWithSelector(ENSignRecoveryManager.ENSignRecoveryManager_InvalidThreshold.selector, 2, 1)
        );
        manager.setRecoveryThreshold(2);
    }

    // ───────────────────────────── request ─────────────────────────────

    function test_requestRecovery_happyPath_maxDelayWins() public {
        bytes32 requestId = _requestWithTwo(_passkeySubject());
        ENSignRecoveryManager.RecoveryRequest memory req = manager.recoveryRequest(requestId);
        assertEq(req.account, address(account));
        assertEq(req.executeAt, uint64(block.timestamp) + 2 days); // max(1 days, 2 days)
        assertEq(manager.recoveryNonce(address(account)), 1);      // bumped
    }

    function test_requestRecovery_rejectsWrongApprovalCount() public {
        bytes32 idA = _addRecovery(providerA, commitmentA, 0);
        _addRecovery(providerB, commitmentB, 0);
        vm.prank(address(account));
        manager.setRecoveryThreshold(2);

        ENSignRecoveryManager.Approval[] memory one = new ENSignRecoveryManager.Approval[](1);
        one[0] = ENSignRecoveryManager.Approval(idA, _proof(_passkeySubject(), 0, commitmentA));
        vm.expectRevert(
            abi.encodeWithSelector(ENSignRecoveryManager.ENSignRecoveryManager_InvalidApprovalCount.selector, 1, 2)
        );
        manager.requestRecovery(address(account), _passkeySubject(), one);
    }

    function test_requestRecovery_rejectsDuplicateApproval() public {
        bytes32 idA = _addRecovery(providerA, commitmentA, 0);
        _addRecovery(providerB, commitmentB, 0);
        vm.prank(address(account));
        manager.setRecoveryThreshold(2);

        ENSignRecoveryManager.Approval[] memory approvals = new ENSignRecoveryManager.Approval[](2);
        approvals[0] = ENSignRecoveryManager.Approval(idA, _proof(_passkeySubject(), 0, commitmentA));
        approvals[1] = ENSignRecoveryManager.Approval(idA, _proof(_passkeySubject(), 0, commitmentA));
        vm.expectRevert(
            abi.encodeWithSelector(ENSignRecoveryManager.ENSignRecoveryManager_DuplicateRecovery.selector, idA)
        );
        manager.requestRecovery(address(account), _passkeySubject(), approvals);
    }

    function test_requestRecovery_rejectsBadProof() public {
        bytes32 idA = _addRecovery(providerA, commitmentA, 0);
        ENSignRecoveryManager.Approval[] memory approvals = new ENSignRecoveryManager.Approval[](1);
        approvals[0] = ENSignRecoveryManager.Approval(idA, bytes("garbage"));
        vm.expectRevert("MockProvider: bad proof");
        manager.requestRecovery(address(account), _passkeySubject(), approvals);
    }

    function test_requestRecovery_proofsAreSingleUse() public {
        bytes32 idA = _addRecovery(providerA, commitmentA, 0);
        bytes memory subject = _passkeySubject();
        ENSignRecoveryManager.Approval[] memory approvals = new ENSignRecoveryManager.Approval[](1);
        approvals[0] = ENSignRecoveryManager.Approval(idA, _proof(subject, 0, commitmentA));

        manager.requestRecovery(address(account), subject, approvals);
        // Same proofs again: nonce is now 1, proof binds nonce 0 → provider rejects.
        vm.expectRevert("MockProvider: bad proof");
        manager.requestRecovery(address(account), subject, approvals);
    }

    function test_requestRecovery_failsFastIfManagerNotOwner() public {
        bytes32 idA = _addRecovery(providerA, commitmentA, 0);
        // Account evicts the manager.
        vm.prank(ownerEOA);
        account.removeOwnerAtIndex(1, abi.encode(address(manager)));

        ENSignRecoveryManager.Approval[] memory approvals = new ENSignRecoveryManager.Approval[](1);
        approvals[0] = ENSignRecoveryManager.Approval(idA, _proof(_passkeySubject(), 0, commitmentA));
        vm.expectRevert(
            abi.encodeWithSelector(
                ENSignRecoveryManager.ENSignRecoveryManager_ManagerNotAccountOwner.selector, address(account)
            )
        );
        manager.requestRecovery(address(account), _passkeySubject(), approvals);
    }

    function test_requestRecovery_validatesSubject() public {
        bytes32 idA = _addRecovery(providerA, commitmentA, 0);
        ENSignRecoveryManager.Approval[] memory approvals = new ENSignRecoveryManager.Approval[](1);

        // Bad length.
        bytes memory bad = hex"deadbeef";
        approvals[0] = ENSignRecoveryManager.Approval(idA, _proof(bad, 0, commitmentA));
        vm.expectRevert(
            abi.encodeWithSelector(ENSignRecoveryManager.ENSignRecoveryManager_InvalidSubjectLength.selector, 4)
        );
        manager.requestRecovery(address(account), bad, approvals);

        // Dirty upper bits in a 32-byte subject.
        bytes memory dirty = abi.encode(uint256(type(uint160).max) + 1);
        approvals[0] = ENSignRecoveryManager.Approval(idA, _proof(dirty, 0, commitmentA));
        vm.expectRevert(
            abi.encodeWithSelector(ENSignRecoveryManager.ENSignRecoveryManager_InvalidSubject.selector, dirty)
        );
        manager.requestRecovery(address(account), dirty, approvals);

        // Already an owner.
        bytes memory existing = abi.encode(ownerEOA);
        approvals[0] = ENSignRecoveryManager.Approval(idA, _proof(existing, 0, commitmentA));
        vm.expectRevert(
            abi.encodeWithSelector(ENSignRecoveryManager.ENSignRecoveryManager_SubjectAlreadyOwner.selector, existing)
        );
        manager.requestRecovery(address(account), existing, approvals);
    }

    // ───────────────────────────── execute / cancel ─────────────────────────────

    function test_executeRecoveryRequest_installsPasskeyAfterDelay() public {
        bytes32 requestId = _requestWithTwo(_passkeySubject());

        vm.expectRevert(); // not ready yet
        manager.executeRecoveryRequest(requestId);

        vm.warp(block.timestamp + 2 days);
        manager.executeRecoveryRequest(requestId);

        assertTrue(account.isOwnerPublicKey(NEW_QX, NEW_QY));
        // Request consumed.
        assertEq(manager.recoveryRequest(requestId).account, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(ENSignRecoveryManager.ENSignRecoveryManager_RequestNotPending.selector, requestId)
        );
        manager.executeRecoveryRequest(requestId);
    }

    function test_executeRecoveryRequest_installsEOA() public {
        address newOwner = makeAddr("backup");
        bytes32 requestId = _requestWithTwo(abi.encode(newOwner));
        vm.warp(block.timestamp + 2 days);
        manager.executeRecoveryRequest(requestId);
        assertTrue(account.isOwnerAddress(newOwner));
    }

    function test_cancelRecoveryRequest_vetoesDuringWindow() public {
        bytes32 requestId = _requestWithTwo(_passkeySubject());

        // Only the account can cancel.
        vm.expectRevert(
            abi.encodeWithSelector(
                ENSignRecoveryManager.ENSignRecoveryManager_NotAccount.selector, address(this), address(account)
            )
        );
        manager.cancelRecoveryRequest(requestId);

        vm.prank(address(account));
        manager.cancelRecoveryRequest(requestId);

        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(
            abi.encodeWithSelector(ENSignRecoveryManager.ENSignRecoveryManager_RequestNotPending.selector, requestId)
        );
        manager.executeRecoveryRequest(requestId);
        assertFalse(account.isOwnerPublicKey(NEW_QX, NEW_QY));
    }
}
