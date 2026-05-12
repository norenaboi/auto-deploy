import crypto from "crypto";
import { Request, Response, NextFunction, Router } from "express";
import path from "path";
import { env } from "./env";
export const adminRouter = Router();

const sessions = new Map<string, { expiresAt: number }>();
const SESSION_TTL = 24 * 60 * 60 * 1000;

const MASTER_KEY: string = env.MASTER_KEY || "admin";

if (!MASTER_KEY || MASTER_KEY.trim().length < 16) {
  console.error("FATAL: MASTER_KEY is not set or too short after reload.");
  process.exit(1);
}

export function parseCookies(req: Request): Record<string, string> {
  const cookies: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(
      part.slice(idx + 1).trim(),
    );
  }
  return cookies;
}

export function verifyMasterKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const provided = req.headers.authorization || "";
  const expected = MASTER_KEY;
  let valid = false;
  try {
    valid =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch (_) {}

  if (!valid) {
    return res.status(403).json({ error: "Invalid master key" });
  }

  next();
}

export function verifySession(req: Request, res: Response, next: NextFunction) {
  const sessionId = parseCookies(req).adminSession;
  if (!validateSession(sessionId)) {
    return res.status(401).json({ error: "Unauthorized. Please log in." });
  }
  next();
}

export function createSession() {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, { expiresAt: Date.now() + SESSION_TTL });
  return sessionId;
}

export function validateSession(sessionId: string) {
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

export function deleteSession(sessionId: string) {
  if (sessionId) sessions.delete(sessionId);
}

setInterval(
  () => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now > session.expiresAt) sessions.delete(id);
    }
  },
  60 * 60 * 1000,
).unref();

const ADMIN_WINDOW_SECONDS = 60;
const ADMIN_MAX_ATTEMPTS = 30;
const adminAttempts = new Map();

function adminRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now() / 1000;
  const recent = (adminAttempts.get(ip) || []).filter(
    (t: any) => now - t < ADMIN_WINDOW_SECONDS,
  );
  if (recent.length >= ADMIN_MAX_ATTEMPTS) {
    return res
      .status(429)
      .json({ error: "Too many requests. Please slow down." });
  }
  recent.push(now);
  adminAttempts.set(ip, recent);
  next();
}

adminRouter.get("/login", (req: Request, res: Response) => {
  if (validateSession(parseCookies(req).adminSession)) {
    return res.redirect("/");
  }
  return res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

adminRouter.post("/login", (req: Request, res: Response) => {
  const provided = (req.body.masterKey || "").toString();
  const expected = MASTER_KEY;
  let valid = false;
  try {
    valid =
      provided.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch (_) {}

  if (!valid) {
    return res.status(403).json({ error: "Invalid master key" });
  }

  const sessionId = createSession();
  const isProduction = env.NODE_ENV === "production";
  res.cookie("adminSession", sessionId, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "strict",
    maxAge: parseInt(env.SESSION_TTL_HOURS || "24", 10) * 60 * 60 * 1000,
  });
  res.json({ success: true });
});

adminRouter.post("/logout", (req: Request, res: Response) => {
  const sessionId = parseCookies(req).adminSession;
  deleteSession(sessionId);
  res.clearCookie("adminSession", { httpOnly: true, sameSite: "strict" });
  res.json({ success: true });
});
