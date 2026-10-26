import { ethers } from "ethers";
import { PayoutRecord, SweepRecord, User } from "../models.js";
import { config } from "../config.js";
import { contractFor } from "./contracts.js";
import { enqueueNotice, flushQueue } from "./notifier.js";
import { payoutsFalling, sweepShortfall, walletRunningDry, preDueWindow, STAGE_NAMES } from "./earlyWarning.js";
import { weiToInr } from "./income.js";

const fmt = (wei) => `${Number(ethers.formatEther(wei)).toFixed(4)} ETH (≈ ₹${Math.round(weiToInr(wei)).toLocaleString("en-IN")})`;
const dateOf = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);

/**
 * Chain watcher → early-warning signals → inbox notices. Loan timing uses chain time (so
 * time-travel demos work); contact hours use wall-clock time in the member's time zone.
 * Payout and sweep events are mirrored by the indexer, which runs first on every tick.
 */
export function createWatcher({ provider, indexer } = {}) {
  provider ??= new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
  const keeper = process.env.DEMO_PRIVATE_KEY ? new ethers.Wallet(process.env.DEMO_PRIVATE_KEY, provider) : null;
  const c = {
    registry: contractFor("IdentityRegistry", provider),
    loans: contractFor("LoanManager", keeper ?? provider),
    router: contractFor("MockPayoutRouter", provider),
    vault: contractFor("SafeRepayVault", provider),
    config: contractFor("PolicyConfig", provider),
  };
  const ready = () => c.registry && c.loans && c.router;

  async function checkUser(user, chainNow, spd) {
    const memberId = await c.registry.memberOf(user.wallet);
    if (memberId === 0n) return;

    const ids = await c.loans.loansOfMember(memberId);
    if (ids.length > 0) {
      const last = await c.loans.getLoan(ids[ids.length - 1]);
      if (Number(last.status) === 3) {
        await enqueueNotice({
          userId: user.id,
          kind: Number(last.dtype) === 1 ? "defaulted_hardship" : "defaulted",
          dedupeKey: `loan-${last.id}-defaulted`,
          facts: `Loan #${last.id} was marked as defaulted and classified as ${["", "hardship", "strategic", "fraud"][Number(last.dtype)]}. You can see the remaining balance and a settlement quote on your Loans page.`,
        });
      }
    }

    const loanId = await c.loans.openLoanOf(memberId);
    if (loanId === 0n) return;
    const loan = await c.loans.getLoan(loanId);
    const stage = STAGE_NAMES[Number(await c.loans.stageOf(loanId))];
    const due = await c.loans.amountDue(loanId);
    const n = Number(loan.paidCount) + 1;
    const facts = `Installment ${n} of ${loan.nInstallments}: ${fmt(due)} due on ${dateOf(loan.nextDueDate)}.`;
    const key = (kind) => `loan-${loanId}-inst-${n}-${kind}`;

    if (stage === "Active") {
      const window = preDueWindow(Number(loan.nextDueDate), chainNow, spd);
      if (window) {
        const payouts = await PayoutRecord.find({ wallet: user.wallet }).lean();
        const sweeps = await SweepRecord.find({ loanId: Number(loanId) }).lean();
        if (payoutsFalling(payouts.map((p) => ({ amount: p.amountWei, ts: p.chainTs })), chainNow, spd)) {
          await enqueueNotice({ userId: user.id, kind: "payouts_falling", facts, dedupeKey: key("payouts_falling") });
        }
        if (sweepShortfall(sweeps.map((s) => ({ amount: s.amountWei, expected: s.expectedWei, ts: s.chainTs })))) {
          await enqueueNotice({ userId: user.id, kind: "sweep_shortfall", facts, dedupeKey: key("sweep_shortfall") });
        }
      }
      if (window === "reminder") {
        await enqueueNotice({ userId: user.id, kind: "reminder", facts, dedupeKey: key("reminder") });
        if (loan.autopay && c.vault) {
          const available = await c.vault.available(user.wallet);
          if (walletRunningDry({ available, due, nextDueTs: Number(loan.nextDueDate), nowTs: chainNow, spd })) {
            await enqueueNotice({
              userId: user.id,
              kind: "wallet_dry",
              facts: `${facts} Your SafeRepay balance available for this installment is ${fmt(available)}.`,
              dedupeKey: key("wallet_dry"),
            });
          }
        }
      }
    } else if (stage === "Grace") {
      // Grace: no personal contact, only a collection retry.
      if (loan.autopay && keeper) await c.loans.autopay(loanId).then((tx) => tx.wait()).catch(() => {});
    } else if (stage === "Onset") {
      await enqueueNotice({ userId: user.id, kind: "onset", facts, dedupeKey: key("onset") });
    } else if (stage === "Significant") {
      await enqueueNotice({ userId: user.id, kind: "significant", facts, dedupeKey: key("significant") });
      if (loan.guarantor !== ethers.ZeroAddress) {
        const guarantor = await User.findOne({ wallet: loan.guarantor.toLowerCase() });
        if (guarantor) {
          await enqueueNotice({
            userId: guarantor.id,
            kind: "guarantor_alert",
            facts: `A loan you guarantee (#${loanId}) has an installment more than 10 days late. Your locked stake may be applied if it stays unpaid.`,
            dedupeKey: key("guarantor"),
          });
        }
      }
    }
  }

  /** One pass: index events, evaluate every linked member, flush queued notices. */
  async function tick(now = new Date()) {
    if (!ready()) return { skipped: "contracts not configured" };
    const indexed = indexer ? await indexer.tick().catch((err) => ({ error: err.shortMessage || err.message })) : null;
    const chainNow = (await provider.getBlock("latest")).timestamp;
    const spd = c.config ? Number(await c.config.secondsPerDay()) : 86400;
    const users = await User.find({ wallet: { $type: "string" } });
    for (const user of users) {
      try {
        await checkUser(user, chainNow, spd);
      } catch (err) {
        console.warn(`[watcher] user ${user.id}: ${err.shortMessage || err.message}`);
      }
    }
    const flushed = await flushQueue(now);
    return { users: users.length, flushed, indexer: indexed };
  }

  return { tick };
}
