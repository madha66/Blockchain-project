import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { prisma } from "../db.js";

export const SESSION_COOKIE = "gl_session";

// Scopes: "signup" (wizard in progress), "preauth" (password/OTP ok, SIWE pending), "full".
const TTL = { signup: "2h", preauth: "5m", full: "12h" };

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: "lax",
  secure: !config.isTest && config.frontendOrigin.startsWith("https"),
  path: "/",
});

export function setSession(res, userId, scope) {
  const token = jwt.sign({ sub: userId, scope }, config.jwtSecret, { expiresIn: TTL[scope] });
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

export function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/**
 * Loads the session user. `scopes` lists the session scopes allowed on the route.
 */
export const requireSession = (...scopes) => async (req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return res.status(401).json({ error: "NOT_AUTHENTICATED" });
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: "SESSION_INVALID" });
  }
  if (scopes.length && !scopes.includes(payload.scope)) {
    return res.status(403).json({ error: "SESSION_SCOPE", scope: payload.scope });
  }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (!user) return res.status(401).json({ error: "SESSION_INVALID" });
  req.user = user;
  req.sessionScope = payload.scope;
  next();
};

export const requireAdmin = (req, res, next) => {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "ADMIN_ONLY" });
  next();
};

/**
 * Wraps async handlers so rejected promises reach the error middleware (Express 4).
 */
export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
