import { ethers, network, run } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Chain:", network.name, "chainId", (await ethers.provider.getNetwork()).chainId);

  if (!process.env.VERIFIER_ADDRESS) {
    console.warn("VERIFIER_ADDRESS not set — using deployer as verifier");
  }
  const verifier = process.env.VERIFIER_ADDRESS || deployer.address;

  const Factory = await ethers.getContractFactory("AttestationRegistry");
  const registry = await Factory.deploy(verifier);
  await registry.waitForDeployment();
  const addr = await registry.getAddress();

  console.log("AttestationRegistry deployed at:", addr);
  console.log("Verifier:", verifier);

  // Verify on BOTScan (works when BOTSCAN_API_KEY is set)
  if (process.env.BOTSCAN_API_KEY) {
    try {
      await run("verify:verify", {
        address: addr,
        constructorArguments: [verifier],
      });
      console.log("Contract verified on BOTScan");
    } catch (e: any) {
      console.warn("Verification skipped:", e?.message || e);
    }
  }

  // Write address to a shared file for the API/frontend
  const fs = require("fs");
  const path = require("path");
  const out = path.join(__dirname, "../../shared/contract-addresses.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    chainId: 677,
    registry: addr,
    verifier,
    deployedAt: new Date().toISOString(),
  }, null, 2));
  console.log("Address written to", out);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
