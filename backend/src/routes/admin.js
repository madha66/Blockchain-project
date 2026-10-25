import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { ah, requireAdmin, requireSession } from "../middleware/auth.js";
import { flushQueue } from "../services/notifier.js";

/**
 * Admin endpoints for off-chain state. On-chain admin actions (reclassify, shock mode,
 * cluster flags, cohort pause, parameters) are signed in the browser by the ADMIN_ROLE /
 * DISPUTE_ROLE wallet. Responses carry no contact details.
 */
export function adminRoutes({ watcher } = {}) {
  const r = Router();
  r.use(requireSession("full"), requireAdmin);

  r.get(
    "/members",
    ah(async (req, res) => {
      const identities = await prisma.identity.findMany({ include: { contact: true, users: true } });
      res.json({
        members: identities.map((i) => ({
          identityId: i.id,
          idHash: i.idHash,
          cohortId: i.cohortId,
          clusterId: i.clusterId,
          clusterOverride: i.clusterOverride,
          activeWallet: i.activeWallet,
          contactName: i.contact.name,
          accounts: i.users.length,
        })),
      });
    })
  );

  /** Demo fixtures: put identities into a named cluster (takes effect on re-attestation). */
  r.post(
    "/cluster-override",
    ah(async (req, res) => {
      const { identityId, override } = z
        .object({ identityId: z.string(), override: z.string().max(64).nullable() })
        .parse(req.body);
      await prisma.identity.update({ where: { id: identityId }, data: { clusterOverride: override } });
      res.json({ ok: true });
    })
  );

  r.get(
    "/message-log",
    ah(async (req, res) => {
      const items = await prisma.notification.findMany({
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { id: true, userId: true, kind: true, title: true, contactName: true, status: true, scheduledFor: true, sentAt: true, createdAt: true },
      });
      res.json({ items });
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
