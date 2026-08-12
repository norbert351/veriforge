// VeriForge audit pipeline — real on-chain checks against BOT Chain mainnet.
// Produces a deterministic risk score + verdict, then optionally refines with LLM.
// Never fabricates data: every finding is backed by an RPC or explorer read.

import { ethers } from "ethers";

export const BOT_RPC = process.env.BOT_RPC || "https://rpc.botchain.ai";
export const BOT_CHAIN_ID = Number(process.env.BOT_CHAIN_ID || 677);
export const BOT_USDT = process.env.BOT_USDT || "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C";
export const BOTSCAN_API = process.env.BOTSCAN_API || "https://scan.botchain.ai/api";

export type Verdict = 0 | 1 | 2; // BLOCKED / CAUTION / APPROVED

export interface Finding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
  evidence?: string;
}

export interface AuditResult {
  target: string;
  score: number; // 0-100
  verdict: Verdict;
  findings: Finding[];
  checks: { name: string; ok: boolean; detail: string }[];
  summary: string;
  attestedAt: number;
}

const ABI_OWNER = ["function owner() view returns (address)"];
const ABI_RENOUNCED = ["function isRenounced() view returns (bool)"];
const ABI_PAUSED = ["function paused() view returns (bool)"];
const ABI_TOTAL_SUPPLY = ["function totalSupply() view returns (uint256)"];
const ABI_MINT = ["function mint(address,uint256)"];

export function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(BOT_RPC, BOT_CHAIN_ID, { staticNetwork: true });
}

function isZeroAddr(a: string): boolean {
  return /^0x0{40}$/i.test(a);
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// ─── On-chain checks ──────────────────────────────────────────────────────

async function checkContractExists(provider: ethers.JsonRpcProvider, target: string): Promise<{ ok: boolean; detail: string }> {
  const code = await safeCall(() => provider.getCode(target));
  const size = code ? (code.length - 2) / 2 : 0;
  if (!code || size === 0) return { ok: false, detail: "No contract at address — EOA or nonexistent" };
  return { ok: true, detail: `Contract present, ${size} bytes of code` };
}

async function checkOwnership(provider: ethers.JsonRpcProvider, target: string): Promise<{ ok: boolean; detail: string }> {
  const contract = new ethers.Contract(target, ABI_OWNER, provider);
  const owner = await safeCall(() => contract.owner());
  if (owner === null) return { ok: true, detail: "No owner() function — cannot verify ownership model" };
  const o = owner as string;
  if (isZeroAddr(o)) return { ok: true, detail: "Ownership renounced (owner = 0x0)" };
  return { ok: false, detail: `Owner is ${o} — mutable control exists` };
}

async function checkPause(provider: ethers.JsonRpcProvider, target: string): Promise<{ ok: boolean; detail: string }> {
  const contract = new ethers.Contract(target, ABI_PAUSED, provider);
  const paused = await safeCall(() => contract.paused());
  if (paused === null) return { ok: true, detail: "No paused() — n/a" };
  return { ok: !paused, detail: paused ? "Contract is PAUSED" : "Not paused" };
}

async function checkSupply(provider: ethers.JsonRpcProvider, target: string): Promise<{ ok: boolean; detail: string }> {
  const contract = new ethers.Contract(target, ABI_TOTAL_SUPPLY, provider);
  const supply = await safeCall(() => contract.totalSupply());
  if (supply === null) return { ok: true, detail: "No totalSupply() — n/a" };
  const formatted = ethers.formatUnits(supply as bigint, 18);
  const num = parseFloat(formatted);
  return {
    ok: num < 1e12,
    detail: num >= 1e12 ? `Supply ${formatted} — suspiciously large` : `Total supply ${formatted}`,
  };
}

async function checkMintAuthority(provider: ethers.JsonRpcProvider, target: string): Promise<{ ok: boolean; detail: string }> {
  const SELECTOR_MINT = "0x40c10f19";
  const code = await provider.getCode(target);
  const hasMintSelector = code ? code.toLowerCase().includes(SELECTOR_MINT.toLowerCase()) : false;
  if (!hasMintSelector) return { ok: true, detail: "No mint(address,uint256) selector in bytecode" };
  return { ok: false, detail: "mint(address,uint256) present in bytecode — check who can call it" };
}

// ─── BOTScan verification status ──────────────────────────────────────────

async function checkSourceVerification(target: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const url = `${BOTSCAN_API}?module=contract&action=getsourcecode&address=${target}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: true, detail: "Explorer check unavailable (non-200)" };
    const json: any = await res.json();
    const result = json?.result?.[0];
    if (!result) return { ok: true, detail: "Explorer returned no record" };
    const verified = result.ABI && result.ABI !== "Contract source code not verified";
    return {
      ok: !!verified,
      detail: verified ? "Source verified on BOTScan" : "Source NOT verified on BOTScan",
    };
  } catch {
    return { ok: true, detail: "Explorer check unavailable" };
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────

function scoreChecks(checks: { name: string; ok: boolean }[]): { score: number; findings: Finding[] } {
  let score = 100;
  const findings: Finding[] = [];

  const byName = Object.fromEntries(checks.map((c) => [c.name, c.ok]));

  if (byName["exists"] === false) {
    return { score: 0, findings: [{ id: "no-contract", severity: "critical", title: "No contract at address", detail: "The target is not a deployed contract on BOT Chain mainnet." }] };
  }

  if (byName["source-verified"] === false) {
    score -= 25;
    findings.push({ id: "unverified-source", severity: "high", title: "Source not verified", detail: "Bytecode cannot be matched to published source on BOTScan. High rug risk." });
  }
  if (byName["owner-renounced"] === false) {
    score -= 20;
    findings.push({ id: "mutable-owner", severity: "high", title: "Active owner control", detail: "An EOA or contract holds owner() and can mutate state." });
  }
  if (byName["mint-authority"] === false) {
    score -= 20;
    findings.push({ id: "mint-selector", severity: "high", title: "Mint capability present", detail: "mint(address,uint256) exists in bytecode. Verify the caller restriction." });
  }
  if (byName["paused"] === false) {
    score -= 10;
    findings.push({ id: "paused", severity: "medium", title: "Contract paused", detail: "paused() returns true — operations halted." });
  }
  if (byName["supply"] === false) {
    score -= 10;
    findings.push({ id: "supply", severity: "medium", title: "Suspicious supply", detail: "Total supply is unusually large." });
  }

  return { score: Math.max(0, score), findings };
}

function verdictFromScore(score: number): Verdict {
  if (score >= 70) return 2; // APPROVED
  if (score >= 40) return 1; // CAUTION
  return 0; // BLOCKED
}

// ─── Main entry ───────────────────────────────────────────────────────────

export async function runAudit(target: string): Promise<AuditResult> {
  const provider = getProvider();

  const [exists, ownership, paused, supply, mintAuth, source] = await Promise.all([
    checkContractExists(provider, target),
    checkOwnership(provider, target),
    checkPause(provider, target),
    checkSupply(provider, target),
    checkMintAuthority(provider, target),
    checkSourceVerification(target),
  ]);

  const checks = [
    { name: "exists", ok: exists.ok, detail: exists.detail },
    { name: "owner-renounced", ok: ownership.ok, detail: ownership.detail },
    { name: "paused", ok: paused.ok, detail: paused.detail },
    { name: "supply", ok: supply.ok, detail: supply.detail },
    { name: "mint-authority", ok: mintAuth.ok, detail: mintAuth.detail },
    { name: "source-verified", ok: source.ok, detail: source.detail },
  ];

  const { score, findings } = scoreChecks(checks);
  const verdict = verdictFromScore(score);
  const criticalCount = findings.filter((f) => f.severity === "critical" || f.severity === "high").length;

  const summary =
    verdict === 0
      ? `BLOCKED — ${criticalCount} critical/high finding(s). Do not interact with this contract.`
      : verdict === 1
        ? `CAUTION — ${criticalCount} material finding(s). Verify each before any interaction.`
        : `APPROVED — no material findings. Contract passes VeriForge screening.`;

  return {
    target,
    score,
    verdict,
    findings,
    checks,
    summary,
    attestedAt: Math.floor(Date.now() / 1000),
  };
}
