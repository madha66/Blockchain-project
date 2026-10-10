import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

describe("GigLend V2 Core Lifecycle & Accounting Test Suite", function () {
  let creditScore;
  let glpToken;
  let lendingPool;
  let owner;
  let alice;
  let bob;
  let charlie;

  const SECONDS_PER_DAY = 86400n;
  const ONE_ETH = ethers.parseEther("1.0");

  beforeEach(async function () {
    [owner, alice, bob, charlie] = await ethers.getSigners();

    // Deploy CreditScore
    const CreditScoreFactory = await ethers.getContractFactory("CreditScore");
    creditScore = await CreditScoreFactory.deploy();
    await creditScore.waitForDeployment();

    // Deploy GLPToken
    const GLPTokenFactory = await ethers.getContractFactory("GLPToken");
    glpToken = await GLPTokenFactory.deploy();
    await glpToken.waitForDeployment();

    // Deploy LendingPool
    const LendingPoolFactory = await ethers.getContractFactory("LendingPool");
    lendingPool = await LendingPoolFactory.deploy(
      await glpToken.getAddress(),
      await creditScore.getAddress()
    );
    await lendingPool.waitForDeployment();

    // Wire permissions
    await glpToken.setLendingPool(await lendingPool.getAddress());
    await creditScore.setLendingPool(await lendingPool.getAddress());
  });

  describe("Group 1: Virtual-Offset Share Valuation & Inflation Attack Protection", function () {
    it("mints 1:1 shares on initial deposit (with virtual offset)", async function () {
      const depositAmount = ethers.parseEther("1.0");
      await lendingPool.connect(alice).deposit({ value: depositAmount });

      // Alice shares = (1e18 * 1e6) / 1e6 = 1e18
      const aliceShares = await glpToken.balanceOf(alice.address);
      expect(aliceShares).to.equal(depositAmount);
      expect(await glpToken.totalSupply()).to.equal(depositAmount);
      expect(await ethers.provider.getBalance(await lendingPool.getAddress())).to.equal(depositAmount);
    });

    it("resists ERC-4626 inflation/donation attack with exact BigInt accounting", async function () {
      // 1. Attacker (bob) deposits 1 wei
      await lendingPool.connect(bob).deposit({ value: 1n });
      // Attacker shares = (1 * 1e6) / 1e6 = 1 wei
      const bobShares1 = await glpToken.balanceOf(bob.address);
      expect(bobShares1).to.equal(1n);
      expect(await glpToken.totalSupply()).to.equal(1n);
      expect(await ethers.provider.getBalance(await lendingPool.getAddress())).to.equal(1n);

      // 2. Attacker donates 1 ETH directly to the contract (bypassing deposit)
      await bob.sendTransaction({
        to: await lendingPool.getAddress(),
        value: ONE_ETH,
      });
      // Asset balance is now 1 ETH + 1 wei
      const poolBalAfterDonation = await ethers.provider.getBalance(await lendingPool.getAddress());
      expect(poolBalAfterDonation).to.equal(ONE_ETH + 1n);
      expect(await glpToken.totalSupply()).to.equal(1n);

      // 3. Victim (alice) deposits 0.5 ETH (500,000,000,000,000,000 wei)
      const victimDeposit = ethers.parseEther("0.5");
      await lendingPool.connect(alice).deposit({ value: victimDeposit });

      // Calculation of Alice's shares:
      // S_existing = 1, S_virtual = 1 + 1e6 = 1,000,001
      // A_pre = (1 ETH + 1 wei) - 0 + 0 = 1,000,000,000,000,000,001
      // A_virtual = A_pre + 1e6 = 1,000,000,000,001,000,001
      // aliceShares = floor(500,000,000,000,000,000 * 1,000,001 / 1,000,000,000,001,000,001)
      // aliceShares = 500,000 wei GLP
      const aliceShares = await glpToken.balanceOf(alice.address);
      expect(aliceShares).to.equal(500_000n);

      const totalSupplyAfterAlice = await glpToken.totalSupply();
      expect(totalSupplyAfterAlice).to.equal(500_001n);

      const poolBalAfterAlice = await ethers.provider.getBalance(await lendingPool.getAddress());
      expect(poolBalAfterAlice).to.equal(ONE_ETH + 1n + victimDeposit);

      // 4. Attacker attempts to redeem their 1 share:
      // A_rec = 1.5 ETH + 1 wei
      // A_virtual = A_rec + 1e6 = 1,500,000,000,000,001,000,001
      // S_virtual = 500,001 + 1e6 = 1,500,001
      // bobReturn = floor(1 * 1,500,000,000,000,001,000,001 / 1,500,001) = 999,999,333,334 wei
      const bobBalBeforeWithdraw = await ethers.provider.getBalance(bob.address);
      const bobTx = await lendingPool.connect(bob).withdraw(1n);
      const bobReceipt = await bobTx.wait();
      const bobGasUsed = bobReceipt.gasUsed * bobReceipt.gasPrice;
      const bobBalAfterWithdraw = await ethers.provider.getBalance(bob.address);

      const bobRetrieved = bobBalAfterWithdraw + bobGasUsed - bobBalBeforeWithdraw;
      expect(bobRetrieved).to.equal(999_999_333_334n);
      // Attacker lost ~1 ETH - 999,999,333,334 wei (~0.999999 ETH loss)

      // 5. Victim redeems their 500,000 shares:
      // A_virtual = poolBalBeforeAliceWithdraw + 1e6
      // S_virtual = 500,000 + 1e6 = 1,500,000
      // aliceReturn = floor(500,000 * A_virtual / 1,500,000) = 499,999,666,667,222,222 wei
      const aliceBalBeforeWithdraw = await ethers.provider.getBalance(alice.address);
      const aliceTx = await lendingPool.connect(alice).withdraw(500_000n);
      const aliceReceipt = await aliceTx.wait();
      const aliceGasUsed = aliceReceipt.gasUsed * aliceReceipt.gasPrice;
      const aliceBalAfterWithdraw = await ethers.provider.getBalance(alice.address);

      const aliceRetrieved = aliceBalAfterWithdraw + aliceGasUsed - aliceBalBeforeWithdraw;
      expect(aliceRetrieved).to.equal(499_999_666_667_222_222n);
      // Alice retrieves virtually entire deposit (slippage < 0.00007%)
    });
  });

  describe("Group 2: Same-Block Utilization Concurrency Race", function () {
    it("mines both borrows in the same block, succeeds first, and proves second reverts with 90% cap", async function () {
      // 1. Initial state: exactly 1 ETH cash and no active loans
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });
      expect(await ethers.provider.getBalance(await lendingPool.getAddress())).to.equal(ONE_ETH);
      expect(await lendingPool.totalActiveLoans()).to.equal(0n);

      // Establish borrowing eligibility for Bob and Charlie:
      // Transfer 0.05 ETH GLP to each from Alice so balanceOf > 0 without adding pool cash
      const shareTransfer = ethers.parseEther("0.05");
      await glpToken.connect(alice).transfer(bob.address, shareTransfer);
      await glpToken.connect(alice).transfer(charlie.address, shareTransfer);

      // Verify both have score 50 (limit 0.5 ETH) and GLP balance > 0
      const scoreB = await creditScore.getScore(bob.address);
      const limitB = await creditScore.getBorrowLimit(bob.address);
      const scoreC = await creditScore.getScore(charlie.address);
      const limitC = await creditScore.getBorrowLimit(charlie.address);
      expect(scoreB).to.equal(50n);
      expect(limitB).to.equal(ethers.parseEther("0.5"));
      expect(scoreC).to.equal(50n);
      expect(limitC).to.equal(ethers.parseEther("0.5"));

      const borrowAmount = ethers.parseEther("0.5");

      try {
        // 2. Disable automining to queue transactions in mempool
        await ethers.provider.send("evm_setAutomine", [false]);
        await ethers.provider.send("evm_setIntervalMining", [0]);

        // 3. Queue both 0.5 ETH borrow transactions using explicit signature
        const tx1Promise = lendingPool.connect(bob)["borrow(uint256,uint256)"](borrowAmount, 30);
        const tx2Promise = lendingPool.connect(charlie)["borrow(uint256,uint256)"](borrowAmount, 30);

        const tx1 = await tx1Promise;
        const tx2 = await tx2Promise;

        // 4. Confirm both transactions are pending in the mempool before mining
        const pendingBlock = await ethers.provider.send("eth_getBlockByNumber", ["pending", false]);
        expect(pendingBlock.transactions).to.include(tx1.hash);
        expect(pendingBlock.transactions).to.include(tx2.hash);

        // 5. Mine one block containing both transactions
        await ethers.provider.send("evm_mine", []);

        // 6. Inspect receipts
        const receipt1 = await tx1.wait();
        const receipt2 = await ethers.provider.getTransactionReceipt(tx2.hash);

        // Assert receipt2 exists
        expect(receipt1).to.not.be.null;
        expect(receipt2).to.not.be.null;

        // Verify both receipts share the same block number
        expect(receipt1.blockNumber).to.equal(receipt2.blockNumber);

        // Verify order: tx1 has lower index than tx2
        expect(receipt1.index).to.be.lessThan(receipt2.index);

        // Verify tx1 succeeded (status 1) and tx2 reverted (status 0)
        expect(receipt1.status).to.equal(1);
        expect(receipt2.status).to.equal(0);

        // 7. Verify the actual revert reason for tx2 via direct historical transaction trace
        const trace = await ethers.provider.send("debug_traceTransaction", [tx2.hash, {}]);
        expect(trace.failed, "Transaction trace should show execution failure").to.be.true;
        expect(trace.returnValue, "Transaction trace should contain non-empty return bytes").to.be.a("string");
        expect(trace.returnValue).to.match(/^0x08c379a0/);

        // Decode the Error(string) payload (4-byte selector 0x08c379a0 + ABI-encoded string)
        const hexPayload = "0x" + trace.returnValue.replace(/^0x/, "").slice(8);
        const decodedRevertReason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], hexPayload)[0];
        expect(decodedRevertReason).to.equal("Utilization exceeds 90% cap");

        // Dual confirmation: simulation against post-tx1 block state also proves identical revert
        let simError = "";
        try {
          await ethers.provider.call(
            {
              from: charlie.address,
              to: await lendingPool.getAddress(),
              data: tx2.data,
            },
            receipt1.blockNumber
          );
        } catch (err) {
          simError = err.message || "";
        }
        expect(simError).to.include("Utilization exceeds 90% cap");

        // 8. Confirm pool state after the block
        expect(await lendingPool.totalActiveLoans()).to.equal(borrowAmount);
        expect(await ethers.provider.getBalance(await lendingPool.getAddress())).to.equal(ethers.parseEther("0.5"));

      } finally {
        // 9. Restore automining baseline even if test fails
        await ethers.provider.send("evm_setAutomine", [true]);
      }
    });
  });

  describe("Group 3: Sequential Multi-Block Utilization Persistence", function () {
    it("enforces 90% cap across subsequent blocks while active loan is outstanding", async function () {
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });

      const shareTransfer = ethers.parseEther("0.05");
      await glpToken.connect(alice).transfer(bob.address, shareTransfer);
      await glpToken.connect(alice).transfer(charlie.address, shareTransfer);

      // Bob borrows 0.5 ETH
      await lendingPool.connect(bob)["borrow(uint256,uint256)"](ethers.parseEther("0.5"), 30);
      expect(await lendingPool.totalActiveLoans()).to.equal(ethers.parseEther("0.5"));

      // Advance several blocks
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);

      // Charlie attempts to borrow 0.45 ETH (0.5 + 0.45 = 0.95 ETH / 1.0 ETH = 95% > 90%)
      await expect(
        lendingPool.connect(charlie)["borrow(uint256,uint256)"](ethers.parseEther("0.45"), 30)
      ).to.be.revertedWith("Utilization exceeds 90% cap");
    });
  });

  describe("Group 4: Interest Accrual, Rate Locking & Repayment Waterfall", function () {
    it("locks interest rate at origination based on post-borrow utilization and credit surcharge", async function () {
      // 1 ETH deposit
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });
      await glpToken.connect(alice).transfer(bob.address, ethers.parseEther("0.05"));

      // Bob borrows 0.5 ETH.
      // Pool total assets = 1 ETH. Post-borrow active loans = 0.5 ETH.
      // Utilization = 5000 bps (50%).
      // Base kinked curve: U <= 8000 bps -> Rate = 400 + (5000 * 500) / 8000 = 400 + 312 = 712 bps.
      // Credit score = 50 (Tier < 60) -> credit surcharge = +200 bps.
      // Expected locked interest rate = 712 + 200 = 912 bps (9.12%).
      await lendingPool.connect(bob)["borrow(uint256,uint256)"](ethers.parseEther("0.5"), 30);

      const loan = await lendingPool.loans(bob.address);
      expect(loan.interestRateBps).to.equal(912n);
      expect(loan.principal).to.equal(ethers.parseEther("0.5"));
      expect(loan.tenureDays).to.equal(30n);
    });

    it("accrues simple interest accurately and splits repayments into 10% reserve and 90% free pool cash", async function () {
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });
      await glpToken.connect(alice).transfer(bob.address, ethers.parseEther("0.05"));

      const borrowAmount = ethers.parseEther("0.4");
      await lendingPool.connect(bob)["borrow(uint256,uint256)"](borrowAmount, 30);

      const loanBefore = await lendingPool.loans(bob.address);
      const originationTime = loanBefore.originationTime;
      const rateBps = loanBefore.interestRateBps;

      // Fast forward 15 days
      const elapsedSeconds = 15n * SECONDS_PER_DAY;
      const targetTimestamp = originationTime + elapsedSeconds;
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(targetTimestamp)]);
      await ethers.provider.send("evm_mine", []);

      // Calculate expected accrued interest at the mined block:
      const expectedInterest = (borrowAmount * rateBps * elapsedSeconds) / (10000n * 365n * SECONDS_PER_DAY);
      const pendingInterest = await lendingPool.getAccruedInterest(bob.address, { blockTag: "latest" });
      expect(pendingInterest).to.equal(expectedInterest);

      // Pin exact timestamp for repay transaction
      const repayTime = targetTimestamp + SECONDS_PER_DAY;
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(repayTime)]);

      const totalElapsedAtRepay = elapsedSeconds + SECONDS_PER_DAY;
      const expectedInterestAtRepay = (borrowAmount * rateBps * totalElapsedAtRepay) / (10000n * 365n * SECONDS_PER_DAY);
      const repayAmount = expectedInterestAtRepay + ethers.parseEther("0.1");
      const reserveBefore = await lendingPool.insuranceReserve();

      await lendingPool.connect(bob).repay({ value: repayAmount });

      // Reserve contribution = floor(expectedInterestAtRepay * 10 / 100)
      const expectedReserveCut = (expectedInterestAtRepay * 10n) / 100n;
      const reserveAfter = await lendingPool.insuranceReserve();
      expect(reserveAfter - reserveBefore).to.equal(expectedReserveCut);

      // Remaining principal should be 0.4 ETH - 0.1 ETH = 0.3 ETH
      const loanAfter = await lendingPool.loans(bob.address);
      expect(loanAfter.principal).to.equal(ethers.parseEther("0.3"));
      expect(loanAfter.accruedInterest).to.equal(0n);
    });

    it("handles overpayment refunds and cleans up loan state upon full repayment", async function () {
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });
      await glpToken.connect(alice).transfer(bob.address, ethers.parseEther("0.05"));

      const borrowAmount = ethers.parseEther("0.2");
      await lendingPool.connect(bob)["borrow(uint256,uint256)"](borrowAmount, 10);

      const loan = await lendingPool.loans(bob.address);
      const originationTime = loan.originationTime;

      // Pin exact timestamp for repayment 5 days later
      const elapsedSeconds = 5n * SECONDS_PER_DAY;
      const repayTime = originationTime + elapsedSeconds;
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(repayTime)]);

      const expectedInterest = (borrowAmount * loan.interestRateBps * elapsedSeconds) / (10000n * 365n * SECONDS_PER_DAY);
      const expectedTotalDue = borrowAmount + expectedInterest;
      const overpayment = ethers.parseEther("0.5"); // paying way more than totalDue

      const bobBalBefore = await ethers.provider.getBalance(bob.address);
      const tx = await lendingPool.connect(bob).repay({ value: overpayment });
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const bobBalAfter = await ethers.provider.getBalance(bob.address);

      // Net change for Bob should equal expectedTotalDue + gasCost
      expect(bobBalBefore - bobBalAfter - gasCost).to.equal(expectedTotalDue);

      // Loan should be fully cleaned up
      const loanFinal = await lendingPool.loans(bob.address);
      expect(loanFinal.principal).to.equal(0n);
      expect(await lendingPool.activeLoans(bob.address)).to.equal(0n);
    });
  });

  describe("Group 5: Default Impairment & Approach A Waterfall", function () {
    it("reverts if default is marked before grace period has elapsed", async function () {
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });
      await glpToken.connect(alice).transfer(bob.address, ethers.parseEther("0.05"));

      await lendingPool.connect(bob)["borrow(uint256,uint256)"](ethers.parseEther("0.2"), 10);

      // Try marking default immediately
      await expect(
        lendingPool.markDefault(bob.address)
      ).to.be.revertedWith("Grace period not elapsed");

      // Advance to due date (10 days) but before grace period (10 + 3 days = 13 days)
      const loan = await lendingPool.loans(bob.address);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(loan.dueDate + 1n * SECONDS_PER_DAY)]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        lendingPool.markDefault(bob.address)
      ).to.be.revertedWith("Grace period not elapsed");
    });

    it("settles default under exact boundary threshold fixture (415238095238093787 wei GLP)", async function () {
      // Setup the exact boundary fixture:
      // P = 0.40 ETH = 400,000,000,000,000,000 wei
      // Unimpaired pool has:
      // Av = 10.5 ETH + 1e6 = 10,500,000,000,001,000,000
      // Sv = 10.9 ETH + 1e6 = 10,900,000,000,001,000,000
      // S_threshold = ceil(P * Sv / Av) = 415,238,095,238,093,787 wei GLP

      // 1. Establish pool state:
      await lendingPool.connect(alice).deposit({ value: ethers.parseEther("10.9") });

      // Transfer exact S_threshold to Bob
      const thresholdShares = 415238095238093787n;
      await glpToken.connect(alice).transfer(bob.address, thresholdShares);

      // Bob borrows 0.4 ETH
      const borrowAmount = ethers.parseEther("0.4");
      await lendingPool.connect(bob)["borrow(uint256,uint256)"](borrowAmount, 10);

      // Pool cash = 10.9 ETH - 0.4 ETH = 10.5 ETH.
      // Total active loans = 0.4 ETH.
      // unimpairedLoans = totalActiveLoans - loan.principal = 0.
      // Free cash = 10.5 ETH - reserve (0) = 10.5 ETH.
      // Av = 10.5 ETH + 1e6, Sv = 10.9 ETH + 1e6. Exactly matching the mathematical fixture!

      const loan = await lendingPool.loans(bob.address);
      // Fast forward past grace period (10 + 3 = 13 days; skip to +8 days)
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(loan.dueDate + 8n * SECONDS_PER_DAY)]);
      await ethers.provider.send("evm_mine", []);

      // Mark default
      const tx = await lendingPool.markDefault(bob.address);
      const receipt = await tx.wait();

      // Find DefaultSettled event
      const defaultEvent = receipt.logs
        .map((log) => {
          try {
            return lendingPool.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "DefaultSettled");

      expect(defaultEvent).to.not.be.undefined;
      const [borrower, sharesBurned, principalExtinguished, reserveCovered, writtenOffPrincipal, accruedInterest] =
        defaultEvent.args;

      expect(borrower).to.equal(bob.address);
      expect(sharesBurned).to.equal(thresholdShares);
      expect(principalExtinguished).to.equal(borrowAmount);
      expect(reserveCovered).to.equal(0n);
      expect(writtenOffPrincipal).to.equal(0n);
      // Reserve drawn is 0
      expect(await lendingPool.reserveDrawn(bob.address)).to.equal(0n);
      // Only unpaid accrued interest is recorded in off-balance memorandum writtenOffDebt
      expect(await lendingPool.writtenOffDebt(bob.address)).to.equal(accruedInterest);
      expect(await lendingPool.isDefaulter(bob.address)).to.be.true;
    });

    it("settles default under one-wei-below-threshold fixture (415238095238093786 wei GLP)", async function () {
      // Sv = 10.9 ETH, Av = 10.5 ETH
      await lendingPool.connect(alice).deposit({ value: ethers.parseEther("10.9") });

      // Give Bob 1 wei less than threshold: 415238095238093786 wei GLP
      const belowThresholdShares = 415238095238093786n;
      await glpToken.connect(alice).transfer(bob.address, belowThresholdShares);

      // Directly seed insurance reserve with 0.1 ETH so it can absorb shortfalls without altering free cash or GLP supply
      await lendingPool.fundInsuranceReserve({ value: ethers.parseEther("0.1") });
      const reserveBal = await lendingPool.insuranceReserve();
      expect(reserveBal).to.equal(ethers.parseEther("0.1"));

      // Bob borrows 0.4 ETH
      const borrowAmount = ethers.parseEther("0.4");
      await lendingPool.connect(bob)["borrow(uint256,uint256)"](borrowAmount, 10);

      const loan = await lendingPool.loans(bob.address);
      // Fast forward past grace period
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(loan.dueDate + 8n * SECONDS_PER_DAY)]);
      await ethers.provider.send("evm_mine", []);

      // Mark default
      const tx = await lendingPool.markDefault(bob.address);
      const receipt = await tx.wait();

      const defaultEvent = receipt.logs
        .map((log) => {
          try {
            return lendingPool.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "DefaultSettled");

      const [, sharesBurned, principalExtinguished, reserveCovered] = defaultEvent.args;
      // All shares burned
      expect(sharesBurned).to.equal(belowThresholdShares);
      // Principal extinguished is strictly 1 wei less than full 0.4 ETH (399999999999999999 wei)
      expect(principalExtinguished).to.equal(borrowAmount - 1n);
      // The 1-wei shortfall was absorbed by insurance reserve
      expect(reserveCovered).to.equal(1n);
      expect(await lendingPool.reserveDrawn(bob.address)).to.equal(1n);
    });

    it("settles default with empty reserve and zero borrower shares (pure socialized loss)", async function () {
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });

      // Give Bob shares to borrow, then transfer away
      await glpToken.connect(alice).transfer(bob.address, ethers.parseEther("0.05"));
      const borrowAmount = ethers.parseEther("0.3");
      await lendingPool.connect(bob)["borrow(uint256,uint256)"](borrowAmount, 10);

      // Bob transfers all GLP shares to Charlie (0 shares remaining for Bob)
      const bobShares = await glpToken.balanceOf(bob.address);
      await glpToken.connect(bob).transfer(charlie.address, bobShares);
      expect(await glpToken.balanceOf(bob.address)).to.equal(0n);
      expect(await lendingPool.insuranceReserve()).to.equal(0n);

      const loan = await lendingPool.loans(bob.address);
      // Fast-forward past grace period
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(loan.dueDate + 8n * SECONDS_PER_DAY)]);
      await ethers.provider.send("evm_mine", []);

      // Mark default
      const tx = await lendingPool.markDefault(bob.address);
      const receipt = await tx.wait();

      const defaultEvent = receipt.logs
        .map((log) => {
          try {
            return lendingPool.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed) => parsed && parsed.name === "DefaultSettled");

      const [, sharesBurned, principalExtinguished, reserveCovered, writtenOffPrincipal, accruedInterest] = defaultEvent.args;

      expect(sharesBurned).to.equal(0n);
      expect(principalExtinguished).to.equal(0n);
      expect(reserveCovered).to.equal(0n);
      expect(writtenOffPrincipal).to.equal(borrowAmount);
      expect(await lendingPool.totalActiveLoans()).to.equal(0n);
      expect(await lendingPool.writtenOffDebt(bob.address)).to.equal(borrowAmount + accruedInterest);
      expect(await lendingPool.isDefaulter(bob.address)).to.be.true;

      // Invariant: repeating markDefault on already defaulted borrower reverts
      await expect(
        lendingPool.markDefault(bob.address)
      ).to.be.revertedWith("No active principal");
    });
  });

  describe("Group 6: Written-Off Debt Recovery & Defaulter Rehabilitation", function () {
    it("recovers written-off debt with reserve-first replenishment, 90/10 split, and clears defaulter status", async function () {
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });
      await glpToken.connect(alice).transfer(bob.address, ethers.parseEther("0.05"));

      // Bob borrows 0.3 ETH
      await lendingPool.connect(bob)["borrow(uint256,uint256)"](ethers.parseEther("0.3"), 10);

      const loan = await lendingPool.loans(bob.address);
      // Fast-forward past grace period
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(loan.dueDate + 8n * SECONDS_PER_DAY)]);
      await ethers.provider.send("evm_mine", []);

      // Mark default (reserve is 0, so Stage 3 socialized loss write-off absorbs remaining principal)
      await lendingPool.markDefault(bob.address);

      expect(await lendingPool.isDefaulter(bob.address)).to.be.true;
      const writtenOff = await lendingPool.writtenOffDebt(bob.address);
      const resDrawn = await lendingPool.reserveDrawn(bob.address);
      const totalDebt = writtenOff + resDrawn;
      expect(totalDebt).to.be.greaterThan(0n);

      // Bob settles debt in full
      await lendingPool.connect(bob).settleWrittenOffDebt({ value: totalDebt });

      // Verification:
      expect(await lendingPool.isDefaulter(bob.address)).to.be.false;
      expect(await lendingPool.writtenOffDebt(bob.address)).to.equal(0n);
      expect(await lendingPool.reserveDrawn(bob.address)).to.equal(0n);

      // Defaulter cooldown in CreditScore
      const cooldownUntil = await creditScore.rehabilitationCooldownUntil(bob.address);
      const latestTimestamp = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      expect(cooldownUntil).to.be.greaterThan(latestTimestamp);

      // Attempting to borrow immediately fails during cooldown
      await expect(
        lendingPool.connect(bob)["borrow(uint256,uint256)"](ethers.parseEther("0.1"), 30)
      ).to.be.revertedWith("Rehabilitation cooldown active");
    });

    it("handles partial recovery, repeated recovery, and overpayment refund correctly", async function () {
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });
      await glpToken.connect(alice).transfer(bob.address, ethers.parseEther("0.05"));

      await lendingPool.connect(bob)["borrow(uint256,uint256)"](ethers.parseEther("0.2"), 10);

      const loan = await lendingPool.loans(bob.address);
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(loan.dueDate + 8n * SECONDS_PER_DAY)]);
      await ethers.provider.send("evm_mine", []);

      await lendingPool.markDefault(bob.address);
      const totalDebt = await lendingPool.writtenOffDebt(bob.address);
      expect(totalDebt).to.be.greaterThan(0n);

      // 1. Partial Recovery: Bob pays exactly half of the debt
      const partialPayment = totalDebt / 2n;
      await lendingPool.connect(bob).settleWrittenOffDebt({ value: partialPayment });

      // Invariant: Partial repayment decreases debt but keeps isDefaulter true
      expect(await lendingPool.isDefaulter(bob.address)).to.be.true;
      const remainingDebt = await lendingPool.writtenOffDebt(bob.address);
      expect(remainingDebt).to.equal(totalDebt - partialPayment);

      // 2. Repeated Recovery with Overpayment: Bob sends 1 ETH to settle the remainder
      const overpayment = ethers.parseEther("1.0");
      const bobBalBefore = await ethers.provider.getBalance(bob.address);
      const tx = await lendingPool.connect(bob).settleWrittenOffDebt({ value: overpayment });
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const bobBalAfter = await ethers.provider.getBalance(bob.address);

      // Net change for Bob equals exact remaining debt + gas (excess was refunded!)
      expect(bobBalBefore - bobBalAfter - gasCost).to.equal(remainingDebt);

      // Invariant: Debt fully cleared and defaulter flag extinguished
      expect(await lendingPool.writtenOffDebt(bob.address)).to.equal(0n);
      expect(await lendingPool.isDefaulter(bob.address)).to.be.false;

      // 3. Attempting to settle again when totalDebt == 0 reverts immediately
      await expect(
        lendingPool.connect(bob).settleWrittenOffDebt({ value: ethers.parseEther("0.01") })
      ).to.be.revertedWith("No debt to settle");
    });
  });

  describe("Group 7: Legacy API Compatibility", function () {
    it("supports legacy borrow(amount) defaulting to 30-day tenure", async function () {
      await lendingPool.connect(alice).deposit({ value: ONE_ETH });
      await glpToken.connect(alice).transfer(bob.address, ethers.parseEther("0.05"));

      // Call legacy borrow
      await lendingPool.connect(bob)["borrow(uint256)"](ethers.parseEther("0.2"));

      const loan = await lendingPool.loans(bob.address);
      expect(loan.principal).to.equal(ethers.parseEther("0.2"));
      expect(loan.tenureDays).to.equal(30n);
    });
  });
});
