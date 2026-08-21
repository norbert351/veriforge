# VeriForge: what I'm building and why

## Here's what I'm building

A platform where anyone with a real-world asset can turn it into a tradeable token on BOT Chain, with an AI compliance officer checking every listing before it goes live. Issuers document their asset, get it approved, sell units for USDT, and pay holders their share of revenue automatically.

I call it VeriForge. AI-gated RWA issuance on BOT Chain, built for the BOT Chain Builder Challenge #2 (AI × RWA).

## Here's the problem it solves

RWA tokenization sounds big but it has one dirty secret: compliance is fake in most projects. A logo, a checkmark, a promise. Nobody actually verifies that the asset behind the token is real, so nobody trusts the market.

BOT Chain has a bridge, a DEX, a wallet, and no asset side. An issuer who wants to tokenize an invoice, a property, or a revenue stream has to stitch together random tools with no compliant way to prove the asset exists before listing it. That gap is the whole business of the RWA side, and it was missing on this chain.

## How it works

Five steps, one pipeline.

1. An issuer documents the asset. Real terms, real revenue source, real paperwork.
2. Our AI compliance officer reads the documentation with a real LLM and scores it from 0 to 100. No docs means an automatic zero. No human rubber stamp.
3. The verdict goes on-chain in an attestation registry, and the issuance registry refuses to list anything that is not APPROVED. The gate lives in the contract, so nobody can bypass it through the API or the frontend.
4. Investors buy units with USDT. The token contract pulls payment straight to the issuer, so the platform never holds funds.
5. Revenue lands in a distributor contract and holders claim their pro-rata share anytime. Pull-based claims, no admin, nobody can run off with the money.

## Why this matters

The chain that ships the compliant issuance rail first defines how the asset side of the ecosystem works. VeriForge is that rail, and it is genuinely AI, not a wrapper. A real LLM reads the real documentation, and the score is verifiable on-chain forever.

## Where we are right now

- 27 contract tests passing
- Full e2e loop working locally: pay, review, deploy, list, buy, deposit, claim
- Live on BOT mainnet (chain 677) with 2 real mainnet issuances, plus Bohr testnet (chain 968)
- Deadline Aug 20 2026

## What I need from you

- **Contracts**: Hardhat suite, 23 tests, mainnet-safe fund handling
- **AI + API**: the compliance gate and the x402 payment flow
- **Frontend**: the investor market and issuer launch experience
- **Growth**: finding the first real issuers and assets, learning what they actually need

## Live deployment

- **Live app:** https://veri-forge.netlify.app  (Marketplace → toggle **Mainnet**)
- **Live API:** https://veriforge-5w80.onrender.com
- **On-chain (BOT mainnet 677):** AttestationRegistry `0xF7ed39F4401062d9A5c45B7583d299887c5Cd560` · IssuanceRegistry `0x9369c520DcE7DA60aB9B0EafcD618d8F3416ae65` · explorer scan.botchain.ai
