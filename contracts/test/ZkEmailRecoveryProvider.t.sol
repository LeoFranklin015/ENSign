// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { SmartAccount } from "../src/account/SmartAccount.sol";
import { SmartAccountFactory } from "../src/account/SmartAccountFactory.sol";
import { ENSignRecoveryManager } from "../src/recovery/ENSignRecoveryManager.sol";
import {
    ZkEmailRecoveryProvider,
    EmailProof,
    IZkEmailVerifier,
    IDKIMRegistry
} from "../src/recovery/providers/ZkEmailRecoveryProvider.sol";

/// @dev Mirrors zkEmail's own `MockGroth16Verifier` test double: the Groth16 check
///      is a pure pairing operation that can't be produced without a real email, so
///      unit tests stub it and exercise everything around it.
contract MockZkVerifier is IZkEmailVerifier {
    bool public accept = true;

    function setAccept(bool a) external {
        accept = a;
    }

    function verifyEmailProof(EmailProof memory) external view returns (bool) {
        return accept;
    }

    function commandBytes() external pure returns (uint256) {
        return 605;
    }
}

contract MockDKIMRegistry is IDKIMRegistry {
    mapping(bytes32 => bool) internal _valid;

    function setValid(string memory domain, bytes32 pkHash, bool v) external {
        _valid[keccak256(abi.encode(domain, pkHash))] = v;
    }

    function isDKIMPublicKeyHashValid(string memory domain, bytes32 pkHash) external view returns (bool) {
        return _valid[keccak256(abi.encode(domain, pkHash))];
    }
}

contract ZkEmailRecoveryProviderTest is Test {
    ZkEmailRecoveryProvider internal provider;
    MockZkVerifier internal zkVerifier;
    MockDKIMRegistry internal dkim;

    address internal constant ACCOUNT = address(0xACC0);
    address internal constant AUTHORIZER = address(0xA411);
    string internal constant DOMAIN = "gmail.com";
    // The real gmail.com DKIM key hash used across zkEmail's own test suite.
    bytes32 internal constant PK_HASH =
        0x0ea9c777dc7110e5a9e89b13f0cfc540e3845ba120b2b6dc24024d61488d4788;
    bytes32 internal constant ACCOUNT_SALT = keccak256("leo@example.com + accountCode");

    bytes internal subject = abi.encode(keccak256("new-qx"), keccak256("new-qy"));

    function setUp() public {
        zkVerifier = new MockZkVerifier();
        dkim = new MockDKIMRegistry();
        dkim.setValid(DOMAIN, PK_HASH, true);
        provider = new ZkEmailRecoveryProvider(zkVerifier, dkim, AUTHORIZER);
    }

    // ───────────────────────────── helpers ─────────────────────────────

    function _commitment() internal pure returns (bytes memory) {
        return abi.encode(ACCOUNT_SALT, DOMAIN);
    }

    function _proof(string memory command) internal view returns (bytes memory) {
        return abi.encode(
            EmailProof({
                domainName: DOMAIN,
                publicKeyHash: PK_HASH,
                timestamp: block.timestamp,
                maskedCommand: command,
                emailNullifier: keccak256("nullifier"),
                accountSalt: ACCOUNT_SALT,
                isCodeExist: true,
                proof: bytes("0")
            })
        );
    }

    function _goodProof(uint256 nonce) internal view returns (bytes memory) {
        return _proof(provider.expectedCommand(ACCOUNT, nonce, subject));
    }

    // ───────────────────────────── happy path ─────────────────────────────

    function test_verify_acceptsValidEmailProof() public view {
        provider.verify(ACCOUNT, subject, 0, _commitment(), _goodProof(0));
    }

    function test_expectedCommand_isHumanReadableAndBinding() public view {
        string memory command = provider.expectedCommand(ACCOUNT, 7, subject);
        // Shaped like zkEmail's deployed template so existing relayers can emit it.
        assertTrue(bytes(command).length > 0);
        assertEq(
            command,
            string.concat(
                "Recover account 0x000000000000000000000000000000000000acc0",
                " using recovery hash 0x",
                _hex(provider.recoveryHash(ACCOUNT, 7, subject))
            )
        );
    }

    function test_verify_acceptsChecksummedAddressCasing() public view {
        // Relayers may emit EIP-55 checksummed or uppercase hex; comparison is
        // case-insensitive so all forms verify.
        string memory shouted = _toUpperHexPortion(provider.expectedCommand(ACCOUNT, 0, subject));
        provider.verify(ACCOUNT, subject, 0, _commitment(), _proof(shouted));
    }

    // ───────────────────────────── binding / replay ─────────────────────────────

    function test_verify_rejectsWrongNonce() public {
        bytes memory staleProof = _goodProof(0);
        vm.expectRevert(); // command carries nonce 0, manager is at nonce 1
        provider.verify(ACCOUNT, subject, 1, _commitment(), staleProof);
    }

    function test_verify_rejectsWrongSubject() public {
        bytes memory otherSubject = abi.encode(keccak256("attacker-qx"), keccak256("attacker-qy"));
        bytes memory p = _goodProof(0);
        vm.expectRevert(); // email authorized a different key
        provider.verify(ACCOUNT, otherSubject, 0, _commitment(), p);
    }

    function test_verify_rejectsWrongAccount() public {
        bytes memory p = _goodProof(0);
        vm.expectRevert(); // email authorized a different account
        provider.verify(address(0xBEEF), subject, 0, _commitment(), p);
    }

    // ───────────────────────────── guardian identity ─────────────────────────────

    function test_verify_rejectsDifferentEmail() public {
        bytes memory otherEmail = abi.encode(keccak256("stranger@example.com"), DOMAIN);
        bytes memory p = _goodProof(0);
        vm.expectRevert(ZkEmailRecoveryProvider.ZkEmailRecoveryProvider_WrongGuardianEmail.selector);
        provider.verify(ACCOUNT, subject, 0, otherEmail, p);
    }

    function test_verify_rejectsDomainMismatch() public {
        bytes memory otherDomain = abi.encode(ACCOUNT_SALT, "evil.com");
        bytes memory p = _goodProof(0);
        vm.expectRevert(ZkEmailRecoveryProvider.ZkEmailRecoveryProvider_WrongDomain.selector);
        provider.verify(ACCOUNT, subject, 0, otherDomain, p);
    }

    // ───────────────────────────── DKIM + proof ─────────────────────────────

    function test_verify_rejectsUnregisteredDKIMKey() public {
        bytes memory p = _goodProof(0);
        dkim.setValid(DOMAIN, PK_HASH, false); // key revoked / never registered
        vm.expectRevert(
            abi.encodeWithSelector(
                ZkEmailRecoveryProvider.ZkEmailRecoveryProvider_InvalidDKIMKey.selector, DOMAIN, PK_HASH
            )
        );
        provider.verify(ACCOUNT, subject, 0, _commitment(), p);
    }

    function test_verify_rejectsFailingGroth16Proof() public {
        bytes memory p = _goodProof(0);
        zkVerifier.setAccept(false);
        vm.expectRevert(ZkEmailRecoveryProvider.ZkEmailRecoveryProvider_InvalidEmailProof.selector);
        provider.verify(ACCOUNT, subject, 0, _commitment(), p);
    }

    function test_verify_rejectsNonCanonicalCommitment() public {
        bytes memory padded = abi.encodePacked(_commitment(), uint8(0));
        bytes memory p = _goodProof(0);
        vm.expectRevert();
        provider.verify(ACCOUNT, subject, 0, padded, p);
    }

    function test_owner_exposedForDKIMRegistries() public view {
        // UserOverrideableDKIMRegistry resolves Ownable(msg.sender).owner().
        assertEq(provider.owner(), AUTHORIZER);
    }

    // ───────────────────────── integration with the manager ─────────────────────────

    function test_endToEnd_emailGuardianRecoversAccount() public {
        ENSignRecoveryManager manager = new ENSignRecoveryManager();
        SmartAccountFactory factory = new SmartAccountFactory(address(0x4337));
        (address ownerEOA,) = makeAddrAndKey("owner");
        bytes[] memory owners = new bytes[](1);
        owners[0] = abi.encode(ownerEOA);
        SmartAccount account = SmartAccount(payable(address(factory.createAccount(owners, 0))));

        vm.startPrank(ownerEOA);
        account.addOwnerAddress(address(manager));
        vm.stopPrank();

        vm.startPrank(address(account));
        bytes32 recoveryId = manager.addRecovery(address(provider), abi.encode(ACCOUNT_SALT, DOMAIN), 1 days);
        vm.stopPrank();

        // The email authorizes exactly this account, nonce, and new key.
        bytes32 newQx = keccak256("recovered-qx");
        bytes32 newQy = keccak256("recovered-qy");
        bytes memory newKey = abi.encode(newQx, newQy);
        string memory command = provider.expectedCommand(address(account), 0, newKey);

        ENSignRecoveryManager.Approval[] memory approvals = new ENSignRecoveryManager.Approval[](1);
        approvals[0] = ENSignRecoveryManager.Approval(recoveryId, _proof(command));

        bytes32 requestId = manager.requestRecovery(address(account), newKey, approvals);
        vm.warp(block.timestamp + 1 days);
        manager.executeRecoveryRequest(requestId);

        assertTrue(account.isOwnerPublicKey(newQx, newQy));

        // The same email proof cannot be replayed: the nonce advanced.
        vm.expectRevert();
        manager.requestRecovery(address(account), newKey, approvals);
    }

    // ───────────────────────────── local utils ─────────────────────────────

    function _hex(bytes32 value) internal pure returns (string memory) {
        bytes memory out = new bytes(64);
        for (uint256 i; i < 32; ++i) {
            uint8 b = uint8(value[i]);
            out[i * 2] = bytes1(uint8(b >> 4) < 10 ? 48 + (b >> 4) : 87 + (b >> 4));
            out[i * 2 + 1] = bytes1(uint8(b & 0x0f) < 10 ? 48 + (b & 0x0f) : 87 + (b & 0x0f));
        }
        return string(out);
    }

    function _toUpperHexPortion(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i; i < b.length; ++i) {
            uint8 c = uint8(b[i]);
            if (c >= 97 && c <= 102) b[i] = bytes1(c - 32); // a-f -> A-F
        }
        return string(b);
    }
}
