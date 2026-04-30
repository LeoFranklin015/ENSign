# ENSign

> Sign with ENS. Subname is the wallet.

ENSign is an ENSv2-native authentication and delegation layer. Registering a
subname (e.g. `leo.ensign.eth`) atomically deploys a passkey-controlled smart
account at a deterministic address — the ENS name *is* the wallet. Each name
can grant permissioned subnames (`bot.leo.ensign.eth`) that act as scoped
agents.

## Layout

```
ensign/
├── contracts/   # Foundry: SmartAccount, ENSignRegistry, ENSignAgentRegistry
└── web/         # Vite + React webapp, iframe wallet, bookmarklet, bot script
```

## Build

```sh
cd contracts && forge build && forge test
cd ../web     && npm install && npm run dev
```
