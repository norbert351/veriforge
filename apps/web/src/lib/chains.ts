// Web-side chain registry — BOT mainnet (677) + Bohr testnet (968).
// Both chains are hardcoded with correct defaults, overridable via per-chain
// env vars. IMPORTANT: the two chains use DEDICATED env names (BOT_MAINNET_* /
// BOHR_*), NOT the legacy single-chain NEXT_PUBLIC_BOT_* set, so a stale build
// env that only sets NEXT_PUBLIC_BOT_RPC/USDT/CHAIN_NAME can never corrupt one
// chain's RPC/USDT/label with the other chain's values.
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
    name: process.env.NEXT_PUBLIC_BOT_MAINNET_NAME || "BOT Chain Mainnet",
    label: "Mainnet",
    rpc: process.env.NEXT_PUBLIC_BOT_MAINNET_RPC || "https://rpc.botchain.ai",
    usdt: process.env.NEXT_PUBLIC_BOT_MAINNET_USDT || "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C",
    scan: process.env.NEXT_PUBLIC_BOT_MAINNET_BOTSCAN_URL || "https://scan.botchain.ai",
    nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  },
  968: {
    id: 968,
    name: process.env.NEXT_PUBLIC_BOHR_NAME || "BOT Chain Testnet (Bohr)",
    label: "Testnet",
    rpc: process.env.NEXT_PUBLIC_BOHR_RPC || "https://rpc.bohr.life",
    usdt: process.env.NEXT_PUBLIC_BOHR_USDT || "0x75edC9335175Fc0552D51D48439F229c10420fe3",
    scan: process.env.NEXT_PUBLIC_BOHR_BOTSCAN_URL || "https://scan.bohr.life",
    nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  },
};

// Mainnet is the runtime default. The Testnet/Mainnet toggle in the header
// switches at runtime and persists the choice to localStorage — no redeploy.
export const DEFAULT_CHAIN_ID = 677;

export const CHAIN_IDS = Object.keys(CHAINS).map(Number);

export function getChain(chainId: number): ChainConfig {
  return CHAINS[chainId] || CHAINS[DEFAULT_CHAIN_ID];
}
