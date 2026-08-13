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
  const PAYLOAD = ethers.keccak256(ethers.toUtf8Bytes("docs+metadata+proof")); // bytes32 commitment
  const PAYLOAD2 = ethers.keccak256(ethers.toUtf8Bytes("another payload"));

  beforeEach(async function () {
    [verifier, attacker, user] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("AttestationRegistry");
    registry = (await Factory.deploy(verifier.address)) as AttestationRegistry;
    await registry.waitForDeployment();
  });

  it("sets the verifier on deploy", async function () {
    expect(await registry.verifier()).to.equal(verifier.address);
    expect(await registry.verifierCount()).to.equal(1);
  });

  it("records an attestation with all fields", async function () {
    await registry.connect(verifier).attest(TARGET, SCORE, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://report-1", PAYLOAD);

    const a = await registry.getAttestation(TARGET);
    expect(a.target).to.equal(TARGET);
    expect(a.score).to.equal(SCORE);
    expect(a.verdict).to.equal(VERDICT_APPROVED);
    expect(a.findingsHash).to.equal(FINDINGS_HASH);
    expect(a.reportUri).to.equal("ipfs://report-1");
    expect(a.payloadHash).to.equal(PAYLOAD);
    expect(a.attestedAt).to.be.greaterThan(0);
    expect(a.blockNumber).to.be.greaterThan(0);
  });

  it("appends to history and keeps latest", async function () {
    await registry.connect(verifier).attest(TARGET, 60, VERDICT_CAUTION, 1, "ipfs://v1", PAYLOAD);
    await registry.connect(verifier).attest(TARGET, 90, VERDICT_APPROVED, 2, "ipfs://v2", PAYLOAD);

    const latest = await registry.getAttestation(TARGET);
    expect(latest.score).to.equal(90);
    expect(latest.verdict).to.equal(VERDICT_APPROVED);

    const hist = await registry.getHistory(TARGET);
    expect(hist.length).to.equal(2);
    expect(hist[0].score).to.equal(60);
    expect(hist[1].score).to.equal(90);
  });

  it("emits Attested with the right fields", async function () {
    const tx = await registry.connect(verifier).attest(TARGET, SCORE, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://report-1", PAYLOAD);
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
    expect(parsed!.args.payloadHash).to.equal(PAYLOAD);
    expect(parsed!.args.attestedAt).to.be.greaterThan(0);
  });

  it("rejects non-verifier callers", async function () {
    await expect(
      registry.connect(attacker).attest(TARGET, SCORE, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://x", PAYLOAD)
    ).to.be.revertedWithCustomError(registry, "OnlyVerifier");
  });

  it("rejects zero target", async function () {
    await expect(
      registry.connect(verifier).attest(ethers.ZeroAddress, SCORE, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://x", PAYLOAD)
    ).to.be.revertedWithCustomError(registry, "InvalidTarget");
  });

  it("rejects score above 100", async function () {
    await expect(
      registry.connect(verifier).attest(TARGET, 101, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://x", PAYLOAD)
    ).to.be.revertedWithCustomError(registry, "ScoreOutOfRange");
  });

  it("rejects empty payload hash", async function () {
    await expect(
      registry.connect(verifier).attest(TARGET, SCORE, VERDICT_APPROVED, FINDINGS_HASH, "ipfs://x", ethers.ZeroHash)
    ).to.be.revertedWithCustomError(registry, "InvalidTarget");
  });

  it("adds verifiers to the set — no single point of failure", async function () {
    await registry.connect(verifier).addVerifier(user.address);
    expect(await registry.verifierCount()).to.equal(2);
    expect(await registry.isVerifier(user.address)).to.equal(true);

    // new verifier can attest
    await registry.connect(user).attest(TARGET, 90, VERDICT_APPROVED, 1, "ipfs://by-user", PAYLOAD);
    expect((await registry.getAttestation(TARGET)).score).to.equal(90);
  });

  it("removes a compromised verifier — old key loses access instantly", async function () {
    await registry.connect(verifier).addVerifier(user.address);
    await registry.connect(verifier).removeVerifier(user.address);
    expect(await registry.isVerifier(user.address)).to.equal(false);

    await expect(
      registry.connect(user).attest(TARGET, 10, VERDICT_BLOCKED, 0, "ipfs://y", PAYLOAD)
    ).to.be.revertedWithCustomError(registry, "OnlyVerifier");

    // remaining verifier still works
    await registry.connect(verifier).attest(TARGET, 10, VERDICT_BLOCKED, 0, "ipfs://y", PAYLOAD);
  });

  it("prevents removal of the last verifier", async function () {
    await expect(registry.connect(verifier).removeVerifier(verifier.address)).to.be.revertedWithCustomError(
      registry,
      "OnlyVerifier"
    );
  });

  it("handles blocked and caution verdicts", async function () {
    await registry.connect(verifier).attest(TARGET, 10, VERDICT_BLOCKED, 999, "ipfs://blocked", PAYLOAD);
    await registry.connect(verifier).attest(TARGET, 45, VERDICT_CAUTION, 888, "ipfs://caution", PAYLOAD2);

    const hist = await registry.getHistory(TARGET);
    expect(hist[0].verdict).to.equal(VERDICT_BLOCKED);
    expect(hist[1].verdict).to.equal(VERDICT_CAUTION);
    expect(hist[1].payloadHash).to.equal(PAYLOAD2);
  });
});
