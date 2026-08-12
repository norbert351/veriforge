"use client";

import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, parseUnits, formatUnits } from "ethers";
import { useAccount, useSwitchChain } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { botChain } from "@/lib/wagmi-config";
import Reveal from "@/components/Reveal";

// BOT Chain mainnet (677) by default; Bohr testnet (968) via env at build time
const BOT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_BOT_CHAIN_ID || 677);
const CHAIN_LABEL = process.env.NEXT_PUBLIC_BOT_CHAIN_NAME || "BOT Chain mainnet";

// API is same-origin — the web server proxies /v1/* to the API (next.config rewrites).
const API = "";
const USDT = process.env.NEXT_PUBLIC_USDT || "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C";

interface Issuance {
  id: number;
  issuer: string;
  token: string;
  distributor: string;
  name: string;
  symbol: string;
  pricePerTokenUsdt: string;
  totalSupply: string;
  docsUri: string;
  accDividendPerToken: string;
  listedAt: number;
  blockNumber: number;
  explorer: string;
}

interface Dossier {
  score: number;
  verdict: number;
  findings: { id: string; severity: string; title: string; detail: string }[];
  summary: string;
  model: string;
}

const VERDICT_LABEL: Record<number, string> = { 0: "BLOCKED", 1: "CAUTION", 2: "APPROVED" };
const VERDICT_COLOR: Record<number, string> = { 0: "#f43f5e", 1: "#f59e0b", 2: "#10b981" };

const RWATOKEN_ABI = [
  "function buy(uint256 usdtAmount) returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function pricePerToken() view returns (uint256)",
];
const DISTRIBUTOR_ABI = ["function claim() returns (uint256)", "function claimable(address) view returns (uint256)", "function deposit(uint256)"];
const ERC20_ABI = ["function approve(address,uint256)", "function allowance(address,address) view returns (uint256)", "function transfer(address,uint256)"];

// EIP-712 domain/types for x402 exact-scheme signing (mirrors the API gate).
const EIP712_TYPES = {
  Payment: [
    { name: "scheme", type: "string" },
    { name: "network", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "asset", type: "address" },
    { name: "amount", type: "string" },
    { name: "payTo", type: "address" },
    { name: "maxTimeoutSeconds", type: "uint256" },
    { name: "description", type: "string" },
    { name: "extra", type: "string" },
  ],
};

function paymentMessage(accepted: any) {
  return {
    scheme: String(accepted.scheme || "exact"),
    network: String(accepted.network || ""),
    chainId: BigInt(accepted.chainId || BOT_CHAIN_ID),
    asset: String(accepted.asset || USDT),
    amount: String(accepted.amount || ""),
    payTo: String(accepted.payTo || ""),
    maxTimeoutSeconds: BigInt(accepted.maxTimeoutSeconds || 300),
    description: String(accepted.description || ""),
    extra: typeof accepted.extra === "string" ? accepted.extra : JSON.stringify(accepted.extra || {}),
  };
}

// Full x402 checkout: probe → 402 challenge → wallet signs + pays → replay.
async function paidPost(path: string, body: unknown): Promise<Response> {
  const probe = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (probe.status !== 402) return probe;

  const challengeB64 = probe.headers.get("payment-required");
  if (!challengeB64) return probe;
  const challenge = JSON.parse(atob(challengeB64));
  const accepted = challenge.accepts?.[0];
  if (!accepted) return probe;

  const eth = getEth();
  if (!eth) throw new Error("No wallet detected. Connect your wallet to pay via x402.");
  const provider = new BrowserProvider(eth);
  const signer = await provider.getSigner();
  const payer = (await signer.getAddress()).toLowerCase();

  // 1. Send the exact USDT amount to payTo (the on-chain settlement).
  const usdt = new Contract(accepted.asset, ERC20_ABI, signer);
  const amount = BigInt(accepted.amount);
  const tx = await usdt.transfer(accepted.payTo, amount);
  await tx.wait();

  // 2. Sign the accepted entry (EIP-712), bound to amount/payTo/chainId/asset.
  const domain = { name: "x402", version: "2", chainId: BOT_CHAIN_ID };
  const signature = await signer.signTypedData(domain, EIP712_TYPES, paymentMessage(accepted));

  // 3. Replay with the payment proof.
  const header = btoa(JSON.stringify({ accepted, signature, payer }));
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": header },
    body: JSON.stringify(body),
  });
}

function getEth() {
  if (typeof window === "undefined") return null;
  return (window as any).ethereum || null;
}

export default function Home() {
  // wagmi-managed wallet state (RainbowKit ConnectButton drives connection)
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [tab, setTab] = useState<"launch" | "market">("market");

  // issuer form
  const [fName, setFName] = useState("");
  const [fSymbol, setFSymbol] = useState("");
  const [fPrice, setFPrice] = useState("");
  const [fDocs, setFDocs] = useState("");
  const [fDocsUri, setFDocsUri] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<any>(null);

  // market
  const [issuances, setIssuances] = useState<Issuance[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [claimables, setClaimables] = useState<Record<number, string>>({});

  const switchToBot = useCallback(async () => {
    try {
      await switchChainAsync({ chainId: BOT_CHAIN_ID });
    } catch (e: any) {
      if (e?.code === 4902) {
        setError("BOT Chain not in this wallet. Add it manually: chain " + BOT_CHAIN_ID + ", RPC " + (process.env.NEXT_PUBLIC_BOT_RPC || "https://rpc.botchain.ai"));
      } else {
        setError(e?.shortMessage || e?.message || "Chain switch failed");
      }
    }
  }, [switchChainAsync]);

  const loadIssuances = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API}/v1/issuances`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      setIssuances(data.issuances || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load issuances");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    loadIssuances();
  }, [loadIssuances]);

  const loadClaimables = useCallback(async () => {
    if (!address) return;
    const next: Record<number, string> = {};
    for (const i of issuances) {
      try {
        const res = await fetch(`${API}/v1/issuances/${i.id}/claimable/${address}`);
        if (res.ok) {
          const d = await res.json();
          next[i.id] = d.claimable_usdt;
        }
      } catch {
        // ignore per-issuance failures
      }
    }
    setClaimables(next);
  }, [address, issuances]);

  useEffect(() => {
    loadClaimables();
  }, [loadClaimables]);

  const launchIssuance = useCallback(async () => {
    if (!fName || !fSymbol || !fPrice || !fDocs) {
      setError("All fields are required. The AI gate reviews your documentation.");
      return;
    }
    setLaunching(true);
    setError("");
    setNotice("");
    setLaunchResult(null);
    try {
      // x402 checkout: probe → 402 → wallet signs + transfers USDT → replay.
      const res = await paidPost("/v1/issuances", {
        name: fName,
        symbol: fSymbol,
        pricePerTokenUsdt: parseFloat(fPrice),
        docsText: fDocs,
        docsUri: fDocsUri,
      });
      if (res.status === 402) {
        const body = await res.json();
        setNotice(`Payment required: ${body.message || "1 USDT on BOT Chain"}. Confirm the transfer and signature in your wallet.`);
        return;
      }
      const body = await res.json();
      setLaunchResult(body);
      if (body?.listed) {
        setFName(""); setFSymbol(""); setFPrice(""); setFDocs(""); setFDocsUri("");
        loadIssuances();
      }
    } catch (e: any) {
      setError(e?.message || "Launch failed");
    } finally {
      setLaunching(false);
    }
  }, [fName, fSymbol, fPrice, fDocs, fDocsUri, loadIssuances]);

  const buyUnits = useCallback(
    async (iss: Issuance, usdtAmount: string) => {
      const eth = getEth();
      if (!eth || !address) {
        setError("Connect wallet first");
        return;
      }
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const provider = new BrowserProvider(eth);
        const signer = await provider.getSigner();
        const amount = parseUnits(usdtAmount, 6);

        // approve USDT to the token contract
        const usdt = new Contract(USDT, ERC20_ABI, signer);
        const allowance = await usdt.allowance(address, iss.token);
        if (allowance < amount) {
          const tx = await usdt.approve(iss.token, amount);
          await tx.wait();
          setNotice("USDT approved. Confirm the buy transaction.");
        }

        const token = new Contract(iss.token, RWATOKEN_ABI, signer);
        const buyTx = await token.buy(amount);
        await buyTx.wait();
        setNotice(`Bought ${usdtAmount} USDT of ${iss.symbol}. Units added to your wallet.`);
        loadIssuances();
        setTimeout(loadClaimables, 500);
      } catch (e: any) {
        setError(e?.reason || e?.shortMessage || e?.message || "Buy failed");
      } finally {
        setBusy(false);
      }
    },
    [address, loadIssuances, loadClaimables]
  );

  const claimRevenue = useCallback(
    async (iss: Issuance) => {
      const eth = getEth();
      if (!eth || !address) {
        setError("Connect wallet first");
        return;
      }
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const provider = new BrowserProvider(eth);
        const signer = await provider.getSigner();
        const distributor = new Contract(iss.distributor, DISTRIBUTOR_ABI, signer);
        const tx = await distributor.claim();
        await tx.wait();
        setNotice(`Claimed revenue from ${iss.symbol}. USDT sent to your wallet.`);
        setTimeout(loadClaimables, 500);
      } catch (e: any) {
        setError(e?.reason || e?.shortMessage || e?.message || "Claim failed");
      } finally {
        setBusy(false);
      }
    },
    [address, loadClaimables]
  );

  const depositRevenue = useCallback(
    async (iss: Issuance, usdtAmount: string) => {
      const eth = getEth();
      if (!eth || !address) {
        setError("Connect wallet first");
        return;
      }
      setBusy(true);
      setError("");
      setNotice("");
      try {
        const provider = new BrowserProvider(eth);
        const signer = await provider.getSigner();
        const amount = parseUnits(usdtAmount, 6);

        // approve USDT to the distributor, then deposit
        const usdt = new Contract(USDT, ERC20_ABI, signer);
        const allowance = await usdt.allowance(address, iss.distributor);
        if (allowance < amount) {
          const tx = await usdt.approve(iss.distributor, amount);
          await tx.wait();
          setNotice("USDT approved. Confirm the deposit transaction.");
        }

        const distributor = new Contract(iss.distributor, DISTRIBUTOR_ABI, signer);
        const tx = await distributor.deposit(amount);
        await tx.wait();
        setNotice(`Deposited ${usdtAmount} USDT revenue into ${iss.symbol}. Holders can claim their share now.`);
        loadIssuances();
        setTimeout(loadClaimables, 500);
      } catch (e: any) {
        setError(e?.reason || e?.shortMessage || e?.message || "Deposit failed");
      } finally {
        setBusy(false);
      }
    },
    [address, loadIssuances, loadClaimables]
  );

  const balanceHint = useCallback(async (iss: Issuance): Promise<string> => {
    const eth = getEth();
    if (!eth || !address) return "";
    try {
      const provider = new BrowserProvider(eth);
      const token = new Contract(iss.token, RWATOKEN_ABI, provider);
      const bal = await token.balanceOf(address);
      if (bal === 0n) return "";
      return formatUnits(bal, 18);
    } catch {
      return "";
    }
  }, [address]);

  return (
    <main>
      {/* ── Nav ── */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0.9rem 1.5rem",
          background: "rgba(10, 10, 20, 0.82)",
          backdropFilter: "blur(10px)",
          borderBottom: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: "1.3rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
            Veri<span style={{ color: "var(--vf-magenta)" }}>Forge</span>
          </div>
        </div>
        <nav style={{ display: "flex", gap: 22, alignItems: "center" }}>
          <a href="#assets" className="gr-link" style={{ fontSize: "0.9rem" }}>RWA Assets</a>
          <a href="#how" className="gr-link" style={{ fontSize: "0.9rem" }}>How it works</a>
          <a href="#marketplace" className="gr-link" style={{ fontSize: "0.9rem" }}>Marketplace</a>
          {chainId !== undefined && chainId !== null && chainId !== BOT_CHAIN_ID && (
            <button onClick={switchToBot} className="gr-btn gr-btn-outline" style={{ padding: "0.5rem 1rem", fontSize: "0.85rem" }}>
              Switch to BOT Chain
            </button>
          )}
          <ConnectButton chainStatus="icon" showBalance={false} accountStatus="address" />
        </nav>
      </header>

      {/* ── Hero: motion-picture RWA showcase ── */}
      <HeroSection />

      {/* ── Film-style asset ticker ── */}
      <Ticker />

      {/* ── RWA asset classes ── */}
      <AssetsSection />

      {/* ── How it works / about the project ── */}
      <HowItWorksSection />

      {/* ── Marketplace (the product) ── */}
      <section id="marketplace" className="vf-section" style={{ paddingTop: "2.5rem" }}>
        <Reveal>
          <p className="vf-eyebrow" style={{ marginBottom: 8 }}>The marketplace</p>
          <h2 className="vf-h2" style={{ marginBottom: 20 }}>
            Live on {CHAIN_LABEL}
          </h2>
        </Reveal>
        <div style={{ display: "flex", gap: 8, marginBottom: "1.5rem" }}>
          <button onClick={() => setTab("market")} style={tabStyle(tab === "market")}>
            Market
          </button>
          <button onClick={() => setTab("launch")} style={tabStyle(tab === "launch")}>
            Launch an asset
          </button>
        </div>

      {tab === "launch" && (
        <section style={{ background: "var(--vf-surface)", border: "1px solid #23233a", borderRadius: 16, padding: "1.5rem" }}>
          <h2 style={{ fontSize: "1.1rem", fontWeight: 700, marginBottom: 4 }}>Tokenize a real-world asset</h2>
          <p style={{ color: "#9ca3af", fontSize: "0.85rem", marginBottom: 16 }}>
            VeriForge&apos;s AI compliance officer reviews your documentation. Only issuances that pass the gate get listed on-chain — the registry refuses the rest.
          </p>
          <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
            <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Asset name (e.g. Lagos Warehouse REIT)" style={inputStyle} />
            <input value={fSymbol} onChange={(e) => setFSymbol(e.target.value)} placeholder="SYMBOL" style={{ ...inputStyle, maxWidth: 130 }} />
            <input value={fPrice} onChange={(e) => setFPrice(e.target.value)} placeholder="Price per unit (USDT)" type="number" step="0.01" style={{ ...inputStyle, maxWidth: 170 }} />
          </div>
          <input value={fDocsUri} onChange={(e) => setFDocsUri(e.target.value)} placeholder="Docs URI (optional, e.g. ipfs://…)" style={{ ...inputStyle, marginBottom: 10 }} />
          <textarea
            value={fDocs}
            onChange={(e) => setFDocs(e.target.value)}
            placeholder={"Issuer documentation — the AI gate reads this. Include: asset backing, value and audit, revenue model, legal entity and jurisdiction, token terms, custody."}
            rows={7}
            style={{ ...inputStyle, width: "100%", resize: "vertical", fontFamily: "inherit", marginBottom: 14 }}
          />
          <button onClick={launchIssuance} disabled={launching} style={btnStyle({ disabled: launching })}>
            {launching ? "Running AI compliance gate…" : "Launch issuance (1 USDT via x402)"}
          </button>
          {notice && <p style={{ color: "#fbbf24", fontSize: "0.85rem", marginTop: 12 }}>{notice}</p>}
          {error && <p style={{ color: "#f43f5e", fontSize: "0.85rem", marginTop: 12 }}>{error}</p>}
          {launchResult && <DossierCard result={launchResult} />}
        </section>
      )}

      {tab === "market" && (
        <section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h2 style={{ fontSize: "1.1rem", fontWeight: 700 }}>Live issuances ({issuances.length})</h2>
            <button onClick={loadIssuances} style={btnStyle({ outline: true })}>
              Refresh
            </button>
          </div>
          {busy && !issuances.length && <p style={{ color: "#9ca3af" }}>Loading…</p>}
          {error && <p style={{ color: "#f43f5e", fontSize: "0.85rem", marginBottom: 12 }}>{error}</p>}
          {notice && <p style={{ color: "#10b981", fontSize: "0.85rem", marginBottom: 12 }}>{notice}</p>}
          {issuances.length === 0 && !busy && (
            <p style={{ color: "#9ca3af", background: "var(--vf-surface)", border: "1px dashed #2c2c47", borderRadius: 12, padding: "2rem", textAlign: "center" }}>
              No issuances yet. The AI gate has to approve one before it can appear here.
            </p>
          )}
          <div style={{ display: "grid", gap: 12 }}>
            {issuances.map((iss) => (
              <IssuanceCard
                key={iss.id}
                iss={iss}
                claimable={claimables[iss.id]}
                onBuy={(amt) => buyUnits(iss, amt)}
                onClaim={() => claimRevenue(iss)}
                onDeposit={(amt) => depositRevenue(iss, amt)}
                balanceHint={balanceHint}
              />
            ))}
          </div>
        </section>
      )}

      </section>

      <footer
        style={{
          marginTop: "3rem",
          padding: "2.5rem 1.5rem 3rem",
          color: "#6b7280",
          fontSize: "0.8rem",
          textAlign: "center",
          borderTop: "1px solid rgba(255,255,255,0.07)",
        }}
      >
        <div style={{ marginBottom: 6 }}>
          Veri<span style={{ color: "var(--vf-magenta)" }}>Forge</span> — {CHAIN_LABEL} · chain {BOT_CHAIN_ID} · AI-gated issuance · revenue claims in USDT · platform holds no funds
        </div>
        <div style={{ fontSize: "0.72rem" }}>BOT Chain Builder Challenge #2 · AI × RWA · Deadline Aug 20 2026</div>
      </footer>
    </main>
  );
}

function IssuanceCard({
  iss,
  claimable,
  onBuy,
  onClaim,
  onDeposit,
  balanceHint,
}: {
  iss: Issuance;
  claimable?: string;
  onBuy: (amt: string) => void;
  onClaim: () => void;
  onDeposit: (amt: string) => void;
  balanceHint: (iss: Issuance) => Promise<string>;
}) {
  const [amount, setAmount] = useState("10");
  const [depositAmt, setDepositAmt] = useState("50");
  const [units, setUnits] = useState("");

  useEffect(() => {
    let live = true;
    balanceHint(iss).then((u) => live && setUnits(u));
    return () => {
      live = false;
    };
  }, [iss, balanceHint]);

  const price = parseFloat(iss.pricePerTokenUsdt);

  return (
    <div style={{ background: "var(--vf-surface)", border: "1px solid #23233a", borderRadius: 16, padding: "1.25rem 1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800 }}>{iss.name || "—"}</h3>
            <span style={{ fontSize: "0.7rem", color: "var(--vf-magenta)", background: "rgba(217,70,239,0.12)", padding: "2px 8px", borderRadius: 999 }}>
              {iss.symbol}
            </span>
          </div>
          <p style={{ color: "#9ca3af", fontSize: "0.8rem", fontFamily: "monospace", marginTop: 4 }}>
            #{iss.id} · token {iss.token.slice(0, 8)}…{iss.token.slice(-4)}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "1.25rem", fontWeight: 800 }}>${price}</div>
          <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>per unit</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 16, fontSize: "0.8rem", color: "#9ca3af", marginBottom: 12 }}>
        <span>Supply: {parseFloat(iss.totalSupply).toLocaleString()} units</span>
        <a href={iss.explorer} target="_blank" rel="noopener noreferrer" style={{ color: "var(--vf-magenta)" }}>
          view on BOTScan ↗
        </a>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="0.01" min="0" style={{ ...inputStyle, maxWidth: 130 }} />
        <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>USDT</span>
        <button onClick={() => onBuy(amount)} style={btnStyle({})}>
          Buy
        </button>
        {units && <span style={{ fontSize: "0.8rem", color: "#10b981" }}>{parseFloat(units).toFixed(2)} units held</span>}
        {claimable !== undefined && parseFloat(claimable || "0") > 0 && (
          <button onClick={onClaim} style={btnStyle({ outline: true })}>
            Claim {claimable} USDT
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, paddingTop: 10, borderTop: "1px dashed #23233a" }}>
        <span style={{ fontSize: "0.75rem", color: "#9ca3af", whiteSpace: "nowrap" }}>Issuer · deposit revenue</span>
        <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} type="number" step="0.01" min="0" style={{ ...inputStyle, maxWidth: 110 }} />
        <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>USDT</span>
        <button onClick={() => onDeposit(depositAmt)} style={btnStyle({ outline: true })}>
          Deposit
        </button>
        <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>→ pro-rata to holders</span>
      </div>
    </div>
  );
}

function DossierCard({ result }: { result: any }) {
  const d: Dossier | undefined = result?.dossier || result;
  if (!d) return null;
  const color = VERDICT_COLOR[d.verdict] || "#9ca3af";
  return (
    <div style={{ marginTop: 16, border: "1px solid #2c2c47", borderRadius: 12, padding: "1rem 1.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em", color }}>
          AI compliance gate
        </span>
        <span style={{ fontSize: "1.4rem", fontWeight: 800, color }}>
          {d.score}/100 · {VERDICT_LABEL[d.verdict] || d.verdict}
        </span>
      </div>
      <p style={{ color: "#d1d5db", fontSize: "0.9rem", marginBottom: 10 }}>{d.summary}</p>
      {result?.ok && result?.onChain && (
        <p style={{ fontSize: "0.8rem", color: "#10b981", marginBottom: 8 }}>
          Listed on-chain ·{" "}
          <a href={result.onChain.explorer} target="_blank" rel="noopener noreferrer" style={{ color: "#10b981", textDecoration: "underline" }}>
            view tx
          </a>
        </p>
      )}
      {d.findings?.length > 0 && (
        <div>
          {d.findings.map((f) => (
            <div key={f.id} style={{ border: "1px solid #2c2c47", borderRadius: 8, padding: "6px 10px", marginBottom: 6, fontSize: "0.8rem" }}>
              <span style={{ textTransform: "uppercase", color: f.severity === "critical" || f.severity === "high" ? "#f43f5e" : "#f59e0b" }}>
                {f.severity}
              </span>{" "}
              <span style={{ color: "#e5e7eb" }}>{f.title}</span>
              <div style={{ color: "#9ca3af" }}>{f.detail}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "#0d0d1a",
  border: "1px solid #2c2c47",
  borderRadius: 10,
  padding: "10px 14px",
  color: "#fff",
  fontSize: "0.85rem",
  flex: 1,
};

function btnStyle({ outline, disabled }: { outline?: boolean; disabled?: boolean }) {
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
    whiteSpace: "nowrap" as const,
  };
}

function tabStyle(active: boolean) {
  return {
    background: active ? "var(--vf-magenta)" : "transparent",
    color: active ? "#fff" : "#9ca3af",
    border: active ? "none" : "1px solid #2c2c47",
    borderRadius: 10,
    padding: "8px 16px",
    fontWeight: 600,
    fontSize: "0.85rem",
    cursor: "pointer",
  };
}

/* ================= Landing sections (cinematic RWA showcase) ================= */

const RWA_ASSETS = [
  { img: "/images/rwa-estate.jpg", name: "Real Estate", desc: "Offices, warehouses and developments tokenized as yield-bearing units." },
  { img: "/images/rwa-gold.jpg", name: "Gold & Metals", desc: "Bullion and precious metals with audited, verifiable custody." },
  { img: "/images/rwa-commodities.jpg", name: "Commodities", desc: "Energy, metals and raw materials priced and settled on-chain." },
  { img: "/images/rwa-port.jpg", name: "Logistics & Ports", desc: "Shipping, warehousing and supply-chain infrastructure cash flows." },
  { img: "/images/rwa-farmland.jpg", name: "Agriculture & Land", desc: "Farmland and crop-yield assets backed by real harvest revenue." },
  { img: "/images/rwa-art.jpg", name: "Art & Collectibles", desc: "Gallery-grade works opened to fractional, compliant ownership." },
  { img: "/images/rwa-invoices.jpg", name: "Invoices & Trade", desc: "Invoice finance and trade receivables turned liquid on-chain." },
  { img: "/images/rwa-documents.jpg", name: "Treasury & Paper", desc: "Bond-like instruments and document-backed fixed income." },
];

const PIPELINE_STEPS = [
  { n: "01", t: "Document the asset", d: "Issuers file real terms, a revenue source and the supporting paperwork." },
  { n: "02", t: "AI compliance gate", d: "A real LLM scores the documentation 0-100 and the verdict lands on-chain." },
  { n: "03", t: "List on BOT Chain", d: "The issuance registry refuses anything that is not APPROVED. No bypass." },
  { n: "04", t: "Buy with USDT", d: "Investors buy units and payment flows straight to the issuer." },
  { n: "05", t: "Claim revenue", d: "Holders pull their pro-rata share of deposited revenue, anytime." },
];

const HERO_SLIDES = [
  { src: "/images/hero-skyline.jpg", alt: "City skyline under a dramatic sky — real estate as an on-chain asset" },
  { src: "/images/hero-port.jpg", alt: "Aerial view of a container port — logistics infrastructure tokenized" },
  { src: "/images/hero-warehouse.jpg", alt: "Aerial view of industrial warehouses — yield-bearing property" },
];

function HeroSection() {
  return (
    <section className="vf-hero">
      {HERO_SLIDES.map((s, i) => (
        <div key={i} className="vf-hero-slide">
          <img src={s.src} alt={s.alt} />
        </div>
      ))}
      <div className="vf-hero-scrim" />
      <div className="vf-hero-glow" />
      <div
        style={{
          position: "relative",
          zIndex: 2,
          textAlign: "center",
          padding: "7rem 1.5rem 8rem",
          maxWidth: 920,
        }}
      >
        <p className="vf-hero-eyebrow vf-eyebrow" style={{ marginBottom: 18 }}>
          BOT Chain Builder Challenge · AI × RWA
        </p>
        <h1
          className="vf-hero-title"
          style={{
            fontSize: "clamp(2.6rem, 7vw, 4.6rem)",
            fontWeight: 900,
            letterSpacing: "-0.03em",
            lineHeight: 1.04,
            margin: "0 0 1.25rem",
          }}
        >
          Real-world assets,
          <br />
          forged <span style={{ color: "var(--vf-magenta)" }}>on-chain</span>.
        </h1>
        <p
          className="vf-hero-sub"
          style={{
            fontSize: "clamp(1rem, 2.2vw, 1.25rem)",
            color: "rgba(245,245,250,0.85)",
            maxWidth: 640,
            margin: "0 auto 2rem",
            lineHeight: 1.65,
          }}
        >
          Issuers document a real asset. The VeriForge AI compliance officer scores the
          documentation, and only APPROVED issuances list on BOT Chain. Investors buy units
          with USDT and claim revenue pro-rata. The platform never holds your funds.
        </p>
        <div className="vf-hero-cta" style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <a href="#assets" className="gr-btn">Explore RWA assets</a>
          <a href="#marketplace" className="gr-btn gr-btn-outline">Enter the marketplace</a>
        </div>
        <div
          className="vf-hero-chips"
          style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap", marginTop: "2.2rem" }}
        >
          {["AI compliance gate", "USDT rails", "On-chain revenue", "Zero custody"].map((c) => (
            <span
              key={c}
              style={{
                fontSize: "0.78rem",
                color: "rgba(245,245,250,0.82)",
                border: "1px solid rgba(255,255,255,0.18)",
                borderRadius: 999,
                padding: "6px 14px",
                background: "rgba(255,255,255,0.05)",
                backdropFilter: "blur(4px)",
              }}
            >
              {c}
            </span>
          ))}
        </div>
      </div>
      <div className="vf-hero-bottom-fade" />
      <div className="vf-scroll-cue" />
    </section>
  );
}

function Ticker() {
  const items = [
    "Real Estate", "Gold & Metals", "Logistics & Ports", "Agriculture & Land",
    "Art & Collectibles", "Invoices & Trade", "Commodities", "Treasuries",
  ];
  return (
    <div className="gr-ticker" aria-hidden="true">
      <div className="gr-ticker-inner">
        {[...items, ...items].map((t, i) => (
          <span
            key={i}
            style={{
              fontSize: "0.82rem",
              fontWeight: 700,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "rgba(245,245,250,0.55)",
            }}
          >
            {t} <span style={{ color: "var(--vf-magenta)" }}>◆</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function AssetsSection() {
  return (
    <section id="assets" className="vf-section">
      <Reveal>
        <p className="vf-eyebrow" style={{ marginBottom: 8 }}>Asset classes</p>
        <h2 className="vf-h2" style={{ marginBottom: 14 }}>RWA assets, tokenized on BOT Chain</h2>
        <p style={{ color: "#9ca3af", maxWidth: 640, lineHeight: 1.7, marginBottom: "2.5rem" }}>
          Anything with a real revenue story can be forged into units here: property, gold,
          logistics, farmland, art, invoices. The AI gate reads the documentation first,
          so what reaches the market is documented and verified.
        </p>
      </Reveal>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(235px, 1fr))", gap: 16 }}>
        {RWA_ASSETS.map((a, i) => (
          <Reveal key={a.name} delay={Math.min(i * 80, 480)} className="h-full">
            <article className="gr-card" style={{ height: "100%", display: "flex", flexDirection: "column" }}>
              <div className="gr-zoom" style={{ aspectRatio: "16 / 10", overflow: "hidden" }}>
                <img src={a.img} alt={a.name} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </div>
              <div style={{ padding: "1.1rem 1.2rem 1.3rem" }}>
                <h3 style={{ fontSize: "1.02rem", fontWeight: 800, margin: "0 0 6px" }}>{a.name}</h3>
                <p style={{ color: "#9ca3af", fontSize: "0.85rem", lineHeight: 1.5, margin: 0 }}>{a.desc}</p>
              </div>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

function HowItWorksSection() {
  return (
    <section id="how" className="vf-section" style={{ paddingTop: "2.5rem" }}>
      <Reveal>
        <p className="vf-eyebrow" style={{ marginBottom: 8 }}>About the project</p>
        <h2 className="vf-h2" style={{ marginBottom: 14 }}>One pipeline, from paperwork to payout</h2>
        <p style={{ color: "#9ca3af", maxWidth: 640, lineHeight: 1.7, marginBottom: "2.5rem" }}>
          VeriForge is the issuance and revenue layer for tokenized real-world assets on BOT
          Chain. The AI decision is enforced by the contracts, not by a rubber stamp: no
          APPROVED verdict, no listing, no exception.
        </p>
      </Reveal>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))", gap: 14 }}>
        {PIPELINE_STEPS.map((s, i) => (
          <Reveal key={s.n} delay={Math.min(i * 90, 450)} className="h-full">
            <div className="gr-card" style={{ padding: "1.4rem 1.3rem", height: "100%" }}>
              <div style={{ fontSize: "0.8rem", fontWeight: 900, color: "var(--vf-magenta)", letterSpacing: "0.12em", marginBottom: 10 }}>
                {s.n}
              </div>
              <h3 style={{ fontSize: "1rem", fontWeight: 800, margin: "0 0 8px" }}>{s.t}</h3>
              <p style={{ color: "#9ca3af", fontSize: "0.85rem", lineHeight: 1.55, margin: 0 }}>{s.d}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
