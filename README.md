
# ENSign

> Your ENS name is the wallet.

<img width="1438" height="599" alt="Screenshot 2026-05-03 at 7 20 12 PM" src="https://github.com/user-attachments/assets/835e6a66-6de3-4a78-a32a-f0160c171094" />

**Demo:** [ensign.app](https://ensign.app) · [pitch deck](https://ensign.app/pitch)

Pick a subname under `ensign.eth`, approve with passkey, and one transaction
later you have a passkey-controlled ERC-4337 smart account at a deterministic
address. No seed phrase, no extension, no gas. The wallet doesn't exist
independently of the name. The name *is* the wallet.


Sign in to any dApp by typing your name. Spawn AI agents as sub-subnames with
on-chain capabilities, revocable by ENS hierarchy.

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
it lives inside the name's resolver record. The agent's permission record sits
under the agent's subname. Every load-bearing piece of state is on-chain ENS
data. There's no parallel database, no off-chain index, no signed-message
theater. Delegation is a child subname. Revocation is transferring or burning
the parent.

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
through Pimlico. Your name is your sign-in across every dApp on every chain.

**Delegate by name.** Grant `trader.leo.ensign.eth` permission to call
`transfer` on USDC, capped at 10 per day, expiring in 7 days. The agent (a
bot, an EOA, anything that can sign) submits its calls through the agent
registry, which validates the permission record on-chain before forwarding.
Burn `leo.ensign.eth` and every agent under it loses authority in the same
block.

---

## How it works

```
ENS root .eth
└── ensign.eth                      ← parent
    └── ENSignRegistry              ← atomic register + deploy
        ├── leo                     ← user smart account, passkey-signed
        │   └── ENSignAgentRegistry ← per-user permission ledger
        │       ├── trader          ← agent · USDC transfer · 10/day · 7d
        │       └── scout           ← sub-agent, narrower scope
        └── alice                   ← another user, same shape
```

Every record is on-chain ENS state. There's no separate database, no off-chain
policy server, no signed-message theater.

| record                          | value                       | what it does               |
| ------------------------------- | --------------------------- | -------------------------- |
| `addr(node)`                    | `0xceF0…F3c7`               | the wallet's address       |
| `text(node, "credentialId")`    | base64url WebAuthn cred     | the passkey that signs     |
| `text(node, "permission")`      | structured `Permission`     | what the agent may do      |

Agent authority is enforced inside the smart contract by reading
`parent.ownerOf()` on every call. The ENS hierarchy *is* the capability tree,
not metadata on top of one. Revoking an agent is just transferring or burning
its parent name. No separate revocation tx, no off-chain coordination.

---

## Live on Sepolia

| component                   | address                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Parent name                 | [`ensign.eth`](https://explorer.ens.dev/ensign.eth/subnames)                                                                       |
| `ENSignRegistry`            | [`0x1Ca4…F07B`](https://sepolia.etherscan.io/address/0x1Ca41364e5724B456D1d03564ea4EC458Cf9F07B#code)                              |
| `ENSignAgentRegistry`       | [`0x4303…00f2`](https://sepolia.etherscan.io/address/0x4303e050dc19F8428F146b8E941C75dF9cDd00f2#code)                              |
| User-storage proxy          | [`0x511b…740D`](https://sepolia.etherscan.io/address/0x511b08f0358F042cA5cED53d7bd68F3f41cE740D)                                   |
| EntryPoint v0.8             | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108`                                                                                       |

Both registries are verified on Etherscan. Browse the live subnames on the
[ENS explorer](https://explorer.ens.dev/ensign.eth/subnames).

---

## Stack

Foundry · Solidity 0.8.30 · Solady (`LibClone`, `WebAuthn`) ·
[`@ensdomains/contracts-v2`](https://github.com/ensdomains/contracts-v2) ·
ERC-4337 v0.8 · Next.js · TypeScript · viem · **Pimlico** bundler & paymaster.

---

## License

MIT.
