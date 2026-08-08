// x402 payment gate — pattern reused from Foundry ASP, pointed at BOT Chain.
// BOT Chain mainnet: chain 677, USDT bridged at 0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C.
// First contact returns 402 + PAYMENT-REQUIRED challenge. Replay with
// PAYMENT-SIGNATURE header to pass.

import type { FastifyRequest, FastifyReply } from "fastify";
import { ethers } from "ethers";

const PAY_TO = process.env.X402_PAY_TO || "";
const CHAIN_ID = 677;
const USDT = process.env.BOT_USDT || "0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C";

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

export async function x402Gate(req: FastifyRequest, reply: FastifyReply, next: () => void) {
  // Public read endpoints bypass payment
  if (req.method === "GET") return next();

  const auth = (req.headers["payment-signature"] || req.headers["x-payment"]) as string | undefined;

  if (auth) {
    try {
      const decoded = JSON.parse(Buffer.from(auth, "base64").toString("utf8"));

      if (decoded.accepted) {
        const accepted = decoded.accepted;
        const expected = String(Math.round(getFee(req.url) * 1e6));

        if (accepted.amount !== expected) {
          return reply.status(402).send({ error: "invalid_payment", message: "amount mismatch" });
        }
        if (String(accepted.chainId) !== String(CHAIN_ID)) {
          return reply.status(402).send({ error: "invalid_payment", message: "chain mismatch" });
        }
        if (accepted.payTo?.toLowerCase() !== PAY_TO.toLowerCase()) {
          return reply.status(402).send({ error: "invalid_payment", message: "payTo mismatch" });
        }
        (req as any).x402 = { paid: true };
        return next();
      }

      // Legacy {payload, signature} — recover signer and require PAY_TO
      if (decoded.payload && decoded.signature) {
        const message = typeof decoded.payload === "string" ? decoded.payload : JSON.stringify(decoded.payload);
        const recovered = ethers.verifyMessage(message, decoded.signature);
        if (recovered.toLowerCase() === PAY_TO.toLowerCase()) {
          (req as any).x402 = { paid: true };
          return next();
        }
      }

      return reply.status(402).send({ error: "invalid_payment", message: "invalid header format" });
    } catch (e: any) {
      return reply.status(402).send({ error: "invalid_payment", message: e.message });
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
      message: "Payment required via x402 (OKX Agent Payments Protocol).",
      amount_usdt: fee,
      pay_to: PAY_TO,
      network: `eip155:${CHAIN_ID}`,
      chain_id: CHAIN_ID,
      asset: USDT,
    });
}
