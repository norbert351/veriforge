# VeriForge 🔱

**AI RWA verification, forged on BOT Chain.**

VeriForge is an AI verification layer for Real World Asset projects on BOT Chain mainnet (chain 677). Paste a contract address, the agent runs real on-chain checks (code presence, ownership, pause, supply, mint authority, source verification via BOTScan), scores risk 0-100, and stores a signed verdict in an on-chain attestation registry. Paid via x402 in USDT on BOT Chain.

Built for the **BOT Chain Builder Challenge #2 (AI × RWA)**, deadline Aug 20 2026. Reuses the x402 + signed-verdict pattern from the Foundry ASP project (X Layer), which stays untouched.

## Why it solves a real problem

RWA tokenization on a fresh chain has zero trust infrastructure. When a project tokenizes real assets, who verifies the asset is real, the contract is clean, ownership is provable, and the source is public? LPs, exchanges, and buyers have no way to check. VeriForge becomes the chain's verification layer. AI is the core capability — the verdict is the product, stored on-chain.

## Architecture

```
veriforge/
├── packages/
│   ├── contracts/        # Hardhat + AttestationRegistry.sol (no funds held)
│   └── shared/           # contract-addresses.json (deploy output)
└── apps/
    ├── api/              # Fastify + x402 gate + audit pipeline
    └── web/              # Next.js, wallet connect to BOT Chain 677
```

## Safety design (mainnet-first)

- AttestationRegistry holds **no funds** — no payable functions, no token transfers
- Single verifier role, transferable only by the verifier itself
- Audit reads are all view calls against BOT Chain RPC + BOTScan
- x402 gate validates amount, chainId (677), and payTo before serving
- No fabricated data: every check is backed by an RPC or explorer read

## Quick start

```bash
npm install -w packages/contracts
npm run test:contracts        # 9 tests, all pass
```

Deploy to BOT Chain mainnet:

```bash
cd packages/contracts
cp .env.example .env          # set DEPLOYER_PRIVATE_KEY, VERIFIER_ADDRESS, BOTSCAN_API_KEY
npx hardhat run scripts/deploy.ts --network botchain
```

Run API:

```bash
cd apps/api
cp .env.example .env          # set X402_PAY_TO, VERIFIER_PRIVATE_KEY
npm run dev
```

Run web:

```bash
cd apps/web
cp .env.local.example .env.local
npm run dev
```

## Endpoints

| Route | Fee | Purpose |
|---|---|---|
| `GET /health` | free | liveness |
| `GET /v1/fees` | free | fee schedule |
| `GET /v1/attestations/:target` | free | public on-chain verdict read |
| `POST /v1/verify-rwa` | 0.5 USDT | audit + sign + store verdict |

## BOT Chain facts

- Mainnet chain ID 677, RPC `https://rpc.botchain.ai`, explorer `https://scan.botchain.ai`
- USDT (bridged): `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C`
- Gas paid in BOT (1 BOT per eligible project from the challenge)

## Track fit

- **RWA Applications** (highest priority): compliance tools, data services, infrastructure — named directions
- **AI Native**: AI is the on-chain decision entity, verdicts written on-chain, not a chat wrapper
