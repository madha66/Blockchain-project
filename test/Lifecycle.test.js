import { expect } from "chai";
import hre from "hardhat";
import {
  deployGigLend,
  register,
  openLoan,
  payOff,
  qualify,
  advanceTo,
  findEvent,
  findEvents,
  Kind,
  Stage,
  Option,
  LOOSE,
} from "./helpers/fixture.js";

const { ethers } = hre;
const E = (v) => ethers.parseEther(String(v));

describe("Lifecycle (Phase 4): stages, late fee, collect, restructure, shock mode", function () {
  let ctx, pool, lm, score, registry, router, alice, bob, keeper;

  beforeEach(async function () {
    ctx = await deployGigLend(LOOSE);
    ({ pool, loanManager: lm, score, registry, router } = ctx);
    [alice, bob, keeper] = ctx.users;
    await pool.connect(alice).deposit({ value: E(5) });
  });

  const atDay = async (loan, day) => advanceTo(loan.nextDueDate + BigInt(day) * ctx.spd);
  const fee = (installment) => {
    const flat = E(0.0005); // ₹50
    const cap = (installment * 1000n) / 10000n;
    return flat < cap ? flat : cap;
  };

  async function unsecuredLoan(amount = E(0.2), n = 4) {
    const memberId = await register(ctx, bob);
    await qualify(ctx, bob);
    await pool.connect(bob).deposit({ value: E(0.3) });
    const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount, n });
    return { memberId, loanId, loan: await lm.getLoan(loanId) };
  }

  describe("Stages are computed from timestamps (no keeper)", function () {
    it("moves Active → Grace → Onset → Significant → DefaultEligible on days 0/1–3/4–10/11–29/30", async function () {
      const memberId = await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.01) });
      const loan = await lm.getLoan(loanId);
      expect(await lm.stageOf(loanId)).to.equal(Stage.Active);
      const expectations = [
        [1, Stage.Grace],
        [3, Stage.Grace],
        [4, Stage.Onset],
        [10, Stage.Onset],
        [11, Stage.Significant],
        [29, Stage.Significant],
        [30, Stage.DefaultEligible],
      ];
      for (const [day, stage] of expectations) {
        await atDay(loan, day);
        expect(await lm.stageOf(loanId), `day ${day}`).to.equal(stage);
      }
      expect(memberId).to.be.greaterThan(0n);
    });

    it("loans over 3 months get 7 days of grace and a day-45 default", async function () {
      await register(ctx, bob, { payoutPeriodDays: 14 });
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.01), n: 7 }); // 98 days
      const loan = await lm.getLoan(loanId);
      await atDay(loan, 7);
      expect(await lm.stageOf(loanId)).to.equal(Stage.Grace);
      await atDay(loan, 44);
      expect(await lm.stageOf(loanId)).to.equal(Stage.Significant);
      await atDay(loan, 45);
      expect(await lm.stageOf(loanId)).to.equal(Stage.DefaultEligible);
    });
  });

  describe("Grace and late fee", function () {
    it("Grace: no fee, no late mark and no score drop; collection simply retries", async function () {
      const memberId = await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.01) });
      const loan = await lm.getLoan(loanId);
      const scoreBefore = await score.getScore(memberId);

      await atDay(loan, 3);
      await lm.accrueLate(loanId);
      expect((await lm.getLoan(loanId)).lateFeesDue).to.equal(0n);
      const due = await lm.amountDue(loanId);
      const receipt = await (await lm.connect(bob).repayInstallment(loanId, { value: due })).wait();
      expect(findEvents(receipt, lm, "LateFeeCharged")).to.have.length(0);
      expect(findEvent(receipt, lm, "InstallmentPaid").weightBps).to.equal(6000n); // late within grace
      expect((await score.stats(memberId)).lateMarks).to.equal(0n);
      expect(await score.getScore(memberId)).to.be.at.least(scoreBefore);
    });

    it("Onset: one flat capped fee per overdue installment, never compounding", async function () {
      const memberId = await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.02), n: 3 });
      const loan = await lm.getLoan(loanId);
      const expectedFee = fee(loan.installment);

      await atDay(loan, 4);
      await expect(lm.accrueLate(loanId)).to.emit(lm, "LateFeeCharged").withArgs(loanId, 1, expectedFee);
      await lm.accrueLate(loanId);
      await atDay(loan, 12);
      await lm.accrueLate(loanId);
      expect((await lm.getLoan(loanId)).lateFeesDue).to.equal(expectedFee);
      expect((await score.stats(memberId)).lateMarks).to.equal(1n);

      // Paying installment 1 at day 12 leaves installment 2 already 5 days late: one new fee.
      const due1 = await lm.amountDue(loanId);
      expect(due1).to.equal(expectedFee + loan.curInterestPortion + loan.curPrincipalPortion);
      const r = await (await lm.connect(bob).repayInstallment(loanId, { value: due1 })).wait();
      expect(findEvent(r, lm, "InstallmentPaid").weightBps).to.equal(2000n); // late
      await lm.accrueLate(loanId);
      const after = await lm.getLoan(loanId);
      expect(after.lateFeesDue).to.equal(expectedFee);
      expect(after.lateFeeChargedFor).to.equal(2);
    });

    it("emits InstallmentMissed once per installment", async function () {
      await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.01) });
      const loan = await lm.getLoan(loanId);
      await atDay(loan, 1);
      await expect(lm.accrueLate(loanId)).to.emit(lm, "InstallmentMissed").withArgs(loanId, 1, loan.nextDueDate);
      await expect(lm.accrueLate(loanId)).to.not.emit(lm, "InstallmentMissed");
      expect((await lm.getLoan(loanId)).firstMissedAt).to.equal(loan.nextDueDate);
    });
  });

  describe("collect() and the bounty", function () {
    it("reverts before Significant, so a bounty can never pull collection forward", async function () {
      const { loanId, loan } = await unsecuredLoan();
      await expect(lm.connect(keeper).collect(loanId)).to.be.revertedWith("Not in Significant stage");
      await atDay(loan, 10);
      await expect(lm.connect(keeper).collect(loanId)).to.be.revertedWith("Not in Significant stage");
    });

    it("in Significant applies locked stake to the missed installment and pays the caller 10% of the late fee", async function () {
      const { loanId, loan } = await unsecuredLoan();
      const expectedFee = fee(loan.installment);
      await atDay(loan, 11);

      const lockedBefore = await ctx.glp.lockedBalance(bob.address);
      const receipt = await (await lm.connect(keeper).collect(loanId)).wait();
      const applied = findEvent(receipt, lm, "StakeApplied");
      expect(applied.account).to.equal(bob.address);
      expect(applied.value).to.equal(expectedFee + loan.curInterestPortion + loan.curPrincipalPortion);
      expect(findEvent(receipt, lm, "BountyPaid").amount).to.equal((expectedFee * 1000n) / 10000n);
      expect(await ctx.glp.lockedBalance(bob.address)).to.equal(lockedBefore - applied.sharesBurned);

      const after = await lm.getLoan(loanId);
      expect(after.paidCount).to.equal(1n);
      expect(after.lateFeesDue).to.equal(0n);
    });

    it("reverts again once the stage reaches DefaultEligible (markDefault takes over)", async function () {
      const { loanId, loan } = await unsecuredLoan();
      await atDay(loan, 30);
      await expect(lm.connect(keeper).collect(loanId)).to.be.revertedWith("Not in Significant stage");
    });
  });

  describe("Restructuring", function () {
    it("payment holiday: skips one installment, freezes interest, adds a flat fee; a second restructure reverts", async function () {
      const memberId = await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.02), n: 3 });
      const before = await lm.getLoan(loanId);

      const receipt = await (await lm.connect(bob).requestRestructure(loanId, Option.PaymentHoliday)).wait();
      const ev = findEvent(receipt, lm, "RestructureGranted");
      expect(ev.option).to.equal(Option.PaymentHoliday);
      expect(ev.fee).to.equal(E(0.0002)); // ₹20

      const after = await lm.getLoan(loanId);
      expect(after.nextDueDate).to.equal(before.nextDueDate + 7n * ctx.spd);
      expect(after.interestRemaining).to.equal(before.interestRemaining);
      expect(after.outstandingPrincipal).to.equal(before.outstandingPrincipal);
      expect(after.askedForHelp).to.equal(true);
      expect((await registry.getMember(memberId)).restructuresLast12m).to.equal(1);

      await expect(lm.connect(bob).requestRestructure(loanId, Option.PaymentHoliday)).to.be.revertedWith(
        "Loan already restructured"
      );
    });

    it("is allowed before due or in Onset, not in Grace or later", async function () {
      await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.02), n: 3 });
      const loan = await lm.getLoan(loanId);
      await atDay(loan, 2);
      await expect(lm.connect(bob).requestRestructure(loanId, Option.PaymentHoliday)).to.be.revertedWith(
        "Restructure only before due or in Onset"
      );
      await atDay(loan, 5);
      await expect(lm.connect(bob).requestRestructure(loanId, Option.PaymentHoliday)).to.not.be.reverted;
    });

    it("asking early makes the installment count as late-within-grace (60%) and avoids the Onset fee", async function () {
      await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.02), n: 3 });
      await lm.connect(bob).requestRestructure(loanId, Option.PaymentHoliday);
      const loan = await lm.getLoan(loanId);
      await atDay(loan, 6);
      const due = await lm.amountDue(loanId);
      const r = await (await lm.connect(bob).repayInstallment(loanId, { value: due })).wait();
      expect(findEvent(r, lm, "InstallmentPaid").weightBps).to.equal(6000n);
      expect(findEvents(r, lm, "LateFeeCharged")).to.have.length(0);
    });

    it("allows at most two restructures per member in 12 months", async function () {
      await register(ctx, bob);
      for (let i = 0; i < 2; i++) {
        const { loanId } = await openLoan(ctx, bob, { amount: E(0.01) });
        await lm.connect(bob).requestRestructure(loanId, Option.PaymentHoliday);
        await payOff(ctx, bob, loanId);
      }
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.01) });
      await expect(lm.connect(bob).requestRestructure(loanId, Option.PaymentHoliday)).to.be.revertedWith(
        "Restructure limit reached"
      );
    });

    it("tenure stretch needs two low payouts, then re-amortises to the window maximum with the term premium", async function () {
      await register(ctx, bob, { incomeTierWei: E(100) });
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.02), n: 3 });
      await expect(lm.connect(bob).requestRestructure(loanId, Option.TenureStretch)).to.be.revertedWith(
        "Income has not dropped for 2 payouts"
      );

      // Expected weekly income 100 × 7 / 30 ≈ 23 ETH; two tiny payouts count as a drop.
      await router.connect(keeper).payout(bob.address, { value: E(0.01) });
      await router.connect(keeper).payout(bob.address, { value: E(0.01) });
      const before = await lm.getLoan(loanId);
      await lm.connect(bob).requestRestructure(loanId, Option.TenureStretch);
      const after = await lm.getLoan(loanId);
      expect(after.nInstallments).to.equal(12n);
      expect(after.rateBps).to.equal(before.rateBps + 200n);
      expect(after.installment).to.be.lessThan(before.installment);
      expect(after.outstandingPrincipal).to.equal(before.outstandingPrincipal);
    });
  });

  describe("Systemic-shock mode", function () {
    it("needs an attested event and a bounded window", async function () {
      await expect(
        registry.connect(ctx.admin).setShockMode(202643, 0, ethers.ZeroHash)
      ).to.be.revertedWith("Attested event required");
      const t = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      await expect(
        registry.connect(ctx.admin).setShockMode(202643, t + 61n * ctx.spd, ethers.id("outage"))
      ).to.be.revertedWith("Shock window too long");
      await expect(registry.connect(bob).setShockMode(202643, t + ctx.spd, ethers.id("outage"))).to.be.reverted;
    });

    it("extends grace and suspends late fees for the cohort, and never reduces principal", async function () {
      await register(ctx, bob, { cohortId: 202644 });
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.02), n: 3 });
      const loan = await lm.getLoan(loanId);
      const t = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      await expect(registry.connect(ctx.admin).setShockMode(202644, t + 30n * ctx.spd, ethers.id("city-flood-2026-10")))
        .to.emit(registry, "ShockModeSet");

      await atDay(loan, 8);
      expect(await lm.stageOf(loanId)).to.equal(Stage.Grace); // 3 + 7 extra days
      await lm.accrueLate(loanId);
      const during = await lm.getLoan(loanId);
      expect(during.lateFeesDue).to.equal(0n);
      expect(during.outstandingPrincipal).to.equal(loan.outstandingPrincipal);
      expect(during.interestRemaining).to.equal(loan.interestRemaining);
      expect(await lm.carriedOf(loanId)).to.equal(loan.outstandingPrincipal);

      const r = await (await lm.connect(bob).repayInstallment(loanId, { value: await lm.amountDue(loanId) })).wait();
      expect(findEvent(r, lm, "InstallmentPaid").weightBps).to.equal(10000n); // no score effect
    });
  });
});
