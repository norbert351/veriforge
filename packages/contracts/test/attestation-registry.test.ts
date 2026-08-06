import { expect } from "chai";
import { ethers } from "hardhat";
import { AttestationRegistry } from "../typechain-types";

describe("AttestationRegistry", function () {
  let registry: AttestationRegistry;
  let verifier: any;
  let attacker: any;
  let user: any;

  const TARGET = "0x1111111111111111111111111111111111111111";
  const SCORE = 85;
  const VERDICT_APPROVED = 2;
  const VERDICT_CAUTION = 1;
  const VERDICT_BLOCKED = 0;
  const FINDINGS_HASH = 123456789;

  beforeEach(async function () {
    [verifier, attacker, user] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AttestationRegistry");
    registry = (await Factory.deploy(verifier.address)) as AttestationRegistry;
    await registry.waitForDeployment();
  });

  it("sets the verifier on deploy", async function () {
    expect(await registry.verifier()).to.equal(verifier.address);
  });

  it("records an attestation with all fields", async function () {
    await registry.connect(verifier).attest(TARGET, SCORE, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://report-1");

    const a = await registry.getAttestation(TARGET);
    expect(a.target).to.equal(TARGET);
    expect(a.score).to.equal(SCORE);
    expect(a.verdict).to.equal(VERDICT_APPROVED);
    expect(a.findingsHash).to.equal(FINDINGS_HASH);
    expect(a.reportUri).to.equal("ipfs://report-1");
    expect(a.attestedAt).to.be.greaterThan(0);
    expect(a.blockNumber).to.be.greaterThan(0);
  });

  it("appends to history and keeps latest", async function () {
    await registry.connect(verifier).attest(TARGET, 60, VERDICT_CAUTION, 1, "ipfs://v1");
    await registry.connect(verifier).attest(TARGET, 90, VERDICT_APPROVED, 2, "ipfs://v2");

    const latest = await registry.getAttestation(TARGET);
    expect(latest.score).to.equal(90);
    expect(latest.verdict).to.equal(VERDICT_APPROVED);

    const hist = await registry.getHistory(TARGET);
    expect(hist.length).to.equal(2);
    expect(hist[0].score).to.equal(60);
    expect(hist[1].score).to.equal(90);
  });

  it("emits Attested with the right fields", async function () {
    const tx = await registry.connect(verifier).attest(TARGET, SCORE, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://report-1");
    const receipt = await tx.wait();
    const iface = registry.interface;
    const log = receipt!.logs.find((l: any) => l.topics[0] === iface.getEvent("Attested")!.topicHash);
    expect(log).to.not.be.undefined;
    const parsed = iface.parseLog({ topics: log!.topics as string[], data: log!.data });
    expect(parsed!.args.target).to.equal(TARGET);
    expect(parsed!.args.score).to.equal(SCORE);
    expect(parsed!.args.verdict).to.equal(VERDICT_APPROVED);
    expect(parsed!.args.findingsHash).to.equal(FINDINGS_HASH);
    expect(parsed!.args.reportUri).to.equal("ipfs://report-1");
    expect(parsed!.args.attestedAt).to.be.greaterThan(0);
  });

  it("rejects non-verifier callers", async function () {
    await expect(registry.connect(attacker).attest(TARGET, SCORE, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://x"))
      .to.be.revertedWithCustomError(registry, "OnlyVerifier");
  });

  it("rejects zero target", async function () {
    await expect(registry.connect(verifier).attest(ethers.ZeroAddress, SCORE, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://x"))
      .to.be.revertedWithCustomError(registry, "InvalidTarget");
  });

  it("rejects score above 100", async function () {
    await expect(registry.connect(verifier).attest(TARGET, 101, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://x"))
      .to.be.revertedWithCustomError(registry, "ScoreOutOfRange");
  });

  it("allows verifier transfer by current verifier only", async function () {
    await registry.connect(verifier).setVerifier(user.address);
    expect(await registry.verifier()).to.equal(user.address);

    // old verifier loses access
    await expect(registry.connect(verifier).attest(TARGET, 10, VERDICT_BLOCKED, 0, "ipfs://y"))
      .to.be.revertedWithCustomError(registry, "OnlyVerifier");

    // new verifier can attest
    await registry.connect(user).attest(TARGET, 10, VERDICT_BLOCKED, 0, "ipfs://y");
  });

  it("handles blocked and caution verdicts", async function () {
    await registry.connect(verifier).attest(TARGET, 10, VERDICT_BLOCKED, 999, "ipfs://blocked");
    await registry.connect(verifier).attest(TARGET, 45, VERDICT_CAUTION, 888, "ipfs://caution");

    const hist = await registry.getHistory(TARGET);
    expect(hist[0].verdict).to.equal(VERDICT_BLOCKED);
    expect(hist[1].verdict).to.equal(VERDICT_CAUTION);
  });
});
