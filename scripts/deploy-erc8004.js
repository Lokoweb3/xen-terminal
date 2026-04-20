// deploy-erc8004.js
//
// Deploys the ERC-8004 Identity / Reputation / Validation registries
// and registers the XEN Terminal relayer as an on-chain agent.
//
// Usage: node scripts/deploy-erc8004.js
//
// Prerequisites:
//   - .env with PRIVATE_KEY (owner) and RELAYER_ADDRESS
//   - solc installed (`npm i solc`)
//   - agent-card.json hosted somewhere accessible (see agent-card.example.json)

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const solc = require('solc');

const RPC = process.env.RPC_URL || 'https://rpc.pulsechain.com';

// Where the agent-card.json lives — set this to your own host
const AGENT_URI = process.env.AGENT_URI || 'ipfs://YOUR_AGENT_CARD_CID_HERE';

// ───────────────────────────────────────────────────────────

function compileContract(contractPath, contractName) {
  console.log(`Compiling ${contractName}...`);
  const source = fs.readFileSync(contractPath, 'utf8');

  const input = {
    language: 'Solidity',
    sources: { [contractName + '.sol']: { content: source } },
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const errors = output.errors.filter(e => e.severity === 'error');
    if (errors.length) {
      errors.forEach(e => console.error(e.formattedMessage));
      process.exit(1);
    }
  }

  const contract = output.contracts[contractName + '.sol'][contractName];
  return {
    abi: contract.abi,
    bytecode: '0x' + contract.evm.bytecode.object,
  };
}

async function deploy(factory, args, label) {
  console.log(`Deploying ${label}...`);
  const contract = args.length > 0 ? await factory.deploy(...args) : await factory.deploy();
  console.log(`  tx: ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(`  ✓ ${label} @ ${addr}`);
  return { contract, address: addr };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const relayerAddr = process.env.RELAYER_ADDRESS;

  if (!relayerAddr) {
    console.error('RELAYER_ADDRESS not set in .env');
    process.exit(1);
  }

  console.log('Deploying ERC-8004 registry stack');
  console.log(`Owner:   ${owner.address}`);
  console.log(`Relayer: ${relayerAddr}`);
  console.log(`RPC:     ${RPC}`);
  console.log('');

  // ─── Compile all three ──
  const identity   = compileContract(path.join(__dirname, '../contracts/IdentityRegistry.sol'),   'IdentityRegistry');
  const reputation = compileContract(path.join(__dirname, '../contracts/ReputationRegistry.sol'), 'ReputationRegistry');
  const validation = compileContract(path.join(__dirname, '../contracts/ValidationRegistry.sol'), 'ValidationRegistry');

  // ─── Deploy Identity ──
  const IdentityFactory = new ethers.ContractFactory(identity.abi, identity.bytecode, owner);
  const { contract: idReg, address: idAddr } = await deploy(IdentityFactory, [], 'IdentityRegistry');

  // ─── Deploy Reputation + init ──
  const RepFactory = new ethers.ContractFactory(reputation.abi, reputation.bytecode, owner);
  const { contract: repReg, address: repAddr } = await deploy(RepFactory, [], 'ReputationRegistry');

  console.log('Initializing ReputationRegistry...');
  const t1 = await repReg.initialize(idAddr);
  await t1.wait();
  console.log('  ✓ initialized');

  // ─── Deploy Validation + init ──
  const ValFactory = new ethers.ContractFactory(validation.abi, validation.bytecode, owner);
  const { contract: valReg, address: valAddr } = await deploy(ValFactory, [], 'ValidationRegistry');

  console.log('Initializing ValidationRegistry...');
  const t2 = await valReg.initialize(idAddr);
  await t2.wait();
  console.log('  ✓ initialized');

  // ─── Register the relayer as an agent ──
  console.log('');
  console.log('Registering XEN Terminal relayer as ERC-8004 agent...');
  console.log(`  agentURI: ${AGENT_URI}`);

  const tx = await idReg['register(string)'](AGENT_URI);
  const receipt = await tx.wait();

  // Parse the Registered event to get the agentId
  let agentId = null;
  for (const log of receipt.logs) {
    try {
      const parsed = idReg.interface.parseLog(log);
      if (parsed && parsed.name === 'Registered') {
        agentId = parsed.args.agentId.toString();
        break;
      }
    } catch {}
  }

  console.log(`  ✓ Registered as agentId: ${agentId}`);

  // ─── Set the agentWallet to the relayer ──
  console.log('');
  console.log('Setting agentWallet to relayer address...');
  const tx2 = await idReg.setAgentWallet(agentId, relayerAddr);
  await tx2.wait();
  console.log(`  ✓ agentWallet = ${relayerAddr}`);

  // ─── Summary ──
  console.log('');
  console.log('═══ Deployment Summary ═══');
  console.log('IdentityRegistry:    ', idAddr);
  console.log('ReputationRegistry:  ', repAddr);
  console.log('ValidationRegistry:  ', valAddr);
  console.log('Agent ID:            ', agentId);
  console.log('Agent URI:           ', AGENT_URI);
  console.log('Agent Wallet:        ', relayerAddr);
  console.log('');
  console.log('Add to .env:');
  console.log(`IDENTITY_REGISTRY=${idAddr}`);
  console.log(`REPUTATION_REGISTRY=${repAddr}`);
  console.log(`VALIDATION_REGISTRY=${valAddr}`);
  console.log(`AGENT_ID=${agentId}`);
}

main().catch(e => { console.error(e); process.exit(1); });
