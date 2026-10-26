import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { AuditLog, Contact, Dispute, Identity, Notice, Notification, User } from "../models.js";
import { ah, requireAdmin, requireSession } from "../middleware/auth.js";
import { flushQueue } from "../services/notifier.js";
import { resolveDispute } from "../services/notices.js";
import { indexerStatus } from "../services/indexer.js";

const objectId = z.string().refine(mongoose.isValidObjectId, "not an id");

/** Notices and their disputes. Platform contacts are visible here only (admin, deployer wallet). */
export async function listNotices() {
  const notices = await Notice.find().sort({ createdAt: -1 }).limit(200).lean();
  const disputes = await Dispute.find({ notice: { $in: notices.map((n) => n._id) } }).sort({ createdAt: -1 }).lean();
  return notices.map((n) => ({
    id: String(n._id),
    wallet: n.wallet,
    memberId: n.memberId,
    proposalId: n.proposalId,
    status: n.status,
    amountOutstandingWei: n.amountOutstandingWei,
    disputeWindowEndsAt: n.disputeWindowEndsAt,
    recipient: n.recipient?.platformName ? n.recipient : null,
    text: n.text ?? null,
    sentAt: n.sentAt,
    createdAt: n.createdAt,
    disputes: disputes
      .filter((d) => String(d.notice) === String(n._id))
      .map((d) => ({
        id: String(d._id),
        reason: d.reason,
        status: d.status,
        resolution: d.resolution,
        createdAt: d.createdAt,
        resolvedAt: d.resolvedAt,
      })),
  }));
}

/**
 * Admin endpoints for off-chain state. On-chain admin actions (reclassify, shock mode,
 * cluster flags, cohort pause, parameters) are signed in the browser by the ADMIN_ROLE /
 * DISPUTE_ROLE wallet. Responses carry no member contact details.
 */
export function adminRoutes({ watcher } = {}) {
  const r = Router();
  r.use(requireSession("full"), requireAdmin);

  r.get(
    "/members",
    ah(async (req, res) => {
      const identities = await Identity.find().lean();
      const contacts = new Map((await Contact.find().lean()).map((c) => [String(c._id), c.name]));
      const counts = new Map(
        (await User.aggregate([{ $match: { identity: { $ne: null } } }, { $group: { _id: "$identity", n: { $sum: 1 } } }])).map(
          (x) => [String(x._id), x.n]
        )
      );
      res.json({
        members: identities.map((i) => ({
          identityId: String(i._id),
          idHash: i.identityHash,
          identifierType: i.identifierType,
          cohortId: i.cohortId,
          clusterId: i.clusterId,
          clusterOverride: i.clusterOverride,
          activeWallet: i.linkedWallet,
          banned: i.banned,
          contactName: contacts.get(String(i.contact)) ?? null,
          accounts: counts.get(String(i._id)) ?? 0,
        })),
      });
    })
  );

  /** Demo fixtures: put identities into a named cluster (takes effect on re-attestation). */
  r.post(
    "/cluster-override",
    ah(async (req, res) => {
      const { identityId, override } = z.object({ identityId: objectId, override: z.string().max(64).nullable() }).parse(req.body);
      await Identity.updateOne({ _id: identityId }, { clusterOverride: override });
      res.json({ ok: true });
    })
  );

  r.get(
    "/message-log",
    ah(async (req, res) => {
      const items = await Notification.find()
        .sort({ createdAt: -1 })
        .limit(200)
        .select({ user: 1, kind: 1, title: 1, contactName: 1, status: 1, scheduledFor: 1, sentAt: 1, createdAt: 1 })
        .lean();
      res.json({ items: items.map(({ _id, user, ...n }) => ({ id: String(_id), userId: String(user), ...n })) });
    })
  );

  r.get("/notices", ah(async (req, res) => res.json({ items: await listNotices() })));

  r.post(
    "/disputes/:id/resolve",
    ah(async (req, res) => {
      const id = objectId.parse(req.params.id);
      const { outcome, resolution } = z
        .object({ outcome: z.enum(["upheld", "rejected"]), resolution: z.string().trim().max(1000).optional() })
        .parse(req.body);
      const dispute = await resolveDispute({ disputeId: id, outcome, resolution });
      res.json({ id: dispute.id, status: dispute.status });
    })
  );

  r.get(
    "/audit",
    ah(async (req, res) => {
      const filter = {};
      if (req.query.category) filter.category = String(req.query.category);
      if (req.query.wallet) filter.wallet = String(req.query.wallet).toLowerCase();
      const items = await AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).limit(300).lean();
      res.json({
        items: items.map(({ _id, user, ...a }) => ({ id: String(_id), user: user ? String(user) : null, ...a })),
        indexer: await indexerStatus(),
      });
    })
  );

  r.post(
    "/watcher/tick",
    ah(async (req, res) => {
      const result = watcher ? await watcher.tick() : { skipped: "watcher disabled" };
      res.json({ ...result, flushed: (result.flushed ?? 0) + (await flushQueue()) });
    })
  );

  return r;
}

/** GET /api/notices: the same list, admin only. */
export function noticeRoutes() {
  const r = Router();
  r.use(requireSession("full"), requireAdmin);
  r.get("/", ah(async (req, res) => res.json({ items: await listNotices() })));
  return r;
}
