"use client";

import { useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";

const BOT_CHAIN_ID = Number(process.env.NEXT_PUBLIC_BOT_CHAIN_ID || 677);

export default function Header({ active }: { active?: "home" | "marketplace" }) {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const [open, setOpen] = useState(false);

  const switchToBot = async () => {
    try {
      await switchChainAsync({ chainId: BOT_CHAIN_ID });
    } catch (e: any) {
      if (e?.code === 4902) {
        alert(
          "BOT Chain not in this wallet. Add it manually: chain " +
            BOT_CHAIN_ID +
            ", RPC " +
            (process.env.NEXT_PUBLIC_BOT_RPC || "https://rpc.botchain.ai")
        );
      }
    }
  };

  const wrongChain = chainId !== undefined && chainId !== null && chainId !== BOT_CHAIN_ID;
  const navLink = (href: string, label: string, isActive: boolean) => (
    <a
      href={href}
      className="gr-link"
      style={{
        fontSize: "0.9rem",
        color: isActive ? "var(--vf-magenta)" : undefined,
        fontWeight: isActive ? 700 : undefined,
      }}
    >
      {label}
    </a>
  );

  return (
    <header className="vf-header">
      <a href="/" style={{ display: "flex", alignItems: "center", textDecoration: "none", color: "inherit" }}>
        <div style={{ fontSize: "1.3rem", fontWeight: 800, letterSpacing: "-0.02em" }}>
          Veri<span style={{ color: "var(--vf-magenta)" }}>Forge</span>
        </div>
      </a>

      <nav className="vf-nav-desktop" aria-label="Main">
        {navLink("/", "Home", active === "home")}
        {navLink("/#assets", "RWA Assets", false)}
        {navLink("/#how", "How it works", false)}
        {navLink("/marketplace", "Marketplace", active === "marketplace")}
      </nav>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {wrongChain && (
          <button onClick={switchToBot} className="gr-btn gr-btn-outline vf-switch-btn" style={{ padding: "0.5rem 1rem", fontSize: "0.85rem" }}>
            Switch to BOT Chain
          </button>
        )}
        <ConnectButton chainStatus="icon" showBalance={false} accountStatus="address" />
        <button
          className="vf-burger"
          onClick={() => setOpen(!open)}
          aria-label="Menu"
          aria-expanded={open}
        >
          {open ? "✕" : "☰"}
        </button>
      </div>

      {open && (
        <div className="vf-mobile-menu">
          {navLink("/", "Home", active === "home")}
          {navLink("/#assets", "RWA Assets", false)}
          {navLink("/#how", "How it works", false)}
          {navLink("/marketplace", "Marketplace", active === "marketplace")}
          {wrongChain && (
            <button onClick={switchToBot} className="gr-btn gr-btn-outline" style={{ padding: "0.6rem 1rem", fontSize: "0.85rem" }}>
              Switch to BOT Chain
            </button>
          )}
        </div>
      )}
    </header>
  );
}
