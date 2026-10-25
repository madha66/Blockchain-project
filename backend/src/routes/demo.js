import { Router } from "express";
import { z } from "zod";
import { ethers } from "ethers";
import { ah, requireSession } from "../middleware/auth.js";
import { config } from "../config.js";
import { contractFor } from "../services/contracts.js";

// Hardhat test account #8 — local demo only; it plays the gig platform paying workers.
const DEFAULT_DEMO_KEY = "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97";

/**
 * Demo panel endpoints. Only mounted on the local Hardhat chain (chainId 31337).
 */
export function demoRoutes({ watcher } = {}) {
  const r = Router();
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { staticNetwork: true });
  const platform = new ethers.Wallet(process.env.DEMO_PRIVATE_KEY || DEFAULT_DEMO_KEY, provider);

  r.use(requireSession("full"));

  /** Sends a mock gig payout through MockPayoutRouter (income sweep and residual sweep apply). */
  r.post(
    "/payout",
    ah(async (req, res) => {
      const { wallet, amountEth } = z
        .object({ wallet: z.string().refine(ethers.isAddress), amountEth: z.string().regex(/^\d+(\.\d+)?$/) })
        .parse(req.body);
      const router = contractFor("MockPayoutRouter", platform);
      if (!router) return res.status(503).json({ error: "ROUTER_NOT_DEPLOYED" });
      const tx = await router.payout(wallet, { value: ethers.parseEther(amountEth) });
      const receipt = await tx.wait();
      res.json({ txHash: receipt.hash });
    })
  );

  /** Advances chain time (same RPC calls as scripts/timeTravel.js). */
  r.post(
    "/time-travel",
    ah(async (req, res) => {
      const { days } = z.object({ days: z.number().min(0.01).max(400) }).parse(req.body);
      const policy = contractFor("PolicyConfig", provider);
      const spd = policy ? Number(await policy.secondsPerDay()) : 86400;
      const seconds = Math.round(days * spd);
      await provider.send("evm_increaseTime", [seconds]);
      await provider.send("evm_mine", []);
      const block = await provider.getBlock("latest");
      const tick = watcher ? await watcher.tick().catch((e) => ({ error: e.message })) : null;
      res.json({ advancedSeconds: seconds, chainTime: block.timestamp, watcher: tick });
    })
  );

  /** Runs one notifier/watcher pass now instead of waiting for the interval. */
  r.post(
    "/tick",
    ah(async (req, res) => {
      res.json(watcher ? await watcher.tick() : { skipped: "watcher disabled" });
    })
  );

  r.get(
    "/chain-time",
    ah(async (req, res) => {
      const block = await provider.getBlock("latest");
      res.json({ chainTime: block.timestamp, wallClock: Math.floor(Date.now() / 1000) });
    })
  );

  return r;
}
