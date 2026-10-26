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
  findEvents,
  Kind,
  LOOSE,
  depositFor,
} from "./helpers/fixture.js";
import { paramKey } from "../scripts/config.js";

const { ethers } = hre;
const E = (v) => ethers.parseEther(String(v));
const ZERO = ethers.ZeroAddress;

describe("Prevention (Phase 3): checks before money leaves the pool", function () {
  let ctx, pool, lm, risk, registry, alice, bob, carol;

  async function setup(overrides = {}) {
    ctx = await deployGigLend(overrides);
    ({ pool, loanManager: lm, risk, registry } = ctx);
    [alice, bob, carol] = ctx.users;
    await depositFor(ctx, alice, E(5));
  }

  const open = (user, kind, amount, n = 2) => lm.connect(user).openLoan(kind, amount, n, ZERO, false);

  describe("Credit-builder first", function () {
    beforeEach(() => setup());

    it("a first loan must be Builder; Unsecured needs a completed Builder loan", async function () {
      await register(ctx, bob);
      await depositFor(ctx, bob, E(0.1));
      await expect(open(bob, Kind.Unsecured, E(0.005))).to.be.revertedWith("Complete a Builder loan first");
      await expect(open(bob, Kind.Builder, E(0.005))).to.not.be.reverted;
    });

    it("the first Unsecured loan also needs 90 days of stake and stays under the ₹1,000 cap", async function () {
      await register(ctx, bob);
      await depositFor(ctx, bob, E(0.1));
      await qualify(ctx, bob, E(0.005));
      await expect(open(bob, Kind.Unsecured, E(0.005))).to.be.revertedWith("Stake must be held for 90 days");

      await advanceDays(ctx, 90);
      await register(ctx, bob); // re-attest: the demo attestation would otherwise near expiry
      await expect(open(bob, Kind.Unsecured, E(0.011))).to.be.revertedWith("Above ladder limit");
      await expect(open(bob, Kind.Unsecured, E(0.01))).to.not.be.reverted; // ₹1,000 ≈ 0.01 ETH
    });

    it("Builder loans are capped at builderMaxWei (₹2,000)", async function () {
      await register(ctx, bob);
      await expect(open(bob, Kind.Builder, E(0.021))).to.be.revertedWith("Builder loan above cap");
    });
  });

  describe("Capped ladder and fast-climber hold", function () {
    it("next limit is at most 1.5× the largest completed Unsecured loan", async function () {
      await setup({ ...LOOSE, firstUnsecuredCapWei: E(0.1), ladderEarlySteps: 0 });
      await register(ctx, bob);
      await depositFor(ctx, bob, E(0.2));
      await qualify(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: E(0.1) });
      await payOff(ctx, bob, loanId);

      await expect(open(bob, Kind.Unsecured, E(0.151))).to.be.revertedWith("Above ladder limit");
      await expect(open(bob, Kind.Unsecured, E(0.15))).to.not.be.reverted;
    });

    it("early steps are smaller (1.25×) and each step is capped in absolute terms", async function () {
      await setup({ ...LOOSE, firstUnsecuredCapWei: E(0.1), ladderStepCapWei: E(0.02) });
      await register(ctx, bob);
      await depositFor(ctx, bob, E(0.2));
      await qualify(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: E(0.1) });
      await payOff(ctx, bob, loanId);
      // 1.25 × 0.1 = 0.125, but the step cap limits it to 0.1 + 0.02.
      expect((await risk.limits(await registry.memberOf(bob.address))).unsecuredCap).to.equal(E(0.12));
      await expect(open(bob, Kind.Unsecured, E(0.121))).to.be.revertedWith("Above ladder limit");
    });

    it("two limit steps within 60 days, then a larger request, holds the member at the current step", async function () {
      await setup({ ...LOOSE, firstUnsecuredCapWei: E(0.06), ladderEarlySteps: 0 });
      await register(ctx, bob);
      await depositFor(ctx, bob, E(0.3));
      await qualify(ctx, bob, E(0.05));

      for (const amount of [E(0.06), E(0.08)]) {
        const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount });
        await payOff(ctx, bob, loanId);
      }
      const memberId = await registry.memberOf(bob.address);
      expect((await risk.limits(memberId)).fastClimberHeld).to.equal(true);
      await expect(open(bob, Kind.Unsecured, E(0.1))).to.be.revertedWith("Fast climber: held at current step");
      await expect(open(bob, Kind.Unsecured, E(0.08))).to.not.be.reverted;
    });

    it("the hold lifts once the steps are older than the window", async function () {
      await setup({ ...LOOSE, firstUnsecuredCapWei: E(0.06), ladderEarlySteps: 0 });
      await register(ctx, bob);
      await depositFor(ctx, bob, E(0.3));
      await qualify(ctx, bob, E(0.05));
      for (const amount of [E(0.06), E(0.08)]) {
        const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount });
        await payOff(ctx, bob, loanId);
      }
      await advanceDays(ctx, 61);
      await register(ctx, bob);
      await expect(open(bob, Kind.Unsecured, E(0.1))).to.not.be.reverted;
    });
  });

  describe("Total debt burden (35% of attested income, counting declared EMIs)", function () {
    beforeEach(() => setup());

    it("reverts when the monthly installment plus declared debts exceed 35% of income", async function () {
      // Income 0.3 ETH/month → 35% = 0.105; declared EMIs 0.1 leave 0.005/month.
      await register(ctx, bob, { incomeTierWei: E(0.3), declaredDebtWei: E(0.1) });
      await expect(open(bob, Kind.Builder, E(0.02))).to.be.revertedWith("Installment exceeds 35% debt burden");

      await register(ctx, carol, { incomeTierWei: E(0.3), declaredDebtWei: 0n });
      await expect(open(carol, Kind.Builder, E(0.02))).to.not.be.reverted;
    });

    it("misdeclared debt (admin flag) lowers the score and the limit", async function () {
      await register(ctx, bob);
      const memberId = await registry.memberOf(bob.address);
      const scoreBefore = await ctx.score.getScore(memberId);
      const capBefore = (await risk.limits(memberId)).builderCap;

      await registry.connect(ctx.admin).flagMisdeclaredDebt(memberId, true);
      expect(await ctx.score.getScore(memberId)).to.equal(scoreBefore - 40n);
      expect((await risk.limits(memberId)).builderCap).to.equal(capBefore / 2n);
      await expect(open(bob, Kind.Builder, E(0.015))).to.be.revertedWith("Builder loan above cap");
    });
  });

  describe("Cohort and concentration screens", function () {
    it("per-loan cap: a loan may not exceed 2% of the pool", async function () {
      await setup({ builderMaxWei: E(1) });
      await register(ctx, bob);
      await expect(open(bob, Kind.Builder, E(0.11))).to.be.revertedWith("Above per-loan cap (2% of pool)");
      await expect(open(bob, Kind.Builder, E(0.1))).to.not.be.reverted;
    });

    it("cluster cap: linked wallets share a 5% exposure limit", async function () {
      await setup({ ...LOOSE, clusterCapBps: 500 });
      const cluster = ethers.id("shared-device-and-phone-prefix");
      await register(ctx, bob, { clusterId: cluster });
      await register(ctx, carol, { clusterId: cluster });
      await openLoan(ctx, bob, { amount: E(0.2) });
      await expect(open(carol, Kind.Builder, E(0.06))).to.be.revertedWith("Cluster exposure cap reached");
      await expect(open(carol, Kind.Builder, E(0.05))).to.not.be.reverted;
    });

    it("weekly growth cap: originations in a week stay under ~10% of the pool", async function () {
      await setup({ ...LOOSE, weeklyGrowthCapBps: 1000 });
      await register(ctx, bob);
      await register(ctx, carol);
      await openLoan(ctx, bob, { amount: E(0.4) });
      await expect(open(carol, Kind.Builder, E(0.11))).to.be.revertedWith("Weekly growth cap reached");
      await advanceDays(ctx, 7);
      await expect(open(carol, Kind.Builder, E(0.11))).to.not.be.reverted;
    });

    it("cohort pause: first loans stop when the cohort's first-payment-default rate crosses the threshold", async function () {
      await setup({ cohortMinSample: 1 });
      await register(ctx, bob, { cohortId: 202650 });
      const { loanId } = await openLoan(ctx, bob, { amount: E(0.01) });
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 31n * ctx.spd);
      await lm.markDefault(loanId);
      expect(await registry.cohortFirstPaymentDefaults(202650)).to.equal(1);

      await register(ctx, carol, { cohortId: 202650 });
      await expect(open(carol, Kind.Builder, E(0.01))).to.be.revertedWith("Cohort paused: first-payment defaults");

      // Other cohorts are unaffected; an admin pause works the same way.
      const [, , , dave] = ctx.users;
      await register(ctx, dave, { cohortId: 202651 });
      await registry.connect(ctx.admin).setCohortPaused(202651, true);
      await expect(open(dave, Kind.Builder, E(0.01))).to.be.revertedWith("Cohort paused: first-payment defaults");
    });
  });

  describe("Eligibility", function () {
    beforeEach(() => setup());

    // Changed for the IAM layer: lending used to be open to any wallet; deposits now need a
    // verified identity too.
    it("unregistered wallets can neither borrow nor deposit", async function () {
      await expect(open(bob, Kind.Builder, E(0.01))).to.be.revertedWith("Not registered");
      await expect(pool.connect(bob).deposit({ value: E(0.01) })).to.be.revertedWith("Identity not verified");
      await register(ctx, bob);
      await expect(pool.connect(bob).deposit({ value: E(0.01) })).to.not.be.reverted;
    });

    it("one open loan per member", async function () {
      await register(ctx, bob);
      await openLoan(ctx, bob, { amount: E(0.01) });
      await expect(open(bob, Kind.Builder, E(0.01))).to.be.revertedWith("Existing loan must be repaid");
    });
  });

  describe("Credit score on 300–900, keyed by member", function () {
    beforeEach(() => setup());

    it("starts at the base, rewards on-time installments and completed loans, and emits ScoreChanged", async function () {
      await register(ctx, bob);
      const memberId = await registry.memberOf(bob.address);
      expect(await ctx.score.getScore(memberId)).to.equal(550n);

      const { loanId } = await openLoan(ctx, bob, { amount: E(0.01), n: 2 });
      const receipt = await payOff(ctx, bob, loanId);
      const changes = findEvents(receipt, ctx.score, "ScoreChanged");
      expect(changes.map((c) => ethers.decodeBytes32String(c.reasonCode))).to.deep.equal([
        "INSTALLMENT_PAID",
        "INSTALLMENT_PAID",
        "LOAN_COMPLETED",
      ]);
      // 550 + 2 × 4 (on time, 100%) + 15
      expect(await ctx.score.getScore(memberId)).to.equal(573n);
      expect((await registry.getMember(memberId)).tier).to.equal(1); // Builder
    });

    it("stake age adds up to 30 points over a year", async function () {
      await register(ctx, bob);
      const memberId = await registry.memberOf(bob.address);
      await depositFor(ctx, bob, E(0.01));
      await advanceDays(ctx, 365);
      expect(await ctx.score.stakeAgePoints(memberId)).to.equal(30n);
    });

    it("parameters are bounded and changes are logged", async function () {
      await expect(ctx.config.setParam(paramKey("burdenBps"), 5001)).to.be.revertedWith("Value out of bounds");
      await expect(ctx.config.setParam(paramKey("burdenBps"), 4000))
        .to.emit(ctx.config, "ParameterUpdated")
        .withArgs(paramKey("burdenBps"), 3500, 4000);
    });
  });
});
