import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "path";
import { webhookRouter, router } from "./routes";
import { adminRouter, parseCookies, validateSession } from "./middleware";
import { env } from "./env";

const app = express();
const PORT: number = parseInt(env.PORT || "3000", 10);

app.use(cors());

app.use(webhookRouter);

app.use(express.json());

app.use(router);
app.use(adminRouter);

app.get("/", (req: Request, res: Response, next: NextFunction) => {
  if (!validateSession(parseCookies(req).adminSession)) {
    return res.redirect("/login");
  }
  next();
});

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.static(path.join(process.cwd(), "dist", "public")));

app.get("*path", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "..", "public", "404.html"));
});

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
