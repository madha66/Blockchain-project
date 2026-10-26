import http from "http";
import request from "supertest";
import { ethers } from "ethers";
import { SiweMessage } from "siwe";
import { createApp } from "../src/app.js";
import mongoose from "mongoose";

export const fakeChain = (overrides = {}) => ({
  now: async () => Math.floor(Date.now() / 1000),
  hasOpenLoanForIdHash: async () => false,
  memberIdForIdHash: async () => 0n,
  isIdentityBanned: async () => false,
  identityOf: async () => null,
  walletStatus: async () => ({ memberId: "0", verified: false, banned: false, expelled: false, identityHash: null, outstandingWei: "0", settlementQuoteWei: "0" }),
  ...overrides,
});

const servers = [];

/**
 * Returns a listening HTTP server (supertest's ephemeral server breaks on multipart uploads).
 */
export function makeApp(chainOverrides) {
  const chain = fakeChain(chainOverrides);
  const { app } = createApp({ chain });
  const server = http.createServer(app).listen(0);
  servers.push(server);
  return { app: server, chain };
}

export async function closeServers() {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
}

export async function resetDb() {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

let counter = 0;
export const uniqueAccount = () => {
  counter += 1;
  const n = String(Date.now() % 1e5).padStart(5, "0") + String(counter).padStart(5, "0");
  return {
    name: `Test User ${counter}`,
    email: `user${counter}-${n}@example.test`,
    phone: `9${n.slice(1)}`,
    password: "correct horse battery",
  };
};

export async function siweSign(agent, wallet) {
  const { body } = await agent.post("/api/auth/siwe/nonce").expect(200);
  const message = new SiweMessage({
    domain: body.domain,
    address: wallet.address,
    statement: "Sign in to GigLend",
    uri: `http://${body.domain}`,
    version: "1",
    chainId: body.chainId,
    nonce: body.nonce,
  }).prepareMessage();
  const signature = await wallet.signMessage(message);
  return { message, signature };
}

const SELFIE = Buffer.from("fake-jpeg-bytes");

/**
 * Runs the whole wizard for a new account with `wallet` and `pan`. Returns the agent.
 */
export async function completeSignup(app, wallet, { pan = "ABCDE1234F", account = uniqueAccount() } = {}) {
  const agent = request.agent(app);
  const created = await agent.post("/api/signup/account").send(account).expect(201);
  await agent.post("/api/signup/otp/verify").send({ code: created.body.devOtp }).expect(200);
  await agent.post("/api/signup/wallet").send(await siweSign(agent, wallet)).expect(200);
  const kyc = await agent
    .post("/api/signup/kyc")
    .field("pan", pan)
    .field("aadhaarRef", "1234")
    .attach("selfie", SELFIE, "selfie.jpg");
  return { agent, account, kyc };
}

export async function finishProfile(agent) {
  await agent
    .post("/api/signup/income")
    .send({
      platform: "Swiggy",
      workerId: "SW-1001",
      monthsActive: 14,
      payoutFrequency: "weekly",
      monthlyPayouts: [32000, 30000, 34000, 31000],
      declaredDebts: [{ lender: "Phone EMI", emiInr: 1500 }],
    })
    .expect(200);
  return agent.post("/api/signup/consent").send({ dataUse: true, autopay: true, peerVisibility: false });
}

export const newWallet = () => ethers.Wallet.createRandom();
