import { Router } from "express";
import { ethers } from "ethers";
import { z } from "zod";
import {
  Consent,
  CreditSnapshot,
  EmployerContact,
  DebtSettlement,
  DefaultEvent,
  LoanEvent,
  Notice,
  Proposal,
  Repayment,
  User,
  Vote,
} from "../models.js";
import { ah } from "../middleware/auth.js";
import { SIGNED_CONSENTS } from "../services/consentText.js";
import { fileDispute } from "../services/notices.js";
import { disputeMessage, recoverSigner } from "../services/walletProof.js";

const walletParam = z.string().refine(ethers.isAddress, "not an address").transform((a) => a.toLowerCase());
const strip = ({ _id, __v, updatedAt, ...rest }) => rest;

/**
 * Read API over the indexed chain data, plus disputes. Responses carry wallets and amounts
 * only: no names, emails, identifiers or platform contacts.
 */
export function dataRoutes({ chain }) {
  const r = Router();

  r.get(
    "/users/:wallet",
    ah(async (req, res) => {
      const wallet = walletParam.parse(req.params.wallet);
      const status = await chain.walletStatus(wallet);
      const consents = {};
      for (const c of await Consent.find({ wallet }).sort({ timestamp: 1, _id: 1 }).lean()) {
        consents[c.type] = { granted: c.granted, textVersion: c.textVersion, signed: Boolean(c.signature), timestamp: c.timestamp };
      }
      const notices = await Notice.find({ wallet }).sort({ createdAt: -1 }).lean();
      res.json({
        wallet,
        ...status,
        hasAccount: Boolean(await User.exists({ wallet })),
        hasPlatformContact: Boolean(await EmployerContact.exists({ wallet })),
        consents,
        signedConsentTypes: SIGNED_CONSENTS,
        notices: notices.map((n) => ({
          id: String(n._id),
          proposalId: n.proposalId,
          status: n.status,
          amountOutstandingWei: n.amountOutstandingWei,
          disputeWindowEndsAt: n.disputeWindowEndsAt,
          sentAt: n.sentAt,
        })),
        creditHistory: (await CreditSnapshot.find({ wallet }).sort({ chainTs: -1 }).limit(50).lean()).map(strip),
      });
    })
  );

  r.get(
    "/proposals",
    ah(async (req, res) => {
      const filter = {};
      if (req.query.status) filter.status = z.enum(["active", "executed", "defeated", "cancelled"]).parse(req.query.status);
      if (req.query.target) filter.target = walletParam.parse(req.query.target);
      const items = await Proposal.find(filter).sort({ proposalId: -1 }).limit(200).lean();
      res.json({ items: items.map(strip) });
    })
  );

  r.get(
    "/proposals/:id",
    ah(async (req, res) => {
      const proposalId = z.coerce.number().int().min(1).parse(req.params.id);
      const proposal = await Proposal.findOne({ proposalId }).lean();
      if (!proposal) return res.status(404).json({ error: "PROPOSAL_NOT_FOUND" });
      const votes = await Vote.find({ proposalId }).sort({ blockNumber: 1, logIndex: 1 }).lean();
      res.json({ proposal: strip(proposal), votes: votes.map(strip) });
    })
  );

  r.get(
    "/loans/:wallet",
    ah(async (req, res) => {
      const wallet = walletParam.parse(req.params.wallet);
      const [loans, repayments, defaults, settlements] = await Promise.all([
        LoanEvent.find({ wallet }).sort({ blockNumber: -1 }).lean(),
        Repayment.find({ wallet }).sort({ blockNumber: -1 }).lean(),
        DefaultEvent.find({ wallet }).sort({ blockNumber: -1 }).lean(),
        DebtSettlement.find({ wallet }).sort({ blockNumber: -1 }).lean(),
      ]);
      res.json({
        wallet,
        loans: loans.map(strip),
        repayments: repayments.map(strip),
        defaults: defaults.map(strip),
        settlements: settlements.map(strip),
      });
    })
  );

  /** The member disputes a pending platform notice (wallet-signed, inside the 7-day window). */
  r.post(
    "/disputes",
    ah(async (req, res) => {
      const body = z
        .object({
          noticeId: z.string().regex(/^[0-9a-f]{24}$/),
          wallet: walletParam,
          reason: z.string().trim().min(5).max(1000),
          signature: z.string().min(10),
        })
        .parse(req.body);
      if (recoverSigner(disputeMessage(body.noticeId, body.wallet, body.reason), body.signature) !== body.wallet) {
        return res.status(401).json({ error: "DISPUTE_SIGNATURE_INVALID" });
      }
      const dispute = await fileDispute({ ...body, chainNow: await chain.now() });
      res.status(201).json({ id: dispute.id, status: dispute.status });
    })
  );

  return r;
}
