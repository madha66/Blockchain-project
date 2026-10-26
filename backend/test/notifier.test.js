import { describe, it, expect, beforeEach } from "vitest";
import { Identity, Notification, User } from "../src/models.js";
import { GRIEVANCE_LINE } from "../src/config.js";
import {
  isWithinContactHours,
  nextContactTime,
  composeMessage,
  enqueueNotice,
  flushQueue,
  purgeExpired,
  allowsPersonalContact,
} from "../src/services/notifier.js";
import { payoutsFalling, sweepShortfall, walletRunningDry, preDueWindow, cohortFpd } from "../src/services/earlyWarning.js";
import { pickContact } from "../src/services/contacts.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);

// 2026-10-26 in India (UTC+05:30)
const ist = (hh, mm = 0) => new Date(Date.UTC(2026, 9, 26, hh, mm) - 330 * 60 * 1000);

async function makeMember() {
  const contact = await pickContact();
  const identity = await Identity.create({
    identityHash: `0x${Math.random().toString(16).slice(2)}`,
    salt: "00",
    identifierType: "pan",
    identifierEnc: "x",
    identifierMasked: "ABxxxxxx4F",
    aadhaarRef: "1234",
    clusterId: "0x1",
    cohortId: 202643,
    contact: contact._id,
  });
  const user = await User.create({
    name: "Ravi",
    email: `ravi${Math.random()}@example.test`,
    phone: `9${Math.floor(Math.random() * 1e9)}`.padEnd(10, "0"),
    passwordHash: "x",
    identity: identity._id,
    timezone: "Asia/Kolkata",
  });
  return { user, contactName: contact.name };
}

describe("Notifier contact rules", () => {
  it("only contacts between 08:00 and 19:00 local time", () => {
    expect(isWithinContactHours(ist(7, 59))).toBe(false);
    expect(isWithinContactHours(ist(8, 0))).toBe(true);
    expect(isWithinContactHours(ist(18, 59))).toBe(true);
    expect(isWithinContactHours(ist(19, 0))).toBe(false);
    expect(isWithinContactHours(ist(23, 30))).toBe(false);
  });

  it("queues a notice created in quiet hours until 08:00 local, then delivers it", async () => {
    const { user } = await makeMember();
    const late = ist(21, 15);
    const notice = await enqueueNotice({ userId: user.id, kind: "onset", facts: "Installment 1 of 4: 0.0050 ETH due on 2026-10-30.", now: late });
    expect(notice.status).toBe("queued");
    expect(notice.sentAt).toBeNull();
    expect(notice.scheduledFor.getTime()).toBe(nextContactTime(late).getTime());
    expect(isWithinContactHours(notice.scheduledFor)).toBe(true);

    expect(await flushQueue(ist(6, 0))).toBe(0);
    expect(await flushQueue(new Date(notice.scheduledFor.getTime() + 60 * 1000))).toBe(1);
    const after = await Notification.findById(notice._id);
    expect(after.status).toBe("sent");
  });

  it("delivers immediately inside contact hours", async () => {
    const { user } = await makeMember();
    const notice = await enqueueNotice({ userId: user.id, kind: "reminder", facts: "x", now: ist(10) });
    expect(notice.status).toBe("sent");
  });

  it("every message carries the member's named contact and the grievance line", async () => {
    const { user, contactName } = await makeMember();
    for (const kind of ["payouts_falling", "sweep_shortfall", "wallet_dry", "reminder", "onset", "significant", "defaulted", "defaulted_hardship"]) {
      const n = await enqueueNotice({ userId: user.id, kind, facts: "Amount and date.", now: ist(12), dedupeKey: `t-${kind}` });
      expect(n.contactName).toBe(contactName);
      expect(n.body).toContain(contactName);
      expect(n.body).toContain(GRIEVANCE_LINE);
    }
  });

  it("puts help first and the facts second, with no threatening language", () => {
    const { body } = composeMessage({ kind: "onset", contactName: "Priya Sharma", facts: "Installment 2 of 4: 0.005 ETH due on 2026-11-02." });
    const help = body.indexOf("payment holiday");
    const facts = body.indexOf("Installment 2 of 4");
    expect(help).toBeGreaterThanOrEqual(0);
    expect(help).toBeLessThan(facts);
    for (const word of ["legal action", "police", "family", "employer", "shame", "seize"]) {
      expect(body.toLowerCase()).not.toContain(word);
    }
  });

  it("keeps the same named contact across notices", async () => {
    const { user } = await makeMember();
    const a = await enqueueNotice({ userId: user.id, kind: "reminder", facts: "a", now: ist(9), dedupeKey: "a" });
    const b = await enqueueNotice({ userId: user.id, kind: "onset", facts: "b", now: ist(9), dedupeKey: "b" });
    expect(a.contactName).toBe(b.contactName);
  });

  it("does not duplicate a notice with the same key", async () => {
    const { user } = await makeMember();
    await enqueueNotice({ userId: user.id, kind: "onset", facts: "x", now: ist(9), dedupeKey: "loan-1-inst-1-onset" });
    await enqueueNotice({ userId: user.id, kind: "onset", facts: "x", now: ist(9), dedupeKey: "loan-1-inst-1-onset" });
    expect(await Notification.countDocuments()).toBe(1);
  });

  it("keeps messages for at least 6 months", async () => {
    const { user } = await makeMember();
    const n = await enqueueNotice({ userId: user.id, kind: "onset", facts: "x", now: ist(9) });
    const fiveMonths = new Date(n.createdAt.getTime() + 150 * 86400 * 1000);
    expect(await purgeExpired(fiveMonths)).toBe(0);
    const sevenMonths = new Date(n.createdAt.getTime() + 210 * 86400 * 1000);
    expect(await purgeExpired(sevenMonths)).toBe(1);
  });

  it("makes no personal contact during Grace", () => {
    expect(allowsPersonalContact("Grace")).toBe(false);
    expect(allowsPersonalContact("Onset")).toBe(true);
    expect(allowsPersonalContact("Active")).toBe(true);
  });
});

describe("Early-warning signals", () => {
  const day = 86400;
  const now = 200 * day;
  const wei = (eth) => BigInt(Math.round(eth * 1e6)) * 10n ** 12n;

  it("flags payout inflows falling below 70% of the 90-day average", () => {
    const steady = [80, 70, 60, 50, 40, 30, 20, 10].map((d) => ({ ts: now - d * day, amount: wei(0.1) }));
    expect(payoutsFalling(steady, now)).toBe(false);
    const falling = [80, 70, 60, 50, 40, 35].map((d) => ({ ts: now - d * day, amount: wei(0.1) })).concat([{ ts: now - 5 * day, amount: wei(0.02) }]);
    expect(payoutsFalling(falling, now)).toBe(true);
  });

  it("flags a sweep shortfall only for two payouts in a row", () => {
    expect(sweepShortfall([{ ts: 1, amount: 5, expected: 10 }, { ts: 2, amount: 12, expected: 10 }])).toBe(false);
    expect(sweepShortfall([{ ts: 1, amount: 5, expected: 10 }, { ts: 2, amount: 4, expected: 10 }])).toBe(true);
  });

  it("flags a wallet running dry 3 days before due", () => {
    expect(walletRunningDry({ available: 5n, due: 10n, nextDueTs: now + 2 * day, nowTs: now })).toBe(true);
    expect(walletRunningDry({ available: 5n, due: 10n, nextDueTs: now + 5 * day, nowTs: now })).toBe(false);
    expect(walletRunningDry({ available: 10n, due: 10n, nextDueTs: now + 1 * day, nowTs: now })).toBe(false);
  });

  it("opens the early-warning window at 7 days and the reminder at 3 days before due", () => {
    expect(preDueWindow(now + 10 * day, now)).toBeNull();
    expect(preDueWindow(now + 6 * day, now)).toBe("early_warning");
    expect(preDueWindow(now + 2 * day, now)).toBe("reminder");
    expect(preDueWindow(now - 1, now)).toBeNull();
  });

  it("computes the cohort first-payment-default rate against its threshold", () => {
    expect(cohortFpd({ firstLoans: 10, firstPaymentDefaults: 3, thresholdBps: 2000, minSample: 5 })).toEqual({ rateBps: 3000, paused: true });
    expect(cohortFpd({ firstLoans: 3, firstPaymentDefaults: 3, thresholdBps: 2000, minSample: 5 }).paused).toBe(false);
  });
});
