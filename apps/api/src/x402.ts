// x402 payment gate — real protocol, dual-chain BOT Chain (mainnet 677 + Bohr testnet 968).
// First contact returns 402 + PAYMENT-REQUIRED challenge offering BOTH chains.
// Replay with a PAYMENT-SIGNATURE header carrying {accepted, signature, payer}:
//   - accepted   the challenge entry the buyer agreed to (amount/chainId/payTo)
//   - signature  EIP-712 signature over that entry, from the payer's wallet
//   - payer      the wallet that actually sent the USDT
// The gate resolves the chain from the accepted entry's chainId, verifies the
// signature, and confirms that the exact amount reached payTo on THAT chain's
// USDT contract (Transfer event scan). No header = 402 challenge.

import type { FastifyRequest, FastifyReply } from "fastify";
import { ethers } from "ethers";
import { CHAINS, getChainInfo, resolveChainId } from "./chains.js";

// Fee per route prefix, in USDT (same across both chains).
const ROUTE_FEES: Record<string, number> = {
  "/v1/issuances": 1.0,
};

function getFee(path: string): number {
  for (const [prefix, fee] of Object.entries(ROUTE_FEES)) {
    if (path.startsWith(prefix)) return fee;
  }
  return 0.01;
}

function buildChainEntry(chainId: number, amount: number, resource: string) {
  const info = getChainInfo(chainId);
  return {
    scheme: "exact",
    network: `eip155:${chainId}`,
    chainId,
    asset: info.usdt,
    amount: String(Math.round(amount * 1e6)),
    payTo: info.payTo,
    maxTimeoutSeconds: 300,
    description: `VeriForge: ${resource}`,
    extra: { name: "Tether USD", version: "1" },
  };
}

function buildChallenge(amount: number, resource: string): string {
  // Offer BOTH chains so the buyer pays on whichever network they selected.
  const payload = {
    x402Version: 2,
    accepts: Object.keys(CHAINS).map((k) => buildChainEntry(Number(k), amount, resource)),
    resource,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

// EIP-712 domain + types matching the x402 exact scheme. The buyer signs the
// challenge entry itself, so the signature is bound to amount, payTo, chainId
// and the asset. Replay protection: the on-chain Transfer check below.
const EIP712_DOMAIN = (chainId: number) => ({
  name: "x402",
  version: "2",
  chainId,
});
const EIP712_TYPES = {
  Payment: [
    { name: "scheme", type: "string" },
    { name: "network", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "asset", type: "address" },
    { name: "amount", type: "string" },
    { name: "payTo", type: "address" },
    { name: "maxTimeoutSeconds", type: "uint256" },
    { name: "description", type: "string" },
    { name: "extra", type: "string" },
  ],
};

function toPaymentMessage(accepted: any, chainId: number): Record<string, any> {
  const info = getChainInfo(chainId);
  return {
    scheme: String(accepted.scheme || "exact"),
    network: String(accepted.network || `eip155:${chainId}`),
    chainId: BigInt(accepted.chainId || chainId),
    asset: String(accepted.asset || info.usdt),
    amount: String(accepted.amount || ""),
    payTo: String(accepted.payTo || info.payTo),
    maxTimeoutSeconds: BigInt(accepted.maxTimeoutSeconds || 300),
    description: String(accepted.description || ""),
    extra: typeof accepted.extra === "string" ? accepted.extra : JSON.stringify(accepted.extra || {}),
  };
}

// Scan the USDT Transfer events on the given chain from `from` to `to` of
// exactly `value` within the last `maxBlocks`. Proves the payment settled.
async function paymentSettled(chainId: number, from: string, to: string, value: bigint, maxBlocks = 50): Promise<string | null> {
  try {
    const info = getChainInfo(chainId);
    const provider = new ethers.JsonRpcProvider(info.rpc, chainId, { staticNetwork: true });
    const usdt = new ethers.Contract(
      info.usdt,
      ["event Transfer(address indexed from, address indexed to, uint256 value)"],
      provider
    );
    const latest = await provider.getBlockNumber();
    const filter = usdt.filters.Transfer(from, to);
    const events = await usdt.queryFilter(filter, Math.max(0, latest - maxBlocks), latest);
    const match = [...events].reverse().find((e: any) => e.args && BigInt(e.args.value) === value);
    return match ? match.transactionHash : null;
  } catch {
    return null;
  }
}

// One settled transfer = one paid request. Consumed tx hashes are remembered
// (bounded ring) so a single payment cannot be replayed for unlimited calls.
const MAX_CONSUMED = 500;
const consumedPayments: string[] = [];
const consumedSet = new Set<string>();

function markConsumed(txHash: string): boolean {
  if (consumedSet.has(txHash)) return false;
  consumedSet.add(txHash);
  consumedPayments.push(txHash);
  if (consumedPayments.length > MAX_CONSUMED) {
    const oldest = consumedPayments.shift();
    if (oldest) consumedSet.delete(oldest);
  }
  return true;
}

export async function x402Gate(req: FastifyRequest, reply: FastifyReply, next: () => void) {
  // Public read endpoints bypass payment
  if (req.method === "GET") return next();

  const auth = (req.headers["payment-signature"] || req.headers["x-payment"]) as string | undefined;

  if (auth) {
    try {
      const decoded = JSON.parse(Buffer.from(auth, "base64").toString("utf8"));
      const accepted = decoded.accepted;
      if (!accepted) {
        return reply.status(402).send({ error: "invalid_payment", message: "accepted entry missing" });
      }

      // Resolve the chain from the accepted entry — the buyer picks which
      // network to pay on; the gate validates against THAT chain.
      const chainId = resolveChainId(accepted.chainId);
      const info = getChainInfo(chainId);

      const expected = String(Math.round(getFee(req.url) * 1e6));
      if (String(accepted.amount) !== expected) {
        return reply.status(402).send({ error: "invalid_payment", message: "amount mismatch" });
      }
      if (String(accepted.chainId) !== String(chainId)) {
        return reply.status(402).send({ error: "invalid_payment", message: "chain mismatch" });
      }
      if (String(accepted.payTo).toLowerCase() !== info.payTo.toLowerCase()) {
        return reply.status(402).send({ error: "invalid_payment", message: "payTo mismatch" });
      }

      // Recover the payer from the EIP-712 signature over the accepted entry.
      const signature = decoded.signature || "";
      const payer = (decoded.payer || "").toLowerCase();
      if (!signature || !payer) {
        return reply.status(402).send({ error: "invalid_payment", message: "signature and payer required" });
      }
      let recovered = "";
      try {
        recovered = ethers
          .verifyTypedData(EIP712_DOMAIN(chainId), EIP712_TYPES, toPaymentMessage(accepted, chainId), signature)
          .toLowerCase();
      } catch {
        return reply.status(402).send({ error: "invalid_payment", message: "signature does not verify" });
      }
      if (recovered !== payer) {
        return reply.status(402).send({ error: "invalid_payment", message: "signer does not match payer" });
      }

      // The payment must actually be settled on-chain on the selected chain.
      const txHash = await paymentSettled(chainId, payer, info.payTo.toLowerCase(), BigInt(expected));
      if (!txHash) {
        return reply.status(402).send({ error: "payment_not_settled", message: "no matching on-chain transfer found" });
      }
      if (!markConsumed(txHash)) {
        return reply.status(402).send({ error: "payment_already_used", message: "this payment was already consumed" });
      }

      (req as any).x402 = { paid: true, chainId, payer, txHash };
      return next();
    } catch (e: any) {
      return reply.status(402).send({ error: "invalid_payment", message: e?.message || "invalid header" });
    }
  }

  const fee = getFee(req.url);
  const challenge = buildChallenge(fee, req.url);
  return reply
    .status(402)
    .header("PAYMENT-REQUIRED", challenge)
    .header("WWW-Authenticate", 'Payment x402Version="2"')
    .send({
      error: "payment_required",
      message: "Payment required via the OKX Agent Payments Protocol.",
      amount_usdt: fee,
      chains: Object.keys(CHAINS).reduce<Record<string, any>>((acc, k) => {
        const c = getChainInfo(Number(k));
        acc[String(c.id)] = { network: `eip155:${c.id}`, chain_id: c.id, asset: c.usdt, pay_to: c.payTo };
        return acc;
      }, {}),
    });
}
