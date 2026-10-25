// Seeds a fully verified, on-chain-registered member through the real HTTP API.
// Local demo only: it uses a Hardhat test key and reads the mock OTP from the database
// side channel (it re-issues the OTP itself, since only hashes are stored).
//
// Usage: node scripts/seedUser.js <hardhatPrivateKey> <PAN> [name] [weekly|biweekly]
import { ethers } from "ethers";
import { SiweMessage } from "siwe";
import { prisma } from "../src/db.js";
import { issueOtp } from "../src/services/otp.js";
import { config } from "../src/config.js";

const API = process.env.API_URL || `http://localhost:${config.port}/api`;

const REGISTRY_ABI = [
  "function register((address wallet,bytes32 idHash,uint256 incomeTierWei,uint256 declaredDebtWei,uint32 payoutPeriodDays,bytes32 clusterId,uint32 cohortId,uint256 nonce,uint64 expiry) a, bytes sig) returns (uint256)",
  "function memberOf(address) view returns (uint256)",
];

function cookieJar() {
  let cookie = "";
  return async (path, { method = "GET", body, form, headers = {} } = {}) => {
    const init = { method, headers: { ...headers, ...(cookie ? { cookie } : {}) } };
    if (form) init.body = form;
    else if (body) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${API}${path}`, init);
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
}

async function siwe(call, wallet, url) {
  const { nonce, domain, chainId } = await call("/auth/siwe/nonce", { method: "POST" });
  const message = new SiweMessage({
    domain,
    address: wallet.address,
    statement: "Seed script sign-in",
    uri: `http://${domain}`,
    version: "1",
    chainId,
    nonce,
  }).prepareMessage();
  return call(url, { method: "POST", body: { message, signature: await wallet.signMessage(message) } });
}

export async function seedUser({
  privateKey,
  pan,
  name = "Demo Worker",
  payoutFrequency = "weekly",
  monthlyPayouts = [32000, 30000, 34000, 31000],
  declaredDebts = [],
  register = true,
}) {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const call = cookieJar();
  const tag = wallet.address.slice(2, 8).toLowerCase();
  const digits = String(BigInt(wallet.address) % 10n ** 9n).padStart(9, "0");

  const account = { name, email: `${tag}@demo.giglend.test`, phone: `9${digits}`, password: "demo-password-1" };

  // Create the account, or log back in and resume the wizard where it stopped.
  let step = 1;
  let userId;
  try {
    userId = (await call("/signup/account", { method: "POST", body: account })).userId;
  } catch (err) {
    if (!String(err.message).includes("ACCOUNT_EXISTS")) throw err;
    const login = await call("/auth/login", { method: "POST", body: { identifier: account.email, password: account.password } });
    if (login.next === "siwe") await siwe(call, wallet, "/auth/siwe/verify");
    const me = await call("/auth/me");
    userId = me.user.id;
    step = me.user.signupStep;
  }

  if (step <= 1) {
    // The real OTP went to the server console; issue a fresh one we can read here.
    const code = await issueOtp(userId, "signup");
    await call("/signup/otp/verify", { method: "POST", body: { code } });
  }
  if (step <= 2) await siwe(call, wallet, "/signup/wallet");

  let kyc = { inherited: false };
  if (step <= 3) {
    const form = new FormData();
    form.append("pan", pan);
    form.append("aadhaarRef", "4321");
    form.append("selfie", new Blob([Buffer.from("demo-selfie")], { type: "image/jpeg" }), "selfie.jpg");
    kyc = await call("/signup/kyc", { method: "POST", form });
  }
  if (step <= 4) {
    await call("/signup/income", {
      method: "POST",
      body: { platform: "Swiggy", workerId: `SW-${tag}`, monthsActive: 18, payoutFrequency, monthlyPayouts, declaredDebts },
    });
  }
  const done =
    step <= 5
      ? await call("/signup/consent", { method: "POST", body: { dataUse: true, autopay: true, peerVisibility: false } })
      : { attestation: await call("/profile/attestation", { method: "POST" }) };

  let memberId = 0n;
  if (register) {
    const registry = new ethers.Contract(config.addresses.IdentityRegistry, REGISTRY_ABI, wallet);
    memberId = await registry.memberOf(wallet.address);
    if (memberId === 0n) {
      const { attestation, signature } = done.attestation;
      await (await registry.register(attestation, signature)).wait();
      memberId = await registry.memberOf(wallet.address);
    }
  }
  return { account, wallet: wallet.address, inherited: kyc.inherited, memberId, userId };
}

if (process.argv[1]?.endsWith("seedUser.js")) {
  const [privateKey, pan, name, freq] = process.argv.slice(2);
  if (!privateKey || !pan) {
    console.log("Usage: node scripts/seedUser.js <hardhatPrivateKey> <PAN> [name] [weekly|biweekly]");
    process.exit(1);
  }
  seedUser({ privateKey, pan, name, payoutFrequency: freq })
    .then((r) => {
      console.log(JSON.stringify({ ...r, memberId: r.memberId.toString() }, null, 2));
      return prisma.$disconnect();
    })
    .catch(async (err) => {
      console.error(err.message);
      await prisma.$disconnect();
      process.exit(1);
    });
}
