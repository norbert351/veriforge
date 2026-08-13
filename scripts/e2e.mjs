// VeriForge full-loop e2e: x402 pay -> AI gate -> deploy -> list -> buy -> deposit -> claim
import { ethers } from "ethers";

const RPC = process.env.BOT_RPC || "http://127.0.0.1:8545";
const API = process.env.VERIFORGE_API_URL || "http://localhost:4000";
const CHAIN_ID = Number(process.env.BOT_CHAIN_ID || 677);
const USDT = process.env.BOT_USDT || "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const PAY_TO = process.env.X402_PAY_TO || "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ISSUER_KEY = process.env.VERIFIER_PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // acct0
const INVESTOR_KEY = process.env.E2E_INVESTOR_KEY || "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // acct1
const PUBLIC_CHAIN = CHAIN_ID !== 677 || RPC.includes("bohr") || RPC.includes("botchain.ai");

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const issuer = new ethers.Wallet(ISSUER_KEY, provider);
const investor = new ethers.Wallet(INVESTOR_KEY, provider);

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
const DOMAIN = { name: "x402", version: "2", chainId: CHAIN_ID };

async function main() {
  // fund investor with USDT
  const usdt = new ethers.Contract(USDT, ["function mint(address,uint256)", "function approve(address,uint256)", "function balanceOf(address) view returns (uint256)", "function transfer(address,uint256)"], issuer);
  if (PUBLIC_CHAIN) {
    // Bohr/mainnet USDT has no mint: reuse the investor's existing balance,
    // top up only the shortfall from the issuer, and fund gas only if low.
    const NEED = ethers.parseUnits("500", 6);
    const invBal = await usdt.balanceOf(investor.address);
    if (invBal < NEED) {
      const fund = await usdt.transfer(investor.address, NEED - invBal);
      await fund.wait();
      console.log("1. topped investor up to 500 USDT from issuer (public chain)");
    } else {
      console.log("1. investor already has", ethers.formatUnits(invBal, 6), "USDT — skipped issuer funding");
    }
    if ((await provider.getBalance(investor.address)) < ethers.parseUnits("0.2", 18)) {
      const gasTop = await issuer.sendTransaction({ to: investor.address, value: ethers.parseUnits("1", 18) });
      await gasTop.wait();
      console.log("   gas top-up sent to investor");
    }
  } else {
    const mintTx = await usdt.mint(investor.address, ethers.parseUnits("500", 6));
    await mintTx.wait();
    console.log("1. minted 500 USDT to investor");
  }

  // probe the endpoint -> expect 402
  const docs = `Asset: Lagos Warehouse REIT (LAWR).
Backing: A 12,000 sqm logistics warehouse in Ikeja, Lagos valued at 4.2M USDT by an independent valuation dated 2026-05-14 (report on file).
Revenue model: Triple-net lease to a national logistics operator, 9.4% gross yield per annum, paid monthly in USDT.
Legal: Issued by Lagos Warehouse Holdings Ltd, a Nigerian company registered in Lagos, regulated under SEC Nigeria digital asset guidelines. Custody with Meridian Trustees.
Terms: 100,000 units at 10 USDT each. Quarterly buyback option at par plus accrued yield. No leverage, no off-chain rehypothecation.`;
  // asset declaration: issuer signs the EXACT canonical payload the API will
  // commit on-chain. Key order fixed (name, symbol, docsText, docsUri, assetMetadata).
  const assetMetadata = {
    assetClass: "real-estate",
    jurisdiction: "NG-Lagos",
    legalEntity: "Lagos Warehouse Holdings Ltd",
    backingProofType: "title-deed + independent valuation",
    backingProofUri: "ipfs://QmValuationLAWR2026",
    assetPhotos: [],
  };
  const payloadJson = JSON.stringify({
    name: "Lagos Warehouse REIT",
    symbol: "LAWR",
    docsText: docs,
    docsUri: "ipfs://QmTestLAWR",
    assetMetadata,
  });
  const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(payloadJson));
  const issuerSignature = await issuer.signMessage(payloadJson);
  console.log("2. issuer signed asset declaration, payloadHash:", payloadHash.slice(0, 18) + "...");

  const body = {
    name: "Lagos Warehouse REIT",
    symbol: "LAWR",
    pricePerTokenUsdt: 10,
    docsText: docs,
    docsUri: "ipfs://QmTestLAWR",
    assetMetadata,
    issuerAddress: issuer.address,
    issuerSignature,
  };

  const probe = await fetch(`${API}/v1/issuances`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  console.log("3. probe status:", probe.status);
  const challengeB64 = probe.headers.get("payment-required") || "";
  const challenge = JSON.parse(Buffer.from(challengeB64, "base64").toString());
  const accepted = challenge.accepts[0];
  console.log("   challenge amount:", accepted.amount, "payTo:", accepted.payTo);

  // payer = investor sends exact USDT
  const amount = BigInt(accepted.amount);
  const usdtInv = new ethers.Contract(USDT, ["function transfer(address,uint256)"], investor);
  const payTx = await usdtInv.transfer(PAY_TO, amount);
  await payTx.wait();
  console.log("4. investor paid", ethers.formatUnits(amount, 6), "USDT tx:", payTx.hash);

  // sign EIP-712
  const msg = {
    scheme: accepted.scheme, network: accepted.network, chainId: BigInt(accepted.chainId),
    asset: accepted.asset, amount: String(accepted.amount), payTo: accepted.payTo,
    maxTimeoutSeconds: BigInt(accepted.maxTimeoutSeconds), description: accepted.description,
    extra: typeof accepted.extra === "string" ? accepted.extra : JSON.stringify(accepted.extra || {}),
  };
  const signature = await investor.signTypedData(DOMAIN, EIP712_TYPES, msg);
  const header = Buffer.from(JSON.stringify({ accepted, signature, payer: investor.address })).toString("base64");
  console.log("5. signed EIP-712, replaying with PAYMENT-SIGNATURE");

  const res = await fetch(`${API}/v1/issuances`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": header },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log("6. issuance status:", res.status, "listed:", data.listed, "id:", data.issuance_id);
  if (data.onChain) console.log("   token:", data.onChain.token, "\n   explorer:", data.onChain.explorer);
  console.log("   dossier:", data.dossier?.verdict, "score", data.dossier?.score);

  if (!data.listed) { console.log("STOP: not listed", JSON.stringify(data)); return; }
  const tokenAddr = data.onChain.token;
  const distributorAddr = data.onChain.distributor;

  // verify the commitment: API hash === our hash === on-chain attestation hash
  if (data.payloadHash !== payloadHash) {
    console.log("STOP: payloadHash mismatch — API", data.payloadHash, "local", payloadHash);
    return;
  }
  console.log("7. payloadHash verified: API hash matches the locally signed declaration");
  const attAddr = process.env.ATTESTATION_REGISTRY || "";
  if (attAddr) {
    const ar = new ethers.Contract(attAddr, ["function getAttestation(address) view returns ((address target,uint96 score,uint8 verdict,uint64 findingsHash,string reportUri,bytes32 payloadHash,uint64 attestedAt,uint64 blockNumber))"], provider);
    const a = await ar.getAttestation(tokenAddr);
    if (a.payloadHash !== payloadHash) {
      console.log("STOP: on-chain attestation payloadHash mismatch:", a.payloadHash);
      return;
    }
    console.log("   on-chain attestation payloadHash matches (", a.payloadHash.slice(0, 18) + "... )");
  }

  // buy units: approve + buy 50 USDT worth
  const rwaAbi = ["function buy(uint256) returns (uint256)", "function balanceOf(address) view returns (uint256)"];
  const distAbi = ["function deposit(uint256)", "function claim() returns (uint256)", "function claimable(address) view returns (uint256)"];
  // The API pipeline consumes the ISSUER's nonces behind this script, so the
  // issuer must read the chain. The investor is only used here, so track its
  // nonce locally to avoid the latest-block read racing with automine.
  let invNonce = await provider.getTransactionCount(investor.address, "latest");
  const freshNonce = async (w) => provider.getTransactionCount(w.address, "latest");
  const usdtApprove = new ethers.Contract(USDT, ["function approve(address,uint256)"], investor);
  const appr = await usdtApprove.approve(tokenAddr, ethers.parseUnits("50", 6), { nonce: invNonce++ });
  await appr.wait();
  const token = new ethers.Contract(tokenAddr, rwaAbi, investor);
  const buy = await token.buy(ethers.parseUnits("50", 6), { nonce: invNonce++ });
  const buyR = await buy.wait();
  const bal = await token.balanceOf(investor.address);
  console.log("8. investor bought 50 USDT worth ->", ethers.formatUnits(bal, 18), "units tx:", buyR.hash);

  // issuer deposits revenue 25 USDT
  // The API pipeline uses the same issuer key (deploy/attest/list), so the
  // issuer nonce advances between our read and our send. Retry on nonce
  // expiry with a fresh read instead of failing the demo.
  const sendWithRetry = async (fn) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await fn({ nonce: await freshNonce(issuer) });
      } catch (e) {
        if (e?.code === "NONCE_EXPIRED" || /nonce/i.test(String(e?.message || ""))) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        throw e;
      }
    }
    throw new Error("nonce retry exhausted");
  };
  const usdtDep = new ethers.Contract(USDT, ["function approve(address,uint256)"], issuer);
  const depAppr = await sendWithRetry((o) => usdtDep.approve(distributorAddr, ethers.parseUnits("25", 6), o));
  await depAppr.wait();
  const dist = new ethers.Contract(distributorAddr, distAbi, issuer);
  const dep = await sendWithRetry((o) => dist.deposit(ethers.parseUnits("25", 6), o));
  await dep.wait();
  console.log("9. issuer deposited 25 USDT revenue");

  // check claimable via API
  const claimable = await fetch(`${API}/v1/issuances/${data.issuance_id}/claimable/${investor.address}`);
  const claimData = await claimable.json();
  console.log("10. API claimable:", claimData.claimable_usdt, "USDT");

  // investor claims
  const distInv = new ethers.Contract(distributorAddr, distAbi, investor);
  const claim = await distInv.claim({ nonce: await freshNonce(investor) });
  const claimR = await claim.wait();
  const balUsdt = await usdt.balanceOf(investor.address);
  console.log("11. investor claimed tx:", claimR.hash, "USDT bal now:", ethers.formatUnits(balUsdt, 6));

  console.log("\nFULL LOOP OK");
}

main().catch((e) => { console.error("FAIL:", e?.reason || e?.message || e); process.exit(1); });
