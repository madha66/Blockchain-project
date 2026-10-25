import { Router } from "express";
import { prisma } from "../db.js";
import { ah, requireSession } from "../middleware/auth.js";

/**
 * In-app inbox. Only delivered notices are shown; queued ones wait for contact hours.
 */
export function notificationRoutes() {
  const r = Router();
  r.use(requireSession("full"));

  r.get(
    "/",
    ah(async (req, res) => {
      const items = await prisma.notification.findMany({
        where: { userId: req.user.id, status: "sent" },
        orderBy: { sentAt: "desc" },
        take: 100,
      });
      const unread = items.filter((n) => !n.readAt).length;
      const queued = await prisma.notification.count({ where: { userId: req.user.id, status: "queued" } });
      res.json({ items, unread, queued });
    })
  );

  r.post(
    "/:id/read",
    ah(async (req, res) => {
      await prisma.notification.updateMany({
        where: { id: req.params.id, userId: req.user.id },
        data: { readAt: new Date() },
      });
      res.json({ ok: true });
    })
  );

  r.post(
    "/read-all",
    ah(async (req, res) => {
      await prisma.notification.updateMany({
        where: { userId: req.user.id, status: "sent", readAt: null },
        data: { readAt: new Date() },
      });
      res.json({ ok: true });
    })
  );

  return r;
}
