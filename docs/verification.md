# Contract Verification

All deployed contracts are verified on PulseScan.

| Contract | Address | PulseScan |
|---|---|---|
| XenMintManagerV2 | `0x8F3b672F0e223d105cE90e38665e7aD05e0bEEe4` | [View](https://scan.pulsechain.com/address/0x8F3b672F0e223d105cE90e38665e7aD05e0bEEe4#code) |
| IdentityRegistry (ERC-8004) | `0xE13c8700ab99b31D9BCC219FDC345f896Dc4a1ac` | [View](https://scan.pulsechain.com/address/0xE13c8700ab99b31D9BCC219FDC345f896Dc4a1ac#code) |
| ReputationRegistry (ERC-8004) | `0xc1fb41388AEf24c0793A03e9Dc1aC2dD92745BdF` | [View](https://scan.pulsechain.com/address/0xc1fb41388AEf24c0793A03e9Dc1aC2dD92745BdF#code) |
| ValidationRegistry (ERC-8004) | `0xdaE9EC7E9Fb715047643e1cc9544CC052337203C` | [View](https://scan.pulsechain.com/address/0xdaE9EC7E9Fb715047643e1cc9544CC052337203C#code) |

## Compile settings

Contracts in this repo were compiled with different settings. Anyone wanting to reproduce the bytecode locally should use:

### XenMintManagerV2

```js
solidity: {
  version: "0.8.20",
  settings: {
    optimizer: { enabled: false, runs: 200 },
    evmVersion: "paris",
    viaIR: false
  }
}
```

### ERC-8004 registries (IdentityRegistry, ReputationRegistry, ValidationRegistry)

```js
solidity: {
  version: "0.8.34",
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    viaIR: true
  }
}
```

Note: `viaIR: true` is required for ReputationRegistry because its event emits 11 fields, which exceeds the EVM stack depth.

Note: `evmVersion: "paris"` is required for all contracts because PulseChain does not implement the MCOPY opcode from the Cancun hard fork.

## Reproducing verification

```bash
# 1. Install Hardhat v2
npm install --save-dev hardhat@^2.22.0 @nomicfoundation/hardhat-verify@^2.0.0

# 2. For each group of contracts, set the correct compile settings in
#    hardhat.config.js (see above) and move other contracts out of the
#    contracts/ folder temporarily.

# 3. Compile
npx hardhat clean
npx hardhat compile

# 4. Verify
npx hardhat verify --network pulsechain <ADDRESS>
```

No constructor arguments needed for any of the above contracts.
