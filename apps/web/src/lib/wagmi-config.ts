import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";

// Chain is build-time configurable. Defaults to BOT Chain mainnet (677);
// set NEXT_PUBLIC_BOT_CHAIN_ID=968 + NEXT_PUBLIC_BOT_RPC=https://rpc.bohr.life
// for the Bohr testnet build.
const chainId = Number(process.env.NEXT_PUBLIC_BOT_CHAIN_ID || 677);
const rpc = process.env.NEXT_PUBLIC_BOT_RPC || "https://rpc.botchain.ai";
const explorer = process.env.NEXT_PUBLIC_BOTSCAN_URL || "https://scan.botchain.ai";
const chainName = process.env.NEXT_PUBLIC_BOT_CHAIN_NAME || "BOT Chain Mainnet";

export const botChain = defineChain({
  id: chainId,
  name: chainName,
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: {
    default: { http: [rpc] },
    public: { http: [rpc] },
  },
  blockExplorers: {
    default: { name: "BOTScan", url: explorer },
  },
});

export const config = createConfig({
  chains: [botChain],
  connectors: [injected()],
  transports: {
    [botChain.id]: http(rpc),
  },
});
