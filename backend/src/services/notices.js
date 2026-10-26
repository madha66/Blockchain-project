import { ethers } from "ethers";
import { Dispute, EmployerContact, Notice } from "../models.js";
import { hasConsent } from "./consents.js";
import { logAudit } from "./audit.js";
import { noopSender } from "./noticeSender.js";
import { weiToInr } from "./income.js";

export const DISPUTE_WINDOW_DAYS = 7;

const refuse = (status, code) => Object.assign(new Error(code), { status, code });
const fmt = (wei) =>
  `${Number(ethers.formatEther(wei)).toFixed(4)} ETH (about ₹${Math.round(weiToInr(wei)).toLocaleString("en-IN")})`;

/**
 * Neutral, factual wording: the balance, that membership ended by a member vote, and how to
 * reach GigLend. No adjectives about the member, no threats, no request to act against them.
 */
export function composeNoticeText({ wallet, amountWei, platformName, payoutDeduction }) {
  const lines = [
    `To: ${platformName}`,
    "",
    `This is a notice from GigLend, a community lending pool, about a worker on your platform who uses the wallet ${wallet}.`,
    `GigLend membership for this wallet was ended by a vote of pool members after a loan default. The outstanding balance is ${fmt(amountWei)}.`,
    "The worker agreed in writing that GigLend may send this one notice.",
  ];
  if (payoutDeduction) {
    lines.push(
      "The worker has also agreed that part of their payouts may be deducted toward this balance, within your platform's limits. Deductions should stop once the balance is cleared."
    );
  }
  lines.push(
    "No action against the worker is requested beyond what they agreed to. Questions or corrections: grievance@giglend.test."
  );
  return lines.join("\n");
}

/** Records the "notice pending" state after an expulsion. Idempotent per (wallet, proposal). */
export async function createPendingNotice({ wallet, memberId, proposalId, amountWei, chainTs, spd = 86400 }) {
  const w = wallet.toLowerCase();
  const notice = await Notice.findOneAndUpdate(
    { wallet: w, proposalId },
    {
      $setOnInsert: {
        wallet: w,
        memberId,
        proposalId,
        status: "pending",
        amountOutstandingWei: String(amountWei),
        createdChainTs: chainTs,
        disputeWindowEndsAt: chainTs + DISPUTE_WINDOW_DAYS * spd,
      },
    },
    { upsert: true, new: true, includeResultMetadata: true }
  );
  if (!notice.lastErrorObject?.updatedExisting) {
    await logAudit("notice", "notice_pending", {
      wallet: w,
      data: { proposalId, disputeWindowEndsAt: notice.value.disputeWindowEndsAt, amountWei: String(amountWei) },
    });
  }
  return notice.value;
}

/** Cancels every notice not yet sent (debt cleared or member reinstated). */
export async function cancelOpenNotices(wallet, reason) {
  const open = await Notice.find({ wallet: wallet.toLowerCase(), status: { $in: ["pending", "disputed"] } });
  for (const n of open) {
    n.status = "cancelled";
    await n.save();
    await logAudit("notice", "notice_cancelled", { wallet: n.wallet, data: { noticeId: n.id, reason } });
  }
  return open.length;
}

/**
 * The member disputes a pending notice. Only possible inside the 7-day window (chain time).
 */
export async function fileDispute({ noticeId, wallet, reason, chainNow }) {
  const notice = await Notice.findById(noticeId);
  if (!notice || notice.wallet !== wallet.toLowerCase()) throw refuse(404, "NOTICE_NOT_FOUND");
  if (notice.status !== "pending") throw refuse(409, "NOTICE_NOT_PENDING");
  if (chainNow > notice.disputeWindowEndsAt) {
    await logAudit("dispute", "dispute_refused_window_closed", { wallet: notice.wallet, data: { noticeId } });
    throw refuse(409, "DISPUTE_WINDOW_CLOSED");
  }
  const dispute = await Dispute.create({ notice: notice._id, wallet: notice.wallet, reason });
  notice.status = "disputed";
  await notice.save();
  await logAudit("dispute", "dispute_filed", { wallet: notice.wallet, data: { noticeId, disputeId: dispute.id } });
  return dispute;
}

/**
 * Admin decision. Upheld → the notice is cancelled for good. Rejected → the notice returns to
 * pending and is processed after the window like any other.
 */
export async function resolveDispute({ disputeId, outcome, resolution = null }) {
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw refuse(404, "DISPUTE_NOT_FOUND");
  if (dispute.status !== "open") throw refuse(409, "DISPUTE_ALREADY_RESOLVED");
  dispute.status = outcome;
  dispute.resolution = resolution;
  dispute.resolvedAt = new Date();
  await dispute.save();

  const notice = await Notice.findById(dispute.notice);
  if (notice && notice.status === "disputed") {
    notice.status = outcome === "upheld" ? "cancelled" : "pending";
    await notice.save();
  }
  await logAudit("dispute", `dispute_${outcome}`, { wallet: dispute.wallet, data: { disputeId, noticeId: String(dispute.notice) } });
  return dispute;
}

/**
 * Moves pending notices whose dispute window has passed:
 *  - debt already cleared → cancelled
 *  - no platform-notice consent (or no platform contact) → not_sent_no_consent
 *  - otherwise → "sent" through the sender (a no-op in this prototype)
 * Disputed notices wait for the admin decision.
 */
export async function processDueNotices({ chainNow, outstandingOf, sender = noopSender }) {
  const due = await Notice.find({ status: "pending", disputeWindowEndsAt: { $lte: chainNow } });
  const results = [];
  for (const notice of due) {
    const outstanding = outstandingOf ? BigInt(await outstandingOf(notice.wallet)) : BigInt(notice.amountOutstandingWei);
    if (outstanding === 0n) {
      notice.status = "cancelled";
      await notice.save();
      await logAudit("notice", "notice_cancelled", { wallet: notice.wallet, data: { noticeId: notice.id, reason: "debt_cleared" } });
      results.push({ id: notice.id, status: notice.status });
      continue;
    }
    const consented = await hasConsent(notice.wallet, "platform_notice");
    const contact = await EmployerContact.findOne({ wallet: notice.wallet });
    if (!consented || !contact) {
      notice.status = "not_sent_no_consent";
      await notice.save();
      await logAudit("notice", "notice_not_sent_no_consent", {
        wallet: notice.wallet,
        data: { noticeId: notice.id, consent: consented, platformContact: Boolean(contact) },
      });
      results.push({ id: notice.id, status: notice.status });
      continue;
    }
    notice.amountOutstandingWei = outstanding.toString();
    notice.recipient = { platformName: contact.platformName, contactEmail: contact.contactEmail };
    notice.text = composeNoticeText({
      wallet: notice.wallet,
      amountWei: outstanding,
      platformName: contact.platformName,
      payoutDeduction: await hasConsent(notice.wallet, "payout_deduction"),
    });
    const delivery = await sender.send(notice);
    notice.status = "sent";
    notice.sentAt = new Date();
    await notice.save();
    await logAudit("notice", "notice_sent", {
      wallet: notice.wallet,
      data: { noticeId: notice.id, sender: sender.name, simulated: Boolean(delivery?.simulated) },
    });
    results.push({ id: notice.id, status: notice.status });
  }
  return results;
}
