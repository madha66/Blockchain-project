import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

describe("GigLend V2 Economic Invariants & Edge-Case Audit Suite", function () {
  let creditScore;
  let glpToken;
  let lendingPool;
  let owner, alice, bob, charlie, dave;

  const ONE_ETH = ethers.parseEther("1.0");
  const SECONDS_PER_DAY = 86400n;

  beforeEach(async function () {
    [owner, alice, bob, charlie, dave] = await ethers.getSigners();

    const CreditScoreFactory = await ethers.getContractFactory("CreditScore");
    creditScore = await CreditScoreFactory.deploy();
    await creditScore.waitForDeployment();

    const GLPTokenFactory = await ethers.getContractFactory("GLPToken");
    glpToken = await GLPTokenFactory.deploy();
    await glpToken.waitForDeployment();

    const LendingPoolFactory = await ethers.getContractFactory("LendingPool");
    lendingPool = await LendingPoolFactory.deploy(
      await glpToken.getAddress(),
      await creditScore.getAddress()
    );
    await lendingPool.waitForDeployment();

    await glpToken.setLendingPool(await lendingPool.getAddress());
    await creditScore.setLendingPool(await lendingPool.getAddress());
  });

  describe("1. Virtual-Offset Behavior when Share Supply is Zero and Assets Remain", function () {
    it("handles new depositor when share supply returns to zero after inflation attack", async function () {
      // Step A: Attacker deposits 1 wei and donates 1 ETH
      await lendingPool.connect(bob).deposit({ value: 1n });
      await bob.sendTransaction({
        to: await lendingPool.getAddress(),
        value: ONE_ETH,
      });

      // Step B: Victim deposits 0.5 ETH
      const victimDeposit = ethers.parseEther("0.5");
      await lendingPool.connect(alice).deposit({ value: victimDeposit });

      // Step C: Both redeem their shares completely
      await lendingPool.connect(bob).withdraw(1n);
      await lendingPool.connect(alice).withdraw(500_000n);

      // Verify supply is exactly 0 and pool has remaining assets
      const supplyAfterFullWithdraw = await glpToken.totalSupply();
      const poolBalAfterFullWithdraw = await ethers.provider.getBalance(await lendingPool.getAddress());
      expect(supplyAfterFullWithdraw).to.equal(0n);
      expect(poolBalAfterFullWithdraw).to.be.greaterThan(0n);
      // Approximately 0.999999 ETH remains
      expect(poolBalAfterFullWithdraw).to.equal(999_999_333_333_444_445n);

      // Step D: A completely new depositor (charlie) deposits 1.0 ETH
      const charlieDeposit = ONE_ETH;
      await lendingPool.connect(charlie).deposit({ value: charlieDeposit });

      // Pre-recognized assets = 999_999_333_333_444_445n
      // S_virtual = 0 + 1e6 = 1,000,000
      // A_virtual = 999_999_333_333_444_445 + 1e6 = 999_999_333_334_444_445
      // Expected shares = floor(1e18 * 1e6 / 999_999_333_334_444_445) = 1,000,000 wei GLP
      const charlieShares = await glpToken.balanceOf(charlie.address);
      expect(charlieShares).to.equal(1_000_000n);
      expect(await glpToken.totalSupply()).to.equal(1_000_000n);

      // Step E: Charlie immediately withdraws his 1,000,000 shares
      const charlieBalBefore = await ethers.provider.getBalance(charlie.address);
      const tx = await lendingPool.connect(charlie).withdraw(charlieShares);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const charlieBalAfter = await ethers.provider.getBalance(charlie.address);

      const netRetrieved = charlieBalAfter + gasCost - charlieBalBefore;
      // Charlie retrieves 999,999,666,667,222,222 wei (99.99996% of deposit)
      expect(netRetrieved).to.equal(999_999_666_667_222_222n);
      expect(await glpToken.totalSupply()).to.equal(0n);
    });

    it("reverts if deposit amount is too small to mint at least 1 share when large assets exist with zero shares", async function () {
      // Donate 1 ETH to contract directly (0 shares exist)
      await bob.sendTransaction({
        to: await lendingPool.getAddress(),
        value: ONE_ETH,
      });

      // Attempt dust deposit of 100 wei:
      // shares = (100 * 1e6) / (1e18 + 1e6) = 0
      await expect(
        lendingPool.connect(alice).deposit({ value: 100n })
      ).to.be.revertedWith("Zero shares minted");
    });
  });

  describe("2. Liquidity Invariant: Cannot Withdraw More than Free Cash", function () {
    it("strictly prevents lenders from withdrawing more liquid cash than the pool currently holds", async function () {
      // Alice deposits 1.0 ETH
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });

      // Bob qualifies and borrows 0.5 ETH
      await lendingPool.connect(bob).deposit({ value: ethers.parseEther("0.1") });
      await lendingPool.connect(bob)["borrow(uint256,uint256)"](ethers.parseEther("0.5"), 30);

      // Current pool state:
      // Pool cash = 0.6 ETH (1.1 ETH - 0.5 ETH borrowed)
      // Active loans = 0.5 ETH
      // Total assets recognized = 1.1 ETH
      // Alice has 1.0 ETH GLP shares (entitled to ~1.0 ETH of assets)
      const aliceShares = await glpToken.balanceOf(alice.address);
      expect(aliceShares).to.equal(ONE_ETH);

      // Alice tries to withdraw all 1.0 ETH of shares (which requires ~1.0 ETH cash)
      // But available free cash is only 0.6 ETH
      await expect(
        lendingPool.connect(alice).withdraw(aliceShares)
      ).to.be.revertedWith("Insufficient liquidity to withdraw");

      // Alice can withdraw up to available free cash (e.g. 0.5 ETH GLP shares)
      const halfShares = ethers.parseEther("0.5");
      await expect(lendingPool.connect(alice).withdraw(halfShares)).to.not.be.reverted;

      // Now pool cash is ~0.1 ETH. Alice trying to withdraw another 0.5 ETH shares fails
      await expect(
        lendingPool.connect(alice).withdraw(halfShares)
      ).to.be.revertedWith("Insufficient liquidity to withdraw");
    });
  });

  describe("3. Simultaneous Borrowing and Utilization Cap Enforcement", function () {
    it("strictly limits total simultaneous active borrowings to 90% of pool capital", async function () {
      // Pool funded with 1.0 ETH
      await lendingPool.connect(owner).deposit({ value: ONE_ETH });

      // Bob, Charlie, and Dave qualify
      await lendingPool.connect(bob).deposit({ value: ethers.parseEther("0.1") });
      await lendingPool.connect(charlie).deposit({ value: ethers.parseEther("0.1") });
      await lendingPool.connect(dave).deposit({ value: ethers.parseEther("0.1") });

      // Total pool capital = 1.3 ETH. 90% cap = 1.17 ETH.
      // Bob borrows 0.5 ETH (limit is 0.5 ETH)
      await lendingPool.connect(bob)["borrow(uint256,uint256)"](ethers.parseEther("0.5"), 30);
      expect(await lendingPool.totalActiveLoans()).to.equal(ethers.parseEther("0.5"));

      // Charlie borrows 0.5 ETH
      await lendingPool.connect(charlie)["borrow(uint256,uint256)"](ethers.parseEther("0.5"), 30);
      expect(await lendingPool.totalActiveLoans()).to.equal(ethers.parseEther("1.0"));

      // Dave attempts to borrow 0.2 ETH:
      // Post-active loans = 1.2 ETH.
      // Total capital = 1.3 ETH.
      // 1.2 * 10000 = 12000 > 1.3 * 9000 = 11700. Exceeds 90% cap!
      await expect(
        lendingPool.connect(dave)["borrow(uint256,uint256)"](ethers.parseEther("0.2"), 30)
      ).to.be.revertedWith("Utilization exceeds 90% cap");

      // Dave can borrow 0.17 ETH (which brings utilization exactly to 1.17 ETH / 1.3 ETH = 90.00%)
      await expect(
        lendingPool.connect(dave)["borrow(uint256,uint256)"](ethers.parseEther("0.17"), 30)
      ).to.not.be.reverted;

      expect(await lendingPool.totalActiveLoans()).to.equal(ethers.parseEther("1.17"));
    });
  });

  describe("4. Accounting Transitions: Repayment, Insurance Reserve, Default & Recovery", function () {
    it("correctly executes the entire lifecycle with full invariant assertions", async function () {
      // 1. Setup pool with 2.0 ETH
      await lendingPool.connect(owner).deposit({ value: ethers.parseEther("2.0") });
      // Alice deposits 0.5 ETH GLP
      await lendingPool.connect(alice).deposit({ value: ethers.parseEther("0.5") });

      // Initial assertions
      expect(await glpToken.totalSupply()).to.equal(ethers.parseEther("2.5"));
      expect(await lendingPool.insuranceReserve()).to.equal(0n);
      expect(await lendingPool.totalActiveLoans()).to.equal(0n);

      // 2. Alice borrows 0.3 ETH for 7 days
      const borrowAmount = ethers.parseEther("0.3");
      await lendingPool.connect(alice)["borrow(uint256,uint256)"](borrowAmount, 7);

      expect(await lendingPool.totalActiveLoans()).to.equal(borrowAmount);
      expect(await lendingPool.activeLoans(alice.address)).to.equal(borrowAmount);

      // 3. Fast forward 7 days to due date
      await ethers.provider.send("evm_increaseTime", [7 * 86400]);
      await ethers.provider.send("evm_mine");

      // Accrued interest is positive
      const accruedInt = await lendingPool.getAccruedInterest(alice.address);
      expect(accruedInt).to.be.greaterThan(0n);

      // 4. Repay with overpayment
      const totalDue = await lendingPool.getRepaymentAmount(alice.address);
      const overpayment = ethers.parseEther("0.1");
      const repayValue = totalDue + overpayment;

      const aliceBalBeforeRepay = await ethers.provider.getBalance(alice.address);
      const repayTx = await lendingPool.connect(alice).repay({ value: repayValue });
      const repayReceipt = await repayTx.wait();
      const repayGas = repayReceipt.gasUsed * repayReceipt.gasPrice;
      const aliceBalAfterRepay = await ethers.provider.getBalance(alice.address);

      const parsedLog = lendingPool.interface.parseLog(
        repayReceipt.logs.find(l => {
          try { return lendingPool.interface.parseLog(l)?.name === "Repaid"; } catch { return false; }
        })
      );
      const { principalPaid, interestPaid, refund } = parsedLog.args;

      // Invariant: Overpayment was refunded
      const netPaid = aliceBalBeforeRepay - aliceBalAfterRepay - repayGas;
      expect(netPaid).to.equal(principalPaid + interestPaid);
      expect(repayValue - (principalPaid + interestPaid)).to.equal(refund);

      // Loan is completely settled
      expect(await lendingPool.totalActiveLoans()).to.equal(0n);
      expect(await lendingPool.activeLoans(alice.address)).to.equal(0n);

      // Insurance reserve collected 10% of interest
      const reserve = await lendingPool.insuranceReserve();
      expect(reserve).to.be.greaterThan(0n);
      expect(reserve).to.equal((interestPaid * 10n) / 100n);
    });

    it("verifies default settlement with insurance reserve depletion and full recovery", async function () {
      // 1. Setup pool with 2 ETH and an insurance reserve
      await lendingPool.connect(owner).deposit({ value: ethers.parseEther("2.0") });
      await lendingPool.connect(alice).deposit({ value: ethers.parseEther("0.1") });

      // Alice borrows 0.2 ETH
      await lendingPool.connect(alice)["borrow(uint256,uint256)"](ethers.parseEther("0.2"), 7);

      // Advance past due date (7 days) + grace period (3 days) = 10 days
      await ethers.provider.send("evm_increaseTime", [11 * 86400]);
      await ethers.provider.send("evm_mine");

      // Settle default
      await lendingPool.markDefault(alice.address);

      expect(await lendingPool.isDefaulter(alice.address)).to.be.true;
      expect(await lendingPool.totalActiveLoans()).to.equal(0n);
      expect(await lendingPool.activeLoans(alice.address)).to.equal(0n);

      // Alice has written off debt recorded
      const memoDebt = await lendingPool.writtenOffDebt(alice.address);
      const resDrawn = await lendingPool.reserveDrawn(alice.address);
      expect(memoDebt + resDrawn).to.be.greaterThan(0n);

      // Alice cannot borrow while defaulter
      await expect(
        lendingPool.connect(alice)["borrow(uint256,uint256)"](ethers.parseEther("0.05"), 7)
      ).to.be.revertedWith("Defaulter cannot borrow");

      // Alice rehabilitates by settling written-off debt with overpayment
      const totalDebt = memoDebt + resDrawn;
      const overpay = ethers.parseEther("0.05");

      const aliceBalBefore = await ethers.provider.getBalance(alice.address);
      const settleTx = await lendingPool.connect(alice).settleWrittenOffDebt({ value: totalDebt + overpay });
      const settleReceipt = await settleTx.wait();
      const gasCost = settleReceipt.gasUsed * settleReceipt.gasPrice;
      const aliceBalAfter = await ethers.provider.getBalance(alice.address);

      // Overpayment refunded
      const netSettled = aliceBalBefore - aliceBalAfter - gasCost;
      expect(netSettled).to.equal(totalDebt);

      // Defaulter status cleared
      expect(await lendingPool.isDefaulter(alice.address)).to.be.false;
      expect(await lendingPool.writtenOffDebt(alice.address)).to.equal(0n);
      expect(await lendingPool.reserveDrawn(alice.address)).to.equal(0n);
    });
  });
});
