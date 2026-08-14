import * as dotenv from "dotenv";
dotenv.config();

import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 677,
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 677,
    },
    botchain: {
      url: process.env.BOT_RPC || "https://rpc.botchain.ai",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 677,
    },
    "botchain-testnet": {
      url: process.env.BOT_TESTNET_RPC || "https://rpc.bohr.life",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 968,
    },
  },
  etherscan: {
    apiKey: {
      botchain: process.env.BOTSCAN_API_KEY || "",
      "botchain-testnet": process.env.BOTSCAN_API_KEY || "blockscout",
    },
    customChains: [
      {
        network: "botchain",
        chainId: 677,
        urls: {
          apiURL: "https://scan.botchain.ai/api",
          browserURL: "https://scan.botchain.ai",
        },
      },
      {
        network: "botchain-testnet",
        chainId: 968,
        urls: {
          apiURL: "https://scan.bohr.life/api",
          browserURL: "https://scan.bohr.life",
        },
      },
    ],
  },
};

export default config;
