import { expect } from "chai";
import hre from "hardhat";
import {
  deployGigLend,
  register,
  openLoan,
  qualify,
  depositFor,
  advanceDays,
  advanceTo,
  findEvent,
  idHashOf,
  signAttestation,
  Kind,
  LOOSE,
} from "./helpers/fixture.js";

const { ethers } = hre;
const E = (v) => ethers.parseEther(String(v));
const State = { None: 0, Active: 1, Succeeded: 2, Defeated: 3, Executed: 4, Cancelled: 5 };
const ProposalKind = { Expel: 0, Reinstate: 1 };

// Expulsion voting, identity bans and debt enforcement. Defaulters here borrow with no stake
// cover so the default leaves an unpaid claim (the definition of a defaulter).
describe("Defaulter governance, identity bans and debt enforcement", function () {
  let ctx, pool, glp, lm, dm, registry, gov, score;
  let alice, bob, carol, dave, erin, frank, newWallet;

  beforeEach(async function () {
    ctx = await deployGigLend({ ...LOOSE, unsecuredStakeCoverBps: 0 });
    ({ pool, glp, loanManager: lm, defaultManager: dm, registry, governance: gov, score } = ctx);
    [alice, bob, carol, dave, erin, frank, newWallet] = ctx.users;
    await depositFor(ctx, alice, E(5)); // main lender and proposer
  });

  const BOB_ID = idHashOf("BOBDE1234F");

  /** Bob borrows with no stake and defaults, leaving an unpaid claim. */
  async function makeDefaulter() {
    await register(ctx, bob, { idHash: BOB_ID });
    await qualify(ctx, bob);
    const { loanId } = await openLoan(ctx, bob, { kind: Kind.Unsecured, amount: E(0.3) });
    const loan = await lm.getLoan(loanId);
    await advanceTo(loan.nextDueDate + 31n * ctx.spd);
    await lm.markDefault(loanId);
    expect(await pool.isDefaulter(bob.address)).to.equal(true);
    return registry.memberOf(bob.address);
  }

  const period = () => 3n * ctx.spd;

  async function proposeExpel(by = alice) {
    const receipt = await (await gov.connect(by).proposeExpel(bob.address)).wait();
    return findEvent(receipt, gov, "ProposalCreated").proposalId;
  }

  /** Gives `user` exactly `shares` GLP (transferred from alice) and registers them. */
  async function voterWith(user, shares) {
    await register(ctx, user);
    await glp.connect(alice).transfer(user.address, shares);
  }

  async function passExpulsion() {
    const id = await proposeExpel();
    await gov.connect(alice).vote(id, true); // alice alone is well above the 20% quorum
    await advanceDays(ctx, 3);
    await gov.execute(id);
    return id;
  }

  describe("Identity registry bans", function () {
    it("only the governance contract can ban or unban an identity", async function () {
      await expect(registry.connect(alice).banIdentity(BOB_ID)).to.be.reverted;
      await expect(registry.connect(ctx.admin).banIdentity(BOB_ID)).to.be.reverted;
      expect(await registry.hasRole(ethers.id("GOVERNANCE_ROLE"), await gov.getAddress())).to.equal(true);
    });

    it("exposes isVerified, identityOf and isBanned", async function () {
      await register(ctx, bob, { idHash: BOB_ID });
      expect(await registry.isVerified(bob.address)).to.equal(true);
      expect(await registry.identityOf(bob.address)).to.equal(BOB_ID);
      expect(await registry.isBanned(bob.address)).to.equal(false);
      expect(await registry.isVerified(carol.address)).to.equal(false);
    });
  });

  describe("Proposals", function () {
    it("a proposal against a non-defaulter reverts", async function () {
      await register(ctx, bob, { idHash: BOB_ID });
      await expect(gov.connect(alice).proposeExpel(bob.address)).to.be.revertedWith("Target is not a defaulter");
    });

    it("only verified GLP holders can propose, and only one open proposal per target", async function () {
      await makeDefaulter();
      await expect(gov.connect(carol).proposeExpel(bob.address)).to.be.revertedWith("Proposer not verified");
      await register(ctx, carol);
      await expect(gov.connect(carol).proposeExpel(bob.address)).to.be.revertedWith("Proposer holds no GLP");
      await expect(gov.connect(alice).proposeExpel(bob.address)).to.emit(gov, "ProposalCreated");
      await expect(gov.connect(alice).proposeExpel(bob.address)).to.be.revertedWith("Open proposal exists");
    });
  });

  describe("Voting weight", function () {
    it("uses balances at the snapshot block; tokens moved later add no weight and nobody votes twice", async function () {
      await makeDefaulter();
      await voterWith(carol, E(1));
      await register(ctx, dave);
      const id = await proposeExpel();
      const p = await gov.getProposal(id);

      // Carol moves her GLP to Dave after the snapshot and votes first.
      await expect(gov.connect(carol).vote(id, true))
        .to.emit(gov, "VoteCast")
        .withArgs(id, carol.address, true, E(1));
      await glp.connect(carol).transfer(dave.address, E(1));
      await expect(gov.connect(carol).vote(id, false)).to.be.revertedWith("Already voted");
      await expect(gov.connect(dave).vote(id, true)).to.be.revertedWith("No voting power at snapshot");

      expect(await glp.getPastVotes(carol.address, p.snapshotBlock)).to.equal(E(1));
      expect((await gov.getProposal(id)).forVotes).to.equal(E(1));
    });

    it("holders are self-delegated automatically", async function () {
      expect(await glp.delegates(alice.address)).to.equal(alice.address);
      expect(await glp.getVotes(alice.address)).to.equal(await glp.balanceOf(alice.address));
    });

    it("the target and unverified wallets cannot vote", async function () {
      await makeDefaulter();
      await depositFor(ctx, bob, E(0.1)); // bob holds some GLP after defaulting
      await advanceDays(ctx, 0.01);
      const id = await proposeExpel();
      await expect(gov.connect(bob).vote(id, false)).to.be.revertedWith("Target cannot vote");
      await expect(gov.connect(frank).vote(id, true)).to.be.revertedWith("Voter not verified");
    });
  });

  describe("Quorum and threshold", function () {
    async function setup(forShares, againstShares) {
      await makeDefaulter();
      const supply = await glp.totalSupply();
      const q = (supply * 2000n) / 10000n;
      if (forShares !== null) await voterWith(carol, forShares(q));
      if (againstShares !== null) await voterWith(dave, againstShares(q));
      const id = await proposeExpel();
      expect(await gov.quorum(id)).to.equal(q);
      if (forShares !== null) await gov.connect(carol).vote(id, true);
      if (againstShares !== null) await gov.connect(dave).vote(id, false);
      await advanceDays(ctx, 3);
      return id;
    }

    it("passes with votes exactly at the 20% quorum", async function () {
      const id = await setup((q) => q, null);
      expect(await gov.state(id)).to.equal(State.Succeeded);
    });

    it("fails one share below quorum", async function () {
      const id = await setup((q) => q - 1n, null);
      expect(await gov.state(id)).to.equal(State.Defeated);
      await expect(gov.execute(id)).to.emit(gov, "ProposalExecuted").withArgs(id, ProposalKind.Expel, bob.address, false);
      expect(await registry.isBanned(bob.address)).to.equal(false);
    });

    it("an exact 50/50 split does not pass, and shares moved after the snapshot cannot break the tie", async function () {
      const tie = await setup((q) => q, (q) => q);
      expect(await gov.state(tie)).to.equal(State.Defeated);
      await gov.execute(tie);

      await gov.connect(alice).proposeExpel(bob.address);
      const id2 = await gov.proposalCount();
      await glp.connect(alice).transfer(carol.address, 1n); // after the snapshot: no effect
      await gov.connect(carol).vote(id2, true);
      await gov.connect(dave).vote(id2, false);
      await advanceDays(ctx, 3);
      expect(await gov.state(id2)).to.equal(State.Defeated);
    });

    it("more than 50% in favour passes", async function () {
      const id = await setup((q) => q + 1n, (q) => q);
      expect(await gov.state(id)).to.equal(State.Succeeded);
    });

    it("cannot execute before the voting period ends", async function () {
      await makeDefaulter();
      const id = await proposeExpel();
      await gov.connect(alice).vote(id, true);
      await expect(gov.execute(id)).to.be.revertedWith("Voting still open");
      await advanceTo((await gov.getProposal(id)).endTime);
      await expect(gov.connect(carol).vote(id, true)).to.be.revertedWith("Voting closed");
    });
  });

  describe("Cancellation", function () {
    it("anyone can cancel once the target settles, and it can then never execute", async function () {
      const memberId = await makeDefaulter();
      const id = await proposeExpel();
      await gov.connect(alice).vote(id, true);
      await expect(gov.connect(carol).cancel(id)).to.be.revertedWith("Target still owes");

      await dm.connect(bob).settleClaim({ value: await dm.settlementQuote(memberId) });
      expect(await pool.isDefaulter(bob.address)).to.equal(false);
      await expect(gov.connect(carol).cancel(id)).to.emit(gov, "ProposalCancelled");
      expect(await gov.state(id)).to.equal(State.Cancelled);
      await advanceDays(ctx, 3);
      await expect(gov.execute(id)).to.be.revertedWith("Proposal closed");
      expect(await registry.isBanned(bob.address)).to.equal(false);
    });
  });

  describe("Execution and re-entry", function () {
    it("a passed expulsion bans the identity and marks the wallet expelled", async function () {
      await makeDefaulter();
      const id = await proposeExpel();
      await gov.connect(alice).vote(id, true);
      await advanceDays(ctx, 3);
      await expect(gov.execute(id))
        .to.emit(gov, "ProposalExecuted")
        .withArgs(id, ProposalKind.Expel, bob.address, true)
        .and.to.emit(registry, "IdentityBanned");

      expect(await registry.isIdentityBanned(BOB_ID)).to.equal(true);
      expect(await registry.isBanned(bob.address)).to.equal(true);
      expect(await registry.isVerified(bob.address)).to.equal(false);
      expect(await pool.expelled(bob.address)).to.equal(true);
      const [ok, reason] = await registry.eligibility(bob.address);
      expect(ok).to.equal(false);
      expect(reason).to.equal("Identity banned");
    });

    it("a banned person cannot register a new wallet with the same identity", async function () {
      await makeDefaulter();
      await passExpulsion();
      const { attestation, signature } = await signAttestation(registry, ctx.attester, {
        wallet: newWallet.address,
        idHash: BOB_ID,
      });
      await expect(registry.connect(newWallet).register(attestation, signature)).to.be.revertedWith("Identity banned");

      // Unlinking the old wallet first does not help either.
      await registry.connect(bob).unlinkWallet();
      const again = await signAttestation(registry, ctx.attester, { wallet: newWallet.address, idHash: BOB_ID });
      await expect(registry.connect(newWallet).register(again.attestation, again.signature)).to.be.revertedWith("Identity banned");
    });

    it("expelled wallets cannot deposit, borrow or vote", async function () {
      await makeDefaulter();
      await passExpulsion();
      await expect(pool.connect(bob).deposit({ value: E(0.1) })).to.be.revertedWith("Wallet expelled");
      await expect(lm.connect(bob).openLoan(Kind.Builder, E(0.01), 2, ethers.ZeroAddress, false)).to.be.revertedWith(
        "Identity banned"
      );

      // A second defaulter's expulsion vote: the expelled wallet may not take part.
      await register(ctx, carol);
      await qualify(ctx, carol);
      const { loanId } = await openLoan(ctx, carol, { kind: Kind.Unsecured, amount: E(0.2) });
      await advanceTo((await lm.getLoan(loanId)).nextDueDate + 31n * ctx.spd);
      await lm.markDefault(loanId);
      const receipt = await (await gov.connect(alice).proposeExpel(carol.address)).wait();
      const id = findEvent(receipt, gov, "ProposalCreated").proposalId;
      await expect(gov.connect(bob).vote(id, true)).to.be.revertedWith("Voter not verified");
    });
  });

  describe("Debt enforcement", function () {
    it("expelled wallets can still repay loans and settle their claim", async function () {
      const memberId = await makeDefaulter();
      await passExpulsion();

      // Repayment stays open to anyone, including an expelled wallet paying a loan.
      await register(ctx, carol);
      const { loanId } = await openLoan(ctx, carol, { amount: E(0.01) });
      await expect(lm.connect(bob).repayInstallment(loanId, { value: E(0.001) })).to.not.be.reverted;

      const quote = await dm.settlementQuote(memberId);
      await expect(dm.connect(bob).settleClaim({ value: quote })).to.emit(dm, "ClaimSettled");
      expect(await dm.claimOf(memberId)).to.equal(0n);
      expect(await registry.isBanned(bob.address)).to.equal(true); // settling does not lift the ban
    });

    it("GLP is frozen while debt remains and released once it is settled", async function () {
      const memberId = await makeDefaulter();
      await depositFor(ctx, bob, E(0.1)); // half goes to the claim, half mints GLP
      const shares = await glp.balanceOf(bob.address);
      expect(shares).to.be.greaterThan(0n);

      await expect(pool.connect(bob).withdraw(shares)).to.be.revertedWith("Debt outstanding");
      await expect(glp.connect(bob).transfer(carol.address, 1n)).to.be.revertedWith("Debt outstanding");
      await expect(glp.connect(alice).transfer(bob.address, 1n)).to.be.revertedWith("Debt outstanding");

      await dm.connect(bob).settleClaim({ value: await dm.claimOf(memberId) });
      await expect(pool.connect(bob).withdraw(shares)).to.not.be.reverted;
    });

    it("on expulsion, held GLP is applied to the debt; leftover GLP is free once the debt is cleared", async function () {
      const memberId = await makeDefaulter();
      const claim = await dm.claimOf(memberId);
      // Deposit between claim and 2×claim: the 50% sweep leaves a small claim and more GLP than it.
      await depositFor(ctx, bob, (claim * 3n) / 2n);
      const remaining = await dm.claimOf(memberId);
      expect(remaining).to.be.greaterThan(0n);
      const sharesBefore = await glp.balanceOf(bob.address);

      const id = await proposeExpel();
      await gov.connect(alice).vote(id, true);
      await advanceDays(ctx, 3);
      const receipt = await (await gov.execute(id)).wait();
      const seized = findEvent(receipt, dm, "StakeSeized");
      expect(seized.value).to.equal(remaining);
      expect(await dm.claimOf(memberId)).to.equal(0n);

      const left = await glp.balanceOf(bob.address);
      expect(left).to.equal(sharesBefore - seized.shares);
      expect(await pool.expelled(bob.address)).to.equal(true);
      await expect(pool.connect(bob).withdraw(left)).to.not.be.reverted; // expelled, but debt-free
    });

    it("an expelled wallet holding less GLP than its debt keeps the rest of the debt", async function () {
      const memberId = await makeDefaulter();
      await depositFor(ctx, bob, E(0.1));
      const before = await dm.claimOf(memberId);
      await passExpulsion();
      expect(await glp.balanceOf(bob.address)).to.equal(0n);
      const after = await dm.claimOf(memberId);
      expect(after).to.be.greaterThan(0n);
      expect(after).to.be.lessThan(before);
    });
  });

  describe("Reinstatement", function () {
    it("requires settled debt, uses the same voting rules, lifts the ban and keeps credit history", async function () {
      const memberId = await makeDefaulter();
      await passExpulsion();

      await expect(gov.connect(alice).proposeReinstate(bob.address)).to.be.revertedWith("Debt not settled");
      await dm.connect(bob).settleClaim({ value: await dm.settlementQuote(memberId) });

      const receipt = await (await gov.connect(alice).proposeReinstate(bob.address)).wait();
      const id = findEvent(receipt, gov, "ProposalCreated").proposalId;
      await gov.connect(alice).vote(id, true);
      await advanceDays(ctx, 3);
      await expect(gov.execute(id))
        .to.emit(gov, "ProposalExecuted")
        .withArgs(id, ProposalKind.Reinstate, bob.address, true)
        .and.to.emit(registry, "IdentityUnbanned");

      expect(await registry.isBanned(bob.address)).to.equal(false);
      expect(await pool.expelled(bob.address)).to.equal(false);
      expect(await registry.isVerified(bob.address)).to.equal(true);
      // History is not erased.
      expect((await registry.getMember(memberId)).defaultCount).to.equal(1);
      expect((await score.scarsOf(memberId)).length).to.equal(1);
    });

    it("cannot reinstate someone who was never expelled", async function () {
      await register(ctx, bob, { idHash: BOB_ID });
      await expect(gov.connect(alice).proposeReinstate(bob.address)).to.be.revertedWith("Target is not expelled");
    });
  });
});
