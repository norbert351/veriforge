"use client";

import { useEffect, useState } from "react";

// Official BOT Chain resources (per the BOT Chain Project Integration Guide).
const LINKS = [
  { label: "Faucet", href: "https://faucet.botchain.ai" },
  { label: "BOTScan", href: process.env.NEXT_PUBLIC_BOTSCAN_URL || "https://scan.bohr.life" },
  { label: "Dev docs", href: "https://dev-docs.botchain.ai/docs/Developers/quick-guide/" },
  { label: "DEX", href: "https://dex.botchain.ai/#/swap" },
  { label: "Bridge", href: "https://bridge.botchain.ai" },
];

export default function BotChainBand() {
  const [price, setPrice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);

    // Official BOT price APIs (guide): coinstore ticker, BDEX graph fallback.
    (async () => {
      try {
        const r = await fetch("https://api.coinstore.com/api/v1/ticker/price;symbol=BOTUSDT", { signal: ctrl.signal });
        const j = await r.json();
        const p = j?.data?.[0]?.price;
        if (live && p) setPrice(Number(p).toFixed(2));
      } catch {
        try {
          const r = await fetch(
            "https://dex-wallet.botchain.ai/api/graph/price?token=0xD5452816194a3784dBa983426cCe7c122F4abd30",
            { signal: ctrl.signal },
          );
          const j = await r.json();
          const p = j?.data?.price;
          if (live && p) setPrice(Number(p).toFixed(2));
        } catch {
          /* price is decorative — links stay */
        }
      }
    })();

    return () => {
      live = false;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, []);

  const chainLabel = process.env.NEXT_PUBLIC_BOT_CHAIN_NAME || "BOT Chain";

  return (
    <section
      style={{
        borderTop: "1px solid rgba(217,70,239,0.25)",
        borderBottom: "1px solid rgba(217,70,239,0.25)",
        background: "rgba(217,70,239,0.05)",
        padding: "0.9rem 1.5rem",
      }}
    >
      <div
        className="vf-row"
        style={{ maxWidth: 1080, margin: "0 auto", flexWrap: "wrap", gap: "0.75rem 1.5rem", justifyContent: "space-between" }}
      >
        <div className="vf-row" style={{ gap: 10, alignItems: "center", fontSize: "0.85rem", color: "#d1d5db" }}>
          <span style={{ fontWeight: 800, letterSpacing: "0.04em", textTransform: "uppercase", fontSize: "0.72rem", color: "var(--vf-magenta)" }}>
            Built on {chainLabel}
          </span>
          <span style={{ color: "#6b7280" }}>·</span>
          <span>
            BOT <span style={{ color: "#10b981", fontWeight: 700 }}>{price ? `$${price}` : "live"}</span>
            <span style={{ color: "#6b7280", fontSize: "0.75rem" }}> official price feed</span>
          </span>
        </div>
        <div className="vf-row" style={{ gap: "0.4rem 1.1rem", flexWrap: "wrap" }}>
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "#9ca3af", fontSize: "0.78rem", textDecoration: "none", borderBottom: "1px dotted rgba(217,70,239,0.5)" }}
            >
              {l.label} ↗
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
