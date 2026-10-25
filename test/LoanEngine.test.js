import { expect } from "chai";
import hre from "hardhat";
import {
  deployGigLend,
  register,
  openLoan,
  payOff,
  qualify,
  advanceDays,
  findEvent,
  Kind,
  Status,
  LOOSE,
  ONE_ETH,
} from "./helpers/fixture.js";

const { ethers } = hre;

describe("Loan engine (Phase 2): installments, stake lock, escrow, SafeRepay, income sweep", function () {
  let ctx, pool, glp, lm, vault, router, alice, bob, carol, platform;

  beforeEach(async function () {
    ctx = await deployGigLend(LOOSE);
    ({ pool, glp, loanManager: lm, vault, router } = ctx);
    [alice, bob, carol, platform] = ctx.users;
    await pool.connect(alice).deposit({ value: ethers.parseEther("5") });
  });

  describe("Stake lock", function () {
    it("locked GLP cannot be withdrawn or transferred while a loan is open, and unlocks on repayment", async function () {
      await register(ctx, bob);
      await qualify(ctx, bob);
      await pool.connect(bob).deposit({ value: ethers.parseEther("0.2") });
      const shares = await glp.balanceOf(bob.address);

      const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: ethers.parseEther("0.2") });
      expect(await glp.lockedBalance(bob.address)).to.equal(shares);

      await expect(pool.connect(bob).withdraw(shares)).to.be.revertedWith("GLP locked");
      await expect(glp.connect(bob).transfer(carol.address, 1n)).to.be.revertedWith("GLP locked");

      await payOff(ctx, bob, loanId);
      expect(await glp.lockedBalance(bob.address)).to.equal(0n);
      await expect(glp.connect(bob).transfer(carol.address, 1n)).to.not.be.reverted;
    });

    it("an Unsecured loan needs 50% stake cover (borrower plus any guarantor)", async function () {
      await register(ctx, bob);
      await qualify(ctx, bob);
      await pool.connect(bob).deposit({ value: ethers.parseEther("0.05") });
      await expect(
        lm.connect(bob).openLoan(Kind.Unsecured, ethers.parseEther("0.2"), 2, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Insufficient stake cover");

      // A guarantor's pledge makes up the difference and is locked for the loan's life.
      await pool.connect(carol).deposit({ value: ethers.parseEther("0.1") });
      const pledge = ethers.parseEther("0.06");
      await lm.connect(carol).offerGuarantee(bob.address, pledge);
      expect(await glp.lockedBalance(carol.address)).to.equal(pledge);

      const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: ethers.parseEther("0.2"), guarantor: carol.address });
      const loan = await lm.getLoan(loanId);
      expect(loan.guarantor).to.equal(carol.address);
      expect(loan.guarantorStakeLocked).to.equal(pledge);

      await payOff(ctx, bob, loanId);
      expect(await glp.lockedBalance(carol.address)).to.equal(0n);
    });

    it("an unused guarantee can be withdrawn", async function () {
      await pool.connect(carol).deposit({ value: ethers.parseEther("0.1") });
      await lm.connect(carol).offerGuarantee(bob.address, ethers.parseEther("0.05"));
      await lm.connect(carol).withdrawGuarantee(bob.address);
      expect(await glp.lockedBalance(carol.address)).to.equal(0n);
    });
  });

  describe("Builder escrow", function () {
    it("holds 100% of a Builder loan in escrow and releases it only on full repayment", async function () {
      await register(ctx, bob);
      const amount = ethers.parseEther("0.02");
      const bobBefore = await ethers.provider.getBalance(bob.address);
      const { loanId, receipt } = await openLoan(ctx, bob, { amount, n: 3 });

      // Nothing reached Bob; the principal sits in LoanManager.
      const gas1 = receipt.gasUsed * receipt.gasPrice;
      expect(await ethers.provider.getBalance(bob.address)).to.equal(bobBefore - gas1);
      expect(await ethers.provider.getBalance(await lm.getAddress())).to.equal(amount);
      expect((await lm.getLoan(loanId)).escrow).to.equal(amount);

      // Paying two of three installments keeps the escrow.
      for (let i = 0; i < 2; i++) {
        const due = await lm.amountDue(loanId);
        const r = await (await lm.connect(bob).repayInstallment(loanId, { value: due })).wait();
        expect(findEvent(r, lm, "EscrowReleased")).to.equal(undefined);
      }
      expect((await lm.getLoan(loanId)).escrow).to.equal(amount);

      const due = await lm.amountDue(loanId);
      const r = await (await lm.connect(bob).repayInstallment(loanId, { value: due })).wait();
      expect(findEvent(r, lm, "EscrowReleased").amount).to.equal(amount);
      expect((await lm.getLoan(loanId)).status).to.equal(Status.Repaid);
      expect(await ethers.provider.getBalance(await lm.getAddress())).to.equal(0n);
    });

    it("installments follow the member's payout period", async function () {
      await register(ctx, bob, { payoutPeriodDays: 14 });
      const { loanId } = await openLoan(ctx, bob, { amount: ethers.parseEther("0.02"), n: 3 });
      const loan = await lm.getLoan(loanId);
      expect(loan.periodDays).to.equal(14n);
      expect(loan.nextDueDate - loan.startAt).to.equal(14n * ctx.spd);
    });

    it("rejects tenure outside the installment window", async function () {
      await register(ctx, bob);
      await expect(
        lm.connect(bob).openLoan(Kind.Builder, ethers.parseEther("0.01"), 1, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Installments out of range");
      await expect(
        lm.connect(bob).openLoan(Kind.Builder, ethers.parseEther("0.01"), 13, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Installments out of range");
    });
  });

  describe("SafeRepay autopay", function () {
    it("is set up at disbursement, prefunded, and pulls the installment within the borrower's limits", async function () {
      await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, {
        amount: ethers.parseEther("0.02"),
        autopay: true,
        value: ethers.parseEther("0.03"),
      });
      const v = await vault.vaults(bob.address);
      expect(v.configured).to.equal(true);
      expect(v.balance).to.equal(ethers.parseEther("0.03"));

      // Borrower protects a minimum balance; the pull never touches it.
      await vault.connect(bob).configure(ethers.parseEther("1"), ethers.parseEther("0.025"), v.expiry);
      const due = await lm.amountDue(loanId);
      await lm.connect(carol).autopay(loanId); // anyone may trigger it
      const after = await vault.vaults(bob.address);
      expect(after.balance).to.equal(ethers.parseEther("0.025"));
      const loan = await lm.getLoan(loanId);
      expect(loan.paidCount).to.equal(0n);
      expect(loan.curInterestPaid + loan.curPrincipalPaid).to.equal(ethers.parseEther("0.005"));
      expect(due).to.be.greaterThan(ethers.parseEther("0.005"));

      await vault.connect(bob).configure(ethers.parseEther("1"), 0, v.expiry);
      await lm.autopay(loanId);
      expect((await lm.getLoan(loanId)).paidCount).to.equal(1n);
    });

    it("does nothing for opted-out loans and refuses a prefund without autopay", async function () {
      await register(ctx, bob);
      await expect(
        lm.connect(bob).openLoan(Kind.Builder, ethers.parseEther("0.01"), 2, ethers.ZeroAddress, false, { value: 1n })
      ).to.be.revertedWith("Prefund needs autopay");
      const { loanId } = await openLoan(ctx, bob, { amount: ethers.parseEther("0.01") });
      await expect(lm.autopay(loanId)).to.be.revertedWith("Autopay off");
    });
  });

  describe("Income sweep through MockPayoutRouter", function () {
    it("sweeps sweepBps of each payout into the open installment and forwards the rest", async function () {
      await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: ethers.parseEther("0.02"), autopay: true });
      const payout = ethers.parseEther("0.01");
      const before = await ethers.provider.getBalance(bob.address);

      const r = await (await router.connect(platform).payout(bob.address, { value: payout })).wait();
      const ev = findEvent(r, router, "PayoutRouted");
      expect(ev.sweptToLoan).to.equal((payout * 2000n) / 10000n);
      expect(ev.forwarded).to.equal(payout - ev.sweptToLoan);
      expect(await ethers.provider.getBalance(bob.address)).to.equal(before + ev.forwarded);
      expect(findEvent(r, lm, "SweepApplied").amount).to.equal(ev.sweptToLoan);

      const loan = await lm.getLoan(loanId);
      expect(loan.curInterestPaid + loan.curPrincipalPaid).to.equal(ev.sweptToLoan);
      expect(await router.inflowSince(bob.address, 0)).to.equal(payout);
    });

    it("records cumulative inflow by time for early warning and classification", async function () {
      await router.connect(platform).payout(bob.address, { value: ethers.parseEther("0.01") });
      await advanceDays(ctx, 7);
      const t = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      await router.connect(platform).payout(bob.address, { value: ethers.parseEther("0.02") });
      expect(await router.inflowSince(bob.address, t)).to.equal(ethers.parseEther("0.02"));
      expect(await router.inflowSince(bob.address, 0)).to.equal(ethers.parseEther("0.03"));
      const [latest, previous] = await router.lastPayouts(bob.address);
      expect(latest).to.equal(ethers.parseEther("0.02"));
      expect(previous).to.equal(ethers.parseEther("0.01"));
    });

    it("passes payouts straight through when there is no loan", async function () {
      const before = await ethers.provider.getBalance(bob.address);
      await router.connect(platform).payout(bob.address, { value: ONE_ETH / 100n });
      expect(await ethers.provider.getBalance(bob.address)).to.equal(before + ONE_ETH / 100n);
    });
  });

  describe("Contract size", function () {
    it("every contract fits the 24 KB EIP-170 limit", async function () {
      for (const name of ["LoanManager", "DefaultManager", "LendingPool", "RiskEngine", "IdentityRegistry", "CreditScore"]) {
        const artifact = await hre.artifacts.readArtifact(name);
        expect((artifact.deployedBytecode.length - 2) / 2, name).to.be.lessThan(24576);
      }
    });
  });
});
