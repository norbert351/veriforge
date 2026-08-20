import { expect } from "chai";
import hre, { ethers } from "hardhat";
import type { AttestationRegistry, RwaToken, RevenueDistributor, IssuanceRegistry } from "../typechain-types";

describe("Issuance loop (AI gate → list → buy → revenue)", () => {
  let registry: AttestationRegistry;
  let issuanceRegistry: IssuanceRegistry;
  let token: RwaToken;
  let distributor: RevenueDistributor;
  let usdt: any;

  let verifier: any, issuer: any, investor: any, other: any;

  const PRICE = 1_000_000n; // 1 USDT per unit (6 dp)
  const ONE = 10n ** 18n;
  const PAYLOAD = ethers.keccak256(ethers.toUtf8Bytes("docs+metadata+proof")); // commitment to reviewed payload
  const PAYLOAD2 = ethers.keccak256(ethers.toUtf8Bytes("tampered docs")); // any edit changes the hash

  async function deployToken(name = "Warehouse Token", symbol = "WHSE") {
    const f = await ethers.getContractFactory("RwaToken");
    return (await f.deploy(name, symbol, issuer.address, usdt.target, PRICE)) as RwaToken;
  }

  async function approveUsdt(holder: any, spender: string, amount: bigint) {
    await usdt.connect(holder).approve(spender, amount);
  }

  async function attestApproved(target: string, score = 90, payload = PAYLOAD) {
    await registry.connect(verifier).attest(target, score, 2, 0x1234, "ipfs://dossier-1", payload);
  }

  beforeEach(async () => {
    [verifier, issuer, investor, other] = await ethers.getSigners();

    // Minimal USDT mock (6 dp, mintable by anyone for tests)
    const Usdt = await ethers.getContractFactory("MockUSDT");
    usdt = await Usdt.deploy();

    const AR = await ethers.getContractFactory("AttestationRegistry");
    registry = (await AR.deploy(verifier.address)) as AttestationRegistry;

    const IR = await ethers.getContractFactory("IssuanceRegistry");
    issuanceRegistry = (await IR.deploy(verifier.address, registry.target)) as IssuanceRegistry;

    token = await deployToken();
    const RD = await ethers.getContractFactory("RevenueDistributor");
    distributor = (await RD.deploy(token.target, usdt.target, issuer.address)) as RevenueDistributor;
  });

  describe("IssuanceRegistry — the AI gate enforced on-chain", () => {
    it("refuses to list an issuance with no attestation", async () => {
      await expect(
        issuanceRegistry.connect(verifier).issue(issuer.address, token.target, distributor.target, PRICE, "ipfs://docs", PAYLOAD)
      ).to.be.revertedWithCustomError(issuanceRegistry, "NotApproved");
    });

    it("refuses to list when the attestation is BLOCKED", async () => {
      await registry.connect(verifier).attest(token.target, 20, 0, 0x1, "ipfs://dossier", PAYLOAD);
      await expect(
        issuanceRegistry.connect(verifier).issue(issuer.address, token.target, distributor.target, PRICE, "ipfs://docs", PAYLOAD)
      ).to.be.revertedWithCustomError(issuanceRegistry, "NotApproved");
    });

    it("refuses to list when the attestation is CAUTION", async () => {
      await registry.connect(verifier).attest(token.target, 55, 1, 0x1, "ipfs://dossier", PAYLOAD);
      await expect(
        issuanceRegistry.connect(verifier).issue(issuer.address, token.target, distributor.target, PRICE, "ipfs://docs", PAYLOAD)
      ).to.be.revertedWithCustomError(issuanceRegistry, "NotApproved");
    });

    it("refuses to list when the payload hash does not match the attestation", async () => {
      await attestApproved(token.target, 90, PAYLOAD);
      // listing with a DIFFERENT payload commitment must fail — tampered docs can't slip through
      await expect(
        issuanceRegistry.connect(verifier).issue(issuer.address, token.target, distributor.target, PRICE, "ipfs://docs", PAYLOAD2)
      ).to.be.revertedWithCustomError(issuanceRegistry, "InvalidPayload");
    });

    it("lists an issuance only after an APPROVED attestation with matching payload", async () => {
      await attestApproved(token.target);
      const id = await issuanceRegistry.connect(verifier).issue.staticCall(
        issuer.address, token.target, distributor.target, PRICE, "ipfs://docs", PAYLOAD
      );
      expect(id).to.equal(1n);
      await issuanceRegistry.connect(verifier).issue(issuer.address, token.target, distributor.target, PRICE, "ipfs://docs", PAYLOAD);
      const i = await issuanceRegistry.getIssuance(1);
      expect(i.token).to.equal(token.target);
      expect(i.issuer).to.equal(issuer.address);
      expect(i.distributor).to.equal(distributor.target);
      expect(i.pricePerToken).to.equal(PRICE);
      expect(i.payloadHash).to.equal(PAYLOAD);
    });

    it("rejects non-verifier callers", async () => {
      await expect(
        issuanceRegistry.connect(issuer).issue(issuer.address, token.target, distributor.target, PRICE, "ipfs://docs", PAYLOAD)
      ).to.be.revertedWithCustomError(issuanceRegistry, "OnlyVerifier");
    });

    it("rejects double listing of the same token", async () => {
      await attestApproved(token.target);
      await issuanceRegistry.connect(verifier).issue(issuer.address, token.target, distributor.target, PRICE, "ipfs://docs", PAYLOAD);
      await expect(
        issuanceRegistry.connect(verifier).issue(issuer.address, token.target, distributor.target, PRICE, "ipfs://docs", PAYLOAD)
      ).to.be.revertedWithCustomError(issuanceRegistry, "AlreadyListed");
    });
  });

  describe("RwaToken — buy units with USDT", () => {
    beforeEach(async () => {
      await usdt.mint(investor.address, 1000n * 1_000_000n);
    });

    it("mints units and forwards USDT to the issuer", async () => {
      await approveUsdt(investor, token.target, 10n * 1_000_000n);
      await expect(token.connect(investor).buy(10n * 1_000_000n))
        .to.emit(token, "Bought")
        .withArgs(investor.address, 10n * 1_000_000n, 10n * ONE);
      expect(await token.balanceOf(investor.address)).to.equal(10n * ONE);
      expect(await usdt.balanceOf(issuer.address)).to.equal(10n * 1_000_000n);
    });

    it("reverts without allowance", async () => {
      await expect(token.connect(investor).buy(10n * 1_000_000n)).to.be.reverted;
    });

    it("reverts on zero amount", async () => {
      await expect(token.connect(investor).buy(0)).to.be.revertedWithCustomError(token, "ZeroAmount");
    });
  });

  describe("RevenueDistributor — pro-rata claims", () => {
    beforeEach(async () => {
      await usdt.mint(investor.address, 1000n * 1_000_000n);
      await usdt.mint(other.address, 1000n * 1_000_000n);
      await usdt.mint(issuer.address, 1000n * 1_000_000n);
    });

    async function buyTokens(holder: any, usdtAmount: bigint) {
      await approveUsdt(holder, token.target, usdtAmount);
      await token.connect(holder).buy(usdtAmount);
    }

    it("distributes revenue pro-rata to holders at claim time", async () => {
      await buyTokens(investor, 300n * 1_000_000n); // 300 units
      await buyTokens(other, 100n * 1_000_000n); // 100 units

      // Issuer deposits 40 USDT of revenue
      await approveUsdt(issuer, distributor.target, 40n * 1_000_000n);
      await distributor.connect(issuer).deposit(40n * 1_000_000n);

      expect(await distributor.claimable(investor.address)).to.equal(30n * 1_000_000n);
      expect(await distributor.claimable(other.address)).to.equal(10n * 1_000_000n);

      await distributor.connect(investor).claim();
      await distributor.connect(other).claim();

      expect(await usdt.balanceOf(investor.address)).to.equal(1000n * 1_000_000n - 300n * 1_000_000n + 30n * 1_000_000n);
      expect(await usdt.balanceOf(other.address)).to.equal(1000n * 1_000_000n - 100n * 1_000_000n + 10n * 1_000_000n);
      expect(await distributor.claimable(investor.address)).to.equal(0n);
    });

    it("accrues new revenue for repeat claims", async () => {
      await buyTokens(investor, 200n * 1_000_000n);
      await approveUsdt(issuer, distributor.target, 20n * 1_000_000n);
      await distributor.connect(issuer).deposit(20n * 1_000_000n);
      await distributor.connect(investor).claim();

      await approveUsdt(issuer, distributor.target, 20n * 1_000_000n);
      await distributor.connect(issuer).deposit(20n * 1_000_000n);
      expect(await distributor.claimable(investor.address)).to.equal(20n * 1_000_000n);
      await distributor.connect(investor).claim();
      expect(await usdt.balanceOf(investor.address)).to.equal(
        1000n * 1_000_000n - 200n * 1_000_000n + 40n * 1_000_000n
      );
    });

    it("reverts claiming with nothing to claim", async () => {
      await expect(distributor.connect(investor).claim()).to.be.revertedWithCustomError(distributor, "NothingToClaim");
    });

    it("reverts deposit when no units exist yet", async () => {
      await approveUsdt(issuer, distributor.target, 5n * 1_000_000n);
      await expect(distributor.connect(issuer).deposit(5n * 1_000_000n)).to.be.revertedWithCustomError(
        distributor,
        "NoSupply"
      );
    });

    it("reverts deposit from a non-issuer (onlyIssuer guard)", async () => {
      await usdt.mint(investor.address, 100n * 1_000_000n);
      // buy units so the distributor has supply
      await approveUsdt(investor, token.target, 10n * 1_000_000n);
      await token.connect(investor).buy(10n * 1_000_000n);
      // non-issuer (investor) tries to deposit — must revert NotIssuer
      await approveUsdt(investor, distributor.target, 5n * 1_000_000n);
      await expect(distributor.connect(investor).deposit(5n * 1_000_000n)).to.be.revertedWithCustomError(
        distributor,
        "NotIssuer"
      );
      // issuer can still deposit
      await approveUsdt(issuer, distributor.target, 5n * 1_000_000n);
      await distributor.connect(issuer).deposit(5n * 1_000_000n);
      expect(await distributor.totalDeposited()).to.equal(5n * 1_000_000n);
      expect(await distributor.lastDepositedBy()).to.equal(issuer.address);
    });
  });

  describe("Full journey", () => {
    it("gate approves → issuance listed → investor buys → revenue claimed", async () => {
      await usdt.mint(investor.address, 1000n * 1_000_000n);
      await usdt.mint(issuer.address, 1000n * 1_000_000n);

      // 1. AI gate approves the token, binding the verdict to the reviewed payload
      await attestApproved(token.target, 88);

      // 2. Issuance listed with the same payload commitment
      await issuanceRegistry.connect(verifier).issue(issuer.address, token.target, distributor.target, PRICE, "ipfs://docs", PAYLOAD);
      const listed = await issuanceRegistry.getIssuance(1);
      expect(listed.token).to.equal(token.target);
      expect(listed.payloadHash).to.equal(PAYLOAD);

      // 3. Investor buys 50 units for 50 USDT
      await approveUsdt(investor, token.target, 50n * 1_000_000n);
      await token.connect(investor).buy(50n * 1_000_000n);

      // 4. Issuer deposits 10 USDT revenue, investor claims all of it
      await approveUsdt(issuer, distributor.target, 10n * 1_000_000n);
      await distributor.connect(issuer).deposit(10n * 1_000_000n);
      expect(await distributor.claimable(investor.address)).to.equal(10n * 1_000_000n);
      await distributor.connect(investor).claim();
      expect(await usdt.balanceOf(investor.address)).to.equal(1000n * 1_000_000n - 50n * 1_000_000n + 10n * 1_000_000n);
    });
  });
});
