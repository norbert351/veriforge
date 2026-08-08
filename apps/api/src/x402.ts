// x402 payment gate — real protocol, BOT Chain.
// BOT Chain mainnet: chain 677, USDT bridged at 0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C.
// First contact returns 402 + PAYMENT-REQUIRED challenge. Replay with a
// PAYMENT-SIGNATURE header carrying {accepted, signature, payer}:
//   - accepted   the challenge entry the buyer agreed to (amount/chainId/payTo)
//   - signature  EIP-712 signature over that entry, from the payer's wallet
//   - payer      the wallet that actually sent the USDT
// The gate verifies the signature AND that the exact amount reached payTo
// on-chain (Transfer event scan). No header = 402 challenge.

import type { FastifyRequest, FastifyReply } from "fastify";
import { ethers } from "ethers";

const PAY_TO = process.env.X402_PAY_TO || "";
const CHAIN_ID = 677;
const USDT = process.env.BOT_USDT || "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C";
const RPC = process.env.BOT_RPC || "https://rpc.botchain.ai";

// Fee per route prefix, in USDT
const ROUTE_FEES: Record<string, number> = {
  "/v1/issuances": 2.0,
};

function getFee(path: string): number {
  for (const [prefix, fee] of Object.entries(ROUTE_FEES)) {
    if (path.startsWith(prefix)) return fee;
  }
  return 0.01;
}

function buildChallenge(amount: number, resource: string): string {
  const payload = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${CHAIN_ID}`,
        chainId: CHAIN_ID,
        asset: USDT,
        amount: String(Math.round(amount * 1e6)),
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        description: `VeriForge: ${resource}`,
        extra: { name: "Tether USD", version: "1" },
      },
    ],
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

function toPaymentMessage(accepted: any): Record<string, any> {
  return {
    scheme: String(accepted.scheme || "exact"),
    network: String(accepted.network || ""),
    chainId: BigInt(accepted.chainId || CHAIN_ID),
    asset: String(accepted.asset || USDT),
    amount: String(accepted.amount || ""),
    payTo: String(accepted.payTo || ""),
    maxTimeoutSeconds: BigInt(accepted.maxTimeoutSeconds || 300),
    description: String(accepted.description || ""),
    extra: typeof accepted.extra === "string" ? accepted.extra : JSON.stringify(accepted.extra || {}),
  };
}

// Scan USDT Transfer events from `from` to `to` of exactly `value` within the
// last `maxBlocks`. Proves the payment settled on-chain.
async function paymentSettled(from: string, to: string, value: bigint, maxBlocks = 50): Promise<string | null> {
  try {
    const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
    const usdt = new ethers.Contract(
      USDT,
      ["event Transfer(address indexed from, address indexed to, uint256 value)"],
      provider
    );
    const latest = await provider.getBlockNumber();
    // Only `from`/`to` are indexed — `value` cannot be a topic filter. Filter
    // the indexed pair, then confirm the exact amount in the decoded args.
    const filter = usdt.filters.Transfer(from, to);
    const events = await usdt.queryFilter(filter, Math.max(0, latest - maxBlocks), latest);
    const match = events.find((e: any) => e.args && BigInt(e.args.value) === value);
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

      const expected = String(Math.round(getFee(req.url) * 1e6));
      if (String(accepted.amount) !== expected) {
        return reply.status(402).send({ error: "invalid_payment", message: "amount mismatch" });
      }
      if (String(accepted.chainId) !== String(CHAIN_ID)) {
        return reply.status(402).send({ error: "invalid_payment", message: "chain mismatch" });
      }
      if (String(accepted.payTo).toLowerCase() !== PAY_TO.toLowerCase()) {
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
          .verifyTypedData(EIP712_DOMAIN(CHAIN_ID), EIP712_TYPES, toPaymentMessage(accepted), signature)
          .toLowerCase();
      } catch {
        return reply.status(402).send({ error: "invalid_payment", message: "signature does not verify" });
      }
      if (recovered !== payer) {
        return reply.status(402).send({ error: "invalid_payment", message: "signer does not match payer" });
      }

      // The payment must actually be settled on-chain: exact USDT amount from
      // the payer to payTo in a recent block window. And it must not have been
      // consumed by an earlier request — one transfer buys one issuance.
      const txHash = await paymentSettled(payer, PAY_TO.toLowerCase(), BigInt(expected));
      if (!txHash) {
        return reply.status(402).send({ error: "payment_not_settled", message: "no matching on-chain transfer found" });
      }
      if (!markConsumed(txHash)) {
        return reply.status(402).send({ error: "payment_already_used", message: "this payment was already consumed" });
      }

      (req as any).x402 = { paid: true, payer, txHash };
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
      pay_to: PAY_TO,
      network: `eip155:${CHAIN_ID}`,
      chain_id: CHAIN_ID,
      asset: USDT,
    });
}
