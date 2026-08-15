import Header from "@/components/Header";
import Reveal from "@/components/Reveal";
import BotChainBand from "@/components/BotChainBand";

/* ================= Landing (marketing page) ================= */

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

export default function Home() {
  return (
    <main>
      <Header active="home" />

      {/* ── Hero: motion-picture RWA showcase ── */}
      <HeroSection />

      {/* ── Film-style asset ticker ── */}
      <Ticker />

      {/* ── Built on BOT Chain: official resources + live BOT price ── */}
      <BotChainBand />

      {/* ── RWA asset classes ── */}
      <AssetsSection />

      {/* ── How it works / about the project ── */}
      <HowItWorksSection />

      {/* ── CTA into the product ── */}
      <section className="vf-section" style={{ textAlign: "center", paddingTop: "1rem" }}>
        <Reveal>
          <h2 className="vf-h2" style={{ marginBottom: 14 }}>Ready to invest or launch?</h2>
          <p style={{ color: "#9ca3af", maxWidth: 560, margin: "0 auto 2rem", lineHeight: 1.7 }}>
            Browse live AI-approved issuances, buy units with USDT, or tokenize your own
            asset through the compliance gate.
          </p>
          <a href="/marketplace" className="gr-btn" style={{ fontSize: "1.05rem", padding: "1rem 2.2rem" }}>
            Enter the marketplace
          </a>
        </Reveal>
      </section>

      <footer className="vf-footer">
        <div>
          Veri<span style={{ color: "var(--vf-magenta)" }}>Forge</span> — AI-gated RWA
          issuance on BOT Chain · revenue claims in USDT · platform holds no funds
        </div>
        <div>BOT Chain Builder Challenge #2 · AI × RWA · Deadline Aug 20 2026</div>
      </footer>
    </main>
  );
}

/* ================= Landing sections ================= */

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
      <div className="vf-hero-content">
        <p className="vf-hero-eyebrow vf-eyebrow" style={{ marginBottom: 18 }}>
          BOT Chain Builder Challenge · AI × RWA
        </p>
        <h1 className="vf-hero-title">
          Real-world assets,
          <br />
          forged <span style={{ color: "var(--vf-magenta)" }}>on-chain</span>.
        </h1>
        <p className="vf-hero-sub">
          Issuers document a real asset. The VeriForge AI compliance officer scores the
          documentation, and only APPROVED issuances list on BOT Chain. Investors buy units
          with USDT and claim revenue pro-rata. The platform never holds your funds.
        </p>
        <div className="vf-hero-cta" style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <a href="#assets" className="gr-btn">Explore RWA assets</a>
          <a href="/marketplace" className="gr-btn gr-btn-outline">Enter the marketplace</a>
        </div>
        <div className="vf-hero-chips" style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap", marginTop: "2.2rem" }}>
          {["AI compliance gate", "USDT rails", "On-chain revenue", "Zero custody"].map((c) => (
            <span key={c} className="vf-chip">{c}</span>
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
          <span key={i} className="vf-ticker-item">
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
