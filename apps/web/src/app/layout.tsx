import type { Metadata } from "next";
import WalletProvider from "@/components/wallet-provider";
import "./globals.css";

export const metadata: Metadata = {
  title: "VeriForge — AI-Gated RWA Issuance on BOT Chain",
  description: "Tokenize real-world assets with an AI compliance gate. Issuances are listed on-chain only after the VeriForge AI officer approves the documentation. Revenue distributed pro-rata to holders.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
