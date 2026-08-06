// VeriForge API — BOT Chain RWA verification service.
//   GET  /health                          — free
//   GET  /v1/attestations/:target         — free, public read
//   POST /v1/verify-rwa                   — 0.5 USDT (x402), runs audit + signs + stores on-chain
//   GET  /v1/fees                         — free, fee schedule

import Fastify from "fastify";
import cors from "@fastify/cors";
import { ethers } from "ethers";
import { x402Gate } from "./x402.js";
import { runAudit, BOT_RPC, BOT_CHAIN_ID, getProvider, type AuditResult } from "./audit.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

// ─── Shared config ────────────────────────────────────────────────────────

function loadContractAddresses(): { registry: string } | null {
  try {
    const p = path.join(__dirname, "../../../packages/shared/contract-addresses.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const REGISTRY_ABI = [
  "function attest(address target, uint96 score, uint8 verdict, uint64 findingsHash, string calldata reportUri) returns (uint64)",
  "function getAttestation(address) view returns (address target, uint96 score, uint8 verdict, uint64 findingsHash, string reportUri, uint64 attestedAt, uint64 blockNumber)",
  "event Attested(address indexed target, uint96 score, uint8 verdict, uint64 findingsHash, string reportUri, uint64 attestedAt)",
];

function getRegistryContract() {
  const cfg = loadContractAddresses();
  const verifierKey = process.env.VERIFIER_PRIVATE_KEY || "";
  if (!cfg || !verifierKey) return null;
  const wallet = new ethers.Wallet(verifierKey);
  const provider = getProvider();
  const signer = wallet.connect(provider);
  return new ethers.Contract(cfg.registry, REGISTRY_ABI, signer);
}

// ─── Routes ───────────────────────────────────────────────────────────────

app.get("/health", async () => ({
  ok: true,
  service: "veriforge",
  chain: "bot-chain",
  chain_id: BOT_CHAIN_ID,
  rpc: BOT_RPC,
  registry: loadContractAddresses()?.registry || null,
  timestamp: new Date().toISOString(),
}));

app.get("/v1/fees", async () => ({
  verify_rwa: { amount_usdt: 0.5, asset: "USDT", network: `eip155:${BOT_CHAIN_ID}`, pay_to: process.env.X402_PAY_TO || "" },
}));

app.get("/v1/attestations/:target", async (req, reply) => {
  const { target } = req.params as { target: string };
  if (!ethers.isAddress(target)) {
    return reply.status(400).send({ error: "invalid_address", message: "Not a valid address" });
  }
  const cfg = loadContractAddresses();
  if (!cfg) {
    return reply.status(503).send({ error: "not_deployed", message: "Registry not deployed yet" });
  }
  const provider = getProvider();
  const registry = new ethers.Contract(cfg.registry, REGISTRY_ABI, provider);
  const a = await registry.getAttestation(target);
  if (!a || a.target === ethers.ZeroAddress) {
    return reply.status(404).send({ error: "not_found", message: "No attestation for this target" });
  }
  return {
    target,
    score: Number(a.score),
    verdict: Number(a.verdict),
    findingsHash: Number(a.findingsHash),
    reportUri: a.reportUri,
    attestedAt: Number(a.attestedAt),
    blockNumber: Number(a.blockNumber),
    explorer: `https://scan.botchain.ai/address/${target}`,
  };
});

app.post("/v1/verify-rwa", { preHandler: x402Gate }, async (req, reply) => {
  const body = (req.body || {}) as { target?: string; chain?: string };
  const target = body.target || "";

  if (!ethers.isAddress(target)) {
    return reply.status(400).send({ error: "invalid_address", message: "Provide a valid target contract address" });
  }
  // BOT Chain mainnet only — the audit reads chain 677 state.
  if (body.chain && String(body.chain).toLowerCase() !== "bot" && String(body.chain) !== "677") {
    return reply.status(400).send({ error: "wrong_chain", message: "VeriForge audits BOT Chain mainnet (chain 677)" });
  }

  // 1. Run the audit
  const result: AuditResult = await runAudit(target);

  // 2. Try to persist on-chain (best-effort — audit result is the deliverable)
  let onChain: any = { stored: false, reason: "registry_not_configured" };
  try {
    const registry = getRegistryContract();
    if (registry) {
      const findingsJson = JSON.stringify({ findings: result.findings, checks: result.checks, summary: result.summary });
      const findingsHash = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(findingsJson)))[0] as number;
      const reportUri = `veriforge://audit/${target.toLowerCase()}/${result.attestedAt}`;
      const tx = await registry.attest(target, result.score, result.verdict, findingsHash, reportUri, {
        gasLimit: 300_000,
      });
      const receipt = await tx.wait();
      onChain = {
        stored: true,
        txHash: receipt!.hash,
        blockNumber: Number(receipt!.blockNumber),
        explorer: `https://scan.botchain.ai/tx/${receipt!.hash}`,
      };
    }
  } catch (e: any) {
    onChain = { stored: false, reason: e?.reason || e?.message || "on-chain store failed" };
    app.log.warn({ err: e }, "attestation store failed");
  }

  return {
    ok: true,
    chain: "bot-chain",
    chain_id: BOT_CHAIN_ID,
    ...result,
    onChain,
  };
});

const port = parseInt(process.env.PORT || "4000", 10);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`VeriForge API listening on :${port}`);
});
