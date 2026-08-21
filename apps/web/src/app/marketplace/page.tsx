"use client";

import { useCallback, useEffect, useState } from "react";
import { BrowserProvider, Contract, JsonRpcProvider, parseUnits, formatUnits } from "ethers";
import { useAccount } from "wagmi";
import Header from "@/components/Header";
import Reveal from "@/components/Reveal";
import { useChain } from "@/lib/chain-context";
import { getChain } from "@/lib/chains";

// Direct API origin. The API has CORS origin:true, so cross-origin calls
// work without the Next.js proxy (Netlify does not honor absolute rewrites).
const API = process.env.NEXT_PUBLIC_API_URL || "https://veriforge-5w80.onrender.com";

interface Issuance {
  id: number;
  issuer: string;
  token: string;
  distributor: string;
  market?: string | null;
  name: string;
  symbol: string;
  pricePerTokenUsdt: string;
  totalSupply: string;
  docsUri: string;
  payloadHash: string;
  accDividendPerToken: string;
  totalRevenueDeposited?: string;
  revenueDepositedBy?: string | null;
  listedAt: number;
  blockNumber: number;
  explorer: string;
  score: number | null;
  verdict: number | null;
  attestedAt: number | null;
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
const MARKET_ABI = [
  "function seed(uint256,uint256)",
  "function buy(uint256) returns (uint256)",
  "function sell(uint256) returns (uint256)",
  "function price() view returns (uint256)",
  "function reserveToken() view returns (uint256)",
  "function reserveUsdt() view returns (uint256)",
];
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

function paymentMessage(accepted: any, chain: { id: number; usdt: string }) {
  return {
    scheme: String(accepted.scheme || "exact"),
    network: String(accepted.network || `eip155:${chain.id}`),
    chainId: BigInt(accepted.chainId || chain.id),
    asset: String(accepted.asset || chain.usdt),
    amount: String(accepted.amount || ""),
    payTo: String(accepted.payTo || ""),
    maxTimeoutSeconds: BigInt(accepted.maxTimeoutSeconds || 300),
    description: String(accepted.description || ""),
    extra: typeof accepted.extra === "string" ? accepted.extra : JSON.stringify(accepted.extra || {}),
  };
}

// Full x402 checkout: probe → 402 challenge → wallet signs + pays → replay.
// Runs on the chain selected by the toggle (chainId), paying the USDT of THAT
// chain and signing with THAT chain's EIP-712 domain.
async function paidPost(path: string, body: unknown, chainId: number): Promise<Response> {
  const chain = getChain(chainId);
  const probe = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (probe.status !== 402) return probe;

  const challengeB64 = probe.headers.get("payment-required");
  if (!challengeB64) return probe;
  const challenge = JSON.parse(atob(challengeB64));
  // Pick the challenge entry for the SELECTED chain (the API offers both).
  const accepted =
    challenge.accepts?.find((a: any) => Number(a.chainId) === chainId) || challenge.accepts?.[0];
  if (!accepted) return probe;

  const eth = getEth();
  if (!eth) throw new Error("No wallet detected. Connect your wallet to pay via x402.");
  const provider = new BrowserProvider(eth);
  const signer = await provider.getSigner();
  const payer = (await signer.getAddress()).toLowerCase();

  // 1. Send the exact USDT amount (of the selected chain) to payTo.
  const usdt = new Contract(accepted.asset, ERC20_ABI, signer);
  const amount = BigInt(accepted.amount);
  const tx = await usdt.transfer(accepted.payTo, amount);
  await tx.wait();

  // 2. Sign the accepted entry (EIP-712), bound to this chain.
  const domain = { name: "x402", version: "2", chainId };
  const signature = await signer.signTypedData(domain, EIP712_TYPES, paymentMessage(accepted, chain));

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

// Upload proof files (PDF/images) → content-hashed URL on the API. The URL
// goes into the signed declaration, so the committed payload references a
// real file that anyone can open.
async function uploadFiles(files: File[], kind: string): Promise<{ url: string; sha256: string; name: string; size: number }[]> {
  const out: { url: string; sha256: string; name: string; size: number }[] = [];
  for (const f of files) {
    const fd = new FormData();
    fd.append("file", f);
    fd.append("kind", kind);
    const res = await fetch(`${API}/v1/uploads`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(`Upload failed (${res.status}): ${f.name}`);
    const j = await res.json();
    if (!j?.ok || !j.files?.[0]) throw new Error(`Upload rejected: ${f.name}`);
    const u = j.files[0];
    out.push({ url: u.url, sha256: u.sha256, name: f.name, size: u.size });
  }
  return out;
}

export default function Marketplace() {
  const { address } = useAccount();
  const { chainId: selChain, info: chainInfo } = useChain();
  const [tab, setTab] = useState<"launch" | "market">("market");

  // issuer form
  const [fName, setFName] = useState("");
  const [fSymbol, setFSymbol] = useState("");
  const [fPrice, setFPrice] = useState("");
  const [fDocs, setFDocs] = useState("");
  const [fDocsUri, setFDocsUri] = useState("");
  const [fAssetClass, setFAssetClass] = useState("");
  const [fJurisdiction, setFJurisdiction] = useState("");
  const [fLegalEntity, setFLegalEntity] = useState("");
  const [fProofType, setFProofType] = useState("");
  const [fProofUri, setFProofUri] = useState("");
  const [fProofFile, setFProofFile] = useState<{ url: string; sha256: string; name: string } | null>(null);
  const [fDocsFile, setFDocsFile] = useState<{ url: string; sha256: string; name: string } | null>(null);
  const [fPhotos, setFPhotos] = useState<{ url: string; sha256: string; name: string }[]>([]);
  const [uploading, setUploading] = useState<string>("");
  const [declSignature, setDeclSignature] = useState("");
  const [declAddress, setDeclAddress] = useState("");
  const [signing, setSigning] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState<any>(null);

  // market
  const [issuances, setIssuances] = useState<Issuance[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [claimables, setClaimables] = useState<Record<number, string>>({});

  const loadIssuances = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`${API}/v1/issuances?chainId=${selChain}`);
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      setIssuances(data.issuances || []);
    } catch (e: any) {
      setError(e?.message || "Failed to load issuances");
    } finally {
      setBusy(false);
    }
  }, [selChain]);

  useEffect(() => {
    loadIssuances();
  }, [loadIssuances]);

  const loadClaimables = useCallback(async () => {
    if (!address) return;
    const next: Record<number, string> = {};
    for (const i of issuances) {
      try {
        const res = await fetch(`${API}/v1/issuances/${i.id}/claimable/${address}?chainId=${selChain}`);
        if (res.ok) {
          const d = await res.json();
          next[i.id] = d.claimable_usdt;
        }
      } catch {
        // ignore per-issuance failures
      }
    }
    setClaimables(next);
  }, [address, issuances, selChain]);

  useEffect(() => {
    loadClaimables();
  }, [loadClaimables]);

  // Builds the canonical declaration payload — SAME key order as the API:
  // name, symbol, docsText, docsUri, assetMetadata.
  const buildPayloadJson = useCallback((): string => {
    const assetMetadata = {
      assetClass: fAssetClass.trim(),
      jurisdiction: fJurisdiction.trim(),
      legalEntity: fLegalEntity.trim(),
      backingProofType: fProofType.trim(),
      backingProofUri: fProofUri.trim() || fProofFile?.url || "",
      assetPhotos: fPhotos.map((p) => p.url),
    };
    return JSON.stringify({
      name: fName.trim(),
      symbol: fSymbol.trim().toUpperCase(),
      docsText: fDocs.trim(),
      docsUri: fDocsUri.trim() || fDocsFile?.url || "",
      assetMetadata,
    });
  }, [fName, fSymbol, fDocs, fDocsUri, fDocsFile, fAssetClass, fJurisdiction, fLegalEntity, fProofType, fProofUri, fProofFile, fPhotos]);

  // The issuer signs the exact declaration that gets committed on-chain.
  // A tampered field changes the hash, breaks the signature, and the API rejects it.
  const signDeclaration = useCallback(async () => {
    if (!fName || !fSymbol || !fDocs || !fAssetClass || !fJurisdiction || !fLegalEntity || !fProofType) {
      setError("Fill all required fields before signing the declaration.");
      return;
    }
    if (!fProofFile && !fProofUri.trim()) {
      setError("Upload a proof document or paste a proof URL before signing.");
      return;
    }
    const eth = getEth();
    if (!eth) {
      setError("Connect your wallet first — the issuer must sign the declaration.");
      return;
    }
    setSigning(true);
    setError("");
    try {
      const provider = new BrowserProvider(eth);
      const signer = await provider.getSigner();
      const addr = (await signer.getAddress()).toLowerCase();
      const sig = await signer.signMessage(buildPayloadJson());
      setDeclSignature(sig);
      setDeclAddress(addr);
      setNotice("Declaration signed. The exact reviewed content is now bound to your wallet.");
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || "Signing failed or was rejected in the wallet");
    } finally {
      setSigning(false);
    }
  }, [fName, fSymbol, fDocs, fAssetClass, fJurisdiction, fLegalEntity, fProofType, buildPayloadJson]);

  const handleProofUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading("proof");
    setError("");
    try {
      const up = await uploadFiles(Array.from(files), "proof");
      setFProofFile(up[0]);
      setFProofUri("");
    } catch (err: any) {
      setError(err?.message || "Proof upload failed");
    } finally {
      setUploading("");
      e.target.value = "";
    }
  };

  const handleDocsUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading("docs");
    setError("");
    try {
      const up = await uploadFiles(Array.from(files), "docs");
      setFDocsFile(up[0]);
      setFDocsUri("");
    } catch (err: any) {
      setError(err?.message || "Docs upload failed");
    } finally {
      setUploading("");
      e.target.value = "";
    }
  };

  const handlePhotosUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading("photos");
    setError("");
    try {
      const up = await uploadFiles(Array.from(files), "photo");
      setFPhotos((prev) => [...prev, ...up].slice(0, 6));
    } catch (err: any) {
      setError(err?.message || "Photo upload failed");
    } finally {
      setUploading("");
      e.target.value = "";
    }
  };

  const launchIssuance = useCallback(async () => {
    if (!fName || !fSymbol || !fPrice || !fDocs || !fAssetClass || !fJurisdiction || !fLegalEntity || !fProofType) {
      setError("All fields are required. The AI gate reviews your documentation and declaration.");
      return;
    }
    if (!fProofFile && !fProofUri.trim()) {
      setError("Upload a proof document or paste a proof URL first.");
      return;
    }
    if (!declSignature || !declAddress) {
      setError("Sign the asset declaration first — your signature binds the reviewed content.");
      return;
    }
    setLaunching(true);
    setError("");
    setNotice("");
    setLaunchResult(null);
    try {
      const assetMetadata = {
        assetClass: fAssetClass.trim(),
        jurisdiction: fJurisdiction.trim(),
        legalEntity: fLegalEntity.trim(),
        backingProofType: fProofType.trim(),
        backingProofUri: fProofUri.trim() || fProofFile?.url || "",
        assetPhotos: fPhotos.map((p) => p.url),
      };
      // x402 checkout: probe → 402 → wallet signs + transfers USDT → replay.
      const res = await paidPost("/v1/issuances", {
        name: fName.trim(),
        symbol: fSymbol.trim().toUpperCase(),
        pricePerTokenUsdt: parseFloat(fPrice),
        docsText: fDocs.trim(),
        docsUri: fDocsUri.trim() || fDocsFile?.url || "",
        assetMetadata,
        issuerAddress: declAddress,
        issuerSignature: declSignature,
      }, selChain);
      if (res.status === 402) {
        const body = await res.json();
        setNotice(`Payment required: ${body.message || "1 USDT on BOT Chain"}. Confirm the transfer and signature in your wallet.`);
        return;
      }
      const body = await res.json();
      setLaunchResult(body);
      if (body?.listed) {
        setFName(""); setFSymbol(""); setFPrice(""); setFDocs(""); setFDocsUri("");
        setFAssetClass(""); setFJurisdiction(""); setFLegalEntity(""); setFProofType(""); setFProofUri("");
        setFProofFile(null); setFDocsFile(null); setFPhotos([]);
        setDeclSignature(""); setDeclAddress("");
        loadIssuances();
      }
    } catch (e: any) {
      setError(e?.message || "Launch failed");
    } finally {
      setLaunching(false);
    }
  }, [fName, fSymbol, fPrice, fDocs, fDocsUri, fDocsFile, fAssetClass, fJurisdiction, fLegalEntity, fProofType, fProofUri, fProofFile, fPhotos, declSignature, declAddress, loadIssuances, selChain]);

  const buyUnits = useCallback(
    async (iss: Issuance, usdtAmount: string) => {
      const eth = getEth();
      if (!eth) {
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

        // approve USDT to the token contract (selected chain's USDT)
        const usdt = new Contract(chainInfo.usdt, ERC20_ABI, signer);
        const allowance = await usdt.allowance(await signer.getAddress(), iss.token);
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
      } catch (e: any) {
        setError(e?.reason || e?.shortMessage || e?.message || "Buy failed");
      } finally {
        setBusy(false);
      }
    },
    [loadIssuances, chainInfo.usdt]
  );

  // Live secondary-market price + price history via the API market endpoint
  // (returns price_usdt, reserve, and price_history for the candle chart).
  const loadMarketData = useCallback(
    async (iss: Issuance): Promise<{ price: string | null; history: { ts: number; price: string; kind: number }[] }> => {
      if (!iss.market) return { price: null, history: [] };
      try {
        const res = await fetch(`${API}/v1/issuances/${iss.id}/market?chainId=${selChain}`);
        const d = await res.json();
        return {
          price: d?.price_usdt && parseFloat(d.price_usdt) ? d.price_usdt : null,
          history: d?.price_history || [],
        };
      } catch {
        return { price: null, history: [] };
      }
    },
    [selChain]
  );

  // Trade on the secondary market: buy units at the live (demand-driven) price.
  const tradeBuy = useCallback(
    async (iss: Issuance, usdtAmount: string) => {
      const eth = getEth();
      if (!eth || !iss.market) {
        setError("Connect wallet first (or this issuance has no secondary market)");
        return;
      }
      setBusy(true); setError(""); setNotice("");
      try {
        const provider = new BrowserProvider(eth);
        const signer = await provider.getSigner();
        const amount = parseUnits(usdtAmount, 6);
        const usdt = new Contract(chainInfo.usdt, ERC20_ABI, signer);
        const allowance = await usdt.allowance(await signer.getAddress(), iss.market);
        if (allowance < amount) {
          const tx = await usdt.approve(iss.market, amount);
          await tx.wait();
          setNotice("USDT approved. Confirm the market buy.");
        }
        const market = new Contract(iss.market, MARKET_ABI, signer);
        const tx = await market.buy(amount);
        await tx.wait();
        setNotice(`Traded ${usdtAmount} USDT on the ${iss.symbol} market at the live price.`);
        loadIssuances();
      } catch (e: any) {
        setError(e?.reason || e?.shortMessage || e?.message || "Market buy failed");
      } finally {
        setBusy(false);
      }
    },
    [loadIssuances, chainInfo.usdt]
  );

  // Trade on the secondary market: sell units back for USDT.
  const tradeSell = useCallback(
    async (iss: Issuance, tokenAmount: string) => {
      const eth = getEth();
      if (!eth || !iss.market) {
        setError("Connect wallet first (or this issuance has no secondary market)");
        return;
      }
      setBusy(true); setError(""); setNotice("");
      try {
        const provider = new BrowserProvider(eth);
        const signer = await provider.getSigner();
        const amount = parseUnits(tokenAmount, 18);
        const tokenContract = new Contract(iss.token, ERC20_ABI, signer);
        const cur = await tokenContract.allowance(await signer.getAddress(), iss.market);
        if (cur < amount) {
          const tx = await tokenContract.approve(iss.market, amount);
          await tx.wait();
          setNotice("Units approved. Confirm the market sell.");
        }
        const market = new Contract(iss.market, MARKET_ABI, signer);
        const tx = await market.sell(amount);
        await tx.wait();
        setNotice(`Sold ${tokenAmount} ${iss.symbol} on the market for USDT.`);
        loadIssuances();
      } catch (e: any) {
        setError(e?.reason || e?.shortMessage || e?.message || "Market sell failed");
      } finally {
        setBusy(false);
      }
    },
    [loadIssuances]
  );

  // Issuer seeds the per-issuance liquidity pool (token + USDT).
  const seedMarket = useCallback(
    async (iss: Issuance, tokenAmount: string, usdtAmount: string) => {
      const eth = getEth();
      if (!eth || !iss.market) {
        setError("Connect wallet first (or this issuance has no secondary market)");
        return;
      }
      setBusy(true); setError(""); setNotice("");
      try {
        const provider = new BrowserProvider(eth);
        const signer = await provider.getSigner();
        const tokenAmt = parseUnits(tokenAmount, 18);
        const usdtAmt = parseUnits(usdtAmount, 6);
        const token = new Contract(iss.token, ERC20_ABI, signer);
        const usdt = new Contract(chainInfo.usdt, ERC20_ABI, signer);
        const tokAllow = await token.allowance(await signer.getAddress(), iss.market);
        if (tokAllow < tokenAmt) { const t = await token.approve(iss.market, tokenAmt); await t.wait(); }
        const usdAllow = await usdt.allowance(await signer.getAddress(), iss.market);
        if (usdAllow < usdtAmt) { const t = await usdt.approve(iss.market, usdtAmt); await t.wait(); }
        setNotice("Seed approved. Confirm the liquidity transaction.");
        const market = new Contract(iss.market, MARKET_ABI, signer);
        const tx = await market.seed(tokenAmt, usdtAmt);
        await tx.wait();
        setNotice(`Secondary market seeded for ${iss.symbol}. Units now trade at a live price.`);
        loadIssuances();
      } catch (e: any) {
        setError(e?.reason || e?.shortMessage || e?.message || "Seeding failed");
      } finally {
        setBusy(false);
      }
    },
    [loadIssuances, chainInfo.usdt]
  );

  const claimRevenue = useCallback(
    async (iss: Issuance) => {
      const eth = getEth();
      if (!eth) {
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
      } catch (e: any) {
        setError(e?.reason || e?.shortMessage || e?.message || "Claim failed");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const depositRevenue = useCallback(
    async (iss: Issuance, usdtAmount: string) => {
      const eth = getEth();
      if (!eth) {
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

        // approve USDT to the distributor, then deposit (selected chain's USDT)
        const usdt = new Contract(chainInfo.usdt, ERC20_ABI, signer);
        const allowance = await usdt.allowance(await signer.getAddress(), iss.distributor);
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
      } catch (e: any) {
        setError(e?.reason || e?.shortMessage || e?.message || "Deposit failed");
      } finally {
        setBusy(false);
      }
    },
    [loadIssuances, chainInfo.usdt]
  );

  const balanceHint = useCallback(async (iss: Issuance): Promise<string> => {
    const eth = getEth();
    if (!eth) return "";
    try {
      const provider = new BrowserProvider(eth);
      const token = new Contract(iss.token, RWATOKEN_ABI, provider);
      const bal = await token.balanceOf(await provider.getSigner().then((s) => s.getAddress()));
      if (bal === 0n) return "";
      return formatUnits(bal, 18);
    } catch {
      return "";
    }
  }, []);

  return (
    <main>
      <Header active="marketplace" />

      <section className="vf-section" style={{ paddingTop: "3rem" }}>
        <Reveal>
          <p className="vf-eyebrow" style={{ marginBottom: 8 }}>The marketplace</p>
          <h1 className="vf-h2" style={{ marginBottom: 8 }}>
            Live on {chainInfo.name}
          </h1>
          <p style={{ color: "#9ca3af", maxWidth: 620, lineHeight: 1.7, marginBottom: "1.75rem" }}>
            Every issuance here passed the AI compliance gate. Buy units with USDT, claim
            your revenue share, or launch the next asset.
          </p>
        </Reveal>

        <div style={{ display: "flex", gap: 8, marginBottom: "1.5rem", flexWrap: "wrap" }}>
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
              Upload the actual proof documents and asset photos. The AI compliance officer reads the file contents, checks them against your declaration, and only APPROVED issuances get listed on-chain. Files are stored content-hashed and the reviewed payload is committed on-chain.
            </p>
            <div className="vf-row" style={{ marginBottom: 10 }}>
              <input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="Asset name (e.g. Lagos Warehouse REIT)" style={inputStyle} />
              <input value={fSymbol} onChange={(e) => setFSymbol(e.target.value)} placeholder="SYMBOL" style={{ ...inputStyle, maxWidth: 130, flexBasis: 110 }} />
              <input value={fPrice} onChange={(e) => setFPrice(e.target.value)} placeholder="Price per unit (USDT)" type="number" step="0.01" style={{ ...inputStyle, maxWidth: 170, flexBasis: 150 }} />
            </div>
            <div className="vf-row" style={{ marginBottom: 10 }}>
              <input value={fAssetClass} onChange={(e) => setFAssetClass(e.target.value)} placeholder="Asset class (real-estate, invoice, bond…)" style={inputStyle} />
              <input value={fJurisdiction} onChange={(e) => setFJurisdiction(e.target.value)} placeholder="Jurisdiction (e.g. NG-Lagos)" style={inputStyle} />
            </div>
            <div className="vf-row" style={{ marginBottom: 10 }}>
              <input value={fLegalEntity} onChange={(e) => setFLegalEntity(e.target.value)} placeholder="Legal entity (registered company name)" style={inputStyle} />
              <input value={fProofType} onChange={(e) => setFProofType(e.target.value)} placeholder="Backing proof (title-deed, escrow, invoice…)" style={inputStyle} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <div className="vf-row" style={{ gap: 10, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                <label style={{ ...btnStyle({ outline: true, disabled: uploading === "proof" }), display: "inline-block", cursor: uploading ? "not-allowed" : "pointer" }}>
                  {uploading === "proof" ? "Uploading…" : fProofFile ? "Replace proof document" : "⬆ Upload proof document (PDF / image)"}
                  <input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" style={{ display: "none" }} onChange={handleProofUpload} disabled={!!uploading} />
                </label>
                {fProofFile ? (
                  <a href={fProofFile.url} target="_blank" rel="noopener noreferrer" style={{ color: "#10b981", fontSize: "0.8rem", wordBreak: "break-all" }}>
                    ✓ {fProofFile.name} · sha256 {fProofFile.sha256.slice(0, 10)}… ↗
                  </a>
                ) : (
                  <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>title deed, valuation, invoice. The AI gate reads PDF text from the file</span>
                )}
              </div>
              <input value={fProofUri} onChange={(e) => setFProofUri(e.target.value)} placeholder="…or paste a proof URL instead (optional)" style={{ ...inputStyle, width: "100%" }} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <div className="vf-row" style={{ gap: 10, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                <label style={{ ...btnStyle({ outline: true, disabled: uploading === "docs" }), display: "inline-block", cursor: uploading ? "not-allowed" : "pointer" }}>
                  {uploading === "docs" ? "Uploading…" : fDocsFile ? "Replace documentation file" : "⬆ Upload documentation (PDF)"}
                  <input type="file" accept="application/pdf" style={{ display: "none" }} onChange={handleDocsUpload} disabled={!!uploading} />
                </label>
                {fDocsFile ? (
                  <a href={fDocsFile.url} target="_blank" rel="noopener noreferrer" style={{ color: "#10b981", fontSize: "0.8rem", wordBreak: "break-all" }}>
                    ✓ {fDocsFile.name} · sha256 {fDocsFile.sha256.slice(0, 10)}… ↗
                  </a>
                ) : (
                  <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>full offering docs — the AI gate reviews the actual file</span>
                )}
              </div>
              <input value={fDocsUri} onChange={(e) => setFDocsUri(e.target.value)} placeholder="…or paste a docs URL instead (optional)" style={{ ...inputStyle, width: "100%" }} />
            </div>
            <div style={{ marginBottom: 10 }}>
              <div className="vf-row" style={{ gap: 10, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                <label style={{ ...btnStyle({ outline: true, disabled: uploading === "photos" }), display: "inline-block", cursor: uploading ? "not-allowed" : "pointer" }}>
                  {uploading === "photos" ? "Uploading…" : "⬆ Upload asset photos"}
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple style={{ display: "none" }} onChange={handlePhotosUpload} disabled={!!uploading} />
                </label>
                {fPhotos.length > 0 && (
                  <span style={{ fontSize: "0.78rem", color: "#10b981" }}>
                    ✓ {fPhotos.length} photo{fPhotos.length > 1 ? "s" : ""} attached
                  </span>
                )}
                <span style={{ color: "#6b7280", fontSize: "0.75rem" }}>up to 6 photos of the asset — URLs go into the signed declaration</span>
              </div>
              {fPhotos.length > 0 && (
                <div className="vf-row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {fPhotos.map((p) => (
                    <a key={p.url} href={p.url} target="_blank" rel="noopener noreferrer" title={p.name}>
                      <img src={p.url} alt={p.name} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid #2c2c47" }} />
                    </a>
                  ))}
                </div>
              )}
            </div>
            <textarea
              value={fDocs}
              onChange={(e) => setFDocs(e.target.value)}
              placeholder={"Issuer documentation — the AI gate reads this. Include: asset backing, value and audit, revenue model, legal entity and jurisdiction, token terms, custody."}
              rows={7}
              style={{ ...inputStyle, width: "100%", resize: "vertical", fontFamily: "inherit", marginBottom: 14 }}
            />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
              <button onClick={signDeclaration} disabled={signing} style={btnStyle({ outline: true, disabled: signing })}>
                {signing ? "Awaiting wallet signature…" : "Sign asset declaration"}
              </button>
              {declAddress && (
                <span style={{ color: "#10b981", fontSize: "0.82rem" }}>
                  ✓ Signed by {declAddress.slice(0, 6)}…{declAddress.slice(-4)}
                </span>
              )}
              <span style={{ color: "#9ca3af", fontSize: "0.78rem" }}>
                Your signature binds the exact reviewed content. Any edit invalidates it.
              </span>
            </div>
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
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
                  connectedAddress={address}
                  claimable={claimables[iss.id]}
                  onBuy={(amt) => buyUnits(iss, amt)}
                  onClaim={() => claimRevenue(iss)}
                  onDeposit={(amt) => depositRevenue(iss, amt)}
                  onTradeBuy={(amt) => tradeBuy(iss, amt)}
                  onTradeSell={(amt) => tradeSell(iss, amt)}
                  onSeed={(t, u) => seedMarket(iss, t, u)}
                  balanceHint={balanceHint}
                  loadMarketData={loadMarketData}
                />
              ))}
            </div>
          </section>
        )}
      </section>

      <footer className="vf-footer">
        <div>
          Veri<span style={{ color: "var(--vf-magenta)" }}>Forge</span> — {chainInfo.name} ·
          chain {selChain} · {chainInfo.scan} · AI-gated issuance · revenue claims in USDT · platform holds no funds
        </div>
        <div>BOT Chain Builder Challenge #2 · AI × RWA · Deadline Aug 20 2026</div>
      </footer>
    </main>
  );
}

function IssuanceCard({
  iss,
  connectedAddress,
  claimable,
  onBuy,
  onClaim,
  onDeposit,
  onTradeBuy,
  onTradeSell,
  onSeed,
  balanceHint,
  loadMarketData,
}: {
  iss: Issuance;
  connectedAddress?: `0x${string}`;
  claimable?: string;
  onBuy: (amt: string) => void;
  onClaim: () => void;
  onDeposit: (amt: string) => void;
  onTradeBuy: (amt: string) => void;
  onTradeSell: (amt: string) => void;
  onSeed: (token: string, usdt: string) => void;
  balanceHint: (iss: Issuance) => Promise<string>;
  loadMarketData: (iss: Issuance) => Promise<{ price: string | null; history: { ts: number; price: string; kind: number }[] }>;
}) {
  const [amount, setAmount] = useState("10");
  const [depositAmt, setDepositAmt] = useState("50");
  const [units, setUnits] = useState("");
  const [tradeAmt, setTradeAmt] = useState("10");
  const [sellAmt, setSellAmt] = useState("");
  const [seedTok, setSeedTok] = useState("");
  const [seedUsd, setSeedUsd] = useState("");
  const [marketPrice, setMarketPrice] = useState<string | null>(null);
  const [marketHistory, setMarketHistory] = useState<{ ts: number; price: string; kind: number }[]>([]);

  // Only the declared on-chain issuer controls the revenue deposit row.
  const isIssuer =
    !!connectedAddress &&
    !!iss.issuer &&
    connectedAddress.toLowerCase() === iss.issuer.toLowerCase();
  const hasDepositedRevenue =
    iss.totalRevenueDeposited !== undefined &&
    parseFloat(iss.totalRevenueDeposited || "0") > 0;
  // Claim is for HOLDERS who are not the issuer. The issuer deposited the
  // revenue — showing a Claim to them reads as a mock, so we hide it there.
  const isHolder = !!connectedAddress && !!units && parseFloat(units) > 0;
  const showClaim =
    hasDepositedRevenue &&
    !isIssuer &&
    isHolder &&
    claimable !== undefined &&
    parseFloat(claimable || "0") > 0;

  useEffect(() => {
    let live = true;
    balanceHint(iss).then((u) => live && setUnits(u));
    return () => {
      live = false;
    };
  }, [iss, balanceHint]);

  // Load the live secondary-market price + price history for this issuance.
  useEffect(() => {
    let live = true;
    if (iss.market) {
      loadMarketData(iss).then((d) => {
        if (!live) return;
        setMarketPrice(d.price);
        setMarketHistory(d.history);
      });
    }
    return () => {
      live = false;
    };
  }, [iss, loadMarketData]);

  const price = parseFloat(iss.pricePerTokenUsdt);

  // Live units preview while typing a USDT amount (primary: amount / price;
  // secondary: the pool quote).
  const primaryUnits =
    amount && price > 0 ? (parseFloat(amount) / price).toFixed(4) : null;
  const tradeUnits =
    tradeAmt && marketPrice && parseFloat(marketPrice) > 0
      ? (parseFloat(tradeAmt) / parseFloat(marketPrice)).toFixed(4)
      : null;

  return (
    <div className="gr-card" style={{ padding: "1.25rem 1.5rem" }}>
      <div className="vf-row" style={{ justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div className="vf-row" style={{ gap: 10, alignItems: "center" }}>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, margin: 0 }}>{iss.name || "—"}</h3>
            <span style={{ fontSize: "0.7rem", color: "var(--vf-magenta)", background: "rgba(217,70,239,0.12)", padding: "2px 8px", borderRadius: 999 }}>
              {iss.symbol}
            </span>
          </div>
          <p style={{ color: "#9ca3af", fontSize: "0.8rem", fontFamily: "monospace", marginTop: 4, wordBreak: "break-all" }}>
            #{iss.id} · token {iss.token.slice(0, 8)}…{iss.token.slice(-4)}
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "1.25rem", fontWeight: 800 }}>${price}</div>
          <div style={{ fontSize: "0.7rem", color: "#9ca3af" }}>per unit</div>
        </div>
      </div>
      <div className="vf-row" style={{ gap: 16, fontSize: "0.8rem", color: "#9ca3af", marginBottom: 12 }}>
        <span>Supply: {parseFloat(iss.totalSupply).toLocaleString()} units</span>
        <a href={iss.explorer} target="_blank" rel="noopener noreferrer" style={{ color: "var(--vf-magenta)" }}>
          view on BOTScan ↗
        </a>
      </div>
      <div className="vf-row" style={{ gap: 8, fontSize: "0.75rem", color: "#9ca3af", marginBottom: 10, alignItems: "center" }}>
        {iss.score !== null && iss.verdict !== null ? (
          <span
            style={{
              color: VERDICT_COLOR[iss.verdict] || "#9ca3af",
              background: `${VERDICT_COLOR[iss.verdict] || "#9ca3af"}1a`,
              border: `1px solid ${VERDICT_COLOR[iss.verdict] || "#9ca3af"}40`,
              borderRadius: 999,
              padding: "2px 10px",
              fontWeight: 700,
            }}
          >
            AI gate · {iss.score}/100 · {VERDICT_LABEL[iss.verdict] || iss.verdict}
          </span>
        ) : (
          <span style={{ color: "#10b981", background: "rgba(16,185,129,0.1)", border: "1px solid rgba(16,185,129,0.3)", borderRadius: 999, padding: "2px 10px" }}>
            ✓ AI-approved
          </span>
        )}
        <span style={{ fontFamily: "monospace" }}>
          {iss.payloadHash ? `docs committed ${iss.payloadHash.slice(0, 10)}…${iss.payloadHash.slice(-6)}` : "docs commitment on-chain"}
        </span>
      </div>
      <div className="vf-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="0.01" min="0" style={{ ...inputStyle, maxWidth: 130, flexBasis: 110 }} />
        <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>USDT</span>
        <button onClick={() => onBuy(amount)} style={btnStyle({})}>
          Buy
        </button>
        {primaryUnits && <span style={{ fontSize: "0.8rem", color: "#10b981" }}>≈ {primaryUnits} units</span>}
        {units && <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>· {parseFloat(units).toFixed(2)} held</span>}
        {showClaim && (
          <button onClick={onClaim} style={btnStyle({ outline: true })}>
            Claim {claimable} USDT
          </button>
        )}
      </div>
      {/* Revenue — visible to the ISSUER only (they deposit); Claim appears to
          holders only once revenue is actually deposited */}
      {isIssuer && (
        <div className="vf-row" style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed #23233a", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.75rem", color: "#9ca3af", whiteSpace: "nowrap" }}>
            {hasDepositedRevenue
              ? `Revenue deposited: ${iss.totalRevenueDeposited} USDT${iss.revenueDepositedBy ? ` · by ${iss.revenueDepositedBy.slice(0, 6)}…${iss.revenueDepositedBy.slice(-4)}` : ""}`
              : "No revenue deposited yet"}
          </span>
          <>
            <input value={depositAmt} onChange={(e) => setDepositAmt(e.target.value)} type="number" step="0.01" min="0" style={{ ...inputStyle, maxWidth: 110, flexBasis: 90 }} />
            <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>USDT</span>
            <button onClick={() => onDeposit(depositAmt)} style={btnStyle({ outline: true })}>
              Deposit
            </button>
            <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>→ pro-rata to holders</span>
          </>
        </div>
      )}

      {/* Secondary market — investors earn from price appreciation too */}
      <div className="vf-row" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px dashed #2c2c47", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
        <div className="vf-row" style={{ alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.78rem", fontWeight: 700, color: "#c4b5fd" }}>Secondary market</span>
          {marketPrice !== null ? (
            <span style={{ fontSize: "0.78rem", color: "#10b981" }}>
              · live price ${Number(marketPrice).toFixed(2)} /unit
            </span>
          ) : (
            <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
              · {iss.market ? "pool not seeded yet" : "no market"}
            </span>
          )}
        </div>

        {/* K-line / candle chart of on-chain price history */}
        {marketHistory.length > 0 && (
          <MarketChart history={marketHistory} primaryPrice={price} />
        )}

        {iss.market && (
          <>
            {isIssuer && marketPrice === null && (
              <div className="vf-row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: "0.72rem", color: "#9ca3af" }}>Seed liquidity ·</span>
                <input value={seedTok} onChange={(e) => setSeedTok(e.target.value)} type="number" step="0.1" min="0" placeholder="units" style={{ ...inputStyle, maxWidth: 100, flexBasis: 80 }} />
                <input value={seedUsd} onChange={(e) => setSeedUsd(e.target.value)} type="number" step="1" min="0" placeholder="USDT" style={{ ...inputStyle, maxWidth: 100, flexBasis: 80 }} />
                <button onClick={() => onSeed(seedTok, seedUsd)} style={btnStyle({ outline: true })}>
                  Seed
                </button>
                <button
                  onClick={() => {
                    // Seed at the SAME starting unit price as the primary issuance.
                    const u = 10;
                    setSeedTok(String(u));
                    setSeedUsd(String((u * price).toFixed(2)));
                  }}
                  style={btnStyle({ outline: true })}
                >
                  Seed @ ${price.toFixed(2)}/unit
                </button>
                <span style={{ fontSize: "0.7rem", color: "#6b7280" }}>starts where primary does</span>
              </div>
            )}
            <div className="vf-row" style={{ gap: 8, flexWrap: "wrap" }}>
              <input value={tradeAmt} onChange={(e) => setTradeAmt(e.target.value)} type="number" step="0.01" min="0" style={{ ...inputStyle, maxWidth: 110, flexBasis: 90 }} />
              <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>USDT</span>
              <button onClick={() => onTradeBuy(tradeAmt)} style={btnStyle({})}>
                Buy
              </button>
              {tradeUnits && <span style={{ fontSize: "0.8rem", color: "#10b981" }}>≈ {tradeUnits} units</span>}
              <input value={sellAmt} onChange={(e) => setSellAmt(e.target.value)} type="number" step="0.1" min="0" placeholder="units" style={{ ...inputStyle, maxWidth: 90, flexBasis: 70 }} />
              <button onClick={() => onTradeSell(sellAmt)} style={btnStyle({ outline: true })}>
                Sell
              </button>
              <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>→ price moves with demand</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Lightweight on-chain candlestick / K-line chart for the secondary market.
// Draws candles from the on-chain price history (each point: seed/buy/sell).
function MarketChart({
  history,
  primaryPrice,
}: {
  history: { ts: number; price: string; kind: number }[];
  primaryPrice: number;
}) {
  const W = 100, H = 48, PAD = 4;
  const pts = history.map((h, i) => ({ i, price: parseFloat(h.price), ts: h.ts, kind: h.kind }));
  const prices = [...pts.map((p) => p.price), primaryPrice];
  const min = Math.min(...prices) * 0.98;
  const max = Math.max(...prices) * 1.02;
  const range = max - min || 1;
  const x = (i: number) => PAD + (i / Math.max(1, pts.length - 1)) * (W - PAD * 2);
  const y = (p: number) => H - PAD - ((p - min) / range) * (H - PAD * 2);
  // Build candles: aggregate by index — open=prev close, close=this price,
  // high/low = max/min of open,close (single-point candles).
  let prev = primaryPrice;
  const candles = pts.map((p) => {
    const open = prev;
    const close = p.price;
    const up = close >= open;
    const c = { ...p, open, close, high: Math.max(open, close), low: Math.min(open, close), up };
    prev = close;
    return c;
  });
  const cw = Math.max(3, (W - PAD * 2) / candles.length - 2);
  return (
    <div style={{ border: "1px solid #2c2c47", borderRadius: 10, padding: 8, background: "rgba(0,0,0,0.25)" }}>
      <div className="vf-row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: "0.7rem", color: "#9ca3af" }}>Price · on-chain</span>
        <span style={{ fontSize: "0.7rem", color: "#10b981" }}>
          {pts.length} trade{pts.length === 1 ? "" : "s"} · primary ${primaryPrice.toFixed(2)}
        </span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
        {candles.map((c, i) => {
          const cx = x(i);
          const upColor = "#10b981", dnColor = "#f87171";
          const col = c.up ? upColor : dnColor;
          return (
            <g key={i}>
              <line x1={cx} y1={y(c.high)} x2={cx} y2={y(c.low)} stroke={col} strokeWidth={1} />
              <line
                x1={cx - cw / 2} y1={y(c.open)} x2={cx + cw / 2} y2={y(c.open)}
                stroke={col} strokeWidth={1}
              />
              <line
                x1={cx - cw / 2} y1={y(c.close)} x2={cx + cw / 2} y2={y(c.close)}
                stroke={col} strokeWidth={2}
              />
            </g>
          );
        })}
        <line x1={PAD} y1={y(primaryPrice)} x2={W - PAD} y2={y(primaryPrice)} stroke="#c4b5fd" strokeDasharray="3,2" strokeWidth={0.8} />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.62rem", color: "#6b7280", marginTop: 2 }}>
        <span>${min.toFixed(2)}</span>
        <span>primary ${primaryPrice.toFixed(2)}</span>
        <span>${max.toFixed(2)}</span>
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
      <div className="vf-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
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
          {result.payloadHash && (
            <span style={{ display: "block", marginTop: 4, fontFamily: "monospace", color: "#6ee7b7" }}>
              payload committed: {result.payloadHash.slice(0, 14)}…{result.payloadHash.slice(-8)}
            </span>
          )}
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
  minWidth: 0,
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
