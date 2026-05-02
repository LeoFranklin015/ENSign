# ENSign Relay

Next.js API service that:

- Mints subnames in the ENSign storage registry on behalf of users (the
  relayer EOA holds `ROLE_REGISTRAR`, so users don't pay registration gas).
- Pre-funds the user's smart account at the EntryPoint so its first UserOp
  succeeds without manual setup.
- Forwards `EntryPoint.handleOps` for legacy clients that don't go through
  a bundler directly.

## Run

```sh
cp .env.example .env.local   # set PRIVATE_KEY, RPC URLs, REGISTRY, ENTRYPOINT
npm install
npm run dev                   # http://localhost:3000
```

## Endpoints

| Method | Path           | Body / Notes |
|--------|----------------|--------------|
| GET    | /api/health    | relayer + block + registry |
| POST   | /api/predict   | `{ qx, qy }` → smart account address |
| POST   | /api/register  | `{ label, qx, qy, credentialId }` → mints subname + prefunds |
| POST   | /api/relay     | `{ userOp, chainId }` → submits `handleOps` |
