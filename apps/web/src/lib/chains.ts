// Web-side chain registry — both BOT mainnet (677) and Bohr testnet (968) are
// build-time configurable so a single bundle can toggle between them.
export interface ChainConfig {
  id: number;
  name: string;
  label: string; // short label for the toggle
  rpc: string;
  usdt: string;
  scan: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export const CHAINS: Record<number, ChainConfig> = {
  677: {
    id: 677,
    name: process.env.NEXT_PUBLIC_BOT_CHAIN_NAME || "BOT Chain Mainnet",
    label: "Mainnet",
    rpc: process.env.NEXT_PUBLIC_BOT_RPC || "https://rpc.botchain.ai",
    usdt: process.env.NEXT_PUBLIC_BOT_USDT || "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C",
    scan: process.env.NEXT_PUBLIC_BOTSCAN_URL || "https://scan.botchain.ai",
    nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  },
  968: {
    id: 968,
    name: "BOT Chain Testnet (Bohr)",
    label: "Testnet",
    rpc: process.env.NEXT_PUBLIC_BOHR_RPC || "https://rpc.bohr.life",
    usdt: process.env.NEXT_PUBLIC_BOHR_USDT || "0x75edC9335175Fc0552D51D48439F229c10420fe3",
    scan: process.env.NEXT_PUBLIC_BOHR_BOTSCAN_URL || "https://scan.bohr.life",
    nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  },
};

// Default network (backwards compatible with the single-chain build which used
// NEXT_PUBLIC_BOT_CHAIN_ID to pick one network).
export const DEFAULT_CHAIN_ID = (() => {
  const raw = Number(process.env.NEXT_PUBLIC_BOT_CHAIN_ID);
  return CHAINS[raw] ? raw : 677;
})();

export const CHAIN_IDS = Object.keys(CHAINS).map(Number);

export function getChain(chainId: number): ChainConfig {
  return CHAINS[chainId] || CHAINS[DEFAULT_CHAIN_ID];
}
