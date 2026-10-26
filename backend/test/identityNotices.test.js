import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { ethers } from "ethers";
import { AuditLog, Consent, Identity, Notice } from "../src/models.js";
import { consentMessage, SIGNED_CONSENTS } from "../src/services/consentText.js";
import { identityProofMessage, disputeMessage } from "../src/services/walletProof.js";
import { decryptIdentifier, identityHashFor } from "../src/services/identity.js";
import { createPendingNotice, fileDispute, processDueNotices, resolveDispute, composeNoticeText } from "../src/services/notices.js";
import { recordSignedConsent } from "../src/services/consents.js";
import { saveEmployerContact } from "../src/routes/profile.js";
import { closeServers, completeSignup, makeApp, newWallet, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterEach(closeServers);

const DAY = 86400;
const E = (v) => ethers.parseEther(String(v));

async function signedConsents(wallet, decisions = {}) {
  return Promise.all(
    SIGNED_CONSENTS.map(async (type) => {
      const granted = decisions[type] ?? true;
      return { type, granted, signature: await wallet.signMessage(consentMessage(type, wallet.address, granted)) };
    })
  );
}

async function proof(wallet) {
  const message = identityProofMessage(wallet.address, new Date().toISOString());
  return { message, signature: await wallet.signMessage(message) };
}

/** Runs the wallet-first verification with an email + OTP. */
async function verifyByEmail(app, wallet, email, { decisions, employer = { platformName: "Swiggy", contactEmail: "ops@swiggy.test" } } = {}) {
  const otp = await request(app).post("/api/identity/otp").send({ email }).expect(200);
  return request(app)
    .post("/api/identity/verify")
    .send({
      wallet: wallet.address,
      method: "email",
      email,
      otp: otp.body.devOtp,
      monthlyIncomeInr: 30000,
      proof: await proof(wallet),
      consents: await signedConsents(wallet, decisions),
      employer,
    });
}

describe("Identity verification (IAM)", () => {
  it("verifies by email + OTP, stores the identifier encrypted and returns an issuer-signed attestation", async () => {
    const { app } = makeApp();
    const wallet = newWallet();
    const res = await verifyByEmail(app, wallet, "Worker@Example.test");
    expect(res.status).toBe(200);
    expect(res.body.attestation.wallet).toBe(wallet.address);
    expect(res.body.attestation.idHash).toBe(identityHashFor("email", "worker@example.test").identityHash);

    const identity = await Identity.findOne({ identityHash: res.body.identityHash });
    expect(identity.identifierEnc).not.toContain("worker");
    expect(decryptIdentifier(identity.identifierEnc)).toBe("worker@example.test"); // normalised before storage
    // Salted: not the plain keccak of the identifier.
    expect(identity.identityHash).not.toBe(ethers.id("worker@example.test"));
  });

  it("refuses a banned identity (on-chain ban), from any wallet", async () => {
    const banned = identityHashFor("email", "expelled@example.test").identityHash;
    const { app } = makeApp({ isIdentityBanned: async (h) => h === banned });
    const res = await verifyByEmail(app, newWallet(), "expelled@example.test");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("IDENTITY_BANNED");
    expect(await Identity.countDocuments()).toBe(0);
    expect(await AuditLog.countDocuments({ event: "identity_refused_banned" })).toBe(1);
  });

  it("refuses a banned identity (Mongo flag) in the sign-up wizard too", async () => {
    const { app } = makeApp();
    const first = await completeSignup(app, newWallet(), { pan: "BANDX1234Q" });
    expect(first.kyc.status).toBe(200);
    await Identity.updateOne({ identityHash: identityHashFor("pan", "BANDX1234Q").identityHash }, { banned: true, linkedWallet: null });
    const again = await completeSignup(app, newWallet(), { pan: "BANDX1234Q" });
    expect(again.kyc.status).toBe(403);
    expect(again.kyc.body.error).toBe("IDENTITY_BANNED");
  });

  it("refuses a duplicate identity while its wallet is linked", async () => {
    const { app } = makeApp();
    expect((await verifyByEmail(app, newWallet(), "same@example.test")).status).toBe(200);
    const dupe = await verifyByEmail(app, newWallet(), "same@example.test");
    expect(dupe.status).toBe(409);
    expect(dupe.body.error).toBe("IDENTITY_WALLET_ACTIVE");
  });

  it("allows only one identity per wallet", async () => {
    const { app } = makeApp();
    const wallet = newWallet();
    expect((await verifyByEmail(app, wallet, "one@example.test")).status).toBe(200);
    const second = await verifyByEmail(app, wallet, "two@example.test");
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("WALLET_HAS_IDENTITY");
  });

  it("rejects a consent signed by another wallet and a stale proof", async () => {
    const { app } = makeApp();
    const wallet = newWallet();
    const otp = await request(app).post("/api/identity/otp").send({ email: "c@example.test" }).expect(200);
    const res = await request(app)
      .post("/api/identity/verify")
      .send({
        wallet: wallet.address,
        method: "email",
        email: "c@example.test",
        otp: otp.body.devOtp,
        proof: await proof(wallet),
        consents: await signedConsents(newWallet(), { platform_notice: false }),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("CONSENT_SIGNATURE_INVALID");

    const old = identityProofMessage(wallet.address, new Date(Date.now() - 3600_000).toISOString());
    const stale = await request(app)
      .post("/api/identity/verify")
      .send({
        wallet: wallet.address,
        method: "id",
        idNumber: "ABCDE1234F",
        proof: { message: old, signature: await wallet.signMessage(old) },
        consents: await signedConsents(wallet, { platform_notice: false }),
      });
    expect(stale.status).toBe(401);
    expect(stale.body.error).toBe("PROOF_EXPIRED");
  });

  it("records both consents with timestamp, text version and signature, visible to the user", async () => {
    const { app } = makeApp();
    const wallet = newWallet();
    await verifyByEmail(app, wallet, "consent@example.test", { decisions: { payout_deduction: false } });
    const rows = await Consent.find({ wallet: wallet.address.toLowerCase() });
    expect(rows.map((r) => r.type).sort()).toEqual(["payout_deduction", "platform_notice"]);
    for (const r of rows) {
      expect(r.textVersion).toMatch(/-v1$/);
      expect(r.timestamp).toBeInstanceOf(Date);
      expect(ethers.verifyMessage(consentMessage(r.type, wallet.address, r.granted), r.signature)).toBe(wallet.address);
    }
    const view = await request(app).get(`/api/users/${wallet.address}`).expect(200);
    expect(view.body.consents.platform_notice.granted).toBe(true);
    expect(view.body.consents.payout_deduction.granted).toBe(false);
    expect(JSON.stringify(view.body)).not.toContain("consent@example.test");
  });
});

describe("Consent-based platform notices", () => {
  const T0 = 1_800_000_000;
  const wallet = () => newWallet();

  async function expelledWithNotice(w, { consent, contact = true } = {}) {
    if (consent !== undefined) {
      await recordSignedConsent({
        wallet: w.address,
        type: "platform_notice",
        granted: consent,
        signature: await w.signMessage(consentMessage("platform_notice", w.address, consent)),
      });
    }
    if (contact) await saveEmployerContact({ wallet: w.address, platformName: "Zomato", contactEmail: "ops@zomato.test" });
    return createPendingNotice({ wallet: w.address, memberId: 7, proposalId: 1, amountWei: E(0.004), chainTs: T0, spd: DAY });
  }

  it("is not sent before the 7-day dispute window ends", async () => {
    const w = wallet();
    const notice = await expelledWithNotice(w, { consent: true });
    expect(notice.status).toBe("pending");
    expect(notice.disputeWindowEndsAt).toBe(T0 + 7 * DAY);
    expect(await processDueNotices({ chainNow: T0 + 7 * DAY - 1 })).toEqual([]);
    expect((await Notice.findById(notice._id)).status).toBe("pending");
  });

  it("requires platform-notice consent before it is marked sent", async () => {
    const without = wallet();
    const n1 = await expelledWithNotice(without); // no consent recorded at all
    const declined = wallet();
    const n2 = await expelledWithNotice(declined, { consent: false });
    const granted = wallet();
    const n3 = await expelledWithNotice(granted, { consent: true });

    await processDueNotices({ chainNow: T0 + 7 * DAY + 1 });
    expect((await Notice.findById(n1._id)).status).toBe("not_sent_no_consent");
    expect((await Notice.findById(n2._id)).status).toBe("not_sent_no_consent");
    const sent = await Notice.findById(n3._id);
    expect(sent.status).toBe("sent");
    expect(sent.recipient.platformName).toBe("Zomato");
    expect(await AuditLog.countDocuments({ event: "notice_not_sent_no_consent" })).toBe(2);
    expect(await AuditLog.countDocuments({ event: "notice_sent" })).toBe(1);
  });

  it("is not sent when consent is withdrawn before the window ends, or the debt is cleared", async () => {
    const w = wallet();
    const n = await expelledWithNotice(w, { consent: true });
    await recordSignedConsent({
      wallet: w.address,
      type: "platform_notice",
      granted: false,
      signature: await w.signMessage(consentMessage("platform_notice", w.address, false)),
    });
    await processDueNotices({ chainNow: T0 + 8 * DAY });
    expect((await Notice.findById(n._id)).status).toBe("not_sent_no_consent");

    const paid = wallet();
    const n2 = await expelledWithNotice(paid, { consent: true });
    await processDueNotices({ chainNow: T0 + 8 * DAY, outstandingOf: async () => 0n });
    expect((await Notice.findById(n2._id)).status).toBe("cancelled");
  });

  it("accepts a dispute inside the window and holds the notice until it is resolved", async () => {
    const w = wallet();
    const n = await expelledWithNotice(w, { consent: true });
    await fileDispute({ noticeId: n.id, wallet: w.address, reason: "The balance is wrong", chainNow: T0 + 2 * DAY });
    expect((await Notice.findById(n._id)).status).toBe("disputed");

    await processDueNotices({ chainNow: T0 + 10 * DAY });
    expect((await Notice.findById(n._id)).status).toBe("disputed");
  });

  it("refuses a dispute after the window closes", async () => {
    const w = wallet();
    const n = await expelledWithNotice(w, { consent: true });
    await expect(
      fileDispute({ noticeId: n.id, wallet: w.address, reason: "Too late?", chainNow: T0 + 7 * DAY + 1 })
    ).rejects.toMatchObject({ code: "DISPUTE_WINDOW_CLOSED" });
  });

  it("an upheld dispute cancels the notice; a rejected one lets it proceed", async () => {
    const a = wallet();
    const na = await expelledWithNotice(a, { consent: true });
    const da = await fileDispute({ noticeId: na.id, wallet: a.address, reason: "I already paid", chainNow: T0 + DAY });
    await resolveDispute({ disputeId: da.id, outcome: "upheld", resolution: "Payment found" });
    await processDueNotices({ chainNow: T0 + 9 * DAY });
    expect((await Notice.findById(na._id)).status).toBe("cancelled");

    const b = wallet();
    const nb = await createPendingNotice({ wallet: b.address, memberId: 8, proposalId: 2, amountWei: E(0.004), chainTs: T0, spd: DAY });
    await recordSignedConsent({
      wallet: b.address,
      type: "platform_notice",
      granted: true,
      signature: await b.signMessage(consentMessage("platform_notice", b.address, true)),
    });
    await saveEmployerContact({ wallet: b.address, platformName: "Zomato", contactEmail: "ops@zomato.test" });
    const db = await fileDispute({ noticeId: nb.id, wallet: b.address, reason: "Not my loan", chainNow: T0 + DAY });
    await resolveDispute({ disputeId: db.id, outcome: "rejected" });
    await processDueNotices({ chainNow: T0 + 9 * DAY });
    expect((await Notice.findById(nb._id)).status).toBe("sent");
  });

  it("files a dispute over HTTP only with the member's wallet signature", async () => {
    const w = wallet();
    const n = await expelledWithNotice(w, { consent: true });
    const { app } = makeApp({ now: async () => T0 + DAY });
    const reason = "The amount does not match my records";
    const forged = await request(app)
      .post("/api/disputes")
      .send({ noticeId: n.id, wallet: w.address, reason, signature: await newWallet().signMessage(disputeMessage(n.id, w.address, reason)) });
    expect(forged.status).toBe(401);
    const ok = await request(app)
      .post("/api/disputes")
      .send({ noticeId: n.id, wallet: w.address, reason, signature: await w.signMessage(disputeMessage(n.id, w.address, reason)) });
    expect(ok.status).toBe(201);
  });

  it("uses neutral, factual wording", () => {
    const text = composeNoticeText({ wallet: "0xabc", amountWei: E(0.004), platformName: "Zomato", payoutDeduction: true });
    expect(text).toContain("outstanding balance");
    expect(text).toContain("vote of pool members");
    for (const word of ["fraud", "thief", "police", "legal action", "shame", "family", "friends", "blacklist", "criminal"]) {
      expect(text.toLowerCase()).not.toContain(word);
    }
  });
});
