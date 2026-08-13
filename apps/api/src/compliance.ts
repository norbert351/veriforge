// VeriForge AI compliance gate — reviews issuer documentation and produces a
// compliance dossier with a verdict. The verdict drives the on-chain listing:
// IssuanceRegistry refuses anything that is not APPROVED.
//
// Primary rail: Claude via the AgentRouter gateway (Anthropic Messages API:
// POST {base}/v1/messages, Bearer auth, anthropic-version header, system in
// the top-level "system" field, max_tokens required). The gate is a REAL LLM
// call. No fabricated scores: if the LLM is unreachable, the gate fails loudly.

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

// ─── Rails ────────────────────────────────────────────────────────────────
// 1. PRIMARY: Claude via AgentRouter (Anthropic Messages API format).
const ANTHROPIC_KEY = process.env.ANTHROPIC_AUTH_TOKEN || "";
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || "https://agentrouter.org";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-8";
// 2. Legacy OpenAI-compatible proxy rail (freemodel) — availability fallback.
const GATE_URL = process.env.GATE_URL || "http://localhost:8799/v1/chat/completions";
const GATE_MODEL = process.env.GATE_MODEL || "gpt-5.6-terra";
const GATE_KEY = process.env.FREEMODEL_API_KEY || "";
// 3. OpenRouter — last-chance fallback. The dossier records which rail/model
// actually produced the verdict, so there is no silent substitution.
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
    return { score, verdict, findings, summary, checkedAt: Math.floor(Date.now() / 1000), model: "" };
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
  assetPhotos?: string[]; // uploaded asset photo URLs
}

// Static instructions + schema go in the Anthropic top-level "system" field.
function buildSystemPrompt(): string {
  return `You are the VeriForge AI compliance officer for BOT Chain, an RWA issuance platform.
Review the issuer's documentation for a tokenized real-world asset issuance and produce a compliance dossier.
Score 0-100 where >=70 is APPROVED, 40-69 is CAUTION, <40 is BLOCKED.

Check for: clear asset backing, defined terms and price, revenue model, jurisdiction/legal entity, no red flags (missing docs, vague promises, no revenue model, no backing).

The issuer also submits a structured asset declaration (signed, committed on-chain). Cross-check it against the free-text documentation. Flag CONSISTENCY ISSUES:
missing asset class, jurisdiction without a legal entity, backing proof type "none",
or docs that describe a different asset than the declaration. These are red flags.

Return ONLY JSON, no prose, no markdown fences:
{"score": <0-100 number>, "summary": "<1-2 sentence verdict>", "findings": [{"id":"<kebab-id>","severity":"critical|high|medium|low|info","title":"<short>","detail":"<specific>"}]}`;
}

// The issuance content goes in the user message.
function buildUserPrompt(doc: {
  name: string;
  symbol: string;
  docsText: string;
  docsUri?: string;
  assetMetadata?: AssetMetadata;
}): string {
  return `Structured asset declaration:
- Asset class: ${doc.assetMetadata?.assetClass || "NOT PROVIDED"}
- Jurisdiction: ${doc.assetMetadata?.jurisdiction || "NOT PROVIDED"}
- Legal entity: ${doc.assetMetadata?.legalEntity || "NOT PROVIDED"}
- Backing proof type: ${doc.assetMetadata?.backingProofType || "NOT PROVIDED"}
- Proof URI: ${doc.assetMetadata?.backingProofUri || "none"}
${Array.isArray(doc.assetMetadata?.assetPhotos) && doc.assetMetadata.assetPhotos.length
  ? `- Asset photos: ${doc.assetMetadata.assetPhotos.join(", ")}`
  : ""}

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
      model: ANTHROPIC_MODEL,
    };
  }

  const system = buildSystemPrompt();
  const userContent = buildUserPrompt(doc);
  const userMessages = [{ role: "user", content: userContent }];

  function fromText(text: string, model: string): ComplianceDossier {
    const dossier = parseDossier(text);
    if (!dossier) {
      throw new Error("AI gate returned unparseable output — refusing to fabricate a verdict.");
    }
    dossier.model = model;
    return dossier;
  }

  // Rail 1: Claude via AgentRouter (Anthropic Messages API).
  async function callAnthropic(): Promise<ComplianceDossier> {
    if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_AUTH_TOKEN not set");
    const res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ANTHROPIC_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 900,
        temperature: 0.2,
        system,
        messages: userMessages,
      }),
      signal: AbortSignal.timeout(90000),
    });

    if (!res.ok) {
      throw new Error(`AgentRouter upstream error ${res.status}: ${await res.text().catch(() => "")}`);
    }

    const json: any = await res.json();
    const text: string = json?.content?.find((b: any) => b?.type === "text")?.text || "";
    if (!text) throw new Error("AgentRouter returned no text content block");
    return fromText(text, ANTHROPIC_MODEL);
  }

  // Rail 2: OpenAI-compatible proxy (freemodel).
  async function callOpenAI(url: string, model: string, key: string): Promise<ComplianceDossier> {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, ...userMessages],
        max_tokens: 900,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      throw new Error(`AI gate upstream error ${res.status}: ${await res.text().catch(() => "")}`);
    }

    const json: any = await res.json();
    const content: string = json?.choices?.[0]?.message?.content || "";
    return fromText(content, model);
  }

  // Claude first, then the legacy proxy, then OpenRouter. All fail loudly.
  try {
    return await callAnthropic();
  } catch (primaryErr) {
    try {
      return await callOpenAI(GATE_URL, GATE_MODEL, GATE_KEY);
    } catch (proxyErr) {
      if (FALLBACK_URL) {
        try {
          return await callOpenAI(FALLBACK_URL, FALLBACK_MODEL, FALLBACK_KEY);
        } catch (fallbackErr) {
          throw new Error(
            `AI gate unreachable (claude: ${(primaryErr as Error).message}; proxy: ${(proxyErr as Error).message}; fallback: ${(fallbackErr as Error).message})`
          );
        }
      }
      throw new Error(
        `AI gate unreachable (claude: ${(primaryErr as Error).message}; proxy: ${(proxyErr as Error).message})`
      );
    }
  }
}
