import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { ethers } from "ethers";
import { AuditLog, Identity, Otp, User } from "../src/models.js";
import { verifyOtp, issueOtp, OTP_TTL_MS } from "../src/services/otp.js";
import { idHashFor } from "../src/services/identity.js";
import { ATTESTATION_TYPES } from "../src/services/attester.js";
import {
  makeApp,
  resetDb,
  uniqueAccount,
  siweSign,
  completeSignup,
  finishProfile,
  newWallet,
  closeServers,
} from "./helpers.js";

beforeEach(resetDb);
afterEach(closeServers);

describe("OTP flow", () => {
  it("verifies the signup OTP once and rejects a wrong code", async () => {
    const { app } = makeApp();
    const agent = request.agent(app);
    const created = await agent.post("/api/signup/account").send(uniqueAccount()).expect(201);

    const wrong = created.body.devOtp === "000000" ? "111111" : "000000";
    const bad = await agent.post("/api/signup/otp/verify").send({ code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("OTP_INVALID");

    const ok = await agent.post("/api/signup/otp/verify").send({ code: created.body.devOtp });
    expect(ok.status).toBe(200);
    expect(ok.body.step).toBe(2);

    const reuse = await agent.post("/api/signup/otp/verify").send({ code: created.body.devOtp });
    expect(reuse.status).toBe(400);
  });

  it("stores only a hash of the OTP and expires it after 5 minutes", async () => {
    const user = await User.create({ name: "X", email: "x@example.test", phone: "9000000001", passwordHash: "x" });
    const code = await issueOtp(user._id, "login");
    const row = await Otp.findOne({ user: user._id });
    expect(row.codeHash).not.toContain(code);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(OTP_TTL_MS + 1000);

    await Otp.updateOne({ _id: row._id }, { expiresAt: new Date(Date.now() - 1) });
    expect((await verifyOtp(user._id, "login", code)).reason).toBe("OTP_EXPIRED");
  });

  it("rejects duplicate email or phone at signup", async () => {
    const { app } = makeApp();
    const account = uniqueAccount();
    await request(app).post("/api/signup/account").send(account).expect(201);
    const dupe = await request(app)
      .post("/api/signup/account")
      .send({ ...uniqueAccount(), email: account.email });
    expect(dupe.status).toBe(409);
  });

  it("logs auth events without personal data", async () => {
    const { app } = makeApp();
    const account = uniqueAccount();
    await request(app).post("/api/signup/account").send(account).expect(201);
    const events = await AuditLog.find({ category: "auth" }).lean();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(JSON.stringify(e)).not.toContain(account.email);
      expect(JSON.stringify(e)).not.toContain(account.phone);
    }
  });
});

describe("SIWE login", () => {
  it("logs in with password then SIWE from the linked wallet", async () => {
    const { app } = makeApp();
    const wallet = newWallet();
    const { account } = await completeSignup(app, wallet);

    const agent = request.agent(app);
    const step1 = await agent.post("/api/auth/login").send({ identifier: account.email, password: account.password });
    expect(step1.status).toBe(200);
    expect(step1.body.next).toBe("siwe");

    // Pre-auth sessions cannot read the profile yet.
    expect((await agent.get("/api/profile")).status).toBe(403);

    const verified = await agent.post("/api/auth/siwe/verify").send(await siweSign(agent, wallet));
    expect(verified.status).toBe(200);
    expect(verified.body.user.wallet).toBe(wallet.address.toLowerCase());

    const me = await agent.get("/api/auth/me").expect(200);
    expect(me.body.scope).toBe("full");
  });

  it("rejects SIWE when the signing wallet is not the linked wallet", async () => {
    const { app } = makeApp();
    const linked = newWallet();
    const other = newWallet();
    const { account } = await completeSignup(app, linked);

    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ identifier: account.phone, password: account.password }).expect(200);
    const res = await agent.post("/api/auth/siwe/verify").send(await siweSign(agent, other));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("WALLET_MISMATCH");
    expect((await agent.get("/api/auth/me")).body.scope).toBe("preauth");
  });

  it("rejects a wrong password and supports OTP login", async () => {
    const { app } = makeApp();
    const wallet = newWallet();
    const { account } = await completeSignup(app, wallet);

    const bad = await request(app).post("/api/auth/login").send({ identifier: account.email, password: "nope-nope-nope" });
    expect(bad.status).toBe(401);

    const agent = request.agent(app);
    const otp = await agent.post("/api/auth/otp/request").send({ identifier: account.email }).expect(200);
    const login = await agent.post("/api/auth/login").send({ identifier: account.email, otp: otp.body.devOtp });
    expect(login.body.next).toBe("siwe");
  });

  it("rejects a reused SIWE nonce", async () => {
    const { app } = makeApp();
    const wallet = newWallet();
    const { account } = await completeSignup(app, wallet);
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ identifier: account.email, password: account.password });
    const signed = await siweSign(agent, wallet);
    await agent.post("/api/auth/siwe/verify").send(signed).expect(200);
    await agent.post("/api/auth/login").send({ identifier: account.email, password: account.password });
    const replay = await agent.post("/api/auth/siwe/verify").send(signed);
    expect(replay.status).toBe(401);
  });

  it("logout clears the session", async () => {
    const { app } = makeApp();
    const { agent } = await completeSignup(app, newWallet());
    await agent.post("/api/auth/logout").expect(200);
    expect((await agent.get("/api/auth/me")).body.user).toBeNull();
  });
});

describe("Signup wizard, identity and attestation", () => {
  it("is resumable: logging back in mid-wizard returns the next step", async () => {
    const { app } = makeApp();
    const account = uniqueAccount();
    const agent = request.agent(app);
    const created = await agent.post("/api/signup/account").send(account).expect(201);
    await agent.post("/api/signup/otp/verify").send({ code: created.body.devOtp }).expect(200);

    const fresh = request.agent(app);
    const login = await fresh.post("/api/auth/login").send({ identifier: account.email, password: account.password });
    expect(login.body).toMatchObject({ next: "signup", step: 2 });
  });

  it("rejects a full Aadhaar number and a malformed PAN", async () => {
    const { app } = makeApp();
    const wallet = newWallet();
    const { agent } = await completeSignup(app, wallet, { pan: "NOTAPAN" });
    const res = await agent
      .post("/api/signup/kyc")
      .field("pan", "ABCDE1234F")
      .field("aadhaarRef", "123412341234")
      .attach("selfie", Buffer.from("x"), "s.jpg");
    expect(res.status).toBe(400);
  });

  it("a duplicate idHash attaches the new account to the existing identity", async () => {
    const { app } = makeApp();
    const first = await completeSignup(app, newWallet(), { pan: "PQRSX6789Z" });
    expect(first.kyc.status).toBe(200);
    expect(first.kyc.body.inherited).toBe(false);

    // While the first wallet is active the identity cannot take a second one.
    const blocked = await completeSignup(app, newWallet(), { pan: "pqrsx6789z" });
    expect(blocked.kyc.status).toBe(409);
    expect(blocked.kyc.body.error).toBe("IDENTITY_WALLET_ACTIVE");

    // After unlinking (no open loan), a new account with the same PAN inherits the identity.
    await finishProfile(first.agent);
    await first.agent.post("/api/profile/unlink-wallet").expect(200);

    const second = await completeSignup(app, newWallet(), { pan: "PQRSX6789Z" });
    expect(second.kyc.status).toBe(200);
    expect(second.kyc.body.inherited).toBe(true);

    const identities = await Identity.find({ identityHash: idHashFor("PQRSX6789Z") });
    expect(identities).toHaveLength(1);
    const users = await User.find({ identity: identities[0]._id });
    expect(users.length).toBe(2);
  });

  it("refuses to unlink a wallet while a loan is open", async () => {
    const { app } = makeApp({ hasOpenLoanForIdHash: async () => true });
    const { agent } = await completeSignup(app, newWallet());
    await finishProfile(agent);
    const res = await agent.post("/api/profile/unlink-wallet");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("OPEN_LOAN");
  });

  it("signs an EIP-712 attestation with the issuer key after consent", async () => {
    const { app } = makeApp();
    const wallet = newWallet();
    const { agent } = await completeSignup(app, wallet);
    const res = await finishProfile(agent);
    expect(res.status).toBe(200);
    expect(res.body.step).toBe(6);

    const { attestation, signature, domain } = res.body.attestation;
    expect(attestation.wallet).toBe(wallet.address);
    expect(attestation.payoutPeriodDays).toBe(7);
    // Assessed ₹31,500 (stable) → ₹30,000 tier → 0.3 ETH; declared EMI ₹1,500 → 0.015 ETH.
    expect(attestation.incomeTierWei).toBe(ethers.parseEther("0.3").toString());
    expect(attestation.declaredDebtWei).toBe(ethers.parseEther("0.015").toString());

    const signer = ethers.verifyTypedData(domain, ATTESTATION_TYPES, attestation, signature);
    // Issuer: Hardhat account #19 (ISSUER_PRIVATE_KEY).
    expect(signer).toBe("0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199");

    const profile = await agent.get("/api/profile").expect(200);
    expect(profile.body.user.identity.contactName).toBeTruthy();
    expect(profile.body.user.consents).toMatchObject({ data_use: true, autopay: true, peer_visibility: false });
  });

  it("requires data-use consent", async () => {
    const { app } = makeApp();
    const { agent } = await completeSignup(app, newWallet());
    await agent
      .post("/api/signup/income")
      .send({
        platform: "Zomato",
        workerId: "Z-1",
        monthsActive: 3,
        payoutFrequency: "biweekly",
        monthlyPayouts: [20000, 22000, 18000],
      })
      .expect(200);
    const res = await agent.post("/api/signup/consent").send({ dataUse: false });
    expect(res.status).toBe(400);
  });

  it("refuses to link a wallet already registered on-chain with another identity, and lets the user pick another", async () => {
    const registered = newWallet();
    const { app } = makeApp({
      identityOf: async (w) => (w.toLowerCase() === registered.address.toLowerCase() ? `0x${"ab".repeat(32)}` : ethers.ZeroHash),
    });
    const agent = request.agent(app);
    const created = await agent.post("/api/signup/account").send(uniqueAccount()).expect(201);
    await agent.post("/api/signup/otp/verify").send({ code: created.body.devOtp }).expect(200);

    const refused = await agent.post("/api/signup/wallet").send(await siweSign(agent, registered));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("WALLET_HAS_IDENTITY");

    const fresh = newWallet();
    const linked = await agent.post("/api/signup/wallet").send(await siweSign(agent, fresh));
    expect(linked.status).toBe(200);
    expect(linked.body.step).toBe(3);

    // Before KYC the user can go back and link a different wallet.
    const reset = await agent.post("/api/signup/wallet/reset").expect(200);
    expect(reset.body.step).toBe(2);
    await agent.post("/api/signup/wallet").send(await siweSign(agent, newWallet())).expect(200);
  });
});
