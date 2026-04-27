# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

JustanAccount is an EIP-4337 (Account Abstraction) and EIP-7702 (Delegation) compliant smart contract wallet system. It supports multi-owner authentication via both ECDSA and WebAuthn (passkeys), cross-chain operations, and deterministic deployment.

## Build Commands

```bash
# Install dependencies
make install

# Build contracts
make build

# Run all tests
make test

# Format code
make format

# Generate gas snapshot
make snapshot

# Start local Anvil instance
make anvil
```

## Testing

Tests use Foundry. Run with increased verbosity for debugging:
```bash
forge test -vvv
```

Run a specific test file:
```bash
forge test --match-path test/unit/TestWebAuthnValidation.t.sol -vvv
```

Run a specific test function:
```bash
forge test --match-test testValidateUserOp -vvv
```

CI uses `FOUNDRY_PROFILE=solx` which includes contract size reporting.

## Deployment

```bash
# Deploy to testnets
make deploy-sepolia
make deploy-base-sepolia

# Deploy to mainnets
make deploy-mainnet
make deploy-base-mainnet
make deploy-op-mainnet
make deploy-arb-mainnet
```

Requires `.env` file with RPC URLs and private keys (see `.env.example`).

## Architecture

### Core Contracts (src/)

**JustanAccount.sol** - Main account contract
- Implements EIP-4337 `BaseAccount` for user operation validation
- Supports both ECDSA (64/65 byte) and WebAuthn (passkey) signature validation
- `execute()` and `executeBatch()` for transaction execution
- `executeWithoutChainIdValidation()` for cross-chain replayable operations (requires `REPLAYABLE_NONCE_KEY = 9999`)
- Immutable state: entrypoint and factory addresses

**MultiOwnable.sol** - Owner management
- ERC-7201 namespaced storage at slot `0x548403af3b7bfc881040446090ff025838396ebf051dc219a19859cf4ef8e800`
- Two owner types: addresses (20 bytes) and WebAuthn public keys (64 bytes)
- Indexed owner storage with removal tracking

**JustanAccountFactory.sol** - Deterministic deployment
- Uses Solady's `LibClone` for minimal ERC-1967 proxy cloning
- CREATE2 salt: `keccak256(abi.encode(owners, nonce))`
- Same owners/nonce produces identical addresses across all chains

### Signature System

Signatures use a wrapper structure for multi-owner scenarios:
```solidity
struct SignatureWrapper {
    uint256 ownerIndex;    // Index of signing owner
    bytes signatureData;   // ECDSA signature or WebAuthn auth data
}
```

ERC-7739 compliance enables nested EIP-712 signatures with automatic detection via magic value `0x77390001`.

### Key Dependencies

- `@account-abstraction/` - EIP-4337 v0.8.0 reference implementation
- `@solady/` - WebAuthn, ECDSA, LibClone utilities
- `@openzeppelin/contracts/` - Standard interfaces

### EntryPoint

Uses ERC-4337 EntryPoint v0.8 at `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`.

## Test Structure

- `test/unit/` - Individual component tests (account, factory, multi-owner, signatures)
- `test/integration/` - Full workflow tests (4337, 7702, multi-owner flows)
- `test/utils/` - Testing utilities (ERC7739Utils)

## Configuration

- Solidity 0.8.30 (Prague EVM)
- Optimizer: 20,000 runs
- Line length: 120 characters
- Fuzz runs: 256
