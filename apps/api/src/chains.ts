// VeriForge chain registry — dual-chain support (BOT mainnet 677 + Bohr testnet 968).
// A chain is fully described by its id, RPC, USDT contract, explorer and payTo.
// Both chains share the same deployer/verifier wallet (same EVM address), but use
// different RPC, USDT and explorer. Everything else in the API resolves a chain id
// to this registry.

export interface ChainInfo {
  id: number;
  name: string;
  rpc: string;
  usdt: string;
  scan: string;
  scanApi: string;
  payTo: string;
}

const PAY_TO = process.env.X402_PAY_TO || "0x73b16058d57a6337060677496d4A8e97A9554539";

export const CHAINS: Record<number, ChainInfo> = {
  677: {
    id: 677,
    name: "BOT Chain Mainnet",
    rpc: process.env.BOT_MAINNET_RPC || "https://rpc.botchain.ai",
    usdt: process.env.BOT_MAINNET_USDT || "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C",
    scan: process.env.BOT_MAINNET_BOTSCAN_URL || "https://scan.botchain.ai",
    scanApi: process.env.BOT_MAINNET_BOTSCAN_API || "https://scan.botchain.ai/api",
    payTo: PAY_TO,
  },
  968: {
    id: 968,
    name: "BOT Chain Testnet (Bohr)",
    rpc: process.env.BOT_TESTNET_RPC || "https://rpc.bohr.life",
    usdt: process.env.BOT_TESTNET_USDT || "0x75edC9335175Fc0552D51D48439F229c10420fe3",
    scan: process.env.BOT_TESTNET_BOTSCAN_URL || "https://scan.bohr.life",
    scanApi: process.env.BOT_TESTNET_BOTSCAN_API || "https://scan.bohr.life/api",
    payTo: PAY_TO,
  },
};

export const CHAIN_IDS = Object.keys(CHAINS).map(Number);

// Default chain controlled by BOT_CHAIN_ID (backwards compatible with the old
// single-chain .env which set BOT_CHAIN_ID=968 for the Bohr build).
export const DEFAULT_CHAIN_ID = (() => {
  const raw = Number(process.env.BOT_CHAIN_ID);
  return CHAINS[raw] ? raw : 677;
})();

/** Resolve an arbitrary value (query param / accepted chainId) to a known chain. */
export function resolveChainId(v: unknown): number {
  const n = Number(v);
  return CHAINS[n] ? n : DEFAULT_CHAIN_ID;
}

export function getChainInfo(chainId: number): ChainInfo {
  return CHAINS[chainId] || CHAINS[DEFAULT_CHAIN_ID];
}
