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
  findEvents,
  gasCost,
  Kind,
  DType,
  LOOSE,
  ONE_ETH,
  depositFor,
} from "./helpers/fixture.js";

const { ethers } = hre;

describe("GigLend Economic Invariants & Edge-Case Audit Suite (migrated to V3)", function () {
  let ctx, pool, glp, lm, dm, reserve, owner, alice, bob, charlie, dave;

  beforeEach(async function () {
    ctx = await deployGigLend(LOOSE);
    ({ pool, glp, loanManager: lm, defaultManager: dm, reserve } = ctx);
    owner = ctx.admin;
    [alice, bob, charlie, dave] = ctx.users;
  });

  const bal = (a) => ethers.provider.getBalance(a);

  describe("1. Virtual-Offset Behavior when Share Supply is Zero and Assets Remain", function () {
    it("handles new depositor when share supply returns to zero after inflation attack", async function () {
      await depositFor(ctx, bob, 1n);
      await bob.sendTransaction({ to: await pool.getAddress(), value: ONE_ETH });
      await depositFor(ctx, alice, ethers.parseEther("0.5"));

      await pool.connect(bob).withdraw(1n);
      await pool.connect(alice).withdraw(500_000n);

      expect(await glp.totalSupply()).to.equal(0n);
      expect(await bal(await pool.getAddress())).to.equal(999_999_333_333_444_445n);

      await depositFor(ctx, charlie, ONE_ETH);
      const charlieShares = await glp.balanceOf(charlie.address);
      expect(charlieShares).to.equal(1_000_000n);

      const before = await bal(charlie.address);
      const receipt = await (await pool.connect(charlie).withdraw(charlieShares)).wait();
      expect((await bal(charlie.address)) + gasCost(receipt) - before).to.equal(999_999_666_667_222_222n);
      expect(await glp.totalSupply()).to.equal(0n);
    });

    it("reverts if deposit amount is too small to mint at least 1 share when large assets exist with zero shares", async function () {
      await bob.sendTransaction({ to: await pool.getAddress(), value: ONE_ETH });
      await expect(depositFor(ctx, alice, 100n)).to.be.revertedWith("Zero shares minted");
    });
  });

  describe("2. Liquidity Invariant: Withdrawals Never Exceed Free Cash", function () {
    it("queues the unpaid part of a withdrawal instead of draining or reverting, and pays it as cash returns", async function () {
      await depositFor(ctx, alice, ONE_ETH);
      await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: ethers.parseEther("0.5") });
      expect(await pool.freeCash()).to.equal(ethers.parseEther("0.5"));

      const aliceShares = await glp.balanceOf(alice.address);
      const receipt = await (await pool.connect(alice).withdraw(aliceShares)).wait();
      expect(findEvent(receipt, pool, "WithdrawalQueued").shares).to.equal(aliceShares);

      // Everything available was paid out at once, pro rata; never more than free cash.
      const paid = findEvents(receipt, pool, "WithdrawalPaid");
      expect(paid.length).to.equal(1);
      expect(paid[0].ethAmount).to.be.lessThanOrEqual(ethers.parseEther("0.5"));
      expect(await pool.freeCash()).to.be.lessThan(1000n);
      const stillQueued = await pool.queuedSharesOf(alice.address);
      expect(stillQueued).to.be.greaterThan(0n);

      // Repayment returns cash; the queue is paid from it automatically.
      await payOff(ctx, bob, loanId);
      expect(await pool.queuedSharesOf(alice.address)).to.equal(0n);
      expect(await glp.totalSupply()).to.equal(0n);
    });
  });

  describe("3. Simultaneous Borrowing and Utilization Cap Enforcement", function () {
    it("strictly limits total simultaneous active borrowings to 90% of pool capital", async function () {
      await depositFor(ctx, owner, ONE_ETH);
      for (const u of [bob, charlie, dave]) {
        await depositFor(ctx, u, ethers.parseEther("0.1"));
        await register(ctx, u);
      }
      // Capital = 1.3 ETH; 90% cap = 1.17 ETH.
      await openLoan(ctx, bob, { amount: ethers.parseEther("0.5") });
      await openLoan(ctx, charlie, { amount: ethers.parseEther("0.5") });
      expect(await lm.totalOutstanding()).to.equal(ethers.parseEther("1.0"));

      await expect(
        lm.connect(dave).openLoan(Kind.Builder, ethers.parseEther("0.2"), 2, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Utilization exceeds 90% cap");
      await openLoan(ctx, dave, { amount: ethers.parseEther("0.17") });
      expect(await lm.totalOutstanding()).to.equal(ethers.parseEther("1.17"));
    });
  });

  describe("4. Accounting Transitions: Repayment, Reserve, Default & Recovery", function () {
    it("correctly executes the entire repayment lifecycle with full invariant assertions", async function () {
      await depositFor(ctx, owner, ethers.parseEther("2.0"));
      await depositFor(ctx, alice, ethers.parseEther("0.5"));
      await register(ctx, alice);
      expect(await glp.totalSupply()).to.equal(ethers.parseEther("2.5"));

      const amount = ethers.parseEther("0.3");
      const { loanId } = await openLoan(ctx, alice, { amount });
      expect(await lm.totalOutstanding()).to.equal(amount);
      expect(await glp.lockedBalance(alice.address)).to.equal(ethers.parseEther("0.5"));

      await advanceDays(ctx, 7);
      const payoff = await lm.payoffAmount(loanId);
      const overpayment = ethers.parseEther("0.1");
      const reserveBefore = await bal(await reserve.getAddress());

      const before = await bal(alice.address);
      const receipt = await (await lm.connect(alice).repayInstallment(loanId, { value: payoff + overpayment })).wait();
      const after = await bal(alice.address);
      const { principalPaid, interestPaid, refund } = findEvent(receipt, lm, "Repaid");

      expect(principalPaid + interestPaid).to.equal(payoff);
      expect(refund).to.equal(overpayment);
      // Net: paid the schedule, got the Builder escrow back.
      expect(before - after - gasCost(receipt)).to.equal(payoff - amount);
      expect(await lm.totalOutstanding()).to.equal(0n);
      expect(await glp.lockedBalance(alice.address)).to.equal(0n);
      expect((await bal(await reserve.getAddress())) - reserveBefore).to.equal((interestPaid * 10n) / 100n);
    });

    it("verifies default settlement with stake set-off, residual claim and full recovery", async function () {
      await depositFor(ctx, owner, ethers.parseEther("2.0"));
      await depositFor(ctx, alice, ethers.parseEther("0.1"));
      const aliceId = await register(ctx, alice);
      await qualify(ctx, alice);

      const { loanId } = await openLoan(ctx, alice, { kind: Kind.Unsecured, amount: ethers.parseEther("0.2") });
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 31n * ctx.spd);

      const receipt = await (await lm.markDefault(loanId)).wait();
      const ev = findEvent(receipt, dm, "LoanDefaulted");
      expect(ev.defaultType).to.equal(DType.Hardship);
      expect(ev.stakeUsed).to.be.greaterThan(0n);
      expect(await lm.totalOutstanding()).to.equal(0n);
      expect(await glp.balanceOf(alice.address)).to.equal(0n);

      const claim = await dm.claimOf(aliceId);
      expect(claim).to.be.greaterThan(0n);
      await expect(
        lm.connect(alice).openLoan(Kind.Builder, ethers.parseEther("0.01"), 2, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Cooling-off active");

      const quote = await dm.settlementQuote(aliceId);
      const before = await bal(alice.address);
      const r = await (await dm.connect(alice).settleClaim({ value: claim + ethers.parseEther("0.05") })).wait();
      expect(before - (await bal(alice.address)) - gasCost(r)).to.equal(quote);
      expect(await dm.claimOf(aliceId)).to.equal(0n);
    });
  });
});
