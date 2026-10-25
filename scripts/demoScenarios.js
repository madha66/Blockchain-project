// Seeds one Hardship, one Strategic and one Fraud borrower end to end on the local chain,
// plus one borrower in good standing, so every page of the demo has something to show.
//
//   npx hardhat node                       (terminal 1)
//   npx hardhat run scripts/deploy.js --network localhost
//   (optional) cd backend && npm run seed:demo   → creates login accounts for these wallets
//   node scripts/demoScenarios.js
//
// Moves chain time forward by about 130 policy days. Members registered through the
// backend are reused; otherwise the script signs attestations with the demo attester key
// (Hardhat account #9, the same key the backend uses).
import { ethers } from "ethers";
import { contract, STAGES, DTYPES } from "./timeTravel.js";

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const ATTESTER_KEY = process.env.ATTESTER_PRIVATE_KEY || "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
const ID_PEPPER = process.env.ID_PEPPER || "change-me-pepper";
const E = (v) => ethers.parseEther(String(v));
const fmt = (wei) => `${Number(ethers.formatEther(wei)).toFixed(4)} ETH`;

export const DEMO_BORROWERS = [
  { index: 3, name: "Asha", pan: "ASHAP1234A", role: "hardship" },
  { index: 4, name: "Vikram", pan: "VIKRM5678B", role: "strategic" },
  { index: 5, name: "Ravi", pan: "RAVIF9012C", role: "fraud" },
  { index: 7, name: "Meena", pan: "MEENA3456D", role: "good" },
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = (i) => provider.getSigner(i);

async function advanceDays(days) {
  const spd = Number(await contract("PolicyConfig", provider).secondsPerDay());
  await provider.send("evm_increaseTime", [days * spd]);
  await provider.send("evm_mine", []);
  console.log(`   ⏱  +${days} days`);
}

async function register(wallet, pan) {
  const registry = contract("IdentityRegistry", wallet);
  const address = await wallet.getAddress();
  if ((await registry.memberOf(address)) !== 0n) return registry.memberOf(address);

  const { chainId } = await provider.getNetwork();
  const latest = await provider.getBlock("latest");
  const attestation = {
    wallet: address,
    idHash: ethers.keccak256(ethers.toUtf8Bytes(`${pan}${ID_PEPPER}`)),
    incomeTierWei: E(0.3), // ₹30,000 a month at ₹1,000 ≈ 0.01 ETH
    declaredDebtWei: E(0.01),
    payoutPeriodDays: 7,
    clusterId: ethers.id(`demo-cluster-${pan}`),
    cohortId: 202643,
    nonce: BigInt(ethers.hexlify(ethers.randomBytes(16))),
    expiry: BigInt(latest.timestamp + 365 * 86400),
  };
  const domain = { name: "GigLendIdentity", version: "1", chainId, verifyingContract: await registry.getAddress() };
  const types = {
    MemberAttestation: [
      { name: "wallet", type: "address" },
      { name: "idHash", type: "bytes32" },
      { name: "incomeTierWei", type: "uint256" },
      { name: "declaredDebtWei", type: "uint256" },
      { name: "payoutPeriodDays", type: "uint32" },
      { name: "clusterId", type: "bytes32" },
      { name: "cohortId", type: "uint32" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint64" },
    ],
  };
  const signature = await new ethers.Wallet(ATTESTER_KEY).signTypedData(domain, types, attestation);
  await (await registry.register(attestation, signature)).wait();
  return registry.memberOf(address);
}

async function openLoan(wallet, kind, amount, n = 4, autopay = false) {
  const lm = contract("LoanManager", wallet);
  const receipt = await (await lm.openLoan(kind, amount, n, ethers.ZeroAddress, autopay)).wait();
  const ev = receipt.logs.map((l) => { try { return lm.interface.parseLog(l); } catch { return null; } }).find((p) => p?.name === "LoanOpened");
  return ev.args.loanId;
}

async function payAll(wallet, loanId) {
  const lm = contract("LoanManager", wallet);
  await (await lm.repayInstallment(loanId, { value: await lm.payoffAmount(loanId) })).wait();
}

async function main() {
  const lender = await signer(0);
  const keeper = await signer(6);
  const platform = await signer(8);
  const pool = contract("LendingPool", lender);

  console.log("\n1. Pool liquidity");
  if ((await pool.freeCash()) < E(5)) {
    await (await pool.deposit({ value: E(20) })).wait();
    console.log("   Lender deposited 20 ETH");
  }

  // Demo only: seed the loss buffer so the reserve step of the waterfall is visible.
  const reserve = contract("ReserveFund", lender);
  if ((await provider.getBalance(await reserve.getAddress())) < E(0.002)) {
    await (await reserve.fund({ value: E(0.005) })).wait();
    console.log("   Seeded the reserve with 0.005 ETH (demo only)");
  }

  console.log("2. Members and credit-builder loans");
  const people = {};
  for (const b of DEMO_BORROWERS) {
    const wallet = await signer(b.index);
    const memberId = await register(wallet, b.pan);
    people[b.role] = { ...b, wallet, address: await wallet.getAddress(), memberId };
    console.log(`   ${b.name.padEnd(7)} member #${memberId} · ${people[b.role].address}`);
  }

  for (const role of ["hardship", "strategic", "good"]) {
    const p = people[role];
    const lm = contract("LoanManager", p.wallet);
    if ((await lm.loansOfMember(p.memberId)).length > 0) continue;
    await (await contract("LendingPool", p.wallet).deposit({ value: E(0.02) })).wait(); // stake
    const id = await openLoan(p.wallet, 0, E(0.02));
    await payAll(p.wallet, id);
    console.log(`   ${p.name} staked 0.02 ETH and completed Builder loan #${id}`);
  }

  // Fraud: a brand-new member with no stake takes the largest Builder loan and vanishes.
  const fraudId = await openLoan(people.fraud.wallet, 0, E(0.02));
  console.log(`   Ravi opened Builder loan #${fraudId} (escrowed) and never pays`);

  console.log("3. Stake ages past 90 days");
  await advanceDays(91);
  await (await contract("LoanManager", keeper).markDefault(fraudId)).wait();
  console.log(`   Ravi's loan #${fraudId} marked as defaulted by a keeper`);

  // Keep just over the 50% cover so a default leaves a residual claim to show.
  for (const role of ["hardship", "strategic"]) {
    const p = people[role];
    const lp = contract("LendingPool", p.wallet);
    const glp = contract("GLPToken", p.wallet);
    const keep = await lp.sharesForValue(E(0.006));
    const balance = await glp.balanceOf(p.address);
    if (balance > keep) await (await lp.withdraw(balance - keep)).wait();
  }

  console.log("4. First Unsecured loans (₹1,000 ≈ 0.01 ETH, 50% stake cover)");
  const hardshipLoan = await openLoan(people.hardship.wallet, 1, E(0.01));
  const strategicLoan = await openLoan(people.strategic.wallet, 1, E(0.01));
  console.log(`   Asha loan #${hardshipLoan}, Vikram loan #${strategicLoan} (autopay off)`);

  console.log("5. Both miss the first installment; only Vikram's payouts keep arriving");
  await advanceDays(10);
  const router = contract("MockPayoutRouter", platform);
  for (let i = 0; i < 3; i++) {
    await (await router.payout(people.strategic.address, { value: E(0.01) })).wait();
  }
  console.log("   Platform paid Vikram 3 × 0.01 ETH after the miss");

  console.log("6. Day 30 after the due date: markDefault");
  await advanceDays(28); // loans fell due 7 days after opening: 10 + 28 = day 31 past due
  const lmKeeper = contract("LoanManager", keeper);
  for (const id of [hardshipLoan, strategicLoan]) {
    await (await lmKeeper.markDefault(id)).wait();
  }

  console.log("7. After default");
  const dm = contract("DefaultManager", people.hardship.wallet);
  if ((await dm.claimOf(people.hardship.memberId)) > 0n) {
    await (await dm.startWorkout(hardshipLoan)).wait();
    console.log("   Asha started a hardship workout (no interest, ≤ 6 months)");
  } else {
    console.log("   Asha's stake covered the whole debt; no workout needed");
  }

  console.log("8. A borrower in good standing with an open loan");
  const goodLoan = await openLoan(people.good.wallet, 1, E(0.01), 4, true);
  const lmGood = contract("LoanManager", people.good.wallet);
  await (await lmGood.repayInstallment(goodLoan, { value: await lmGood.amountDue(goodLoan) })).wait();
  console.log(`   Meena opened Unsecured loan #${goodLoan} with autopay and paid installment 1`);

  console.log("\nSummary");
  const lm = contract("LoanManager", provider);
  const dmView = contract("DefaultManager", provider);
  for (const [label, id] of [["Ravi (fraud)", fraudId], ["Asha (hardship)", hardshipLoan], ["Vikram (strategic)", strategicLoan], ["Meena (good)", goodLoan]]) {
    const l = await lm.getLoan(id);
    const status = Number(l.status) === 3 ? `Defaulted · ${DTYPES[Number(l.dtype)]}` : `Active · ${STAGES[Number(await lm.stageOf(id))]}`;
    const claim = await dmView.claimOf(l.memberId);
    console.log(`   ${label.padEnd(19)} loan #${id} · ${status}${claim > 0n ? ` · claim ${fmt(claim)} · settle for ${fmt(await dmView.settlementQuote(l.memberId))}` : ""}`);
  }
  console.log("\nDone. Open the app, or run: node scripts/timeTravel.js status <loanId>\n");
}

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exitCode = 1;
});
