require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

module.exports = {
  solidity: {
    version: "0.8.34",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "paris",
      viaIR: true,
    },
  },
  networks: {
    pulsechain: {
      url: "https://rpc.pulsechain.com",
      chainId: 369,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      pulsechain: "empty",
    },
    customChains: [
      {
        network: "pulsechain",
        chainId: 369,
        urls: {
          apiURL: "https://api.scan.pulsechain.com/api",
          browserURL: "https://scan.pulsechain.com",
        },
      },
    ],
  },
  sourcify: {
    enabled: false,
  },
};
