# VeriForge 🔱

**AI-gated RWA issuance on BOT Chain.**

VeriForge is the issuance and revenue layer for tokenized real-world assets on BOT Chain. An issuer documents a real asset, the VeriForge AI compliance officer reviews it and produces a dossier with a 0-100 score, and only APPROVED issuances get listed on-chain. Investors buy units with USDT, revenue is deposited into a distributor, and holders claim their pro-rata share. The platform holds no funds.

**Live on Bohr testnet (chain 968)** with the full loop verified on-chain. Targeting BOT mainnet (chain 677).

Built for the **BOT Chain Builder Challenge #2 (AI × RWA)**, deadline Aug 20 2026.

## Why this problem

BOT Chain has a bridge, a DEX, a wallet, and a young ecosystem. What it lacks is the loop every RWA issuer needs: issue a token with real terms, sell it for USDT, distribute revenue pro-rata, and stay compliant. That loop is the whole business of the asset side, and it did not exist on the chain. VeriForge is that loop.

AI is genuinely core, not bolted on. The compliance gate is a real LLM review of the issuer's documentation. The verdict is stored on-chain in the attestation registry, and the issuance registry refuses to list anything that is not APPROVED. No human rubber stamp, no heuristic linter, no fabricated scores.

## Architecture

```
veriforge/
├── packages/
│   ├── contracts/        # Hardhat: AttestationRegistry, IssuanceRegistry, RwaToken, RevenueDistributor
│   └── shared/           # contract-addresses.json (deploy output)
└── apps/
    ├── api/              # Fastify + x402 gate + AI compliance gate + issuance pipeline
    └── web/              # Next.js: market, buy units, claim revenue, launch an asset
```

## Contract design (mainnet-safe)

| Contract | Role | Funds |
|---|---|---|
| `AttestationRegistry` | Stores AI verdicts, verifier-only writes | holds none |
| `IssuanceRegistry` | Lists issuances, enforces the AI gate on-chain | holds none |
| `RwaToken` | ERC-20 units, buy() pulls USDT to the issuer | holds none |
| `RevenueDistributor` | Pull-based pro-rata claims, no admin | holds only unclaimed |

The IssuanceRegistry calls the AttestationRegistry and reverts with `NotApproved` unless the token carries an APPROVED verdict. The gate is enforced in the contract, not just in the API.

## The AI gate

`apps/api/src/compliance.ts` sends the issuer's documentation to a real LLM and parses a structured dossier. Score >= 70 is APPROVED, 40-69 CAUTION, < 40 BLOCKED. If the LLM is unreachable the request fails loudly. No documentation at all scores 0 automatically. The gate runs a primary rail (`GATE_URL`) with an automatic failover (`FALLBACK_GATE_URL`), and the dossier records which model produced the verdict — no silent substitution.

## API

| Route | Fee | Purpose |
|---|---|---|
| `GET /health` | free | liveness + registry addresses |
| `GET /v1/fees` | free | fee schedule |
| `GET /v1/issuances` | free | list from on-chain registry |
| `GET /v1/issuances/:id` | free | single issuance |
| `GET /v1/issuances/:id/claimable/:holder` | free | USDT claimable by a holder |
| `GET /v1/attestations/:target` | free | AI verdict for a contract |
| `POST /v1/issuances` | 1 USDT (x402) | AI gate + deploy + attest + list |

## Quick start

```bash
# contracts
cd packages/contracts
npm install
npx hardhat test          # 27 tests

# local node + deploy (chain 677)
npx hardhat node
npx hardhat run scripts/deploy-local.ts --network localhost

# api
cd ../../apps/api
cp .env.example .env      # set VERIFIER_PRIVATE_KEY, X402_PAY_TO, FREEMODEL_API_KEY
npm run dev               # :4000

# web
cd ../web
cp .env.local.example .env.local
npm run dev               # :3000
```

Production-style local stack (systemd, survives reboot):

```bash
sudo cp deploy/veriforge-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now veriforge-node veriforge-api veriforge-web
cd packages/contracts && npx hardhat run scripts/deploy-local.ts --network localhost
```

Deploy to a public BOT Chain (verified on Bohr testnet 968):

```bash
cd packages/contracts
export DEPLOYER_PRIVATE_KEY=<key> BOT_TESTNET_RPC=https://rpc.bohr.life
npx hardhat run scripts/deploy.ts --network botchain-testnet

# mainnet (needs a funded wallet with real BOT)
npx hardhat run scripts/deploy.ts --network botchain
```

## Live on Bohr testnet (verified 2026-08-14)

- RPC `https://rpc.bohr.life`, chain 968, explorer `https://scan.bohr.life`
- USDT: `0x75edC9335175Fc0552D51D48439F229c10420fe3` (faucet: `https://faucet.botchain.ai/basic`)
- AttestationRegistry: `0x569ab13814bb10A0E661a1993c6372b40eEab57d` ([verified source](https://scan.bohr.life/address/0x569ab13814bb10A0E661a1993c6372b40eEab57d#code))
- IssuanceRegistry: `0x2011C677a4EF5859975c54E593252a7b868a7269` ([verified source](https://scan.bohr.life/address/0x2011C677a4EF5859975c54E593252a7b868a7269#code))
- Live issuances and their tokens/distributors are listed by `GET /v1/issuances` — see the marketplace.

Full e2e loop executed on Bohr: x402 pay (1 USDT) → AI gate (score 90, APPROVED) → deploy → list → buy units for USDT → issuer deposits revenue → holder claims. All steps confirmed on-chain.

The stack is env-driven for either chain: `BOT_CHAIN_ID`, `BOT_RPC`, `BOT_USDT`, `X402_PAY_TO`, `BOTSCAN_URL` in `apps/api/.env`.

## Web

Next.js 15 + RainbowKit (wagmi v2) wallet model. BOT Chain 677 is a first-class wagmi chain, so connect, chain switch, and account state are all provider-managed — no raw `window.ethereum` plumbing. The web server proxies `/v1/*` to the API (next.config rewrites), so the app works from a single origin with no CORS and no baked localhost base.

![VeriForge marketplace with live issuances](docs/marketplace.png)

| Flow | Path |
|---|---|
| Launch an asset (docs → AI gate → deploy → list) | Launch tab, 1 USDT via x402 |
| Buy units with USDT | Market tab, wallet-signed approve + buy |
| Deposit revenue | Market tab, issuer row |
| Claim pro-rata share | Market tab, holder row |

## BOT Chain facts

- Mainnet chain ID 677, RPC `https://rpc.botchain.ai`, explorer `https://scan.botchain.ai`
- USDT (bridged): `0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C`
- Gas paid in BOT (1 BOT per eligible project from the challenge)

## Track fit

- **RWA Applications** (highest priority): asset distribution and asset management are named directions
- **AI Native**: the AI compliance gate is the on-chain decision entity, verdicts written on-chain, not a chat wrapper
- **Deep mainnet integration**: the registry pair is a real deployment, not a demo
