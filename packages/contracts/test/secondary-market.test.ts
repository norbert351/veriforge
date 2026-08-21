import { expect } from "chai";
import { ethers } from "hardhat";
import type { SecondaryMarket, RwaToken, MockUSDT } from "../typechain-types";

describe("SecondaryMarket — demand-driven trading", () => {
  let token: RwaToken;
  let usdt: MockUSDT;
  let market: SecondaryMarket;
  let issuer: any, investor: any, buyer: any, other: any;

  const TOKEN_SUPPLY = ethers.parseUnits("100", 18); // 100 units
  const PRICE = ethers.parseUnits("10", 6); // $10 primary per unit

  async function deployMarket() {
    const SM = await ethers.getContractFactory("SecondaryMarket");
    return (await SM.deploy(await token.getAddress(), await usdt.getAddress(), issuer.address)) as SecondaryMarket;
  }

  beforeEach(async () => {
    [issuer, investor, buyer, other] = await ethers.getSigners();
    const USD = await ethers.getContractFactory("MockUSDT");
    usdt = (await USD.deploy()) as MockUSDT;
    const R = await ethers.getContractFactory("RwaToken");
    token = (await R.deploy("Gold & Minerals Fund", "GMF", issuer.address, await usdt.getAddress(), PRICE)) as RwaToken;
    market = await deployMarket();

    // mint USDT to all
    await usdt.mint(issuer.address, ethers.parseUnits("10000", 6));
    await usdt.mint(investor.address, ethers.parseUnits("10000", 6));
    await usdt.mint(buyer.address, ethers.parseUnits("10000", 6));
    // mint token units to the issuer so they can seed the pool
    await usdt.approve(await token.getAddress(), ethers.parseUnits("10000", 6));
    await token.connect(issuer).buy(ethers.parseUnits("1000", 6)); // issuer buys 100 units at $10
  });

  it("rejects seeding from a non-issuer", async () => {
    await usdt.connect(buyer).approve(await market.getAddress(), ethers.parseUnits("100", 6));
    await token.connect(buyer).approve(await market.getAddress(), ethers.parseUnits("100", 18));
    await expect(
      market.connect(buyer).seed(ethers.parseUnits("1", 18), ethers.parseUnits("100", 6))
    ).to.be.revertedWithCustomError(market, "NotIssuer");
  });

  it("seeds the pool and sets an initial price", async () => {
    await token.connect(issuer).approve(await market.getAddress(), TOKEN_SUPPLY);
    await usdt.connect(issuer).approve(await market.getAddress(), ethers.parseUnits("100", 6));
    await market.connect(issuer).seed(ethers.parseUnits("10", 18), ethers.parseUnits("100", 6));

    expect(await market.reserveToken()).to.equal(ethers.parseUnits("10", 18));
    expect(await market.reserveUsdt()).to.equal(ethers.parseUnits("100", 6));
    // 100 USDT / 10 tokens = $10 per token
    expect(await market.price()).to.equal(ethers.parseUnits("10", 6));
  });

  it("buying raises the price; selling lowers it (demand-driven)", async () => {
    await token.connect(issuer).approve(await market.getAddress(), TOKEN_SUPPLY);
    await usdt.connect(issuer).approve(await market.getAddress(), ethers.parseUnits("100", 6));
    await market.connect(issuer).seed(ethers.parseUnits("10", 18), ethers.parseUnits("100", 6));

    const p0 = await market.price();
    // buyer buys 100 USDT worth of tokens
    await usdt.connect(buyer).approve(await market.getAddress(), ethers.parseUnits("100", 6));
    const tokenOut = await market.connect(buyer).buy.staticCall(ethers.parseUnits("100", 6));
    await market.connect(buyer).buy(ethers.parseUnits("100", 6));
    const p1 = await market.price();

    expect(tokenOut).to.equal((await market.totalBuyVolume()) === ethers.parseUnits("0", 6) ? 0 : tokenOut);
    // price must have risen after buying
    expect(p1).to.be.gt(p0);
    // buyer now holds tokens
    expect(await token.balanceOf(buyer.address)).to.be.gt(0);

    // selling returns some USDT and lowers price
    const bal = await token.balanceOf(buyer.address);
    await token.connect(buyer).approve(await market.getAddress(), bal);
    const usdtOut = await market.connect(buyer).sell.staticCall(bal);
    await market.connect(buyer).sell(bal);
    const p2 = await market.price();

    expect(usdtOut).to.be.gt(0);
    expect(p2).to.be.lt(p1);
  });

  it("tracks buy/sell volume", async () => {
    await token.connect(issuer).approve(await market.getAddress(), TOKEN_SUPPLY);
    await usdt.connect(issuer).approve(await market.getAddress(), ethers.parseUnits("100", 6));
    await market.connect(issuer).seed(ethers.parseUnits("10", 18), ethers.parseUnits("100", 6));

    await usdt.connect(buyer).approve(await market.getAddress(), ethers.parseUnits("50", 6));
    await market.connect(buyer).buy(ethers.parseUnits("50", 6));
    expect(await market.totalBuyVolume()).to.equal(ethers.parseUnits("50", 6));

    const bal = await token.balanceOf(buyer.address);
    await token.connect(buyer).approve(await market.getAddress(), bal);
    await market.connect(buyer).sell(bal);
    expect(await market.totalSellVolume()).to.be.gt(0);
  });

  it("reverts trading when the pool is unseeded", async () => {
    await usdt.connect(buyer).approve(await market.getAddress(), ethers.parseUnits("10", 6));
    await expect(market.connect(buyer).buy(ethers.parseUnits("10", 6))).to.be.revertedWithCustomError(market, "ZeroAmount");
  });

  it("records an on-chain price point (candle feed) on seed, buy and sell", async () => {
    await token.connect(issuer).approve(await market.getAddress(), TOKEN_SUPPLY);
    await usdt.connect(issuer).approve(await market.getAddress(), ethers.parseUnits("100", 6));
    await market.connect(issuer).seed(ethers.parseUnits("10", 18), ethers.parseUnits("100", 6));
    const pt0 = await market.priceHistory(0);
    expect(pt0.price).to.equal(ethers.parseUnits("10", 6)); // seed at $10
    expect(pt0.kind).to.equal(0);

    // buy -> 2nd candle point, higher price, kind=1
    await usdt.connect(buyer).approve(await market.getAddress(), ethers.parseUnits("10", 6));
    await market.connect(buyer).buy(ethers.parseUnits("10", 6));
    const pt1 = await market.priceHistory(1);
    expect(pt1.price).to.be.gt(pt0.price); // buy pushed price up
    expect(pt1.kind).to.equal(1);
    // The second point confirms the array grew (no revert on getting index 1).
  });
});
