import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { config } from "../config.js";

// deploy.js writes ABIs to the frontend; the backend reads the same files.
const ABI_DIR = path.resolve(process.env.ABI_DIR || "../frontend/src/contracts");

export function loadAbi(name) {
  const file = path.join(ABI_DIR, `${name}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")).abi;
}

/** ethers Contract for a deployed protocol contract, or null if not deployed/configured. */
export function contractFor(name, runner) {
  const address = config.addresses[name];
  const abi = loadAbi(name);
  if (!address || !abi) return null;
  return new ethers.Contract(address, abi, runner);
}

export const PROTOCOL = [
  "IdentityRegistry",
  "LoanManager",
  "DefaultManager",
  "LendingPool",
  "SafeRepayVault",
  "MockPayoutRouter",
  "PolicyConfig",
  "CreditScore",
];
