// Local dev deployment: MockUSDT + AttestationRegistry + IssuanceRegistry
// against a local hardhat node (chain 677). Writes contract-addresses.json.
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const Usdt = await ethers.getContractFactory("MockUSDT");
  const usdt = await Usdt.deploy();
  await usdt.waitForDeployment();
  console.log("MockUSDT:", await usdt.getAddress());

  const AR = await ethers.getContractFactory("AttestationRegistry");
  const attestations = await AR.deploy(deployer.address);
  await attestations.waitForDeployment();
  console.log("AttestationRegistry:", await attestations.getAddress());

  const IR = await ethers.getContractFactory("IssuanceRegistry");
  const issuances = await IR.deploy(deployer.address, await attestations.getAddress());
  await issuances.waitForDeployment();
  console.log("IssuanceRegistry:", await issuances.getAddress());

  const fs = require("fs");
  const path = require("path");
  const out = path.join(__dirname, "../../shared/contract-addresses.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        chainId: 677,
        attestationRegistry: await attestations.getAddress(),
        issuanceRegistry: await issuances.getAddress(),
        verifier: deployer.address,
        usdt: await usdt.getAddress(),
        deployedAt: new Date().toISOString(),
        local: true,
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
