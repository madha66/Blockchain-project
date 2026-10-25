// Creates login accounts for the demo borrowers used by scripts/demoScenarios.js, through the
// real signup API (account → OTP → SIWE wallet link → mock KYC → income → consent → on-chain
// registration). Run with the backend running, after deploy.js and before demoScenarios.js.
//
// Local demo only: the keys are Hardhat's public test keys.
import { prisma } from "../src/db.js";
import { seedUser } from "./seedUser.js";

const DEMO = [
  { name: "Asha Kumari", pan: "ASHAP1234A", key: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" },
  { name: "Vikram Singh", pan: "VIKRM5678B", key: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" },
  { name: "Ravi Teja", pan: "RAVIF9012C", key: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" },
  { name: "Meena Iyer", pan: "MEENA3456D", key: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" },
  // Deployer (account #0): holds ADMIN_ROLE and DISPUTE_ROLE, so this login opens the Admin console.
  { name: "Ops Admin", pan: "ADMIN0000Z", key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" },
];

for (const d of DEMO) {
  try {
    const r = await seedUser({ privateKey: d.key, pan: d.pan, name: d.name, declaredDebts: [{ lender: "Phone EMI", emiInr: 1000 }] });
    console.log(`${d.name.padEnd(13)} ${r.wallet} · member #${r.memberId} · login ${r.account.email} / ${r.account.password}`);
  } catch (err) {
    console.log(`${d.name.padEnd(13)} skipped: ${err.message}`);
  }
}
await prisma.$disconnect();
