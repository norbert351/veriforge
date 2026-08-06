"use client";

import { useCallback, useEffect, useState } from "react";
import { BrowserProvider } from "ethers";

// BOT Chain mainnet
const BOT_CHAIN_ID = 677;
const BOT_CHAIN_ID_HEX = "0x2a5";
const TARGET_NET = {
  chainId: BOT_CHAIN_ID_HEX,
  chainName: "BOT Chain Mainnet",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: ["https://rpc.botchain.ai"],
  blockExplorerUrls: ["https://scan.botchain.ai"],
} as const;

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

type Verdict = 0 | 1 | 2;

interface AuditResult {
  target: string;
  score: number;
  verdict: Verdict;
  summary: string;
  findings: { id: string; severity: string; title: string; detail: string }[];
  checks: { name: string; ok: boolean; detail: string }[];
  onChain?: { stored: boolean; txHash?: string; explorer?: string; reason?: string };
}

const VERDICT_LABEL: Record<number, string> = { 0: "BLOCKED", 1: "CAUTION", 2: "APPROVED" };
const VERDICT_COLOR: Record<number, string> = {
  0: "#f43f5e",
  1: "#f59e0b",
  2: "#10b981",
};

function getEth() {
  if (typeof window === "undefined") return null;
  return (window as any).ethereum || null;
}

export default function Home() {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<{ target: string; result: AuditResult } | null>(null);

  const connect = useCallback(async () => {
    const eth = getEth();
    if (!eth) {
      setError("No wallet detected. Install a wallet and switch to BOT Chain mainnet.");
      return;
    }
    try {
      const accounts = await eth.request({ method: "eth_requestAccounts" });
      setAddress(accounts[0]);
      const chain = await eth.request({ method: "eth_chainId" });
      setChainId(parseInt(chain, 16));
    } catch (e: any) {
      setError(e?.message || "Wallet connection failed");
    }
  }, []);

  const switchToBot = useCallback(async () => {
    const eth = getEth();
    if (!eth) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BOT_CHAIN_ID_HEX }] });
      setChainId(BOT_CHAIN_ID);
    } catch (e: any) {
      if (e?.code === 4902) {
        await eth.request({ method: "wallet_addEthereumChain", params: [TARGET_NET] });
        setChainId(BOT_CHAIN_ID);
      }
    }
  }, []);

  useEffect(() => {
    const eth = getEth();
    if (!eth) return;
    eth.on?.("accountsChanged", (accs: string[]) => setAddress(accs[0] || null));
    eth.on?.("chainChanged", (c: string) => setChainId(parseInt(c, 16)));
    return () => {
      eth.removeListener?.("accountsChanged", () => {});
      eth.removeListener?.("chainChanged", () => {});
    };
  }, []);

  const runVerify = useCallback(async () => {
    if (!target) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      // Step 1: probe the x402 gate (free GET-like call via POST without signature returns 402 challenge)
      const probe = await fetch(`${API}/v1/verify-rwa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target }),
      });
      if (probe.status !== 402) {
        const body = await probe.json();
        setResult(body);
        setChecked({ target, result: body });
        return;
      }
      // Step 2: paywall challenge received — surface it for now (web3 x402 client is the next layer)
      const challenge = probe.headers.get("payment-required") || "";
      setError(
        `Payment required: 0.5 USDT on BOT Chain. x402 web checkout is being wired — the API accepts PAYMENT-SIGNATURE headers. Challenge: ${challenge.slice(0, 60)}...`
      );
    } catch (e: any) {
      setError(e?.message || "Request failed");
    } finally {
      setBusy(false);
    }
  }, [target]);

  const lookup = useCallback(async (addr: string) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API}/v1/attestations/${addr}`);
      if (res.status === 404) {
        setError("No attestation on-chain for this address yet. Run a verification.");
        return;
      }
      const body = await res.json();
      setChecked({ target: addr, result: { ...body, findings: [], checks: [] } });
    } catch (e: any) {
      setError(e?.message || "Lookup failed");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2.5rem" }}>
        <div>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
            Veri<span style={{ color: "var(--vf-magenta)" }}>Forge</span>
          </h1>
          <p style={{ color: "#9ca3af", fontSize: "0.875rem" }}>AI RWA verification, forged on BOT Chain</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {chainId !== null && chainId !== BOT_CHAIN_ID && (
            <button onClick={switchToBot} style={btnStyle({ outline: true })}>
              Switch to BOT Chain
            </button>
          )}
          {!address ? (
            <button onClick={connect} style={btnStyle({})}>
              Connect Wallet
            </button>
          ) : (
            <span style={{ fontSize: "0.8rem", color: "#cbd5e1", background: "var(--vf-surface)", padding: "6px 12px", borderRadius: 999 }}>
              {address.slice(0, 6)}…{address.slice(-4)}
              {chainId === BOT_CHAIN_ID ? " · BOT" : " · wrong net"}
            </span>
          )}
        </div>
      </header>

      <section style={{ background: "var(--vf-surface)", border: "1px solid #23233a", borderRadius: 16, padding: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: 4 }}>Verify an RWA project</h2>
        <p style={{ color: "#9ca3af", fontSize: "0.85rem", marginBottom: 16 }}>
          Paste a contract address on BOT Chain mainnet. VeriForge runs real on-chain checks, scores risk 0-100, and stores the signed verdict on-chain.
        </p>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="0x… contract address"
            style={{
              flex: 1,
              background: "#0d0d1a",
              border: "1px solid #2c2c47",
              borderRadius: 10,
              padding: "10px 14px",
              color: "#fff",
              fontFamily: "monospace",
              fontSize: "0.85rem",
            }}
          />
          <button onClick={runVerify} disabled={busy || !target} style={btnStyle({ disabled: busy || !target })}>
            {busy ? "Verifying…" : "Verify (0.5 USDT)"}
          </button>
        </div>
        {address && chainId === BOT_CHAIN_ID && (
          <button onClick={() => lookup(target)} style={btnStyle({ outline: true, marginTop: 10 })}>
            Look up existing attestation
          </button>
        )}
        {error && <p style={{ color: "#fbbf24", fontSize: "0.85rem", marginTop: 12 }}>{error}</p>}
      </section>

      {result && (
        <section style={{ marginTop: "1.5rem", background: "var(--vf-surface)", border: "1px solid #23233a", borderRadius: 16, padding: "1.5rem" }}>
          <VerdictCard result={result} />
        </section>
      )}

      {checked && !result && (
        <section style={{ marginTop: "1.5rem", background: "var(--vf-surface)", border: "1px solid #23233a", borderRadius: 16, padding: "1.5rem" }}>
          <VerdictCard result={checked.result} />
        </section>
      )}

      <footer style={{ marginTop: "3rem", color: "#6b7280", fontSize: "0.75rem", textAlign: "center" }}>
        BOT Chain mainnet · chain 677 · x402 payments in USDT · verdicts stored on-chain
      </footer>
    </main>
  );
}

function VerdictCard({ result }: { result: AuditResult }) {
  const color = VERDICT_COLOR[result.verdict] || "#9ca3af";
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <span style={{ fontSize: "0.75rem", color: "#9ca3af", fontFamily: "monospace" }}>{result.target}</span>
          <h3 style={{ fontSize: "1.25rem", fontWeight: 800, color }}>
            {VERDICT_LABEL[result.verdict] || result.verdict}
          </h3>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "2rem", fontWeight: 800, color }}>{result.score}</div>
          <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>/ 100</div>
        </div>
      </div>
      <p style={{ color: "#d1d5db", fontSize: "0.9rem", marginBottom: 12 }}>{result.summary}</p>
      {result.onChain?.stored && (
        <p style={{ fontSize: "0.8rem", color: "#10b981" }}>
          Stored on-chain ·{" "}
          <a href={result.onChain.explorer} target="_blank" rel="noopener noreferrer" style={{ color: "#10b981", textDecoration: "underline" }}>
            view tx
          </a>
        </p>
      )}
      {result.onChain && !result.onChain.stored && (
        <p style={{ fontSize: "0.8rem", color: "#9ca3af" }}>On-chain store: {result.onChain.reason}</p>
      )}
      {result.checks && result.checks.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {result.checks.map((c) => (
            <div key={c.name} style={{ display: "flex", gap: 8, fontSize: "0.8rem", padding: "4px 0", color: c.ok ? "#10b981" : "#f43f5e" }}>
              <span>{c.ok ? "✓" : "✗"}</span>
              <span style={{ minWidth: 150, color: "#e5e7eb" }}>{c.name}</span>
              <span style={{ color: "#9ca3af" }}>{c.detail}</span>
            </div>
          ))}
        </div>
      )}
      {result.findings && result.findings.length > 0 && (
        <div style={{ marginTop: 12 }}>
          {result.findings.map((f) => (
            <div key={f.id} style={{ border: "1px solid #2c2c47", borderRadius: 8, padding: "8px 12px", marginBottom: 6 }}>
              <span style={{ fontSize: "0.7rem", textTransform: "uppercase", color: f.severity === "critical" || f.severity === "high" ? "#f43f5e" : "#f59e0b" }}>
                {f.severity}
              </span>
              <div style={{ fontSize: "0.85rem" }}>{f.title}</div>
              <div style={{ fontSize: "0.75rem", color: "#9ca3af" }}>{f.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function btnStyle({ outline, disabled, marginTop }: { outline?: boolean; disabled?: boolean; marginTop?: number }) {
  return {
    background: outline ? "transparent" : "var(--vf-magenta)",
    color: outline ? "var(--vf-magenta)" : "#fff",
    border: outline ? "1px solid var(--vf-magenta)" : "none",
    borderRadius: 10,
    padding: "10px 18px",
    fontWeight: 600,
    fontSize: "0.85rem",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    marginTop,
    whiteSpace: "nowrap" as const,
  };
}
