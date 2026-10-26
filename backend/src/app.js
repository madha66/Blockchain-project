import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { ZodError } from "zod";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { signupRoutes } from "./routes/signup.js";
import { profileRoutes } from "./routes/profile.js";
import { notificationRoutes } from "./routes/notifications.js";
import { adminRoutes, noticeRoutes } from "./routes/admin.js";
import { identityRoutes } from "./routes/identity.js";
import { dataRoutes } from "./routes/data.js";
import { demoRoutes } from "./routes/demo.js";
import { createChain } from "./services/chain.js";

/**
 * Builds the Express app. `deps.chain` can be stubbed in tests.
 */
export function createApp(deps = {}) {
  const chain = deps.chain ?? createChain();
  const app = express();

  app.disable("x-powered-by");
  app.use(cors({ origin: config.frontendOrigin, credentials: true }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.authRateLimit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "RATE_LIMITED" },
  });

  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.use("/api/auth", authLimiter, authRoutes());
  app.use("/api/signup", authLimiter, signupRoutes({ chain }));
  app.use("/api/profile", profileRoutes({ chain }));
  app.use("/api/notifications", notificationRoutes());
  app.use("/api/identity", authLimiter, identityRoutes({ chain }));
  app.use("/api/admin", adminRoutes({ watcher: deps.watcher }));
  app.use("/api/notices", noticeRoutes());
  app.use("/api", dataRoutes({ chain }));
  if (config.chainId === 31337 && process.env.DEMO_ENABLED !== "false") {
    app.use("/api/demo", demoRoutes({ watcher: deps.watcher }));
  }

  for (const extra of deps.routers ?? []) app.use(extra.path, extra.router);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: "VALIDATION", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) });
    }
    if (err.status) return res.status(err.status).json({ error: err.code || err.message });
    if (err.code === 11000) return res.status(409).json({ error: "DUPLICATE" });
    console.error("[api] unhandled error:", err.message);
    res.status(500).json({ error: "INTERNAL" });
  });

  return { app, chain };
}
