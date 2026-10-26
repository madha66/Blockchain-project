import { ethers } from "ethers";
import { config } from "../config.js";
import { contractFor } from "./contracts.js";
import {
  CreditSnapshot,
  Cursor,
  DebtSettlement,
  DefaultEvent,
  Identity,
  LoanEvent,
  MIRRORS,
  Notice,
  PayoutRecord,
  Proposal,
  Repayment,
  SweepRecord,
  User,
  Vote,
} from "../models.js";
import { logAudit } from "./audit.js";
import { enqueueNotice } from "./notifier.js";
import { cancelOpenNotices, createPendingNotice, processDueNotices } from "./notices.js";
import { noopSender } from "./noticeSender.js";
import { weiToInr } from "./income.js";

const CURSOR_ID = "indexer";
const BATCH = 2000; // blocks per getLogs call
const KEEP_HASHES = 64; // reorg detection depth
const KIND = ["expel", "reinstate"];
const fmt = (wei) => `${Number(ethers.formatEther(wei)).toFixed(4)} ETH (≈ ₹${Math.round(weiToInr(wei)).toLocaleString("en-IN")})`;

/**
 * Chain → MongoDB indexer. Mirrors protocol events (deduplicated on txHash + logIndex), rolls
 * back on reorgs (block-hash check, plus logs flagged `removed`), backfills from
 * INDEXER_START_BLOCK, and drives the debt escalation timeline:
 *   day 0 reminder → day 3 reminder → (on expulsion) notice pending with a 7-day dispute window
 *   → sent only if no dispute is upheld and the member consented to platform notices.
 */
export function createIndexer({ provider, sender = noopSender, startBlock = config.indexerStartBlock, log = console } = {}) {
  provider ??= new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
  const c = {
    registry: contractFor("IdentityRegistry", provider),
    loans: contractFor("LoanManager", provider),
    defaults: contractFor("DefaultManager", provider),
    pool: contractFor("LendingPool", provider),
    governance: contractFor("DefaulterGovernance", provider),
    router: contractFor("MockPayoutRouter", provider),
    score: contractFor("CreditScore", provider),
    policy: contractFor("PolicyConfig", provider),
  };
  const sources = [c.registry, c.loans, c.defaults, c.pool, c.governance, c.router, c.score].filter(Boolean);
  const ready = () => Boolean(c.registry && c.loans && c.defaults && c.governance);

  const blockCache = new Map();
  async function block(n) {
    if (!blockCache.has(n)) {
      blockCache.set(n, await provider.getBlock(n));
      if (blockCache.size > 512) blockCache.delete(blockCache.keys().next().value);
    }
    return blockCache.get(n);
  }
  const spd = async () => (c.policy ? Number(await c.policy.secondsPerDay()) : 86400);
  const walletOfMember = async (memberId) => (await c.registry.walletOf(memberId)).toLowerCase();
  const outstandingOf = async (wallet) => {
    const memberId = await c.registry.memberOf(wallet);
    return memberId === 0n ? 0n : c.defaults.claimOf(memberId);
  };

  /** Re-reads ban/expulsion/verification flags for a wallet from the chain. */
  async function syncWalletFlags(wallet) {
    const w = wallet.toLowerCase();
    const [verified, banned, expelled, idHash] = await Promise.all([
      c.registry.isVerified(w),
      c.registry.isBanned(w),
      c.pool ? c.pool.expelled(w) : false,
      c.registry.identityOf(w),
    ]);
    await User.updateOne({ wallet: w }, { verified, banned, expelled, ...(verified ? { identityHash: idHash } : {}) });
    if (idHash && idHash !== ethers.ZeroHash) await Identity.updateOne({ identityHash: idHash }, { banned });
    return { verified, banned, expelled };
  }

  async function snapshotScore(memberId, chainTs, reason) {
    if (!c.score) return;
    const wallet = await walletOfMember(memberId);
    const score = Number(await c.score.getScore(memberId));
    await CreditSnapshot.create({ wallet, memberId: Number(memberId), score, chainTs, reason });
  }

  /** Inserts a mirror row once; returns true when it is new. */
  async function mirror(Model, ev, fields) {
    const res = await Model.updateOne(
      { txHash: ev.txHash, logIndex: ev.logIndex },
      { $setOnInsert: { ...ev, ...fields } },
      { upsert: true }
    );
    return res.upsertedCount === 1;
  }

  async function tallyProposal(proposalId) {
    const votes = await Vote.find({ proposalId }).lean();
    let forV = 0n;
    let against = 0n;
    for (const v of votes) (v.support ? (forV += BigInt(v.weightWei)) : (against += BigInt(v.weightWei)));
    await Proposal.updateOne({ proposalId }, { forVotesWei: forV.toString(), againstVotesWei: against.toString() });
  }

  const handlers = {
    async LoanOpened(a, ev) {
      await mirror(LoanEvent, ev, {
        loanId: Number(a.loanId),
        memberId: Number(a.memberId),
        wallet: a.borrower.toLowerCase(),
        kind: Number(a.kind),
        principalWei: a.principal.toString(),
        rateBps: Number(a.rateBps),
        nInstallments: Number(a.nInstallments),
        periodDays: Number(a.periodDays),
        installmentWei: a.installment.toString(),
      });
    },
    async Repaid(a, ev) {
      await mirror(Repayment, ev, {
        wallet: a.user.toLowerCase(),
        amountWei: a.amount.toString(),
        principalWei: a.principalPaid.toString(),
        interestWei: a.interestPaid.toString(),
        refundWei: a.refund.toString(),
      });
    },
    async LoanDefaulted(a, ev) {
      const loan = await c.loans.getLoan(a.loanId);
      const wallet = loan.borrower.toLowerCase();
      const isNew = await mirror(DefaultEvent, ev, {
        loanId: Number(a.loanId),
        memberId: Number(loan.memberId),
        wallet,
        defaultType: Number(a.defaultType),
        stakeUsedWei: a.stakeUsed.toString(),
        guarantorUsedWei: a.guarantorUsed.toString(),
        reserveUsedWei: a.reserveUsed.toString(),
        lenderLossWei: a.lenderLoss.toString(),
      });
      if (isNew) await logAudit("governance", "loan_defaulted", { wallet, data: { loanId: Number(a.loanId) } });
    },
    async ClaimSettled(a, ev) {
      const wallet = await walletOfMember(a.memberId);
      await mirror(DebtSettlement, ev, {
        memberId: Number(a.memberId),
        wallet,
        kind: "settled",
        amountWei: a.paid.toString(),
        discountWei: a.discount.toString(),
        fullySettled: a.fullySettled,
      });
      if (a.fullySettled) await cancelOpenNotices(wallet, "debt_cleared");
    },
    async ClaimRecovered(a, ev) {
      await mirror(DebtSettlement, ev, {
        memberId: Number(a.memberId),
        wallet: await walletOfMember(a.memberId),
        kind: "recovered",
        amountWei: a.amount.toString(),
        discountWei: "0",
        fullySettled: false,
      });
    },
    async StakeSeized(a, ev) {
      await mirror(DebtSettlement, ev, {
        memberId: Number(a.memberId),
        wallet: a.wallet.toLowerCase(),
        kind: "stake_seized",
        amountWei: a.value.toString(),
        discountWei: "0",
        fullySettled: false,
      });
    },
    async ProposalCreated(a, ev) {
      const isNew = await mirror(Proposal, ev, {
        proposalId: Number(a.proposalId),
        kind: KIND[Number(a.kind)],
        target: a.target.toLowerCase(),
        proposer: a.proposer.toLowerCase(),
        snapshotBlock: Number(a.snapshotBlock),
        endTime: Number(a.endTime),
      });
      if (isNew) {
        await logAudit("governance", "proposal_created", {
          wallet: a.target,
          data: { proposalId: Number(a.proposalId), kind: KIND[Number(a.kind)], proposer: a.proposer.toLowerCase() },
        });
      }
    },
    async VoteCast(a, ev) {
      await mirror(Vote, ev, {
        proposalId: Number(a.proposalId),
        voter: a.voter.toLowerCase(),
        support: a.support,
        weightWei: a.weight.toString(),
      });
      await tallyProposal(Number(a.proposalId));
    },
    async ProposalExecuted(a, ev) {
      const proposalId = Number(a.proposalId);
      const kind = KIND[Number(a.kind)];
      const target = a.target.toLowerCase();
      const proposal = await Proposal.findOne({ proposalId });
      if (proposal?.status !== "active") return; // already applied
      proposal.status = a.passed ? "executed" : "defeated";
      proposal.passed = a.passed;
      proposal.closedAtChainTs = ev.chainTs;
      await proposal.save();
      await logAudit("governance", `proposal_${proposal.status}`, { wallet: target, data: { proposalId, kind } });
      if (!a.passed) return;

      await syncWalletFlags(target);
      const memberId = await c.registry.memberOf(target);
      if (kind === "expel") {
        const amountWei = await outstandingOf(target);
        const user = await User.findOne({ wallet: target });
        if (user) {
          await enqueueNotice({
            userId: user._id,
            kind: "expelled",
            dedupeKey: `proposal-${proposalId}-expelled`,
            facts: `Proposal #${proposalId} passed. Your outstanding balance is ${fmt(amountWei)}. Deposits and new loans are closed for this wallet until the balance is cleared and a reinstatement vote passes.`,
          });
        }
        if (amountWei > 0n) {
          await createPendingNotice({ wallet: target, memberId: Number(memberId), proposalId, amountWei, chainTs: ev.chainTs, spd: await spd() });
        }
      } else {
        await Identity.updateOne({ linkedWallet: target }, { reinstatedAt: new Date() });
        await cancelOpenNotices(target, "reinstated");
      }
      if (memberId !== 0n) await snapshotScore(memberId, ev.chainTs, `proposal_${kind}`);
    },
    async ProposalCancelled(a) {
      const res = await Proposal.updateOne({ proposalId: Number(a.proposalId), status: "active" }, { status: "cancelled" });
      if (res.modifiedCount) {
        await logAudit("governance", "proposal_cancelled", { wallet: a.target, data: { proposalId: Number(a.proposalId) } });
      }
    },
    async MemberRegistered(a, ev) {
      const wallet = a.wallet.toLowerCase();
      await User.updateOne({ wallet }, { verifiedAt: new Date(ev.chainTs * 1000) });
      await syncWalletFlags(wallet);
      await logAudit("identity", "member_registered", { wallet, data: { memberId: Number(a.memberId) } });
      await snapshotScore(a.memberId, ev.chainTs, "registered");
    },
    async WalletLinked(a) {
      await syncWalletFlags(a.wallet);
    },
    async IdentityBanned(a) {
      await Identity.updateOne({ identityHash: a.idHash }, { banned: true, bannedAt: new Date() });
      await User.updateMany({ identityHash: a.idHash }, { banned: true });
      await logAudit("identity", "identity_banned", { data: { identityHash: a.idHash, memberId: Number(a.memberId) } });
    },
    async IdentityUnbanned(a) {
      await Identity.updateOne({ identityHash: a.idHash }, { banned: false });
      await User.updateMany({ identityHash: a.idHash }, { banned: false });
      await logAudit("identity", "identity_unbanned", { data: { identityHash: a.idHash, memberId: Number(a.memberId) } });
    },
    async WalletExpelled(a) {
      await User.updateOne({ wallet: a.wallet.toLowerCase() }, { expelled: a.expelled });
    },
    async ScoreChanged(a, ev) {
      let reason = "score_changed";
      try {
        reason = ethers.decodeBytes32String(a.reasonCode) || reason;
      } catch {
        /* not a short string */
      }
      await snapshotScore(a.memberId, ev.chainTs, reason);
    },
    async PayoutRouted(a, ev) {
      await mirror(PayoutRecord, ev, {
        wallet: a.worker.toLowerCase(),
        amountWei: a.amount.toString(),
        sweptWei: a.sweptToLoan.toString(),
      });
    },
    async SweepApplied(a, ev) {
      const loan = await c.loans.getLoan(a.loanId);
      await mirror(SweepRecord, ev, {
        wallet: loan.borrower.toLowerCase(),
        loanId: Number(a.loanId),
        amountWei: a.amount.toString(),
        expectedWei: a.expected.toString(),
      });
    },
  };

  /** Deletes mirrored rows above `forkBlock` and re-syncs the wallets they touched. */
  async function rollback(forkBlock) {
    const wallets = new Set();
    for (const Model of MIRRORS) {
      const rows = await Model.find({ blockNumber: { $gt: forkBlock } }, { wallet: 1, target: 1 }).lean();
      rows.forEach((r) => (r.wallet || r.target) && wallets.add(r.wallet || r.target));
      await Model.deleteMany({ blockNumber: { $gt: forkBlock } });
    }
    for (const p of await Proposal.distinct("proposalId")) await tallyProposal(p);
    for (const w of wallets) await syncWalletFlags(w).catch(() => {});
    await logAudit("governance", "indexer_reorg_rollback", { data: { forkBlock, wallets: wallets.size } });
    log.warn?.(`[indexer] reorg: rolled back to block ${forkBlock}`);
  }

  /** Finds the last stored block whose hash still matches the chain. */
  async function checkReorg(cursor) {
    const hashes = [...(cursor.recentHashes ?? [])].sort((a, b) => b.number - a.number);
    for (let i = 0; i < hashes.length; i++) {
      const onChain = await provider.getBlock(hashes[i].number);
      if (onChain?.hash === hashes[i].hash) {
        if (i === 0) return null;
        return hashes[i].number;
      }
    }
    // Nothing matches (for example a restarted local node): rebuild from the start block.
    return hashes.length ? startBlock - 1 : null;
  }

  async function removeLog(log) {
    for (const Model of MIRRORS) await Model.deleteMany({ txHash: log.transactionHash, logIndex: log.index });
  }

  async function processLogs(from, to) {
    const logs = [];
    for (const contract of sources) {
      const address = await contract.getAddress();
      for (const raw of await provider.getLogs({ address, fromBlock: from, toBlock: to })) logs.push({ raw, contract });
    }
    logs.sort((x, y) => x.raw.blockNumber - y.raw.blockNumber || x.raw.index - y.raw.index);
    for (const { raw, contract } of logs) {
      if (raw.removed) {
        await removeLog(raw);
        continue;
      }
      let parsed;
      try {
        parsed = contract.interface.parseLog(raw);
      } catch {
        parsed = null;
      }
      const handler = parsed && handlers[parsed.name];
      if (!handler) continue;
      const b = await block(raw.blockNumber);
      const ev = {
        txHash: raw.transactionHash,
        logIndex: raw.index,
        blockNumber: raw.blockNumber,
        blockHash: raw.blockHash,
        chainTs: b.timestamp,
      };
      try {
        await handler(parsed.args, ev);
      } catch (err) {
        log.warn?.(`[indexer] ${parsed.name} @${raw.blockNumber}: ${err.shortMessage || err.message}`);
      }
    }
  }

  /**
   * Day-0 and day-3 reminders while a default claim is unpaid, then the notice timeline.
   */
  async function escalate(chainNow) {
    const day = await spd();
    const open = await DefaultEvent.find({ $or: [{ reminder0At: null }, { reminder3At: null }] });
    for (const d of open) {
      const outstanding = await outstandingOf(d.wallet);
      if (outstanding === 0n) {
        await DefaultEvent.updateOne({ _id: d._id }, { reminder0At: d.reminder0At ?? new Date(0), reminder3At: d.reminder3At ?? new Date(0) });
        continue;
      }
      const user = await User.findOne({ wallet: d.wallet });
      const facts = `Loan #${d.loanId} is in default. The outstanding balance is ${fmt(outstanding)}.`;
      for (const [field, kind, days] of [
        ["reminder0At", "debt_reminder", 0],
        ["reminder3At", "debt_reminder_2", 3],
      ]) {
        if (d[field] || chainNow < d.chainTs + days * day) continue;
        if (user) await enqueueNotice({ userId: user._id, kind, facts, dedupeKey: `default-${d.loanId}-${kind}` });
        await DefaultEvent.updateOne({ _id: d._id }, { [field]: new Date() });
        await logAudit("reminder", kind === "debt_reminder" ? "reminder_day_0" : "reminder_day_3", {
          wallet: d.wallet,
          data: { loanId: d.loanId, inbox: Boolean(user) },
        });
      }
    }
    return processDueNotices({ chainNow, outstandingOf, sender });
  }

  /** One pass: reorg check, index new blocks, run the escalation timeline. */
  async function tick() {
    if (!ready()) return { skipped: "contracts not configured" };
    let cursor = (await Cursor.findById(CURSOR_ID)) ?? new Cursor({ _id: CURSOR_ID, lastBlock: startBlock - 1, recentHashes: [] });

    const fork = await checkReorg(cursor);
    if (fork !== null) {
      await rollback(fork);
      cursor.lastBlock = fork;
      cursor.recentHashes = cursor.recentHashes.filter((h) => h.number <= fork);
      blockCache.clear();
    }

    const head = await provider.getBlockNumber();
    let indexed = 0;
    for (let from = cursor.lastBlock + 1; from <= head; from += BATCH) {
      const to = Math.min(head, from + BATCH - 1);
      await processLogs(from, to);
      const tip = await block(to);
      cursor.lastBlock = to;
      cursor.recentHashes = [...cursor.recentHashes.filter((h) => h.number < to), { number: to, hash: tip.hash }].slice(-KEEP_HASHES);
      await cursor.save();
      indexed += to - from + 1;
    }
    const chainNow = (await provider.getBlock("latest")).timestamp;
    const notices = await escalate(chainNow);
    return { head, indexed, reorgedTo: fork, notices: notices.length };
  }

  return { tick, rollback, syncWalletFlags, outstandingOf };
}

/** Live counts for the admin page. */
export async function indexerStatus() {
  const cursor = await Cursor.findById(CURSOR_ID).lean();
  return {
    lastBlock: cursor?.lastBlock ?? null,
    proposals: await Proposal.countDocuments(),
    pendingNotices: await Notice.countDocuments({ status: { $in: ["pending", "disputed"] } }),
  };
}
