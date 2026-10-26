// Deploys and wires the full GigLend protocol. Shared by scripts/deploy.js and the tests so
// role grants and wiring live in exactly one place.
import { defineAllParams } from "../config.js";

export const CONTRACT_NAMES = [
  "PolicyConfig",
  "IdentityRegistry",
  "GLPToken",
  "CreditScore",
  "LendingPool",
  "ReserveFund",
  "SafeRepayVault",
  "MockPayoutRouter",
  "LoanManager",
  "RiskEngine",
  "DefaultManager",
  "PortfolioLens",
  "DefaulterGovernance",
];

// Expulsion voting rules, fixed at deployment.
export const GOVERNANCE = { votingPeriodDays: 3, quorumBps: 2000, passThresholdBps: 5000 };

const role = (ethers, name) => ethers.id(name);

/**
 * @param ethers hardhat-ethers instance
 * @param opts.admin signer holding ADMIN_ROLE (production: a Safe multisig)
 * @param opts.attester address holding ATTESTER_ROLE (the backend's EIP-712 key)
 * @param opts.overrides demo/test parameter overrides (bounds still apply)
 */
export async function deployProtocol(ethers, { admin, attester, overrides = {}, log = false }) {
  const say = (...a) => log && console.log(...a);
  const deploy = async (name, args = [], libraries) => {
    const factory = await ethers.getContractFactory(name, libraries ? { libraries } : undefined);
    const c = await factory.connect(admin).deploy(...args);
    await c.waitForDeployment();
    say(`${name.padEnd(18)} ${await c.getAddress()}`);
    return c;
  };
  const a = (c) => c.getAddress();

  const config = await deploy("PolicyConfig", [admin.address]);
  await defineAllParams(config.connect(admin), overrides);

  const registry = await deploy("IdentityRegistry", [admin.address, attester, await a(config)]);
  const glp = await deploy("GLPToken", [admin.address]);
  const score = await deploy("CreditScore", [admin.address, await a(config), await a(registry)]);
  const pool = await deploy("LendingPool", [admin.address, await a(glp), await a(config), await a(registry)]);
  const reserve = await deploy("ReserveFund", [admin.address]);
  const vault = await deploy("SafeRepayVault", [admin.address]);
  const router = await deploy("MockPayoutRouter", [admin.address, await a(registry), await a(config)]);
  const loanOpsLib = await deploy("LoanOpsLib");
  const loanManager = await deploy("LoanManager", [admin.address, await a(config), await a(registry), await a(glp)], {
    LoanOpsLib: await a(loanOpsLib),
  });
  const risk = await deploy("RiskEngine", [await a(config), await a(registry), await a(loanManager), await a(pool), await a(score)]);
  const defaultManager = await deploy("DefaultManager", [admin.address, await a(config), await a(registry), await a(glp)]);
  const lens = await deploy("PortfolioLens", [await a(loanManager), await a(defaultManager), await a(pool), await a(reserve)]);
  const governance = await deploy("DefaulterGovernance", [
    await a(registry),
    await a(config),
    await a(pool),
    await a(glp),
    await a(defaultManager),
    GOVERNANCE.votingPeriodDays,
    GOVERNANCE.quorumBps,
    GOVERNANCE.passThresholdBps,
  ]);

  const LM = await a(loanManager);
  const DM = await a(defaultManager);
  const POOL = await a(pool);
  const send = async (txPromise) => (await txPromise).wait();

  // Roles
  for (const holder of [LM, DM, POOL]) await send(registry.grantRole(role(ethers, "LOAN_ROLE"), holder));
  await send(glp.grantRole(role(ethers, "POOL_ROLE"), POOL));
  for (const holder of [LM, DM, POOL]) await send(glp.grantRole(role(ethers, "LOCKER_ROLE"), holder));
  for (const holder of [LM, DM]) await send(score.grantRole(role(ethers, "LOAN_ROLE"), holder));
  for (const holder of [LM, DM]) await send(pool.grantRole(role(ethers, "LOAN_ROLE"), holder));
  for (const holder of [LM, DM]) await send(reserve.grantRole(role(ethers, "LOAN_ROLE"), holder));
  await send(vault.grantRole(role(ethers, "LOAN_ROLE"), LM));
  await send(loanManager.grantRole(role(ethers, "DEFAULT_ROLE"), DM));
  await send(loanManager.grantRole(role(ethers, "ROUTER_ROLE"), await a(router)));
  const GOV = await a(governance);
  for (const c of [registry, pool, defaultManager]) await send(c.grantRole(role(ethers, "GOVERNANCE_ROLE"), GOV));

  // Wiring (each set once)
  await send(registry.setLoanStatus(LM));
  await send(registry.setScoreSource(await a(score)));
  await send(pool.setLoanManager(LM));
  await send(pool.setDefaultManager(DM));
  await send(pool.setReserveFund(await a(reserve)));
  await send(glp.setDebtView(POOL));
  await send(router.setLoanManager(LM));
  await send(router.setDefaultManager(DM));
  await send(
    loanManager.wire(POOL, await a(score), await a(vault), await a(reserve), await a(router), await a(risk), DM)
  );
  await send(defaultManager.wire(LM, POOL, await a(reserve), await a(score), await a(router)));

  return {
    config,
    registry,
    glp,
    score,
    pool,
    reserve,
    vault,
    router,
    loanOpsLib,
    loanManager,
    risk,
    defaultManager,
    lens,
    governance,
  };
}
