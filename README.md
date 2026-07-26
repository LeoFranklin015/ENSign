
# ENSign

> Your ENS name is the wallet.

<img width="1438" height="599" alt="Screenshot 2026-05-03 at 7 20 12 PM" src="https://github.com/user-attachments/assets/835e6a66-6de3-4a78-a32a-f0160c171094" />

**Demo:** [ensign.app](https://ensign.app) · [pitch deck](https://ensign.app/pitch)

Pick a subname under `ensign.eth`, approve with passkey, and one transaction
later you have a passkey-controlled ERC-4337 smart account at a deterministic
address. No seed phrase, no extension, no gas. The wallet doesn't exist
independently of the name. The name *is* the wallet.

And because the name is the wallet, getting back in is a question about
names too. Guardians are ENS names, not addresses.

---

## The inversion

**The address derives from the name, not the other way around.**

Today every wallet starts as a hash. The name, if you bother, gets bolted on
later as a label that points back at the address. DNS solved this exact problem
in 1983: names became the web, IPs became plumbing. Wallets never got that
treatment. ENS V2 is what finally makes the name itself the foundation, not
the decoration.

In ENSign, `leo.ensign.eth` is not a label on `0xa742…f3d7`. It's the other
way around. The address is derived from the name. The passkey that signs for
it lives inside the name's resolver record. A guardian is a subname under
`recovery.leo.ensign.eth`. Every load-bearing piece of state is on-chain ENS
data. There's no parallel database, no off-chain index, no signed-message
theater.

---

## What it does

**Claim a name.** Pick `leo.ensign.eth`, approve with your face. One
transaction mints the ENS subname and deploys a sponsored ERC-4337 smart
account at a deterministic address derived from the name itself. The user
never sees ETH, never bridges, never installs anything.

**Sign in anywhere.** A drag-to-bookmark bookmarklet injects a hosted sign-in
iframe and an EIP-1193 provider shim into any page. Aave, Uniswap testnet,
anything that calls `window.ethereum` sees a real EVM signer. Behind it, the
ENSign smart account, signing userOps with the passkey and broadcasting
through Pimlico.

**Recover by name.** A passkey wallet has nothing to write down — that's the
point, and the risk. Nominate M-of-N guardians as ENS names, or an email
address. Lose the device and *anyone* can open your recovery link; guardians
approve by signing or by replying to an email. At threshold, a new passkey is
installed after a time-lock you can veto.

---

## How recovery works

```
ensign.eth
└── leo                              ← smart account, passkey-signed
    └── recovery                     ← guardian namespace
        ├── mom                      ← guardian · ENS-committed
        └── dad                    ← guardian · ENS-committed
```

Guardian subnames are real ENS records on `explorer.ens.dev`, not rows in a
database. That has a consequence worth stating plainly: a guardian who
**changes wallet keeps working**, because the manager resolves `ownerOf()`
live at verification time. A guardian whose name expires or is burned drops
out of the quorum by itself, failing closed.

### The lifecycle

| step | call | who |
| --- | --- | --- |
| 1 | `addOwnerAddress(manager)` | the account — opt-in, and revocable |
| 2 | `addRecovery(provider, commitment, delay)` | the account, once per guardian |
| 3 | `setRecoveryThreshold(m)` | the account |
| 4 | *device lost* — guardians sign or reply to an email | guardians |
| 5 | `requestRecovery(account, subject, approvals)` | **anyone** |
| 6 | `cancelRecoveryRequest(requestId)` | the account — the veto window |
| 7 | `executeRecoveryRequest(requestId)` | **anyone**, after the delay |

`subject` is the key being installed: 32 bytes for an address, 64 bytes for a
passkey public key. Steps 5 and 7 take an unrestricted caller on purpose — the
person recovering has lost their device and has no ETH, and a guardian is
doing a favour, not funding one. ENSign relays both.

### What a guardian cannot do

Recovery **only ever adds an owner** — `addOwnerPublicKey` or
`addOwnerAddress`. There is no path through the manager that moves funds,
removes an existing owner, or changes the threshold. A full quorum of
compromised guardians can put a key alongside yours; it cannot take yours
away, and it cannot spend while you still hold a device and can cancel.

Three further constraints are enforced on-chain:

- **Proofs are single-use.** Every approval is bound to the account's manager
  nonce, which increments on each request. Replay across requests reverts.
- **The time-lock is the max, not the min.** A request inherits the longest
  delay among the guardians who approved it, so one cautious guardian can't be
  routed around by faster ones.
- **Opt-in is checked up front.** `requestRecovery` reverts immediately if the
  manager isn't an owner, rather than failing after the delay — when the user
  can least afford it.

### Providers

The manager holds no verification logic. It stores an opaque `commitment` per
guardian and calls out to a stateless provider, so a new proof type is a new
contract, not a migration.

| provider | commitment | proof |
| --- | --- | --- |
| `ENSRecoveryProvider` | `abi.encode(registry, resource)` — a guardian's ENS name | EIP-712 signature from whoever owns that name *now*, or ERC-1271 |
| `ECDSARecoveryProvider` | `abi.encode(address)` — a backup EOA | EIP-712 signature over `Recover(account, nonce, subject)` |
| `ZkEmailRecoveryProvider` | `abi.encode(accountSalt, domainName)` | Groth16 proof of a DKIM-signed reply |

`resource` is deliberately not a `tokenId`: ENSv2 regenerates tokenIds on role
changes, while resources are stable for the life of the name.

The zkEmail path proves the guardian replied from a given domain without ever
putting their address on-chain, and binds the manager nonce into the signed
command so a reply can't be replayed. It verifies against a Groth16 verifier
we generated and deployed ourselves to match our prover — see
[`docs/SELF-HOST-ZKEMAIL.md`](docs/SELF-HOST-ZKEMAIL.md).

---

## Live on Sepolia

| component                   | address                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Parent name                 | [`ensign.eth`](https://explorer.ens.dev/ensign.eth/subnames)                                             |
| `ENSignRegistry`            | [`0xC68a…fFC0`](https://sepolia.etherscan.io/address/0xC68aAa219D06e38335E1aD3F74e85485BD38fFC0#code)    |
| `ENSignRecoveryManager`     | [`0xD952…5846`](https://sepolia.etherscan.io/address/0xD952928319e72c3F96eBD3e6398a8421f0865846#code)    |
| `ENSRecoveryProvider`       | [`0x8B1b…f15c`](https://sepolia.etherscan.io/address/0x8B1b7B3f634B4774F18101Ec15d24824b6E0f15c#code)    |
| `ECDSARecoveryProvider`     | [`0x97F9…Ebf5`](https://sepolia.etherscan.io/address/0x97F9EFfAF5399a637b98359cda3cBf7493a0Ebf5#code)    |
| `ZkEmailRecoveryProvider`   | [`0x8AD2…7E90`](https://sepolia.etherscan.io/address/0x8AD2E487a82fb14C689a5D85f6FE53EF7B427E90#code)    |
| `EmailProofVerifier`        | [`0x3D39…69d6`](https://sepolia.etherscan.io/address/0x3D3935B3C030893f118a84C92C66dF1B9E4169d6#code)    |
| EntryPoint v0.8             | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`                                                             |

Built against the ENSv2 `sepolia-official-v1-20260525-r2` staging deployment.
Browse the live subnames on the [ENS explorer](https://explorer.ens.dev/ensign.eth/subnames).

---

## Run the recovery flow on-chain

A Foundry script that walks the full lifecycle against the live `ensign.eth`
Sepolia stack, no UI needed. It mints a fresh account, builds the guardian
namespace, collects two approvals, and installs a brand-new key.

```sh
cd contracts
export PRIVATE_KEY=0x...                     # EOA with REGISTRAR + Sepolia ETH for gas
export SEPOLIA_RPC_URL=https://...           # any Sepolia RPC
export RECOVERY_MANAGER=0xD952928319e72c3F96eBD3e6398a8421f0865846
export ENS_PROVIDER=0x8B1b7B3f634B4774F18101Ec15d24824b6E0f15c
forge script script/RecoveryDemo.s.sol:RecoveryDemo \
  --rpc-url $SEPOLIA_RPC_URL --broadcast --slow -vv
```

The script registers `rec<timestamp>.ensign.eth`, creates
`mom.recovery.rec<timestamp>.ensign.eth` and `ghadi.…` as ENS-committed
guardians at threshold 2 (delay 0, so the demo finishes in one run), has both
sign EIP-712 approvals for a new passkey, then submits `requestRecovery` and
`executeRecoveryRequest`. Guardian names and explorer links are printed at the
end so you can look them up.

---

## Tests

```sh
cd contracts && forge test --match-contract "Recovery|ZkEmail|RealEmail"
```

41 passing across four suites — manager semantics (16), the three providers
(11), zkEmail proof handling (13), and one test that pins a **real proof from
our self-hosted prover** and verifies it on-chain, so a circuit or verifier
mismatch fails in CI rather than in front of a user. A fifth suite forks
Sepolia and is skipped unless an RPC is configured.

---

## Stack

Foundry · Solidity 0.8.30 · Solady (`LibClone`, `WebAuthn`) ·
[`@ensdomains/contracts-v2`](https://github.com/ensdomains/contracts-v2) ·
ERC-4337 v0.8 · [zkEmail](https://prove.email) (Groth16, DKIM) ·
Next.js · TypeScript · viem · **Pimlico** bundler & paymaster.

---

## License

MIT.
