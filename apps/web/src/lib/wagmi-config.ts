import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";

// BOT Chain mainnet — chain 677
export const botChain = defineChain({
  id: 677,
  name: "BOT Chain Mainnet",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.botchain.ai"] },
    public: { http: ["https://rpc.botchain.ai"] },
  },
  blockExplorers: {
    default: { name: "BOTScan", url: "https://scan.botchain.ai" },
  },
});

export const config = createConfig({
  chains: [botChain],
  connectors: [injected()],
  transports: {
    [botChain.id]: http("https://rpc.botchain.ai"),
  },
});
