import { ethers, network, run } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Chain:", network.name, "chainId", (await ethers.provider.getNetwork()).chainId);

  const verifier = process.env.VERIFIER_ADDRESS || deployer.address;
  console.log("Verifier (AI backend signer):", verifier);

  // 1. AttestationRegistry — where the AI backend stores APPROVED verdicts
  const AR = await ethers.getContractFactory("AttestationRegistry");
  const attestations = await AR.deploy(verifier);
  await attestations.waitForDeployment();
  const attestationsAddr = await attestations.getAddress();
  console.log("AttestationRegistry:", attestationsAddr);

  // 2. IssuanceRegistry — enforces the gate: only APPROVED tokens get listed
  const IR = await ethers.getContractFactory("IssuanceRegistry");
  const issuances = await IR.deploy(verifier, attestationsAddr);
  await issuances.waitForDeployment();
  const issuancesAddr = await issuances.getAddress();
  console.log("IssuanceRegistry:", issuancesAddr);

  // 3. Verify on BOTScan when an API key is set
  if (process.env.BOTSCAN_API_KEY) {
    for (const [addr, args] of [
      [attestationsAddr, [verifier]],
      [issuancesAddr, [verifier, attestationsAddr]],
    ] as [string, any[]][]) {
      try {
        await run("verify:verify", { address: addr, constructorArguments: args });
        console.log("Verified on BOTScan:", addr);
      } catch (e: any) {
        console.warn("Verification skipped:", e?.message || e);
      }
    }
  }

  const fs = require("fs");
  const path = require("path");
  const out = path.join(__dirname, "../../shared/contract-addresses.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        chainId: 677,
        attestationRegistry: attestationsAddr,
        issuanceRegistry: issuancesAddr,
        verifier,
        deployedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("Addresses written to", out);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
