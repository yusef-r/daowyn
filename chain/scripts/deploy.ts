// chain/scripts/deploy.ts
import { viem } from "hardhat";

async function main() {
  // If your constructor takes arguments, pass them like:
  // const lottery = await viem.deployContract("Lottery", [arg1, arg2, ...]);
  const lottery = await viem.deployContract("Lottery");

  console.log("Lottery deployed at:", lottery.address);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});