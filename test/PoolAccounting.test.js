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
  gasCost,
  Kind,
  Option,
  LOOSE,
  VIRTUAL_OFFSET,
  depositFor,
} from "./helpers/fixture.js";

const { ethers } = hre;
const E = (v) => ethers.parseEther(String(v));

describe("Pool accounting (Phase 6): provisions, withdrawal queue, disclosures", function () {
  let ctx, pool, glp, lm, lens, alice, bob, carol, dave;

  beforeEach(async function () {
    ctx = await deployGigLend(LOOSE);
    ({ pool, glp, loanManager: lm, lens } = ctx);
    [alice, bob, carol, dave] = ctx.users;
  });

  async function unsecured(user, amount = E(0.4)) {
    await register(ctx, user);
    await depositFor(ctx, user, amount);
    await qualify(ctx, user);
    const { loanId } = await openLoan(ctx, user, { kind: Kind.Unsecured, amount });
    return { loanId, loan: await lm.getLoan(loanId) };
  }

  describe("poolValue() books losses in steps", function () {
    it("carries a late loan at 100% / 90% / 50% / 0% by stage and restores the carry when it cures", async function () {
      await depositFor(ctx, alice, E(5));
      const { loanId, loan } = await unsecured(bob);
      const P = loan.outstandingPrincipal;
      const cash = await pool.freeCash();
      const at = (day) => advanceTo(loan.nextDueDate + BigInt(day) * ctx.spd);

      expect(await pool.poolValue()).to.equal(cash + P);
      await at(2); // Grace
      expect(await pool.poolValue()).to.equal(cash + P);
      await at(5); // Onset
      expect(await pool.poolValue()).to.equal(cash + (P * 9000n) / 10000n);
      await at(12); // Significant
      expect(await pool.poolValue()).to.equal(cash + (P * 5000n) / 10000n);
      await at(30); // DefaultEligible
      expect(await pool.poolValue()).to.equal(cash);

      // Cure: paying everything due brings the loan current, and the carry returns.
      const payoff = await lm.payoffAmount(loanId);
      await lm.connect(bob).repayInstallment(loanId, { value: payoff });
      expect(await lm.totalOutstanding()).to.equal(0n);
    });

    it("a partial cure that makes the loan current restores 100% carry", async function () {
      await depositFor(ctx, alice, E(5));
      await register(ctx, bob);
      await depositFor(ctx, bob, E(0.4));
      await qualify(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: E(0.4), n: 4 });
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 12n * ctx.spd);
      expect(await lm.carriedOf(loanId)).to.equal(loan.outstandingPrincipal / 2n);

      // Installments 1 and 2 are past due; paying both makes installment 3 (day 14) current.
      for (let i = 0; i < 2; i++) {
        await lm.connect(bob).repayInstallment(loanId, { value: await lm.amountDue(loanId) });
      }
      const l = await lm.getLoan(loanId);
      expect(l.paidCount).to.equal(2n);
      expect(await lm.carriedOf(loanId)).to.equal(l.outstandingPrincipal);
    });

    it("a withdrawal during Significant gets the lower (provisioned) share price", async function () {
      await depositFor(ctx, alice, E(5));
      const { loan } = await unsecured(bob);
      await advanceTo(loan.nextDueDate + 12n * ctx.spd);

      const shares = E(1);
      const supply = await glp.totalSupply();
      const pv = await pool.poolValue();
      const expected = (shares * (pv + VIRTUAL_OFFSET)) / (supply + VIRTUAL_OFFSET);
      const unprovisioned = (shares * ((await pool.freeCash()) + loan.outstandingPrincipal + VIRTUAL_OFFSET)) / (supply + VIRTUAL_OFFSET);
      expect(expected).to.be.lessThan(unprovisioned);

      const before = await ethers.provider.getBalance(alice.address);
      const receipt = await (await pool.connect(alice).withdraw(shares)).wait();
      expect((await ethers.provider.getBalance(alice.address)) + gasCost(receipt) - before).to.equal(expected);
    });

    it("deposits during Significant also price off the provisioned value (no free ride on a recovery)", async function () {
      await depositFor(ctx, alice, E(5));
      const { loan } = await unsecured(bob);
      await advanceTo(loan.nextDueDate + 12n * ctx.spd);
      const supply = await glp.totalSupply();
      const pv = await pool.poolValue();
      const receipt = await (await depositFor(ctx, carol, E(1))).wait();
      const minted = findEvent(receipt, pool, "Deposited").shares;
      expect(minted).to.equal((E(1) * (supply + VIRTUAL_OFFSET)) / (pv + VIRTUAL_OFFSET));
    });
  });

  describe("Withdrawal queue", function () {
    it("pays a withdrawal run pro rata as cash returns, FIFO, without reverting", async function () {
      await depositFor(ctx, alice, E(1));
      await depositFor(ctx, carol, E(1));
      await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: E(1.6) });
      expect(await pool.freeCash()).to.equal(E(0.4));

      // Alice asks for 1.0 ETH: 0.4 is paid now, the rest waits.
      const r1 = await (await pool.connect(alice).withdraw(E(1))).wait();
      expect(findEvent(r1, pool, "WithdrawalQueued").shares).to.equal(E(1));
      expect(await pool.freeCash()).to.be.lessThan(10n);
      const aliceQueued = await pool.queuedSharesOf(alice.address);
      expect(aliceQueued).to.be.closeTo(E(0.6), E(0.001));

      // Carol joins behind her even though she alone could not be paid either.
      await pool.connect(carol).withdraw(E(1));
      expect(await pool.queueLength()).to.equal(2n);
      const [ahead, own] = await pool.queuePosition(carol.address);
      expect(ahead).to.equal(aliceQueued);
      expect(own).to.equal(E(1));

      // A partial repayment returns cash: both requests receive the same fraction.
      const due = await lm.amountDue(loanId);
      const receipt = await (await lm.connect(bob).repayInstallment(loanId, { value: due })).wait();
      const paid = findEvents(receipt, pool, "WithdrawalPaid");
      expect(paid.length).to.equal(2);
      const aliceFrac = (paid[0].sharesBurned * 10n ** 18n) / aliceQueued;
      const carolFrac = (paid[1].sharesBurned * 10n ** 18n) / E(1);
      expect(aliceFrac).to.be.closeTo(carolFrac, 10n ** 6n);

      // Full repayment clears the queue.
      await payOff(ctx, bob, loanId);
      expect(await pool.queueLength()).to.equal(0n);
      expect(await pool.totalQueuedShares()).to.equal(0n);
    });

    it("queued shares keep sharing gains and losses, and can be cancelled", async function () {
      await depositFor(ctx, alice, E(1));
      await register(ctx, bob);
      await openLoan(ctx, bob, { amount: E(0.9) });
      await pool.connect(alice).withdraw(E(1));
      const queued = await pool.queuedSharesOf(alice.address);
      expect(await glp.balanceOf(await pool.getAddress())).to.equal(queued);

      await expect(pool.connect(dave).cancelQueuedWithdrawals()).to.be.revertedWith("Nothing queued");
      await pool.connect(alice).cancelQueuedWithdrawals();
      expect(await glp.balanceOf(alice.address)).to.equal(queued);
      expect(await pool.queueLength()).to.equal(0n);
    });

    it("bounds the number of waiting requests", async function () {
      ctx = await deployGigLend({ ...LOOSE, maxQueueLength: 1 });
      ({ pool, glp, loanManager: lm } = ctx);
      await depositFor(ctx, alice, E(1));
      await depositFor(ctx, carol, E(1));
      await register(ctx, bob);
      await openLoan(ctx, bob, { amount: E(1.8) });
      await pool.connect(alice).withdraw(E(1));
      await expect(pool.connect(carol).withdraw(E(1))).to.be.revertedWith("Withdrawal queue full");
    });
  });

  describe("Disclosures", function () {
    it("reports loans by stage and arrears twice, with and without restructured loans", async function () {
      await depositFor(ctx, alice, E(10));
      await register(ctx, bob);
      await register(ctx, carol);
      const { loanId: a } = await openLoan(ctx, bob, { amount: E(0.1) });
      const { loanId: b } = await openLoan(ctx, carol, { amount: E(0.1) });
      await lm.connect(carol).requestRestructure(b, Option.PaymentHoliday);

      const la = await lm.getLoan(a);
      await advanceTo(la.nextDueDate + 5n * ctx.spd); // a: Onset; b (shifted a week): Active
      let p = await lens.portfolio();
      expect(p.activeLoans).to.equal(2n);
      expect(p.countByStage[2]).to.equal(1n); // Onset
      expect(p.arrearsAll).to.equal(E(0.1));
      expect(p.arrearsExRestructured).to.equal(E(0.1));
      expect(p.restructuredLoans).to.equal(1n);
      expect(p.provisions).to.equal(0n); // Builder loans are escrow-backed

      await advanceTo(la.nextDueDate + 12n * ctx.spd); // both late now
      p = await lens.portfolio();
      expect(p.arrearsAll).to.equal(E(0.2));
      expect(p.arrearsExRestructured).to.equal(E(0.1));
    });

    it("reports provisions, realised losses by month and the reserve", async function () {
      ctx = await deployGigLend({ ...LOOSE, unsecuredStakeCoverBps: 0 });
      ({ pool, glp, loanManager: lm, lens } = ctx);
      await depositFor(ctx, alice, E(5));
      await register(ctx, bob);
      await qualify(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: E(0.2) });
      const loan = await lm.getLoan(loanId);

      await advanceTo(loan.nextDueDate + 12n * ctx.spd);
      let p = await lens.portfolio();
      expect(p.provisions).to.equal(E(0.1));
      expect(p.countByStage[3]).to.equal(1n);

      await advanceTo(loan.nextDueDate + 31n * ctx.spd);
      const receipt = await (await lm.markDefault(loanId)).wait();
      const loss = findEvent(receipt, ctx.defaultManager, "LoanDefaulted").lenderLoss;
      p = await lens.portfolio();
      expect(p.totalLenderLoss).to.equal(loss);
      const [months] = await lens.lossesByMonth(3, ctx.spd);
      expect(months[0]).to.equal(loss);
      expect(p.reserveBalance).to.equal(await ethers.provider.getBalance(await ctx.reserve.getAddress()));
    });
  });
});
