import { expect } from "chai";
import hre from "hardhat";
import {
  deployGigLend,
  register,
  openLoan,
  payOff,
  qualify,
  advanceDays,
  advanceTo,
  findEvent,
  gasCost,
  now,
  idHashOf,
  signAttestation,
  Kind,
  DType,
  Option,
  LOOSE,
} from "./helpers/fixture.js";

const { ethers } = hre;
const E = (v) => ethers.parseEther(String(v));
const MAX_U64 = 2n ** 64n - 1n;

describe("Default and recovery (Phase 5)", function () {
  let ctx, pool, glp, lm, dm, registry, score, router, reserve, alice, bob, carol, keeper, newWallet;

  beforeEach(async function () {
    ctx = await deployGigLend(LOOSE);
    ({ pool, glp, loanManager: lm, defaultManager: dm, registry, score, router, reserve } = ctx);
    [alice, bob, carol, keeper, newWallet] = ctx.users;
    await pool.connect(alice).deposit({ value: E(10) });
  });

  const toDefaultDay = async (loanId) => {
    const loan = await lm.getLoan(loanId);
    await advanceTo(loan.nextDueDate + 31n * ctx.spd);
  };

  /** A seasoned member (one completed Builder loan, stake older than 30 days) with an Unsecured loan. */
  async function seasonedUnsecured(user, { amount = E(0.2), stake = E(0.15), fields = {} } = {}) {
    const memberId = await register(ctx, user, fields);
    await pool.connect(user).deposit({ value: stake });
    await qualify(ctx, user);
    const { loanId } = await openLoan(ctx, user, { kind: Kind.Unsecured, amount });
    return { memberId, loanId };
  }

  async function markDefault(loanId, caller = keeper) {
    const receipt = await (await lm.connect(caller).markDefault(loanId)).wait();
    return { receipt, ev: findEvent(receipt, dm, "LoanDefaulted"), cls: findEvent(receipt, dm, "Classified") };
  }

  describe("Attack economics", function () {
    it("dust-stake borrow-and-vanish leaves the attacker with no profit", async function () {
      const startBalance = await ethers.provider.getBalance(carol.address);
      await register(ctx, carol);
      await pool.connect(carol).deposit({ value: 1000n }); // dust stake

      // Without the 50% cover (and a completed Builder loan) there is no Unsecured loan.
      await expect(
        lm.connect(carol).openLoan(Kind.Unsecured, E(0.2), 2, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Complete a Builder loan first");

      // The only loan available is an escrowed Builder loan: none of it reaches the attacker.
      const { loanId } = await openLoan(ctx, carol, { kind: Kind.Builder, amount: E(0.5) });
      await toDefaultDay(loanId);
      const { ev } = await markDefault(loanId);
      expect(ev.lenderLoss).to.equal(0n);
      expect(await ethers.provider.getBalance(carol.address)).to.be.lessThan(startBalance);
    });

    it("an Unsecured loan without enough stake cover is refused even after a Builder loan", async function () {
      await register(ctx, carol);
      await qualify(ctx, carol);
      await pool.connect(carol).deposit({ value: 1000n });
      await expect(
        lm.connect(carol).openLoan(Kind.Unsecured, E(0.2), 2, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Insufficient stake cover");
    });
  });

  describe("Classification: one fixture per type", function () {
    it("Hardship: seasoned member, no income since the miss", async function () {
      const { loanId } = await seasonedUnsecured(bob);
      await toDefaultDay(loanId);
      const { ev, cls } = await markDefault(loanId);
      expect(ev.defaultType).to.equal(DType.Hardship);
      expect(cls.fraudFlags).to.equal(0);
      expect(cls.incomeKeptFlowing).to.equal(false);
    });

    it("Strategic: payouts kept arriving after the miss and no help was asked for", async function () {
      const { loanId } = await seasonedUnsecured(bob);
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 2n * ctx.spd);
      await router.connect(keeper).payout(bob.address, { value: loan.installment * 2n });
      await toDefaultDay(loanId);
      const { ev, cls } = await markDefault(loanId);
      expect(cls.incomeKeptFlowing).to.equal(true);
      expect(ev.defaultType).to.equal(DType.Strategic);
    });

    it("Hardship, not Strategic, when the borrower asked for help early", async function () {
      const { loanId } = await seasonedUnsecured(bob);
      await lm.connect(bob).requestRestructure(loanId, Option.PaymentHoliday);
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 2n * ctx.spd);
      await router.connect(keeper).payout(bob.address, { value: loan.installment * 2n });
      await toDefaultDay(loanId);
      expect((await markDefault(loanId)).ev.defaultType).to.equal(DType.Hardship);
    });

    it("Fraud: first-payment default with a new, thin stake; cluster flagged, member barred", async function () {
      const memberId = await register(ctx, carol);
      const { loanId } = await openLoan(ctx, carol, { amount: E(0.02) });
      await toDefaultDay(loanId);
      const { ev, cls } = await markDefault(loanId);
      expect(ev.defaultType).to.equal(DType.Fraud);
      expect(cls.fraudFlags).to.be.at.least(2);

      const m = await registry.getMember(memberId);
      expect(m.permanentlyBarred).to.equal(true);
      expect(await registry.clusterFlagged(m.clusterId)).to.equal(true);
      const [ok, reason] = await registry.eligibility(carol.address);
      expect(ok).to.equal(false);
      expect(reason).to.equal("Permanently barred");
    });

    it("the rule is public: previewClassification matches what markDefault logs", async function () {
      const { loanId } = await seasonedUnsecured(bob);
      await toDefaultDay(loanId);
      const [preview] = await dm.previewClassification(loanId);
      expect((await markDefault(loanId)).ev.defaultType).to.equal(preview);
    });
  });

  describe("Appeal", function () {
    it("an appeal within 21 days lets DISPUTE_ROLE reclassify (Fraud → Hardship lifts the bar)", async function () {
      const memberId = await register(ctx, carol);
      const { loanId } = await openLoan(ctx, carol, { amount: E(0.02) });
      await toDefaultDay(loanId);
      await markDefault(loanId);
      const scarBefore = await score.totalScar(memberId);

      await expect(dm.connect(bob).appeal(loanId)).to.be.revertedWith("Not your loan");
      await expect(dm.connect(carol).appeal(loanId)).to.emit(dm, "Appealed");
      await expect(dm.connect(carol).appeal(loanId)).to.be.revertedWith("Appeal already open");
      await expect(dm.connect(keeper).reclassify(loanId, DType.Hardship)).to.be.reverted;

      await expect(dm.connect(ctx.admin).reclassify(loanId, DType.Hardship))
        .to.emit(dm, "Reclassified")
        .withArgs(loanId, DType.Fraud, DType.Hardship);
      expect((await lm.getLoan(loanId)).dtype).to.equal(DType.Hardship);
      expect((await registry.getMember(memberId)).permanentlyBarred).to.equal(false);
      expect(await score.totalScar(memberId)).to.be.lessThan(scarBefore);
    });

    it("the appeal window closes after 21 days", async function () {
      const { loanId } = await seasonedUnsecured(bob);
      await toDefaultDay(loanId);
      await markDefault(loanId);
      await advanceDays(ctx, 22);
      await expect(dm.connect(bob).appeal(loanId)).to.be.revertedWith("Appeal window closed");
    });
  });

  describe("Waterfall", function () {
    it("takes borrower stake, then guarantor stake, then the reserve, then lenders", async function () {
      const memberId = await register(ctx, bob);
      await pool.connect(bob).deposit({ value: E(0.05) });
      await qualify(ctx, bob);
      await pool.connect(carol).deposit({ value: E(0.06) });
      await lm.connect(carol).offerGuarantee(bob.address, await glp.balanceOf(carol.address));
      await reserve.fund({ value: E(0.02) });

      const P = E(0.2);
      const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: P, guarantor: carol.address });
      await toDefaultDay(loanId);
      const [principal, interest, fees] = await dm.defaultDebt(loanId);
      const { ev } = await markDefault(loanId);

      expect(ev.stakeUsed).to.be.closeTo(E(0.05), E(0.001));
      expect(ev.guarantorUsed).to.be.closeTo(E(0.06), E(0.001));
      expect(await glp.balanceOf(bob.address)).to.equal(0n);
      expect(await glp.balanceOf(carol.address)).to.equal(0n);
      // Stake goes to principal first; the reserve covers the rest of the principal it can.
      const principalLeft = principal - ev.stakeUsed - ev.guarantorUsed;
      expect(ev.reserveUsed).to.equal(principalLeft < E(0.02) ? principalLeft : (await reserve.totalCovered()));
      expect(ev.lenderLoss).to.equal(principalLeft - ev.reserveUsed);
      expect(await dm.claimOf(memberId)).to.equal(principal + interest + fees - ev.stakeUsed - ev.guarantorUsed);
    });

    it("pays the markDefault caller a bounty of 10% of the late fee", async function () {
      await reserve.fund({ value: E(0.01) });
      const { loanId } = await seasonedUnsecured(bob);
      await toDefaultDay(loanId);
      const [, , fees] = await dm.defaultDebt(loanId);
      const { receipt } = await markDefault(loanId, keeper);
      expect(findEvent(receipt, dm, "BountyPaid").amount).to.equal((fees * 1000n) / 10000n);
    });

    it("withdrawals priced while a loan is Significant get the provisioned (lower) share price", async function () {
      const { loanId } = await seasonedUnsecured(bob);
      const loan = await lm.getLoan(loanId);
      const priceBefore = await pool.valueOfShares(E(1));
      await advanceTo(loan.nextDueDate + 12n * ctx.spd);
      const priceSignificant = await pool.valueOfShares(E(1));
      expect(priceSignificant).to.be.lessThan(priceBefore);
    });
  });

  describe("Residual claim, settlement, cooling-off", function () {
    async function hardshipDefault(user = bob) {
      const { memberId, loanId } = await seasonedUnsecured(user, { amount: E(0.04), stake: E(0.02) });
      await toDefaultDay(loanId);
      await markDefault(loanId);
      return { memberId, loanId };
    }

    it("full settlement sets coolingOffUntil, and borrowing reverts until it passes", async function () {
      const { memberId } = await hardshipDefault();
      expect((await registry.getMember(memberId)).coolingOffUntil).to.equal(MAX_U64);

      const quote = await dm.settlementQuote(memberId);
      await dm.connect(bob).settleClaim({ value: quote });
      const until = (await registry.getMember(memberId)).coolingOffUntil;
      expect(until).to.equal((await now()) + 30n * ctx.spd);

      await expect(
        lm.connect(bob).openLoan(Kind.Builder, E(0.01), 2, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Cooling-off active");

      await advanceTo(until);
      await register(ctx, bob); // fresh attestation
      // Re-entry is always through a Builder loan.
      await expect(
        lm.connect(bob).openLoan(Kind.Unsecured, E(0.01), 2, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Re-entry after default starts with a Builder loan");
      await expect(lm.connect(bob).openLoan(Kind.Builder, E(0.01), 2, ethers.ZeroAddress, false)).to.not.be.reverted;
    });

    it("settlement discounts follow the type: Hardship 25%, Strategic 5%, Fraud 0%", async function () {
      expect(await dm.discountBps(DType.Hardship)).to.equal(2500n);
      expect(await dm.discountBps(DType.Strategic)).to.equal(500n);
      expect(await dm.discountBps(DType.Fraud)).to.equal(0n);
    });

    it("a Strategic default cools off for 12 months after settlement", async function () {
      const { memberId, loanId } = await seasonedUnsecured(bob, { amount: E(0.04), stake: E(0.02) });
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 2n * ctx.spd);
      await router.connect(keeper).payout(bob.address, { value: loan.installment * 2n });
      await toDefaultDay(loanId);
      await markDefault(loanId);
      await dm.connect(bob).settleClaim({ value: await dm.settlementQuote(memberId) });
      expect((await registry.getMember(memberId)).coolingOffUntil).to.equal((await now()) + 365n * ctx.spd);
    });

    it("residual sweep: 50% of a defaulter's later deposit goes to the claim, reserve first", async function () {
      const { memberId } = await hardshipDefault();
      const claimBefore = await dm.claimOf(memberId);
      const deposit = E(0.02);
      const receipt = await (await pool.connect(bob).deposit({ value: deposit })).wait();
      const swept = findEvent(receipt, pool, "ResidualSwept");
      expect(swept.amount).to.equal(deposit / 2n);
      expect(findEvent(receipt, pool, "Deposited").amount).to.equal(deposit / 2n);
      expect(await dm.claimOf(memberId)).to.equal(claimBefore - deposit / 2n);
    });

    it("residual sweep also takes 50% of routed payouts", async function () {
      const { memberId } = await hardshipDefault();
      const claimBefore = await dm.claimOf(memberId);
      const r = await (await router.connect(keeper).payout(bob.address, { value: E(0.01) })).wait();
      expect(findEvent(r, router, "PayoutRouted").sweptToClaim).to.equal(E(0.005));
      expect(await dm.claimOf(memberId)).to.equal(claimBefore - E(0.005));
    });

    it("hardship workout: capped installments, no interest, ≤ 6 months; completing it earns back part of the scar", async function () {
      const { memberId, loanId } = await hardshipDefault();
      const claim = await dm.claimOf(memberId);
      await expect(dm.connect(bob).startWorkout(loanId)).to.emit(dm, "WorkoutStarted");
      const c = await dm.claims(memberId);
      expect(c.workoutPeriods).to.equal(25); // 180 days / 7
      expect(c.workoutInstallment).to.equal((claim + 24n) / 25n);
      expect(c.workoutEndsAt - (await now())).to.be.at.most(180n * ctx.spd);

      const scarBefore = await score.totalScar(memberId);
      await expect(dm.connect(bob).payWorkout({ value: claim })).to.emit(dm, "WorkoutCompleted");
      expect(await dm.claimOf(memberId)).to.equal(0n);
      expect(await score.totalScar(memberId)).to.be.lessThan(scarBefore);
      expect((await registry.getMember(memberId)).coolingOffUntil).to.equal((await now()) + 30n * ctx.spd);
    });

    it("workouts are for Hardship defaults only", async function () {
      const { memberId, loanId } = await seasonedUnsecured(bob, { amount: E(0.04), stake: E(0.02) });
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 2n * ctx.spd);
      await router.connect(keeper).payout(bob.address, { value: loan.installment * 2n });
      await toDefaultDay(loanId);
      await markDefault(loanId);
      expect((await dm.claims(memberId)).dtype).to.equal(DType.Strategic);
      await expect(dm.connect(bob).startWorkout(loanId)).to.be.revertedWith("Workout is for hardship defaults");
    });
  });

  describe("Reputation follows the person, not the wallet", function () {
    it("a new wallet tied to the same attested identity inherits the default record", async function () {
      const idHash = idHashOf("ABCDE1234F");
      const { memberId, loanId } = await seasonedUnsecured(bob, { amount: E(0.04), stake: E(0.02), fields: { idHash } });
      await toDefaultDay(loanId);
      await markDefault(loanId);
      const scoreAfterDefault = await score.getScore(memberId);
      const claim = await dm.claimOf(memberId);

      await registry.connect(bob).unlinkWallet();
      const { attestation, signature } = await signAttestation(registry, ctx.attester, {
        wallet: newWallet.address,
        idHash: idHashOf("abcde1234f"),
        incomeTierWei: E(100),
      });
      await registry.connect(newWallet).register(attestation, signature);

      expect(await registry.memberOf(newWallet.address)).to.equal(memberId);
      expect(await dm.claimOf(memberId)).to.equal(claim);
      expect(await score.scoreOfWallet(newWallet.address)).to.equal(scoreAfterDefault);
      expect((await registry.getMember(memberId)).defaultCount).to.equal(1);
      await expect(
        lm.connect(newWallet).openLoan(Kind.Builder, E(0.01), 2, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Cooling-off active");
    });

    it("cannot unlink a wallet while a loan is open", async function () {
      await register(ctx, bob);
      await openLoan(ctx, bob, { amount: E(0.01) });
      await expect(registry.connect(bob).unlinkWallet()).to.be.revertedWith("Cannot unlink with an open loan");
    });

    it("a second default ends unsecured borrowing (Builder only)", async function () {
      const { memberId, loanId } = await seasonedUnsecured(bob, { amount: E(0.04), stake: E(0.02) });
      await toDefaultDay(loanId);
      await markDefault(loanId);
      await dm.connect(bob).settleClaim({ value: await dm.settlementQuote(memberId) });
      await advanceDays(ctx, 31);
      await register(ctx, bob);
      const { loanId: second } = await openLoan(ctx, bob, { amount: E(0.01) });
      await toDefaultDay(second);
      await markDefault(second);

      expect((await registry.getMember(memberId)).defaultCount).to.equal(2);
      const limits = await ctx.risk.limits(memberId);
      expect(limits.unsecuredAllowed).to.equal(false);
      expect(limits.unsecuredHold).to.equal("Unsecured borrowing ended after a second default");
    });
  });

  describe("Scar", function () {
    it("is ~90 points, fades linearly over two years to exactly the 30% floor, and never below", async function () {
      const size = 90n;
      const t0 = await now();
      expect(await score.scarStrength(size, t0)).to.equal(size);
      await advanceDays(ctx, 365);
      const half = await score.scarStrength(size, t0);
      expect(half).to.be.closeTo(60n, 1n); // 90 − (63 × ½)
      await advanceDays(ctx, 365);
      expect(await score.scarStrength(size, t0)).to.equal(27n); // 30% of 90
      await advanceDays(ctx, 2000);
      expect(await score.scarStrength(size, t0)).to.equal(27n);
    });

    it("a Hardship scar is smaller than a Strategic one, and settlement shrinks it but never removes it", async function () {
      const { memberId, loanId } = await seasonedUnsecured(bob, { amount: E(0.04), stake: E(0.02) });
      await toDefaultDay(loanId);
      await markDefault(loanId);
      const scars = await score.scarsOf(memberId);
      expect(scars[0].size).to.equal(60n); // Hardship
      await dm.connect(bob).settleClaim({ value: await dm.settlementQuote(memberId) });
      const after = await score.scarsOf(memberId);
      expect(after[0].size).to.equal(42n); // 70% kept
      expect(after[0].size).to.be.greaterThan(0n);
    });
  });
});
