// VeriForge API — RWA issuance + revenue distribution on BOT Chain.
//   GET  /health                       — free
//   GET  /v1/fees                      — free
//   GET  /v1/issuances                 — free, list from on-chain registry
//   GET  /v1/issuances/:id             — free, single issuance
//   GET  /v1/issuances/:id/claimable/:holder — free, USDT claimable
//   GET  /v1/attestations/:target      — free, attestation read
//   POST /v1/uploads                   — free, multipart proof/docs/photo upload
//   GET  /uploads/*                    — free, served proof files (content-hashed)
//   POST /v1/issuances                 — 1 USDT (x402): AI gate + deploy + list

import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { ethers } from "ethers";
import { createHash } from "node:crypto";
import { x402Gate } from "./x402.js";
import { getProvider, BOT_CHAIN_ID } from "./audit.js";
import { runComplianceGate, type ComplianceDossier } from "./compliance.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "../uploads");

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
await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 6 } });

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
  "function attest(address target, uint96 score, uint8 verdict, uint64 findingsHash, string calldata reportUri, bytes32 payloadHash) returns (uint64)",
  "function getAttestation(address) view returns ((address target, uint96 score, uint8 verdict, uint64 findingsHash, string reportUri, bytes32 payloadHash, uint64 attestedAt, uint64 blockNumber))",
  "function isVerifier(address) view returns (bool)",
  "function verifierCount() view returns (uint256)",
];

const ISSUANCE_ABI = [
  "function issue(address issuer, address token, address distributor, uint256 pricePerToken, string calldata docsUri, bytes32 payloadHash) returns (uint64)",
  "function count() view returns (uint64)",
  "function getIssuance(uint64) view returns (tuple(uint64 id, address issuer, address token, address distributor, uint256 pricePerToken, string docsUri, bytes32 payloadHash, uint64 listedAt, uint64 blockNumber))",
  "function getIssuanceByToken(address) view returns (tuple(uint64 id, address issuer, address token, address distributor, uint256 pricePerToken, string docsUri, bytes32 payloadHash, uint64 listedAt, uint64 blockNumber))",
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
const BOTSCAN_URL = process.env.BOTSCAN_URL || "https://scan.botchain.ai";

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
  create_issuance: { amount_usdt: 1.0, asset: "USDT", network: `eip155:${BOT_CHAIN_ID}`, pay_to: process.env.X402_PAY_TO || "" },
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
    payloadHash: a.payloadHash,
    attestedAt: Number(a.attestedAt),
    blockNumber: Number(a.blockNumber),
    explorer: `${BOTSCAN_URL}/address/${target}`,
  };
});

// ─── Uploads: proof files, asset photos, docs (content-hashed, served) ────

const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

app.post("/v1/uploads", async (req, reply) => {
  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const parts = req.parts();
  const uploaded: any[] = [];
  for await (const part of parts) {
    if (part.type !== "file") continue; // skip non-file fields (type: 'field')
    const mime = (part.mimetype || "").toLowerCase();
    const ext = MIME_EXT[mime];
    if (!ext) {
      part.file.resume();
      throw new HttpError(400, { error: "unsupported_file", message: `unsupported type ${mime || "unknown"}` });
    }
    const chunks: Buffer[] = [];
    for await (const chunk of part.file) chunks.push(chunk as Buffer);
    const buf = Buffer.concat(chunks);
    if (buf.length === 0) throw new HttpError(400, { error: "empty_file", message: "file is empty" });

    const sha = createHash("sha256").update(buf).digest("hex");
    const name = `${sha}.${ext}`;
    const dest = path.join(UPLOAD_DIR, name);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf); // content-addressed: dedupe

    const kind = String((part.fields?.kind as any)?.value || "other");
    uploaded.push({
      kind,
      url: `/uploads/${name}`,
      sha256: sha,
      contentType: mime,
      size: buf.length,
    });
  }
  if (uploaded.length === 0) throw new HttpError(400, { error: "no_file", message: "send a file in multipart form" });
  return reply.send({ ok: true, files: uploaded });
});

app.get("/uploads/*", async (req, reply) => {
  const p = String((req.params as any)["*"] || "");
  // content-hashed names only: /^[a-f0-9]{64}\.(pdf|png|jpg|webp|txt|doc|docx)$/
  if (!/^[a-f0-9]{64}\.(pdf|png|jpg|webp|txt|doc|docx)$/.test(p)) {
    return reply.status(404).send({ error: "not_found" });
  }
  const file = path.join(UPLOAD_DIR, p);
  if (!fs.existsSync(file)) return reply.status(404).send({ error: "not_found" });
  const ext = p.split(".").pop();
  const mime = ext === "pdf" ? "application/pdf" : ext === "txt" ? "text/plain" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const buf = fs.readFileSync(file);
  return reply.type(mime).header("Cache-Control", "public, max-age=31536000, immutable").send(buf);
});

// If a reviewed URI points at an uploaded PDF, pull its text so the AI gate
// reads the ACTUAL proof document, not just what the issuer typed.
async function extractUploadText(uri: string | undefined): Promise<string> {
  if (!uri) return "";
  const m = String(uri).match(/^\/uploads\/([a-f0-9]{64})\.pdf$/);
  if (!m) return "";
  const file = path.join(UPLOAD_DIR, `${m[1]}.pdf`);
  if (!fs.existsSync(file)) return "";
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: fs.readFileSync(file) });
    const raw = await parser.getText();
    const text = typeof raw === "string" ? raw : String((raw as any)?.text || "");
    return text.trim().slice(0, 8000);
  } catch {
    return "";
  }
}

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
        assetMetadata?: {
          assetClass?: string;
          jurisdiction?: string;
          legalEntity?: string;
          backingProofType?: string;
          backingProofUri?: string;
          assetPhotos?: string[];
        };
        issuerAddress?: string;
        issuerSignature?: string;
      };

      const name = (body.name || "").trim();
      const symbol = (body.symbol || "").trim().toUpperCase();
      const docsText = (body.docsText || "").trim();
      const docsUri = (body.docsUri || "").trim();
      const priceUsdt = Number(body.pricePerTokenUsdt);

      // Structured asset declaration — the issuer must sign it. It is
      // committed on-chain so the reviewed content can never be swapped.
      const assetMetadata = {
        assetClass: (body.assetMetadata?.assetClass || "").trim(),
        jurisdiction: (body.assetMetadata?.jurisdiction || "").trim(),
        legalEntity: (body.assetMetadata?.legalEntity || "").trim(),
        backingProofType: (body.assetMetadata?.backingProofType || "").trim(),
        backingProofUri: (body.assetMetadata?.backingProofUri || "").trim(),
        assetPhotos: Array.isArray(body.assetMetadata?.assetPhotos)
          ? body.assetMetadata.assetPhotos.map((s: any) => String(s || "").trim()).filter(Boolean)
          : [],
      };
      const issuerAddress = (body.issuerAddress || "").trim();
      const issuerSignature = (body.issuerSignature || "").trim();

      if (!name || !symbol || !docsText) {
        throw new HttpError(400, { error: "missing_fields", message: "name, symbol and docsText are required" });
      }
      if (!Number.isFinite(priceUsdt) || priceUsdt <= 0) {
        throw new HttpError(400, { error: "invalid_price", message: "pricePerTokenUsdt must be > 0" });
      }
      if (!assetMetadata.assetClass || !assetMetadata.jurisdiction || !assetMetadata.legalEntity || !assetMetadata.backingProofType) {
        throw new HttpError(400, {
          error: "missing_asset_metadata",
          message: "assetClass, jurisdiction, legalEntity and backingProofType are required in assetMetadata",
        });
      }
      if (!issuerAddress || !issuerSignature) {
        throw new HttpError(400, {
          error: "missing_issuer_signature",
          message: "the issuer must sign the asset declaration (sign the exact payload the API returns)",
        });
      }

      // Canonical reviewed payload: the EXACT string both the issuer signs and
      // the registry commits on-chain. Key order is fixed — web, e2e and API
      // must build it identically.
      const payloadJson = JSON.stringify({
        name,
        symbol,
        docsText,
        docsUri,
        assetMetadata,
      });
      const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(payloadJson));

      // Verify the issuer really signed THIS declaration. Tampered fields
      // change the hash, break the signature, and get rejected before any
      // on-chain work happens.
      let recovered: string;
      try {
        recovered = ethers.verifyMessage(payloadJson, issuerSignature);
      } catch {
        throw new HttpError(400, { error: "invalid_signature", message: "issuerSignature is not a valid signature" });
      }
      if (recovered.toLowerCase() !== issuerAddress.toLowerCase()) {
        throw new HttpError(400, {
          error: "signature_mismatch",
          message: `signature does not match issuerAddress ${issuerAddress} (recovered ${recovered})`,
        });
      }

      // 1. AI compliance gate — reviews the issuer documentation AND the
      // structured declaration, checking the two are consistent. If the
      // issuer uploaded a PDF (docs or proof), its extracted text is fed to
      // the gate too, so the AI reads the ACTUAL document, not just the
      // typed summary. The signed payload is unchanged — the file text is
      // review-only material.
      const uploadText =
        (await extractUploadText(docsUri)) || (await extractUploadText(assetMetadata.backingProofUri));
      const reviewedDocs = uploadText
        ? `${docsText}\n\n[Extracted from uploaded document: ${docsUri || assetMetadata.backingProofUri}]\n${uploadText}`
        : docsText;
      let dossier: ComplianceDossier;
      try {
        dossier = await runComplianceGate({ name, symbol, docsText: reviewedDocs, docsUri, assetMetadata });
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
          payloadHash,
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

        // 3c. Attest APPROVED on-chain (the gate verdict, verifier-signed),
        // binding the verdict to the exact reviewed payload hash.
        const attestations = new ethers.Contract(cfg.attestationRegistry, ATTESTATION_ABI, wallet);
        const findingsJson = JSON.stringify({ findings: dossier.findings, summary: dossier.summary });
        const findingsHash = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(findingsJson)))[0];
        const reportUri = `veriforge://dossier/${tokenAddr.toLowerCase()}/${dossier.checkedAt}`;
        const attestTx = await attestations.attest(tokenAddr, dossier.score, 2, findingsHash, reportUri, payloadHash, { gasLimit: 600_000, nonce: await nextNonce() });
        const attestReceipt = await attestTx.wait();
        app.log.info(`Attestation stored: ${attestReceipt!.hash}`);

        // 3d. List in IssuanceRegistry — reverts on-chain if not APPROVED
        // or if the payload commitment does not match the attestation.
        const registry = new ethers.Contract(cfg.issuanceRegistry, ISSUANCE_ABI, wallet);
        const issueTx = await registry.issue(wallet.address, tokenAddr, distributorAddr, priceRaw, docsUri, payloadHash, { gasLimit: 600_000, nonce: await nextNonce() });
        const issueReceipt = await issueTx.wait();
        const id = Number(await registry.count());
        app.log.info(`Issuance #${id} listed: ${issueReceipt!.hash}`);

        const hydrated = await hydrateIssuance(new ethers.Contract(cfg.issuanceRegistry, ISSUANCE_ABI, getProvider()), getProvider(), id);

        return {
          ok: true,
          listed: true,
          issuance_id: id,
          dossier,
          payloadHash,
          payloadJson,
          onChain: {
            token: tokenAddr,
            distributor: distributorAddr,
            attestationTx: attestReceipt!.hash,
            listingTx: issueReceipt!.hash,
            explorer: `${BOTSCAN_URL}/tx/${issueReceipt!.hash}`,
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
    payloadHash: i.payloadHash,
    accDividendPerToken: (accDividend as bigint).toString(),
    listedAt: Number(i.listedAt),
    blockNumber: Number(i.blockNumber),
    explorer: `${BOTSCAN_URL}/address/${i.token}`,
  };
}

const port = parseInt(process.env.PORT || "4000", 10);
app.listen({ port, host: "0.0.0.0" }).then(() => {
  app.log.info(`VeriForge API listening on :${port}`);
});
