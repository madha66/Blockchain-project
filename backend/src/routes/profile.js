import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { ah, requireSession, setSession } from "../middleware/auth.js";
import { logAuthEvent } from "../services/audit.js";
import { buildAttestation } from "../services/attestationBuilder.js";
import { refreshStep } from "../services/signupState.js";
import { publicUser } from "./serialise.js";

export function profileRoutes({ chain }) {
  const r = Router();

  r.get(
    "/",
    requireSession("full"),
    ah(async (req, res) => {
      const consents = await prisma.consent.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: "desc" },
        select: { kind: true, granted: true, createdAt: true },
      });
      res.json({ user: await publicUser(req.user.id), consentHistory: consents });
    })
  );

  r.post(
    "/consent",
    requireSession("full"),
    ah(async (req, res) => {
      const { kind, granted } = z
        .object({ kind: z.enum(["data_use", "autopay", "peer_visibility"]), granted: z.boolean() })
        .parse(req.body);
      await prisma.consent.create({ data: { userId: req.user.id, kind, granted } });
      res.json({ user: await publicUser(req.user.id) });
    })
  );

  /** Fresh attestation (re-attestation updates income, debts and expiry on-chain). */
  r.post(
    "/attestation",
    requireSession("full"),
    ah(async (req, res) => {
      res.json(await buildAttestation(req.user.id, chain));
    })
  );

  /**
   * Unlinks the wallet so the identity can move to a new one. Refused while a loan is open.
   * The user must also call IdentityRegistry.unlinkWallet() on-chain from the old wallet.
   */
  r.post(
    "/unlink-wallet",
    requireSession("full"),
    ah(async (req, res) => {
      if (!req.user.wallet) return res.status(400).json({ error: "NO_WALLET" });
      const identity = req.user.identityId
        ? await prisma.identity.findUnique({ where: { id: req.user.identityId } })
        : null;
      if (identity && (await chain.hasOpenLoanForIdHash(identity.idHash))) {
        return res.status(409).json({ error: "OPEN_LOAN" });
      }
      await prisma.user.update({ where: { id: req.user.id }, data: { wallet: null } });
      if (identity) await prisma.identity.update({ where: { id: identity.id }, data: { activeWallet: null } });
      await logAuthEvent("wallet_unlinked", req.user.id);
      setSession(res, req.user.id, "signup");
      res.json({ step: await refreshStep(req.user.id) });
    })
  );

  return r;
}
