// VeriForge AI compliance gate — reviews issuer documentation and produces a
// compliance dossier with a verdict. The verdict drives the on-chain listing:
// IssuanceRegistry refuses anything that is not APPROVED.
//
// The gate is a REAL LLM call (gpt-5.6-terra via the local freemodel proxy).
// No fabricated scores: if the LLM is unreachable, the gate fails loudly.

export type Verdict = 0 | 1 | 2; // BLOCKED / CAUTION / APPROVED

export interface GateFinding {
  id: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  detail: string;
}

export interface ComplianceDossier {
  score: number; // 0-100
  verdict: Verdict;
  findings: GateFinding[];
  summary: string;
  checkedAt: number;
  model: string;
}

const GATE_URL = process.env.GATE_URL || "http://localhost:8799/v1/chat/completions";
const GATE_MODEL = process.env.GATE_MODEL || "gpt-5.6-terra";
const GATE_KEY = process.env.FREEMODEL_API_KEY || "";
// Fallback rail: if the primary gate upstream is down (container
// provisioning, outage, rate limit), the gate fails over to a second
// OpenAI-compatible endpoint so issuance can keep working. The dossier
// records which model actually produced the verdict.
const FALLBACK_URL = process.env.FALLBACK_GATE_URL || "";
const FALLBACK_MODEL = process.env.FALLBACK_GATE_MODEL || "openai/gpt-4o-mini";
const FALLBACK_KEY = process.env.FALLBACK_GATE_KEY || process.env.OPENROUTER_API_KEY || "";

const APPROVE_THRESHOLD = 70;
const CAUTION_THRESHOLD = 40;

function parseScore(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function parseDossier(text: string): ComplianceDossier | null {
  try {
    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const data = JSON.parse(cleaned.slice(start, end + 1));
    const score = parseScore(data.score);
    const findings: GateFinding[] = Array.isArray(data.findings) ? data.findings : [];
    const summary = typeof data.summary === "string" ? data.summary : "No summary provided.";
    let verdict: Verdict;
    if (score >= APPROVE_THRESHOLD) verdict = 2;
    else if (score >= CAUTION_THRESHOLD) verdict = 1;
    else verdict = 0;
    return { score, verdict, findings, summary, checkedAt: Math.floor(Date.now() / 1000), model: GATE_MODEL };
  } catch {
    return null;
  }
}

export interface AssetMetadata {
  assetClass: string; // e.g. real-estate, invoice, bond, commodity
  jurisdiction: string; // e.g. UK, DE, US-Delaware
  legalEntity: string; // registered entity name
  backingProofType: string; // title-deed, escrow, invoice, custody, none
  backingProofUri?: string; // link to the proof document
}

function buildPrompt(doc: {
  name: string;
  symbol: string;
  docsText: string;
  docsUri?: string;
  assetMetadata?: AssetMetadata;
}): string {
  return `You are the VeriForge AI compliance officer for BOT Chain, an RWA issuance platform.
Review the issuer's documentation for a tokenized real-world asset issuance and produce a compliance dossier.
Score 0-100 where >=70 is APPROVED, 40-69 is CAUTION, <40 is BLOCKED.

Check for: clear asset backing, defined terms and price, revenue model, jurisdiction/legal entity, no red flags (missing docs, vague promises, no revenue model, no backing).

Structured asset declaration (issuer-signed, committed on-chain):
- Asset class: ${doc.assetMetadata?.assetClass || "NOT PROVIDED"}
- Jurisdiction: ${doc.assetMetadata?.jurisdiction || "NOT PROVIDED"}
- Legal entity: ${doc.assetMetadata?.legalEntity || "NOT PROVIDED"}
- Backing proof type: ${doc.assetMetadata?.backingProofType || "NOT PROVIDED"}
- Proof URI: ${doc.assetMetadata?.backingProofUri || "none"}

Cross-check the structured declaration against the free-text documentation. Flag CONSISTENCY ISSUES:
missing asset class, jurisdiction without a legal entity, backing proof type "none",
or docs that describe a different asset than the declaration. These are red flags.

Return ONLY JSON:
{"score": <0-100 number>, "summary": "<1-2 sentence verdict>", "findings": [{"id":"<kebab-id>","severity":"critical|high|medium|low|info","title":"<short>","detail":"<specific>"}]}

Issuance name: ${doc.name} (${doc.symbol})
Documentation URI: ${doc.docsUri || "none"}
Issuer documentation:
---
${doc.docsText.slice(0, 6000)}
---`;
}

export async function runComplianceGate(doc: {
  name: string;
  symbol: string;
  docsText: string;
  docsUri?: string;
  assetMetadata?: AssetMetadata;
}): Promise<ComplianceDossier> {
  if (!doc.docsText || doc.docsText.trim().length < 40) {
    // No real documentation to review — this is itself a red flag, not a fake pass.
    return {
      score: 10,
      verdict: 0,
      findings: [
        {
          id: "no-documentation",
          severity: "critical",
          title: "No issuer documentation provided",
          detail: "The AI gate cannot approve an issuance with no asset documentation.",
        },
      ],
      summary: "BLOCKED — no documentation to review.",
      checkedAt: Math.floor(Date.now() / 1000),
      model: GATE_MODEL,
    };
  }

  const prompt = buildPrompt(doc);
  const payload = {
    model: GATE_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 900,
    temperature: 0.2,
  };

  async function callGate(url: string, model: string, key: string): Promise<ComplianceDossier> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ ...payload, model }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      throw new Error(`AI gate upstream error ${res.status}: ${await res.text().catch(() => "")}`);
    }

    const json: any = await res.json();
    const content: string = json?.choices?.[0]?.message?.content || "";
    const dossier = parseDossier(content);
    if (!dossier) {
      throw new Error("AI gate returned unparseable output — refusing to fabricate a verdict.");
    }
    dossier.model = model;
    return dossier;
  }

  // Primary rail first, fallback rail second. Both fail loudly.
  try {
    return await callGate(GATE_URL, GATE_MODEL, GATE_KEY);
  } catch (primaryErr) {
    if (FALLBACK_URL) {
      try {
        return await callGate(FALLBACK_URL, FALLBACK_MODEL, FALLBACK_KEY);
      } catch (fallbackErr) {
        throw new Error(
          `AI gate unreachable (primary: ${(primaryErr as Error).message}; fallback: ${(fallbackErr as Error).message})`
        );
      }
    }
    throw primaryErr;
  }
}
