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
  Kind,
  Status,
  DType,
  LOOSE,
  ONE_ETH,
  VIRTUAL_OFFSET,
} from "./helpers/fixture.js";

const { ethers } = hre;

// V2 core suite migrated to the V3 loan engine (LoanManager + DefaultManager). The economic
// assertions are kept: virtual-offset share math, inflation-attack resistance, the 90% cap,
// rate locking, interest-first repayment with a 10% reserve cut, refunds, the default waterfall
// with fair-price stake set-off, and reserve-first recovery.
describe("GigLend V2 Core Lifecycle & Accounting Test Suite (migrated to V3)", function () {
  let ctx, pool, glp, lm, dm, reserve, alice, bob, charlie;

  beforeEach(async function () {
    ctx = await deployGigLend(LOOSE);
    ({ pool, glp, loanManager: lm, defaultManager: dm, reserve } = ctx);
    [alice, bob, charlie] = ctx.users;
  });

  const poolAddr = () => pool.getAddress();
  const balanceOf = async (a) => ethers.provider.getBalance(a);

  describe("Group 1: Virtual-Offset Share Valuation & Inflation Attack Protection", function () {
    it("mints 1:1 shares on initial deposit (with virtual offset)", async function () {
      await pool.connect(alice).deposit({ value: ONE_ETH });
      expect(await glp.balanceOf(alice.address)).to.equal(ONE_ETH);
      expect(await glp.totalSupply()).to.equal(ONE_ETH);
      expect(await balanceOf(await poolAddr())).to.equal(ONE_ETH);
    });

    it("resists ERC-4626 inflation/donation attack with exact BigInt accounting", async function () {
      await pool.connect(bob).deposit({ value: 1n });
      expect(await glp.balanceOf(bob.address)).to.equal(1n);

      await bob.sendTransaction({ to: await poolAddr(), value: ONE_ETH });
      expect(await balanceOf(await poolAddr())).to.equal(ONE_ETH + 1n);

      await pool.connect(alice).deposit({ value: ethers.parseEther("0.5") });
      expect(await glp.balanceOf(alice.address)).to.equal(500_000n);
      expect(await glp.totalSupply()).to.equal(500_001n);

      const bobBefore = await balanceOf(bob.address);
      const r1 = await (await pool.connect(bob).withdraw(1n)).wait();
      expect((await balanceOf(bob.address)) + gasCost(r1) - bobBefore).to.equal(999_999_333_334n);

      const aliceBefore = await balanceOf(alice.address);
      const r2 = await (await pool.connect(alice).withdraw(500_000n)).wait();
      expect((await balanceOf(alice.address)) + gasCost(r2) - aliceBefore).to.equal(499_999_666_667_222_222n);
    });
  });

  describe("Group 2: Same-Block Utilization Concurrency Race", function () {
    it("mines both borrows in the same block, succeeds first, and proves second reverts with 90% cap", async function () {
      await pool.connect(alice).deposit({ value: ONE_ETH });
      await register(ctx, bob);
      await register(ctx, charlie);
      const amount = ethers.parseEther("0.5");

      try {
        await ethers.provider.send("evm_setAutomine", [false]);
        await ethers.provider.send("evm_setIntervalMining", [0]);

        const tx1 = await lm.connect(bob).openLoan(Kind.Builder, amount, 2, ethers.ZeroAddress, false, { gasLimit: 3_000_000 });
        const tx2 = await lm.connect(charlie).openLoan(Kind.Builder, amount, 2, ethers.ZeroAddress, false, { gasLimit: 3_000_000 });

        const pending = await ethers.provider.send("eth_getBlockByNumber", ["pending", false]);
        expect(pending.transactions).to.include(tx1.hash);
        expect(pending.transactions).to.include(tx2.hash);

        await ethers.provider.send("evm_mine", []);
        const receipt1 = await tx1.wait();
        const receipt2 = await ethers.provider.getTransactionReceipt(tx2.hash);

        expect(receipt1.blockNumber).to.equal(receipt2.blockNumber);
        expect(receipt1.index).to.be.lessThan(receipt2.index);
        expect(receipt1.status).to.equal(1);
        expect(receipt2.status).to.equal(0);

        const trace = await ethers.provider.send("debug_traceTransaction", [tx2.hash, {}]);
        expect(trace.failed).to.be.true;
        expect(trace.returnValue).to.match(/^0x08c379a0/);
        const payload = "0x" + trace.returnValue.replace(/^0x/, "").slice(8);
        expect(ethers.AbiCoder.defaultAbiCoder().decode(["string"], payload)[0]).to.equal("Utilization exceeds 90% cap");

        expect(await lm.totalOutstanding()).to.equal(amount);
        expect(await balanceOf(await poolAddr())).to.equal(ethers.parseEther("0.5"));
      } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
      }
    });
  });

  describe("Group 3: Sequential Multi-Block Utilization Persistence", function () {
    it("enforces 90% cap across subsequent blocks while active loan is outstanding", async function () {
      await pool.connect(alice).deposit({ value: ONE_ETH });
      await register(ctx, bob);
      await register(ctx, charlie);
      await openLoan(ctx, bob, { amount: ethers.parseEther("0.5") });
      expect(await lm.totalOutstanding()).to.equal(ethers.parseEther("0.5"));

      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);

      await expect(
        lm.connect(charlie).openLoan(Kind.Builder, ethers.parseEther("0.45"), 2, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Utilization exceeds 90% cap");
    });
  });

  describe("Group 4: Interest, Rate Locking & Repayment Waterfall", function () {
    it("locks interest rate at origination based on post-borrow utilization and credit surcharge", async function () {
      await pool.connect(alice).deposit({ value: ONE_ETH });
      await register(ctx, bob);
      // Utilisation 50% → 400 + 5000·500/8000 = 712 bps; new member score 550 → +200 bps.
      const { loanId } = await openLoan(ctx, bob, { amount: ethers.parseEther("0.5") });
      const loan = await lm.getLoan(loanId);
      expect(loan.rateBps).to.equal(912n);
      expect(loan.principal).to.equal(ethers.parseEther("0.5"));
      expect(loan.periodDays).to.equal(7n);
      expect(loan.nInstallments).to.equal(2n);
    });

    it("amortises simple interest and splits interest into 10% reserve and 90% pool cash", async function () {
      await pool.connect(alice).deposit({ value: ONE_ETH });
      await register(ctx, bob);
      const amount = ethers.parseEther("0.4");
      const { loanId } = await openLoan(ctx, bob, { amount });
      const loan = await lm.getLoan(loanId);

      // 650 bps (40% utilisation) + 200 bps surcharge, 2 weekly installments = 14 days.
      expect(loan.rateBps).to.equal(850n);
      const totalInterest = (amount * 850n * 2n * 7n) / (10000n * 365n);
      expect(loan.interestRemaining).to.equal(totalInterest);
      expect(loan.installment).to.equal((amount + totalInterest + 1n) / 2n);

      const firstInterest = totalInterest / 2n;
      const firstPrincipal = amount / 2n;
      const reserveBefore = await balanceOf(await reserve.getAddress());
      const poolBefore = await balanceOf(await poolAddr());

      await lm.connect(bob).repayInstallment(loanId, { value: firstInterest + firstPrincipal });

      const reserveCut = (firstInterest * 1000n) / 10000n;
      expect((await balanceOf(await reserve.getAddress())) - reserveBefore).to.equal(reserveCut);
      expect((await balanceOf(await poolAddr())) - poolBefore).to.equal(firstPrincipal + firstInterest - reserveCut);

      const after = await lm.getLoan(loanId);
      expect(after.paidCount).to.equal(1n);
      expect(after.outstandingPrincipal).to.equal(amount - firstPrincipal);
      expect(after.interestRemaining).to.equal(totalInterest - firstInterest);
    });

    it("pays interest before principal on a partial payment", async function () {
      await pool.connect(alice).deposit({ value: ONE_ETH });
      await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: ethers.parseEther("0.4") });
      const loan = await lm.getLoan(loanId);
      const partial = loan.curInterestPortion / 2n;

      const receipt = await (await lm.connect(bob).repayInstallment(loanId, { value: partial })).wait();
      const ev = findEvent(receipt, lm, "Repaid");
      expect(ev.interestPaid).to.equal(partial);
      expect(ev.principalPaid).to.equal(0n);
      expect((await lm.getLoan(loanId)).paidCount).to.equal(0n);
    });

    it("refunds overpayment, releases Builder escrow and cleans up loan state on full repayment", async function () {
      await pool.connect(alice).deposit({ value: ONE_ETH });
      await register(ctx, bob);
      const amount = ethers.parseEther("0.2");
      const { loanId } = await openLoan(ctx, bob, { amount });
      const payoff = await lm.payoffAmount(loanId);

      const before = await balanceOf(bob.address);
      const receipt = await (await lm.connect(bob).repayInstallment(loanId, { value: ethers.parseEther("0.5") })).wait();
      const after = await balanceOf(bob.address);

      // Net cost = schedule payoff − escrow returned (the Builder principal was held for Bob).
      expect(before - after - gasCost(receipt)).to.equal(payoff - amount);
      expect(findEvent(receipt, lm, "Repaid").refund).to.equal(ethers.parseEther("0.5") - payoff);
      expect(findEvent(receipt, lm, "EscrowReleased").amount).to.equal(amount);

      const loan = await lm.getLoan(loanId);
      expect(loan.status).to.equal(Status.Repaid);
      expect(loan.outstandingPrincipal).to.equal(0n);
      expect(await lm.totalOutstanding()).to.equal(0n);
      expect(await lm.hasOpenLoan(loan.memberId)).to.equal(false);
    });
  });

  describe("Group 5: Default Impairment & Fair-Price Stake Waterfall", function () {
    it("reverts if default is marked before the default day", async function () {
      await pool.connect(alice).deposit({ value: ONE_ETH });
      await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: ethers.parseEther("0.2") });

      await expect(lm.markDefault(loanId)).to.be.revertedWith("Default day not reached");
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 29n * ctx.spd);
      await expect(lm.markDefault(loanId)).to.be.revertedWith("Default day not reached");
      await advanceTo(loan.nextDueDate + 30n * ctx.spd);
      await expect(lm.markDefault(loanId)).to.emit(dm, "LoanDefaulted");
    });

    // Bob holds exactly the shares needed to cover the whole debt at the fair share price
    // (impaired loan excluded), or one wei-share fewer.
    async function thresholdFixture(oneBelow) {
      await pool.connect(alice).deposit({ value: ethers.parseEther("10.9") });
      const bobId = await register(ctx, bob);
      await qualify(ctx, bob);

      const P = ethers.parseEther("0.4");
      const [, totalInterest, installment] = await ctx.risk.quote(bobId, Kind.Unsecured, P, 2);
      const flat = await ctx.config.get(ethers.encodeBytes32String("lateFeeFlatWei"));
      const cap = (installment * 1000n) / 10000n;
      const fee = flat < cap ? flat : cap;
      const debt = P + totalInterest + fee;

      const cashAfterOpen = (await balanceOf(await poolAddr())) - P;
      const supply = await glp.totalSupply();
      const den = cashAfterOpen + VIRTUAL_OFFSET;
      const threshold = (debt * (supply + VIRTUAL_OFFSET) + den - 1n) / den;
      const shares = oneBelow ? threshold - 1n : threshold;
      await glp.connect(alice).transfer(bob.address, shares);

      const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: P });
      expect(await glp.lockedBalance(bob.address)).to.equal(shares);
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 31n * ctx.spd);

      const receipt = await (await lm.markDefault(loanId)).wait();
      const ev = findEvent(receipt, dm, "LoanDefaulted");
      return { ev, debt, shares, den, supply, bobId };
    }

    it("settles default under the exact share threshold: stake covers the whole debt", async function () {
      const { ev, debt, bobId } = await thresholdFixture(false);
      expect(ev.stakeUsed).to.equal(debt);
      expect(ev.reserveUsed).to.equal(0n);
      expect(ev.lenderLoss).to.equal(0n);
      expect(await glp.balanceOf(bob.address)).to.equal(0n);
      expect(await dm.claimOf(bobId)).to.equal(0n);
    });

    it("settles default one share below threshold: the shortfall stays as a residual claim", async function () {
      const { ev, debt, shares, den, supply, bobId } = await thresholdFixture(true);
      const expectedValue = (shares * den) / (supply + VIRTUAL_OFFSET);
      expect(ev.stakeUsed).to.equal(expectedValue);
      expect(ev.stakeUsed).to.be.lessThan(debt);
      // Stake is applied to principal first, so lenders lose nothing; the wei shortfall is owed.
      expect(ev.lenderLoss).to.equal(0n);
      expect(await dm.claimOf(bobId)).to.equal(debt - expectedValue);
    });

    it("settles default with zero borrower stake (reserve first, then lenders)", async function () {
      ctx = await deployGigLend({ ...LOOSE, unsecuredStakeCoverBps: 0 });
      ({ pool, glp, loanManager: lm, defaultManager: dm, reserve } = ctx);
      [alice, bob, charlie] = ctx.users;

      await pool.connect(alice).deposit({ value: ONE_ETH });
      const bobId = await register(ctx, bob);
      await qualify(ctx, bob);
      expect(await glp.balanceOf(bob.address)).to.equal(0n);

      const P = ethers.parseEther("0.3");
      const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: P });
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 31n * ctx.spd);

      const reserveBal = await balanceOf(await reserve.getAddress());
      const [, interest, fees] = await dm.defaultDebt(loanId);
      const receipt = await (await lm.markDefault(loanId)).wait();
      const ev = findEvent(receipt, dm, "LoanDefaulted");

      expect(ev.stakeUsed).to.equal(0n);
      // The reserve covers principal up to its balance (here only the Builder loan's interest cut).
      expect(ev.reserveUsed).to.equal(reserveBal < P ? reserveBal : P);
      expect(ev.reserveUsed).to.be.greaterThan(0n);
      expect(ev.lenderLoss).to.equal(P - ev.reserveUsed);
      expect(await lm.totalOutstanding()).to.equal(0n);
      expect(await dm.claimOf(bobId)).to.equal(P + interest + fees);
      expect((await lm.getLoan(loanId)).status).to.equal(Status.Defaulted);

      await expect(lm.markDefault(loanId)).to.be.revertedWith("No active loan");
    });
  });

  describe("Group 6: Residual Claim Recovery & Rehabilitation", function () {
    let bobId, loanId;

    beforeEach(async function () {
      ctx = await deployGigLend({ ...LOOSE, unsecuredStakeCoverBps: 0 });
      ({ pool, glp, loanManager: lm, defaultManager: dm, reserve } = ctx);
      [alice, bob, charlie] = ctx.users;
      await pool.connect(alice).deposit({ value: ONE_ETH });
      bobId = await register(ctx, bob);
      await qualify(ctx, bob);
      ({ loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: ethers.parseEther("0.3") }));
      const loan = await lm.getLoan(loanId);
      await advanceTo(loan.nextDueDate + 31n * ctx.spd);
      await lm.markDefault(loanId);
    });

    it("full settlement refills the reserve first, applies the type discount and starts cooling-off", async function () {
      const claim = await dm.claimOf(bobId);
      const c = await dm.claims(bobId);
      expect(c.dtype).to.equal(DType.Hardship);
      const quote = await dm.settlementQuote(bobId);
      expect(quote).to.equal((claim * 7500n) / 10000n);

      const reserveBefore = await ethers.provider.getBalance(await reserve.getAddress());
      await expect(dm.connect(bob).settleClaim({ value: quote }))
        .to.emit(dm, "ClaimSettled")
        .withArgs(bobId, quote, claim - quote, true);
      const reserveAfter = await ethers.provider.getBalance(await reserve.getAddress());
      expect(reserveAfter - reserveBefore).to.be.at.least(c.reserveDrawn);
      expect(await dm.claimOf(bobId)).to.equal(0n);

      const member = await ctx.registry.getMember(bobId);
      expect(member.coolingOffUntil).to.equal((await now()) + 30n * ctx.spd);
      await expect(
        lm.connect(bob).openLoan(Kind.Builder, ethers.parseEther("0.01"), 2, ethers.ZeroAddress, false)
      ).to.be.revertedWith("Cooling-off active");
    });

    it("handles partial recovery, repeated recovery and overpayment refund", async function () {
      const claim = await dm.claimOf(bobId);
      const partial = claim / 2n; // below the settlement quote: no discount
      await dm.connect(bob).settleClaim({ value: partial });
      const remaining = await dm.claimOf(bobId);
      expect(remaining).to.equal(claim - partial);
      expect((await ctx.registry.getMember(bobId)).coolingOffUntil).to.equal(2n ** 64n - 1n);

      const quote = await dm.settlementQuote(bobId);
      const before = await ethers.provider.getBalance(bob.address);
      const receipt = await (await dm.connect(bob).settleClaim({ value: ONE_ETH })).wait();
      const after = await ethers.provider.getBalance(bob.address);
      expect(before - after - gasCost(receipt)).to.equal(quote);
      expect(await dm.claimOf(bobId)).to.equal(0n);

      await expect(dm.connect(bob).settleClaim({ value: ethers.parseEther("0.01") })).to.be.revertedWith(
        "No claim to settle"
      );
    });
  });

  describe("Group 7: Penalty-free exit (replaces the legacy borrow(amount) ABI)", function () {
    it("returns the principal within 1 day with no interest or fees", async function () {
      await pool.connect(alice).deposit({ value: ONE_ETH });
      await register(ctx, bob);
      await qualify(ctx, bob);
      await pool.connect(bob).deposit({ value: ethers.parseEther("0.2") });
      const P = ethers.parseEther("0.2");
      const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: P });
      expect(await glp.lockedBalance(bob.address)).to.be.greaterThan(0n);

      await expect(lm.connect(bob).exitLoan(loanId, { value: P - 1n })).to.be.revertedWith("Return the full principal");
      await lm.connect(bob).exitLoan(loanId, { value: P });
      expect((await lm.getLoan(loanId)).status).to.equal(Status.Exited);
      expect(await glp.lockedBalance(bob.address)).to.equal(0n);
      expect(await lm.totalOutstanding()).to.equal(0n);
    });

    it("closes the exit window after penaltyFreeExitDays", async function () {
      await pool.connect(alice).deposit({ value: ONE_ETH });
      await register(ctx, bob);
      const { loanId } = await openLoan(ctx, bob, { amount: ethers.parseEther("0.1") });
      await advanceDays(ctx, 2);
      await expect(lm.connect(bob).exitLoan(loanId)).to.be.revertedWith("Exit window closed");
    });
  });
});
