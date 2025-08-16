// chain/scripts/sync-abi.js
// Usage: node scripts/sync-abi.js [ContractName]
// Example: node scripts/sync-abi.js Lottery

const fs = require('fs');
const path = require('path');

const contractName = process.argv[2] || 'Lottery';

// Path to Hardhat artifact for this contract
const artifactPath = path.join(
  __dirname,
  '..',
  'artifacts',
  'contracts',
  `${contractName}.sol`,
  `${contractName}.json`
);

// Where to write the ABI in the frontend
const outDir = path.resolve(__dirname, '../../web/src/abi');
const outPath = path.join(outDir, `${contractName}.json`);

function main() {
  if (!fs.existsSync(artifactPath)) {
    console.error(`Artifact not found for ${contractName}.
- Did you run: npx hardhat compile ?
- Expected at: ${artifactPath}`);
    process.exit(1);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  if (!artifact.abi) {
    console.error(`No ABI field found in artifact: ${artifactPath}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });

  // Write only the ABI to keep the frontend bundle lean
  fs.writeFileSync(outPath, JSON.stringify({ abi: artifact.abi }, null, 2));
  console.log(`✅ Synced ABI for ${contractName} -> ${outPath}`);
}

main();