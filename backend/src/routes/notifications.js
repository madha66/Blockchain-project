import { Router } from "express";
import mongoose from "mongoose";
import { Notification } from "../models.js";
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
      const items = (await Notification.find({ user: req.user._id, status: "sent" }).sort({ sentAt: -1 }).limit(100)).map(
        (n) => n.toJSON()
      );
      const unread = items.filter((n) => !n.readAt).length;
      const queued = await Notification.countDocuments({ user: req.user._id, status: "queued" });
      res.json({ items, unread, queued });
    })
  );

  r.post(
    "/:id/read",
    ah(async (req, res) => {
      if (mongoose.isValidObjectId(req.params.id)) {
        await Notification.updateOne({ _id: req.params.id, user: req.user._id }, { readAt: new Date() });
      }
      res.json({ ok: true });
    })
  );

  r.post(
    "/read-all",
    ah(async (req, res) => {
      await Notification.updateMany({ user: req.user._id, status: "sent", readAt: null }, { readAt: new Date() });
      res.json({ ok: true });
    })
  );

  return r;
}
