import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain, type Chain } from "viem";
import { CHAINS, CHAIN_IDS, getChain, type ChainConfig } from "./chains";

// Both BOT mainnet (677) and Bohr testnet (968) are registered so the wallet
// can switchChain between them via the Testnet/Mainnet toggle.
function makeChain(cfg: ChainConfig): Chain {
  return defineChain({
    id: cfg.id,
    name: cfg.name,
    nativeCurrency: cfg.nativeCurrency,
    rpcUrls: {
      default: { http: [cfg.rpc] },
      public: { http: [cfg.rpc] },
    },
    blockExplorers: {
      default: { name: "BOTScan", url: cfg.scan },
    },
  });
}

export const botChain = makeChain(getChain(677));
export const bohrChain = makeChain(getChain(968));

export const chains: readonly [Chain, ...Chain[]] = [botChain, bohrChain];

export const config = createConfig({
  chains,
  connectors: [injected()],
  transports: Object.fromEntries(CHAIN_IDS.map((id) => [id, http(getChain(id).rpc)])),
});
