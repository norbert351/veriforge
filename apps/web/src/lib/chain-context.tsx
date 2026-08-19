"use client";

import { createContext, useContext, useEffect, useMemo, useState, ReactNode } from "react";
import { useSwitchChain } from "wagmi";
import { CHAINS, DEFAULT_CHAIN_ID, getChain, type ChainConfig } from "./chains";

const LS_KEY = "vf-chain";

interface ChainCtx {
  chainId: number;
  info: ChainConfig;
  switchTo: (id: number) => Promise<void>;
}

const Ctx = createContext<ChainCtx>({
  chainId: DEFAULT_CHAIN_ID,
  info: getChain(DEFAULT_CHAIN_ID),
  switchTo: async () => {},
});

export function ChainProvider({ children }: { children: ReactNode }) {
  // Server + first client render both use DEFAULT_CHAIN_ID, then the effect
  // hydrates the persisted choice from localStorage (no hydration mismatch).
  const [chainId, setChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const { switchChainAsync } = useSwitchChain();

  useEffect(() => {
    try {
      const s = window.localStorage.getItem(LS_KEY);
      if (s && CHAINS[Number(s)]) setChainId(Number(s));
    } catch {
      // ignore
    }
  }, []);

  const switchTo = async (id: number) => {
    if (!CHAINS[id]) return;
    setChainId(id);
    try {
      window.localStorage.setItem(LS_KEY, String(id));
    } catch {
      // ignore
    }
    // Try to move the connected wallet to the same network so payments and
    // contract calls target the selected chain. Non-fatal if it fails.
    try {
      await switchChainAsync({ chainId: id });
    } catch {
      // ignore — user may still interact via a manual network switch
    }
  };

  const value = useMemo<ChainCtx>(
    () => ({ chainId, info: getChain(chainId), switchTo }),
    [chainId]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChain() {
  return useContext(Ctx);
}
