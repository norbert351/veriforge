import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VeriForge — AI RWA Verification on BOT Chain",
  description: "AI-driven risk verification for Real World Asset projects on BOT Chain mainnet. Signed, on-chain attestations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
