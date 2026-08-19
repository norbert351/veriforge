"use client";

import { useState } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { CHAINS, CHAIN_IDS } from "@/lib/chains";
import { useChain } from "@/lib/chain-context";

export default function Header({ active }: { active?: "home" | "marketplace" }) {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { chainId: selChain, info, switchTo } = useChain();
  const [open, setOpen] = useState(false);

  const switchToSelected = async () => {
    try {
      await switchChainAsync({ chainId: selChain });
    } catch (e: any) {
      if (e?.code === 4902) {
        alert(
          `${info.name} not in this wallet. Add it manually: chain ${selChain}, RPC ${info.rpc}`
        );
      }
    }
  };

  const wrongChain = chainId !== undefined && chainId !== null && chainId !== selChain;

  // Segmented Testnet / Mainnet toggle — switches the whole app + wallet chain.
  // Hidden from the top bar on mobile (see CSS); shown inside the menu instead.
  const toggle = (
    <div
      className="vf-chain-toggle"
      role="group"
      aria-label="Network"
      style={{
        display: "flex",
        background: "rgba(255,255,255,0.06)",
        border: "1px solid #23233a",
        borderRadius: 999,
        padding: 3,
        gap: 2,
      }}
    >
      {CHAIN_IDS.map((id) => {
        const c = CHAINS[id];
        const active = id === selChain;
        return (
          <button
            key={id}
            onClick={() => switchTo(id)}
            className={active ? "vf-chain-toggle-btn active" : "vf-chain-toggle-btn"}
            style={{
              border: "none",
              background: active ? "var(--vf-magenta)" : "transparent",
              color: active ? "#fff" : "#9ca3af",
              borderRadius: 999,
              padding: "4px 12px",
              fontSize: "0.72rem",
              fontWeight: 700,
              cursor: "pointer",
              transition: "all 0.15s ease",
            }}
            aria-pressed={active}
            title={c.name}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );

  const navLink = (href: string, label: string, isActive: boolean) => (
    <a
      href={href}
      className="gr-link"
      style={{
        fontSize: "0.95rem",
        color: isActive ? "var(--vf-magenta)" : undefined,
        fontWeight: isActive ? 700 : undefined,
      }}
    >
      {label}
    </a>
  );

  return (
    <header className="vf-header">
      <a
        href="/"
        className="vf-logo"
        style={{ display: "flex", alignItems: "center", textDecoration: "none", color: "inherit" }}
      >
        <img
          src="/logo.jpg"
          alt="VeriForge"
          style={{ width: 34, height: 34, borderRadius: 9, objectFit: "cover", marginRight: 9, border: "1px solid #2a2a44" }}
        />
        <div style={{ fontSize: "1.3rem", fontWeight: 800, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
          Veri<span style={{ color: "var(--vf-magenta)" }}>Forge</span>
        </div>
      </a>

      <nav className="vf-nav-desktop" aria-label="Main">
        {navLink("/", "Home", active === "home")}
        {navLink("/#assets", "RWA Assets", false)}
        {navLink("/#how", "How it works", false)}
        {navLink("/marketplace", "Marketplace", active === "marketplace")}
      </nav>

      <div className="vf-header-actions">
        <div className="vf-header-toggle">{toggle}</div>
        {wrongChain && (
          <button
            onClick={switchToSelected}
            className="gr-btn gr-btn-outline vf-switch-btn"
            style={{ padding: "0.5rem 1rem", fontSize: "0.85rem", whiteSpace: "nowrap" }}
          >
            Switch to {info.label}
          </button>
        )}
        <ConnectButton chainStatus="icon" showBalance={false} accountStatus="address" />
        <button
          className={open ? "vf-burger open" : "vf-burger"}
          onClick={() => setOpen(!open)}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="vf-mobile-menu"
        >
          <span className="vf-burger-box" aria-hidden="true">
            <span></span>
            <span></span>
            <span></span>
          </span>
        </button>
      </div>

      {open && (
        <div className="vf-mobile-menu" id="vf-mobile-menu">
          {navLink("/", "Home", active === "home")}
          {navLink("/#assets", "RWA Assets", false)}
          {navLink("/#how", "How it works", false)}
          {navLink("/marketplace", "Marketplace", active === "marketplace")}
          <div className="vf-mobile-menu-actions">
            {toggle}
            {wrongChain && (
              <button
                onClick={switchToSelected}
                className="gr-btn gr-btn-outline"
                style={{ padding: "0.5rem 1rem", fontSize: "0.8rem", whiteSpace: "nowrap" }}
              >
                Switch to {info.label}
              </button>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
