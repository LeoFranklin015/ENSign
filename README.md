# ENSign

> Sign with ENS. Subname is the wallet.

ENSign is an ENSv2-native authentication and delegation layer. Registering a
subname (e.g. `leo.ensign.eth`) atomically deploys a passkey-controlled smart
account at a deterministic address — the ENS name *is* the wallet. Each name
can grant permissioned subnames (`bot.leo.ensign.eth`) that act as scoped
agents.

## Status

Work in progress — Foundry contracts + scripts in this repo, frontend lives
separately.

## Build

```sh
forge build
forge test
```
