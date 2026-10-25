import { expect } from "chai";
import hre from "hardhat";
import { deployGigLend, register, openLoan, LOOSE, Kind } from "./helpers/fixture.js";

const { ethers } = hre;

/**
 * EventSyncEngine mimics the frontend's useEventSync.js behavior:
 * - Listens or queries contract logs
 * - Deduplicates logs using `${txHash}-${logIndex}`
 * - Tracks last synced block
 * - Filters account-specific versus protocol-wide events
 * - Validates chain ID
 */
class EventSyncEngine {
  // `contracts` may be one contract or several (LendingPool + LoanManager, as useEventSync does).
  constructor(contracts, userAddress, targetChainId = 31337) {
    this.contracts = Array.isArray(contracts) ? contracts : [contracts];
    this.userAddress = userAddress ? userAddress.toLowerCase() : null;
    this.targetChainId = targetChainId;
    this.seenLogKeys = new Set();
    this.confirmedEvents = [];
    this.lastSyncedBlock = 0;
    this.isConnected = true;
  }

  setAccount(newAccount) {
    this.userAddress = newAccount ? newAccount.toLowerCase() : null;
  }

  disconnect() {
    this.isConnected = false;
  }

  reconnect() {
    this.isConnected = true;
  }

  handleRemovedLog(keyOrTxHash, maybeLogIndex) {
    const key = maybeLogIndex !== undefined ? `${keyOrTxHash}-${maybeLogIndex}` : keyOrTxHash;
    this.seenLogKeys.delete(key);
    this.confirmedEvents = this.confirmedEvents.filter(e => e.key !== key);
  }

  async syncEvents(fromBlock, toBlock, currentNetworkChainId = 31337) {
    // Network validation
    if (currentNetworkChainId !== this.targetChainId) {
      throw new Error(`Chain mismatch: expected ${this.targetChainId}, got ${currentNetworkChainId}`);
    }

    if (!this.isConnected) {
      // Disconnected client does not sync
      return [];
    }

    const addresses = await Promise.all(this.contracts.map((c) => c.getAddress()));
    const logs = (
      await Promise.all(addresses.map((address) => ethers.provider.getLogs({ address, fromBlock, toBlock })))
    )
      .flat()
      .sort((a, b) => a.blockNumber - b.blockNumber || (a.index ?? a.logIndex) - (b.index ?? b.logIndex));
    const byAddress = Object.fromEntries(addresses.map((a, i) => [a.toLowerCase(), this.contracts[i]]));
    const newItems = [];

    for (const log of logs) {
      const key = `${log.transactionHash}-${log.index ?? log.logIndex}`;
      if (this.seenLogKeys.has(key)) {
        continue; // Deduplication
      }
      this.seenLogKeys.add(key);

      try {
        const parsed = byAddress[log.address.toLowerCase()].interface.parseLog(log);
        if (parsed) {
          const item = {
            key,
            eventName: parsed.name,
            args: parsed.args,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash
          };
          this.confirmedEvents.push(item);
          newItems.push(item);
        }
      } catch {
        // Unknown log or different event interface
      }
    }

    this.lastSyncedBlock = toBlock;
    return newItems;
  }

  getUserEvents() {
    if (!this.userAddress) return [];
    return this.confirmedEvents.filter(ev => {
      // Check if user is indexed or param in event args
      const user = ev.args.user || ev.args.borrower || ev.args.lender;
      return user && user.toLowerCase() === this.userAddress;
    });
  }

  getProtocolEvents() {
    return this.confirmedEvents;
  }
}

describe("GigLend Cross-Client Event Synchronization Suite (migrated to V3)", function () {
  let ctx, lendingPool, loanManager, glpToken;
  let owner, alice, bob;
  let clientA, clientB;
  let startBlock;

  beforeEach(async function () {
    ctx = await deployGigLend(LOOSE);
    ({ pool: lendingPool, loanManager, glp: glpToken } = ctx);
    owner = ctx.admin;
    [alice, bob] = ctx.users;
    startBlock = await ethers.provider.getBlockNumber();

    // Like useEventSync: both clients follow the pool and the loan engine.
    clientA = new EventSyncEngine([lendingPool, loanManager], alice.address, 31337);
    clientB = new EventSyncEngine([lendingPool, loanManager], bob.address, 31337);
  });

  it("1. Client A deposits -> Client B sees confirmed update & pool liquidity", async function () {
    // Initial sync
    const b0 = await ethers.provider.getBlockNumber();
    await clientA.syncEvents(startBlock, b0);
    await clientB.syncEvents(startBlock, b0);

    // Client A deposits 2.0 ETH
    const depositAmount = ethers.parseEther("2.0");
    const tx = await lendingPool.connect(alice).deposit({ value: depositAmount });
    const receipt = await tx.wait();

    // Client B syncs logs from the chain
    const b1 = receipt.blockNumber;
    await clientB.syncEvents(b0 + 1, b1);

    // Client B observes Deposited event
    const eventsB = clientB.getProtocolEvents();
    const depositEv = eventsB.find(e => e.eventName === "Deposited" && e.args.user.toLowerCase() === alice.address.toLowerCase());
    expect(depositEv).to.not.be.undefined;
    expect(depositEv.args.amount).to.equal(depositAmount);

    // Client B queries updated pool liquidity
    expect(await lendingPool.freeCash()).to.equal(depositAmount);
  });

  it("2. Client A borrows -> Client B sees confirmed loan event and updated pool state", async function () {
    // Fund pool with 5 ETH from owner
    await lendingPool.connect(owner).deposit({ value: ethers.parseEther("5.0") });
    // Alice is a verified, registered member
    await lendingPool.connect(alice).deposit({ value: ethers.parseEther("0.1") });
    await register(ctx, alice);

    const b0 = await ethers.provider.getBlockNumber();

    // Client A borrows 0.3 ETH over 2 weekly installments (14 days)
    const borrowAmount = ethers.parseEther("0.3");
    const tx = await loanManager.connect(alice).openLoan(Kind.Builder, borrowAmount, 2, ethers.ZeroAddress, false);
    const receipt = await tx.wait();

    // Client B syncs
    await clientB.syncEvents(b0 + 1, receipt.blockNumber);

    // Client B sees confirmed Borrowed event
    const origEvents = clientB.getProtocolEvents().filter(e => e.eventName === "Borrowed");
    expect(origEvents.length).to.equal(1);
    expect(origEvents[0].args.user.toLowerCase()).to.equal(alice.address.toLowerCase());
    expect(origEvents[0].args.amount).to.equal(borrowAmount);
    expect(origEvents[0].args.tenureDays).to.equal(14n);

    // Client B observes the outstanding-loans update
    expect(await loanManager.totalOutstanding()).to.equal(borrowAmount);
  });

  it("3. Repayment updates both clients", async function () {
    // Setup deposit and borrow for Alice
    await lendingPool.connect(owner).deposit({ value: ethers.parseEther("5.0") });
    await lendingPool.connect(alice).deposit({ value: ethers.parseEther("0.1") });
    await register(ctx, alice);
    const borrowAmount = ethers.parseEther("0.2");
    const { loanId } = await openLoan(ctx, alice, { amount: borrowAmount });

    const b0 = await ethers.provider.getBlockNumber();

    // Repay part of the loan (interest first, then principal)
    const repayAmount = ethers.parseEther("0.1");
    const tx = await loanManager.connect(alice).repayInstallment(loanId, { value: repayAmount });
    const receipt = await tx.wait();

    // Both clients sync
    await clientA.syncEvents(b0 + 1, receipt.blockNumber);
    await clientB.syncEvents(b0 + 1, receipt.blockNumber);

    // Both observe Repaid event
    const aEvents = clientA.getProtocolEvents().filter(e => e.eventName === "Repaid");
    const bEvents = clientB.getProtocolEvents().filter(e => e.eventName === "Repaid");
    expect(aEvents.length).to.equal(1);
    expect(bEvents.length).to.equal(1);
    expect(aEvents[0].args.user.toLowerCase()).to.equal(alice.address.toLowerCase());
    expect(bEvents[0].args.amount).to.equal(repayAmount);

    // Both see reduced principal
    const aliceLoan = await loanManager.getLoan(loanId);
    expect(aliceLoan.outstandingPrincipal).to.be.lessThan(borrowAmount);
  });

  it("4. Withdrawal updates both clients", async function () {
    // Alice deposits 1.0 ETH
    await lendingPool.connect(alice).deposit({ value: ethers.parseEther("1.0") });
    const b0 = await ethers.provider.getBlockNumber();

    // Alice withdraws 0.4 GLP shares
    const withdrawShares = ethers.parseEther("0.4");
    const tx = await lendingPool.connect(alice).withdraw(withdrawShares);
    const receipt = await tx.wait();

    // Both clients sync
    await clientA.syncEvents(b0 + 1, receipt.blockNumber);
    await clientB.syncEvents(b0 + 1, receipt.blockNumber);

    // Both observe Withdrawn event
    const aWithdraw = clientA.getProtocolEvents().filter(e => e.eventName === "Withdrawn");
    const bWithdraw = clientB.getProtocolEvents().filter(e => e.eventName === "Withdrawn");
    expect(aWithdraw.length).to.equal(1);
    expect(bWithdraw.length).to.equal(1);
    expect(aWithdraw[0].args.glpBurned).to.equal(withdrawShares);

    // GLP supply and balance decreased
    const aliceGlp = await glpToken.balanceOf(alice.address);
    expect(aliceGlp).to.equal(ethers.parseEther("0.6"));
  });

  it("5. Failed or reverted transaction does not appear as a successful transaction", async function () {
    // Pool has 0.5 ETH total capital (0.45 ETH owner + 0.05 ETH Alice)
    await lendingPool.connect(owner).deposit({ value: ethers.parseEther("0.45") });
    await lendingPool.connect(alice).deposit({ value: ethers.parseEther("0.05") });
    await register(ctx, alice);

    const bSetup = await ethers.provider.getBlockNumber();
    await clientA.syncEvents(startBlock, bSetup);
    await clientB.syncEvents(startBlock, bSetup);

    const countBeforeA = clientA.getProtocolEvents().length;
    const countBeforeB = clientB.getProtocolEvents().length;

    // 0.48 ETH of a 0.5 ETH pool exceeds the 90% cap (96%)
    await expect(
      loanManager.connect(alice).openLoan(Kind.Builder, ethers.parseEther("0.48"), 2, ethers.ZeroAddress, false)
    ).to.be.revertedWith("Utilization exceeds 90% cap");

    const bAfter = await ethers.provider.getBlockNumber();

    // Sync any logs in the mined range after the reverted attempt
    await clientA.syncEvents(bSetup + 1, bAfter);
    await clientB.syncEvents(bSetup + 1, bAfter);

    // No new events should have been added
    expect(clientA.getProtocolEvents().length).to.equal(countBeforeA);
    expect(clientB.getProtocolEvents().length).to.equal(countBeforeB);
  });

  it("6. Disconnected client reconnects and catches up on missed events", async function () {
    const b0 = await ethers.provider.getBlockNumber();
    await clientB.syncEvents(startBlock, b0);

    // Client B disconnects
    clientB.disconnect();

    // While B is offline, Alice deposits and then borrows
    await lendingPool.connect(alice).deposit({ value: ethers.parseEther("2.0") });
    await register(ctx, alice);
    await openLoan(ctx, alice, { amount: ethers.parseEther("0.2") });

    const bOffline = await ethers.provider.getBlockNumber();

    // B attempts sync while disconnected -> returns empty
    const offlineItems = await clientB.syncEvents(b0 + 1, bOffline);
    expect(offlineItems.length).to.equal(0);
    expect(clientB.getProtocolEvents().length).to.equal(0);

    // B reconnects and catches up from lastSyncedBlock + 1 to latest
    clientB.reconnect();
    const caughtUp = await clientB.syncEvents(clientB.lastSyncedBlock + 1, bOffline);

    expect(caughtUp.length).to.be.at.least(2); // Deposited + Borrowed
    const eventNames = caughtUp.map(e => e.eventName);
    expect(eventNames).to.include("Deposited");
    expect(eventNames).to.include("Borrowed");
  });

  it("7. Duplicate event delivery does not create duplicate history entries", async function () {
    // Alice deposits 1.0 ETH
    const tx = await lendingPool.connect(alice).deposit({ value: ethers.parseEther("1.0") });
    const receipt = await tx.wait();

    // Initial sync
    await clientA.syncEvents(receipt.blockNumber, receipt.blockNumber);
    const countAfterFirstSync = clientA.getProtocolEvents().length;
    expect(countAfterFirstSync).to.equal(1);

    // Redundant resync over the exact same block range (simulating WebSocket duplicate push / polling overlap)
    await clientA.syncEvents(receipt.blockNumber, receipt.blockNumber);
    const countAfterSecondSync = clientA.getProtocolEvents().length;

    // Deduplication prevents duplicate entries
    expect(countAfterSecondSync).to.equal(countAfterFirstSync);
    expect(clientA.seenLogKeys.size).to.equal(1);
  });

  it("8. Switching accounts or networks does not mix data between users or chains", async function () {
    // Alice and Bob both deposit
    await lendingPool.connect(alice).deposit({ value: ethers.parseEther("1.0") });
    await lendingPool.connect(bob).deposit({ value: ethers.parseEther("0.5") });

    const b = await ethers.provider.getBlockNumber();
    await clientA.syncEvents(startBlock, b);

    // While clientA is set to Alice:
    const aliceEvents = clientA.getUserEvents();
    expect(aliceEvents.every(e => e.args.user.toLowerCase() === alice.address.toLowerCase())).to.be.true;

    // Now switch clientA's account to Bob
    clientA.setAccount(bob.address);
    const bobEvents = clientA.getUserEvents();
    expect(bobEvents.every(e => e.args.user.toLowerCase() === bob.address.toLowerCase())).to.be.true;

    // Validate chain isolation: syncing against an incorrect chain ID must throw and reject
    await expect(
      clientA.syncEvents(startBlock, b, 1) // Mainnet chain ID 1 instead of 31337
    ).to.be.rejectedWith("Chain mismatch: expected 31337, got 1");
  });

  it("9. Handles chain reorganizations and purges removed logs from confirmed state", async function () {
    // Alice deposits 1.0 ETH
    const tx = await lendingPool.connect(alice).deposit({ value: ethers.parseEther("1.0") });
    const receipt = await tx.wait();

    // Initial sync confirms the event
    await clientA.syncEvents(receipt.blockNumber, receipt.blockNumber);
    expect(clientA.getProtocolEvents().length).to.equal(1);

    // Simulate reorg delivery with removed: true
    const event = clientA.getProtocolEvents()[0];
    clientA.handleRemovedLog(event.key);

    // Confirmed event is purged and key is removed from seen set
    expect(clientA.getProtocolEvents().length).to.equal(0);
    expect(clientA.seenLogKeys.has(event.key)).to.be.false;
  });
});
