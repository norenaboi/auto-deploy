import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import { router } from "./routes";
import { adminRouter, parseCookies, validateSession } from "./middleware";

//  App Setup
const app = express();
const PORT: number = parseInt(process.env.PORT || "3000", 10);

//  Middleware
app.use(cors());
app.use(express.json());

// Login / logout routes
app.use(adminRouter);

// Guard the dashboard page — assets (CSS, JS, images) skip straight to static
app.get("/", (req: Request, res: Response, next: NextFunction) => {
  if (!validateSession(parseCookies(req).adminSession)) {
    return res.redirect("/login");
  }
  next();
});

// Static files — served before the API router so assets are never caught by
// the API routes. The / guard above already handles auth for index.html.
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.static(path.join(process.cwd(), "dist", "public")));

// API routes
app.use(router);

// 404 fallback — must be after static and API routes
app.get("*path", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "..", "public", "404.html"));
});

//  Global Error Handler
app.use(
  (
    err: Error & { status?: number },
    req: Request,
    res: Response,
    next: NextFunction,
  ) => {
    console.error("[Error]", err);
    res.status(err.status || 500).json({
      error: err.message || "Internal server error",
    });
  },
);

export { app };

//  Boot
function start(): void {
  try {
    app.listen(PORT, () => {
      console.log(`[Server] Running at http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("[Fatal] Failed to start server:", err);
    process.exit(1);
  }
}

start();
