"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme } from "@rainbow-me/rainbowkit";
import { config } from "@/lib/wagmi-config";
import { ChainProvider } from "@/lib/chain-context";
import { DEFAULT_CHAIN_ID } from "@/lib/chains";
import { ReactNode } from "react";
import "@rainbow-me/rainbowkit/styles.css";

const queryClient = new QueryClient();

export default function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({ accentColor: "#d81b60", borderRadius: "large" })}
          initialChain={DEFAULT_CHAIN_ID}
        >
          <ChainProvider>{children}</ChainProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
