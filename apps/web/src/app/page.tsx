"use client";

import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, parseUnits, formatUnits } from "ethers";

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
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
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
        setNotice(`Payment required: ${body.message || "2 USDT on BOT Chain"}. Confirm the transfer and signature in your wallet.`);
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
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "2rem 1.25rem" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div>
          <h1 style={{ fontSize: "1.75rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
            Veri<span style={{ color: "var(--vf-magenta)" }}>Forge</span>
          </h1>
          <p style={{ color: "#9ca3af", fontSize: "0.875rem" }}>AI-gated RWA issuance and revenue distribution on BOT Chain</p>
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

      <nav style={{ display: "flex", gap: 8, marginBottom: "1.5rem" }}>
        <button onClick={() => setTab("market")} style={tabStyle(tab === "market")}>
          Market
        </button>
        <button onClick={() => setTab("launch")} style={tabStyle(tab === "launch")}>
          Launch an asset
        </button>
      </nav>

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
            {launching ? "Running AI compliance gate…" : "Launch issuance (2 USDT via x402)"}
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

      <footer style={{ marginTop: "3rem", color: "#6b7280", fontSize: "0.75rem", textAlign: "center" }}>
        BOT Chain mainnet · chain 677 · AI-gated issuance · revenue claims in USDT · platform holds no funds
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
