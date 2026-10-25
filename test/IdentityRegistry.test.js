import { expect } from "chai";
import hre from "hardhat";
import { defineAllParams, paramKey } from "../scripts/config.js";
import { signAttestation, registerMember, idHashOf } from "./helpers/identity.js";

const { ethers } = hre;

describe("IdentityRegistry & PolicyConfig (Phase 1)", function () {
  let config, registry, admin, attester, alice, aliceNewWallet, mallory;

  beforeEach(async function () {
    [admin, attester, alice, aliceNewWallet, mallory] = await ethers.getSigners();
    config = await (await ethers.getContractFactory("PolicyConfig")).deploy(admin.address);
    await defineAllParams(config);
    registry = await (await ethers.getContractFactory("IdentityRegistry")).deploy(
      admin.address,
      attester.address,
      await config.getAddress()
    );
  });

  describe("PolicyConfig bounded setters", function () {
    it("updates a parameter within bounds and emits ParameterUpdated", async function () {
      await expect(config.setParam(paramKey("graceDaysShort"), 5))
        .to.emit(config, "ParameterUpdated")
        .withArgs(paramKey("graceDaysShort"), 3, 5);
      expect(await config.get(paramKey("graceDaysShort"))).to.equal(5);
    });

    it("rejects out-of-bounds values, unknown keys and non-admins", async function () {
      await expect(config.setParam(paramKey("burdenBps"), 6000)).to.be.revertedWith("Value out of bounds");
      await expect(config.setParam(paramKey("noSuchParam"), 1)).to.be.revertedWith("Unknown param");
      await expect(config.connect(mallory).setParam(paramKey("burdenBps"), 3000)).to.be.reverted;
    });

    it("exposes secondsPerDay for time compression", async function () {
      await config.setParam(paramKey("secondsPerDay"), 60);
      expect(await config.secondsPerDay()).to.equal(60);
      expect(await config.daysToSeconds(30)).to.equal(1800);
    });
  });

  describe("Attestation verification", function () {
    it("registers a member from a valid EIP-712 attestation", async function () {
      const { attestation, signature } = await signAttestation(registry, attester, {
        wallet: alice.address,
        idHash: idHashOf("ABCDE1234F"),
      });
      await expect(registry.connect(alice).register(attestation, signature))
        .to.emit(registry, "MemberRegistered")
        .withArgs(1, alice.address, attestation.cohortId, attestation.clusterId);
      expect(await registry.memberOf(alice.address)).to.equal(1);
      expect(await registry.isEligible(alice.address)).to.equal(true);
      const m = await registry.getMember(1);
      expect(m.payoutPeriodDays).to.equal(7);
      expect(m.incomeWei).to.equal(attestation.incomeTierWei);
    });

    it("rejects a replayed attestation nonce", async function () {
      const { attestation, signature } = await signAttestation(registry, attester, {
        wallet: alice.address,
        idHash: idHashOf("ABCDE1234F"),
      });
      await registry.connect(alice).register(attestation, signature);
      await expect(registry.connect(alice).register(attestation, signature)).to.be.revertedWith(
        "Attestation replayed"
      );
    });

    it("rejects an expired attestation", async function () {
      const latest = await ethers.provider.getBlock("latest");
      const { attestation, signature } = await signAttestation(registry, attester, {
        wallet: alice.address,
        idHash: idHashOf("ABCDE1234F"),
        expiry: BigInt(latest.timestamp) - 1n,
      });
      await expect(registry.connect(alice).register(attestation, signature)).to.be.revertedWith(
        "Attestation expired"
      );
    });

    it("rejects a signature from a wallet without ATTESTER_ROLE", async function () {
      const { attestation, signature } = await signAttestation(registry, mallory, {
        wallet: alice.address,
        idHash: idHashOf("ABCDE1234F"),
      });
      await expect(registry.connect(alice).register(attestation, signature)).to.be.revertedWith(
        "Invalid attester signature"
      );
    });

    it("rejects an attestation submitted by a different wallet", async function () {
      const { attestation, signature } = await signAttestation(registry, attester, {
        wallet: alice.address,
        idHash: idHashOf("ABCDE1234F"),
      });
      await expect(registry.connect(mallory).register(attestation, signature)).to.be.revertedWith(
        "Attestation not for sender"
      );
    });

    it("rejects a tampered attestation field", async function () {
      const { attestation, signature } = await signAttestation(registry, attester, {
        wallet: alice.address,
        idHash: idHashOf("ABCDE1234F"),
      });
      const tampered = { ...attestation, incomeTierWei: attestation.incomeTierWei * 10n };
      await expect(registry.connect(alice).register(tampered, signature)).to.be.revertedWith(
        "Invalid attester signature"
      );
    });

    it("eligibility lapses when the attestation validity ends", async function () {
      const latest = await ethers.provider.getBlock("latest");
      await registerMember(registry, attester, alice, { expiry: BigInt(latest.timestamp) + 1000n });
      expect(await registry.isEligible(alice.address)).to.equal(true);
      await ethers.provider.send("evm_increaseTime", [2000]);
      await ethers.provider.send("evm_mine", []);
      const [ok, reason] = await registry.eligibility(alice.address);
      expect(ok).to.equal(false);
      expect(reason).to.equal("Attestation expired");
    });
  });

  describe("One person, one record", function () {
    it("re-attestation updates income, debts and expiry on the same member", async function () {
      const idHash = idHashOf("ABCDE1234F");
      await registerMember(registry, attester, alice, { idHash });
      await expect(
        registerMember(registry, attester, alice, {
          idHash,
          incomeTierWei: ethers.parseEther("0.5"),
          declaredDebtWei: ethers.parseEther("0.05"),
        })
      ).to.not.be.reverted;
      const m = await registry.getMember(1);
      expect(m.incomeWei).to.equal(ethers.parseEther("0.5"));
      expect(m.declaredDebtWei).to.equal(ethers.parseEther("0.05"));
      expect(await registry.memberCount()).to.equal(1);
    });

    it("blocks a second active wallet for the same identity", async function () {
      const idHash = idHashOf("ABCDE1234F");
      await registerMember(registry, attester, alice, { idHash });
      await expect(registerMember(registry, attester, aliceNewWallet, { idHash })).to.be.revertedWith(
        "Identity has an active wallet; unlink it first"
      );
    });

    it("a new wallet for the same idHash inherits the member record after unlinking", async function () {
      const idHash = idHashOf("abcde1234f");
      await registerMember(registry, attester, alice, { idHash });
      await expect(registry.connect(alice).unlinkWallet()).to.emit(registry, "WalletUnlinked");
      expect(await registry.isEligible(alice.address)).to.equal(false);

      const { attestation, signature } = await signAttestation(registry, attester, {
        wallet: aliceNewWallet.address,
        idHash: idHashOf("ABCDE1234F"),
      });
      await expect(registry.connect(aliceNewWallet).register(attestation, signature))
        .to.emit(registry, "WalletLinked")
        .withArgs(1, aliceNewWallet.address);
      expect(await registry.memberOf(aliceNewWallet.address)).to.equal(1);
      expect(await registry.memberCount()).to.equal(1);
      const m = await registry.getMember(1);
      expect(m.wallet).to.equal(aliceNewWallet.address);
    });
  });

  describe("Clusters, cohorts and misdeclared debt", function () {
    it("only LOAN_ROLE or DISPUTE_ROLE may flag a cluster", async function () {
      const cluster = ethers.id("cluster-x");
      await expect(registry.connect(mallory).setClusterFlag(cluster, true)).to.be.revertedWith("Not authorised");
      await expect(registry.connect(admin).setClusterFlag(cluster, true))
        .to.emit(registry, "ClusterFlagged")
        .withArgs(cluster, true);
      expect(await registry.clusterFlagged(cluster)).to.equal(true);
    });

    it("admin can pause a cohort and flag misdeclared debt", async function () {
      await registerMember(registry, attester, alice);
      await registry.setCohortPaused(202643, true);
      expect(await registry.cohortPaused(202643)).to.equal(true);
      await registry.flagMisdeclaredDebt(1, true);
      expect((await registry.getMember(1)).misdeclaredDebt).to.equal(true);
    });
  });
});
