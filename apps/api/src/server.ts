// VeriForge API — RWA issuance + revenue distribution on BOT Chain.
//   GET  /health                       — free
//   GET  /v1/fees                      — free
//   GET  /v1/issuances                 — free, list from on-chain registry
//   GET  /v1/issuances/:id             — free, single issuance
//   GET  /v1/issuances/:id/claimable/:holder — free, USDT claimable
//   GET  /v1/attestations/:target      — free, attestation read
//   POST /v1/issuances                 — 2 USDT (x402): AI gate + deploy + list

import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { ethers } from "ethers";
import { x402Gate } from "./x402.js";
import { getProvider, BOT_CHAIN_ID } from "./audit.js";
import { runComplianceGate, type ComplianceDossier } from "./compliance.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: true });

// Error carrying an HTTP status + body, thrown inside the serialized pipeline
// and turned into a single reply by the route handler (no Fastify double-send).
class HttpError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(typeof body?.message === "string" ? body.message : String(status));
    this.status = status;
    this.body = body;
  }
}

await app.register(cors, { origin: true });

// ─── Shared config ────────────────────────────────────────────────────────

function loadContractAddresses(): { attestationRegistry: string; issuanceRegistry: string } | null {
  try {
    const p = path.join(__dirname, "../../../packages/shared/contract-addresses.json");
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!data.attestationRegistry || !data.issuanceRegistry) return null;
    return data;
  } catch {
    return null;
  }
}

const ATTESTATION_ABI = [
  "function attest(address target, uint96 score, uint8 verdict, uint64 findingsHash, string calldata reportUri) returns (uint64)",
  "function getAttestation(address) view returns (address target, uint96 score, uint8 verdict, uint64 findingsHash, string reportUri, uint64 attestedAt, uint64 blockNumber)",
];

const ISSUANCE_ABI = [
  "function issue(address issuer, address token, address distributor, uint256 pricePerToken, string calldata docsUri) returns (uint64)",
  "function count() view returns (uint64)",
  "function getIssuance(uint64) view returns (tuple(uint64 id, address issuer, address token, address distributor, uint256 pricePerToken, string docsUri, uint64 listedAt, uint64 blockNumber))",
  "function getIssuanceByToken(address) view returns (tuple(uint64 id, address issuer, address token, address distributor, uint256 pricePerToken, string docsUri, uint64 listedAt, uint64 blockNumber))",
];

const RWATOKEN_ABI = [
  "function issuer() view returns (address)",
  "function usdt() view returns (address)",
  "function pricePerToken() view returns (uint256)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
];

const DISTRIBUTOR_ABI = [
  "function claimable(address) view returns (uint256)",
  "function accDividendPerToken() view returns (uint256)",
  "function token() view returns (address)",
];

const RWATOKEN_BYTECODE_ABI = [
  "constructor(string name, string symbol, address issuer, address usdt, uint256 pricePerToken)",
  "function buy(uint256 usdtAmount) returns (uint256)",
];

const DISTRIBUTOR_BYTECODE_ABI = ["constructor(address token, address usdt)"];

// Load real compiled artifacts from the contracts package (hardhat output).
function loadArtifact(name: string): { abi: any[]; bytecode: string } {
  const p = path.join(__dirname, "../../../packages/contracts/artifacts/contracts", `${name}.sol`, `${name}.json`);
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return { abi: raw.abi, bytecode: raw.bytecode };
}

const RWATOKEN_ARTIFACT = loadArtifact("RwaToken");
const DISTRIBUTOR_ARTIFACT = loadArtifact("RevenueDistributor");

function getVerifierWallet() {
  const key = process.env.VERIFIER_PRIVATE_KEY || "";
  if (!key) return null;
  return new ethers.Wallet(key).connect(getProvider());
}

// Serialize issuance creation: the verifier wallet signs sequential txs, so
// concurrent POSTs must not interleave (nonce collisions). Single-flight lock.
let pipelineTail: Promise<unknown> = Promise.resolve();
function serializePipeline<T>(fn: () => Promise<T>): Promise<T> {
  const run = pipelineTail.then(fn, fn);
  pipelineTail = run.catch(() => {});
  return run;
}

// ─── Routes ───────────────────────────────────────────────────────────────

app.get("/health", async () => {
  const cfg = loadContractAddresses();
  return {
    ok: true,
    service: "veriforge",
    chain: "bot-chain",
    chain_id: BOT_CHAIN_ID,
    attestationRegistry: cfg?.attestationRegistry || null,
    issuanceRegistry: cfg?.issuanceRegistry || null,
    timestamp: new Date().toISOString(),
  };
});

app.get("/v1/fees", async () => ({
  create_issuance: { amount_usdt: 2.0, asset: "USDT", network: `eip155:${BOT_CHAIN_ID}`, pay_to: process.env.X402_PAY_TO || "" },
}));

app.get("/v1/issuances", async (req, reply) => {
  const cfg = loadContractAddresses();
  if (!cfg) return reply.status(503).send({ error: "not_deployed", message: "Registry not deployed yet" });
  const provider = getProvider();
  const registry = new ethers.Contract(cfg.issuanceRegistry, ISSUANCE_ABI, provider);
  const count = Number(await registry.count());
  const out: any[] = [];
  for (let i = 1; i <= count; i++) {
    out.push(await hydrateIssuance(registry, provider, i));
  }
  return { count, issuances: out };
});

app.get("/v1/issuances/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const cfg = loadContractAddresses();
  if (!cfg) return reply.status(503).send({ error: "not_deployed", message: "Registry not deployed yet" });
  const provider = getProvider();
  const registry = new ethers.Contract(cfg.issuanceRegistry, ISSUANCE_ABI, provider);
  try {
    return await hydrateIssuance(registry, provider, Number(id));
  } catch {
    return reply.status(404).send({ error: "not_found", message: "No such issuance" });
  }
});

app.get("/v1/issuances/:id/claimable/:holder", async (req, reply) => {
  const { id, holder } = req.params as { id: string; holder: string };
  if (!ethers.isAddress(holder)) {
    return reply.status(400).send({ error: "invalid_address", message: "Not a valid holder address" });
  }
  const cfg = loadContractAddresses();
  if (!cfg) return reply.status(503).send({ error: "not_deployed", message: "Registry not deployed yet" });
  const provider = getProvider();
  const registry = new ethers.Contract(cfg.issuanceRegistry, ISSUANCE_ABI, provider);
  try {
    const issuance = await registry.getIssuance(Number(id));
    const distributor = new ethers.Contract(issuance.distributor, DISTRIBUTOR_ABI, provider);
    const claimable = await distributor.claimable(holder);
    return {
      issuance_id: Number(issuance.id),
      holder,
      token: issuance.token,
      distributor: issuance.distributor,
      claimable_usdt: ethers.formatUnits(claimable, 6),
      claimable_raw: claimable.toString(),
    };
  } catch {
    return reply.status(404).send({ error: "not_found", message: "No such issuance" });
  }
});

app.get("/v1/attestations/:target", async (req, reply) => {
  const { target } = req.params as { target: string };
  if (!ethers.isAddress(target)) {
    return reply.status(400).send({ error: "invalid_address", message: "Not a valid address" });
  }
  const cfg = loadContractAddresses();
  if (!cfg) return reply.status(503).send({ error: "not_deployed", message: "Registry not deployed yet" });
  const provider = getProvider();
  const attestations = new ethers.Contract(cfg.attestationRegistry, ATTESTATION_ABI, provider);
  const a = await attestations.getAttestation(target);
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

app.post("/v1/issuances", { preHandler: x402Gate }, async (req, reply) => {
  // One issuance pipeline at a time — the verifier wallet signs sequential txs.
  // The pipeline returns plain data or throws HttpError; the handler replies
  // exactly once. Never send from inside the serialized fn (Fastify double-send).
  try {
    const result = await serializePipeline(async () => {
      const body = (req.body || {}) as {
        name?: string;
        symbol?: string;
        pricePerTokenUsdt?: number | string;
        docsText?: string;
        docsUri?: string;
      };

      const name = (body.name || "").trim();
      const symbol = (body.symbol || "").trim().toUpperCase();
      const docsText = (body.docsText || "").trim();
      const docsUri = (body.docsUri || "").trim();
      const priceUsdt = Number(body.pricePerTokenUsdt);

      if (!name || !symbol || !docsText) {
        throw new HttpError(400, { error: "missing_fields", message: "name, symbol and docsText are required" });
      }
      if (!Number.isFinite(priceUsdt) || priceUsdt <= 0) {
        throw new HttpError(400, { error: "invalid_price", message: "pricePerTokenUsdt must be > 0" });
      }

      // 1. AI compliance gate — reviews the issuer documentation
      let dossier: ComplianceDossier;
      try {
        dossier = await runComplianceGate({ name, symbol, docsText, docsUri });
      } catch (e: any) {
        app.log.error({ err: e }, "compliance gate failed");
        throw new HttpError(503, { error: "gate_unavailable", message: `AI gate failed: ${e?.message || e}` });
      }

      // 2. Gate rejects — no deployment, no listing. The fee covers the review.
      if (dossier.verdict !== 2) {
        throw new HttpError(422, {
          ok: false,
          listed: false,
          reason: "issuance_rejected_by_gate",
          dossier,
        });
      }

      // 3. Gate approves — deploy RwaToken + RevenueDistributor, attest, list.
      const wallet = getVerifierWallet();
      if (!wallet) {
        throw new HttpError(503, { error: "not_configured", message: "VERIFIER_PRIVATE_KEY not set" });
      }
      const cfg = loadContractAddresses();
      if (!cfg) {
        throw new HttpError(503, { error: "not_deployed", message: "Registry not deployed yet" });
      }

      const usdt = process.env.BOT_USDT || "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C";
      const priceRaw = ethers.parseUnits(String(priceUsdt.toFixed(6)), 6);

      // Deterministic nonce sequencing: fetch once, increment per tx. Avoids the
      // ethers v6 parallel-nonce race on fast chains (and local automining nodes).
      let nonce = await wallet.getNonce("pending");

      async function nextNonce(): Promise<number> {
        return nonce++;
      }

      try {
        // 3a. Deploy RwaToken (units)
        const tokenFactory = new ethers.ContractFactory(RWATOKEN_ARTIFACT.abi, RWATOKEN_ARTIFACT.bytecode, wallet);
        const token = await tokenFactory.deploy(name, symbol, wallet.address, usdt, priceRaw, { nonce: await nextNonce() });
        await token.waitForDeployment();
        const tokenAddr = await token.getAddress();
        app.log.info(`RwaToken deployed: ${tokenAddr}`);

        // 3b. Deploy RevenueDistributor
        const distFactory = new ethers.ContractFactory(DISTRIBUTOR_ARTIFACT.abi, DISTRIBUTOR_ARTIFACT.bytecode, wallet);
        const distributor = await distFactory.deploy(tokenAddr, usdt, { nonce: await nextNonce() });
        await distributor.waitForDeployment();
        const distributorAddr = await distributor.getAddress();
        app.log.info(`RevenueDistributor deployed: ${distributorAddr}`);

        // 3c. Attest APPROVED on-chain (the gate verdict, verifier-signed)
        const attestations = new ethers.Contract(cfg.attestationRegistry, ATTESTATION_ABI, wallet);
        const findingsJson = JSON.stringify({ findings: dossier.findings, summary: dossier.summary });
        const findingsHash = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(findingsJson)))[0];
        const reportUri = `veriforge://dossier/${tokenAddr.toLowerCase()}/${dossier.checkedAt}`;
        const attestTx = await attestations.attest(tokenAddr, dossier.score, 2, findingsHash, reportUri, { gasLimit: 600_000, nonce: await nextNonce() });
        const attestReceipt = await attestTx.wait();
        app.log.info(`Attestation stored: ${attestReceipt!.hash}`);

        // 3d. List in IssuanceRegistry — reverts on-chain if not APPROVED
        const registry = new ethers.Contract(cfg.issuanceRegistry, ISSUANCE_ABI, wallet);
        const issueTx = await registry.issue(wallet.address, tokenAddr, distributorAddr, priceRaw, docsUri, { gasLimit: 600_000, nonce: await nextNonce() });
        const issueReceipt = await issueTx.wait();
        const id = Number(await registry.count());
        app.log.info(`Issuance #${id} listed: ${issueReceipt!.hash}`);

        const hydrated = await hydrateIssuance(new ethers.Contract(cfg.issuanceRegistry, ISSUANCE_ABI, getProvider()), getProvider(), id);

        return {
          ok: true,
          listed: true,
          issuance_id: id,
          dossier,
          onChain: {
            token: tokenAddr,
            distributor: distributorAddr,
            attestationTx: attestReceipt!.hash,
            listingTx: issueReceipt!.hash,
            explorer: `https://scan.botchain.ai/tx/${issueReceipt!.hash}`,
          },
          issuance: hydrated,
        };
      } catch (e: any) {
        app.log.error({ err: e }, "issuance pipeline failed");
        throw new HttpError(502, {
          ok: false,
          listed: false,
          reason: "deployment_failed",
          detail: e?.reason || e?.message || String(e),
          dossier,
        });
      }
    });
    return reply.send(result);
  } catch (e: any) {
    if (e instanceof HttpError) {
      return reply.status(e.status).send(e.body);
    }
    app.log.error({ err: e }, "unhandled issuance error");
    return reply.status(500).send({ error: "internal", message: e?.message || String(e) });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────

async function hydrateIssuance(registry: ethers.Contract, provider: ethers.JsonRpcProvider, id: number) {
  const i = await registry.getIssuance(id);
  const token = new ethers.Contract(i.token, RWATOKEN_ABI, provider);
  const distributor = new ethers.Contract(i.distributor, DISTRIBUTOR_ABI, provider);
  const [name, symbol, totalSupply, accDividend] = await Promise.all([
    token.name().catch(() => ""),
    token.symbol().catch(() => ""),
    token.totalSupply().catch(() => 0n),
    distributor.accDividendPerToken().catch(() => 0n),
  ]);
  return {
    id: Number(i.id),
    issuer: i.issuer,
    token: i.token,
    distributor: i.distributor,
    name,
    symbol,
    pricePerTokenUsdt: ethers.formatUnits(i.pricePerToken, 6),
    totalSupply: ethers.formatUnits(totalSupply as bigint, 18),
    docsUri: i.docsUri,
    accDividendPerToken: (accDividend as bigint).toString(),
    listedAt: Number(i.listedAt),
    blockNumber: Number(i.blockNumber),
    explorer: `https://scan.botchain.ai/address/${i.token}`,
  };
}

const port = parseInt(process.env.PORT || "4000", 10);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`VeriForge API listening on :${port}`);
});
