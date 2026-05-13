import express, { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import * as db from "./db";
import { Config, Settings } from "./types";
import { queueDeploy, deployEmitters, stopDeploy } from "./runner";
import { verifySession } from "./middleware";
export const router = Router();
export const webhookRouter = Router();

const CONFIG_DIR = path.join(__dirname, "..", "data");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

if (!fs.existsSync(CONFIG_DIR)) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

if (!fs.existsSync(CONFIG_PATH)) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({}));
}

function getConfig(repoName: string): Config {
  const configFile = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (configFile[repoName]) {
    return { name: repoName, settings: configFile[repoName] } as Config;
  }
  console.log(`No config found for repo ${repoName}`);
  throw new Error(`No config found for repo ${repoName}`);
}

function editConfig(
  name: string,
  secret?: string,
  pathDir?: string,
  branch?: string,
  steps?: string[],
  auto?: boolean,
) {
  const configData = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (secret) configData[name].secret = secret;
  if (pathDir) configData[name].path = pathDir;
  if (branch) configData[name].branch = branch;
  if (steps) configData[name].steps = steps;
  if (auto !== undefined) configData[name].auto = auto;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configData));
}

function saveConfig(config: Config) {
  const configData = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  configData[config.name] = config.settings;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configData));
}

function deleteConfig(name: string) {
  const configData = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (!configData[name]) throw new Error(`No config found for repo ${name}`);
  delete configData[name];
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(configData));
}

webhookRouter.post(
  "/webhook/:repo",
  express.raw({ type: "*/*" }),
  (req: Request, res: Response) => {
    const raw = req.body;
    if (req.headers["x-github-event"] === "ping") {
      return res.send("PONG");
    }
    if (typeof req.params.repo !== "string") {
      return res.status(400).send("Invalid repo name");
    }
    const repoName: string = req.params.repo;
    let config: Config;
    try {
      config = getConfig(repoName);
    } catch (error: any) {
      return res.status(404).send(error.message);
    }

    const secret = config.settings.secret;
    const signature = req.headers["x-hub-signature-256"];
    if (!signature || !secret || Array.isArray(signature)) {
      return res.status(401).send("Unauthorized");
    }

    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(raw);
    const digest = hmac.digest("hex");

    const theirDigest = signature.split("=")[1];

    const a = Buffer.from(digest, "hex");
    const b = Buffer.from(theirDigest, "hex");
    if (a.length !== b.length) return res.status(401).send("Unauthorized");
    const isEqual = crypto.timingSafeEqual(a, b);
    if (!isEqual) {
      return res.status(401).send("Unauthorized");
    }

    const payload = JSON.parse(raw.toString());
    const branch = payload.ref.replace("refs/heads/", "");
    if (branch !== config.settings.branch)
      return res.status(200).send("Ignored");

    // Persist the commit metadata before queuing the deploy
    const headCommit = payload.head_commit;
    if (headCommit) {
      db.createCommit({
        commit_sha: headCommit.id,
        commit_repo: repoName,
        commit_branch: branch,
        message: headCommit.message ?? "",
        timestamp: headCommit.timestamp
          ? new Date(headCommit.timestamp).getTime()
          : Date.now(),
      });
    }

    if (config.settings.auto === false)
      return res.status(200).send("Auto-deploy disabled");

    queueDeploy(config, headCommit?.id);

    return res.send("OK");
  },
);

router.get("/commits", verifySession, (req: Request, res: Response) => {
  const repo = req.query.repo;
  if (typeof repo === "string" && repo) {
    return res.json(db.getCommitsByRepo(repo));
  }
  return res.json(db.getAllCommits());
});

router.get("/deploy/id/:id", verifySession, (req: Request, res: Response) => {
  if (typeof req.params.id !== "string") {
    return res.status(400).send("Invalid id");
  }
  const id: number = parseInt(req.params.id);
  const deploy = db.getDeployById(id);
  if (!deploy) return res.status(404).send("No deploy found");
  return res.send(deploy);
});

router.get("/deploy/:name", verifySession, (req: Request, res: Response) => {
  if (typeof req.params.name !== "string") {
    return res.status(400).send("Invalid repo name");
  }
  const repoName: string = req.params.name;
  const deploys = db.getDeploysByName(repoName);
  if (deploys.length === 0)
    return res.status(404).send("No deploys found by the repo " + repoName);
  return res.send(deploys);
});

router.get("/deploy", verifySession, (req: Request, res: Response) => {
  const deploys = db.getAllDeploys();
  if (deploys.length === 0) return res.status(404).send("No deploys found");
  return res.send(deploys);
});

router.post(
  "/deploy/stop/:deployId",
  verifySession,
  (req: Request, res: Response) => {
    const deployId = parseInt(req.params.deployId as string, 10);
    if (isNaN(deployId)) return res.status(400).send("Invalid deploy id");

    const stopped = stopDeploy(deployId);
    if (!stopped) {
      return res.status(404).send("No running deploy found with that id");
    }
    return res.send("OK");
  },
);

router.post("/deploy/:name", verifySession, (req: Request, res: Response) => {
  if (typeof req.params.name !== "string") {
    return res.status(400).send("Invalid name");
  }
  const repoName: string = req.params.name;
  try {
    const config = getConfig(repoName);
    queueDeploy(config);
    return res.send("OK");
  } catch (e) {
    return res.status(404).send("No config found for repo " + repoName);
  }
});

router.delete("/config/:name", verifySession, (req: Request, res: Response) => {
  if (typeof req.params.name !== "string") {
    return res.status(400).send("Invalid repo name");
  }
  const repoName: string = req.params.name;
  try {
    deleteConfig(repoName);
    return res.send("OK");
  } catch (e: any) {
    return res.status(404).send(e.message);
  }
});

router.get("/configs", verifySession, (req: Request, res: Response) => {
  const configData = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const configs = Object.entries(configData).map(
    ([name, settings]: [string, any]) => ({
      name,
      path: settings.path,
      branch: settings.branch,
      steps: settings.steps,
      auto: settings.auto !== false,
    }),
  );
  return res.json(configs);
});

const ALLOWED_STEPS = [
  /^git pull(\s--(rebase|force))?$/,
  /^npm (install|ci)$/,
  /^npm run build$/,
  /^docker compose (pull|down)$/,
  /^docker compose up -d --build(\s--no-cache)?$/,
  /^& npm run start$/,
];

function validateSteps(steps: unknown): string | null {
  if (!Array.isArray(steps)) return "Steps must be an array";
  for (const step of steps) {
    if (typeof step !== "string") return "Each step must be a string";
    if (!ALLOWED_STEPS.some((r) => r.test(step.trim()))) {
      return `Step not allowed: "${step}"`;
    }
  }
  return null;
}

router.post("/config", verifySession, (req: Request, res: Response) => {
  if (typeof req.body !== "object") {
    return res.status(400).send("Invalid request body");
  }
  const { name, secret, path: pathDir, branch, steps, auto } = req.body;
  if (
    typeof name !== "string" ||
    typeof secret !== "string" ||
    typeof pathDir !== "string" ||
    typeof branch !== "string"
  ) {
    return res.status(400).send("Invalid request body");
  }
  if (auto !== undefined && typeof auto !== "boolean") {
    return res.status(400).send("Invalid value for auto");
  }

  let secretTemp: string | undefined;
  let pathTemp: string | undefined;
  let branchTemp: string | undefined;
  try {
    let config = getConfig(name);
    if (config) {
      if (secret) {
        secretTemp = secret;
      }
      if (pathDir) {
        pathTemp = pathDir;
      }
      if (branch) {
        branchTemp = branch;
      }
      let stepsTemp: string[] | undefined;
      if (steps && Array.isArray(steps)) {
        const err = validateSteps(steps);
        if (err) return res.status(400).send(err);
        stepsTemp = steps;
      }
      const autoTemp: boolean | undefined =
        auto !== undefined ? auto : undefined;
      if (secret || pathDir || branch || stepsTemp || autoTemp !== undefined) {
        editConfig(name, secretTemp, pathTemp, branchTemp, stepsTemp, autoTemp);
        return res.send("OK");
      } else {
        return res.status(400).send("The config already exists");
      }
    }
  } catch (e) {
    const settings: Settings = { secret, path: pathDir, branch };
    if (steps && Array.isArray(steps)) {
      const err = validateSteps(steps);
      if (err) return res.status(400).send(err);
      settings.steps = steps;
    }
    if (auto !== undefined) settings.auto = auto;
    const config = { name, settings };
    saveConfig(config);
    return res.send("OK");
  }
});

router.get(
  "/logs/stream/:deployId",
  verifySession,
  (req: Request, res: Response) => {
    const deployId = parseInt(req.params.deployId as string, 10);
    if (isNaN(deployId)) return res.status(400).send("Invalid deploy id");

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    function sseWrite(line: string) {
      const encoded = line.replace(/\n/g, "\ndata: ");
      res.write(`data: ${encoded}\n\n`);
    }

    const existingLogs = db.getLogsByDeployId(deployId);
    for (const log of existingLogs) {
      sseWrite(log.line);
    }

    const emitter = deployEmitters.get(deployId);
    if (!emitter) {
      res.end();
      return;
    }

    const onLog = (line: string) => sseWrite(line);
    const onDone = (status: string) => {
      res.write(`data: [deploy ${status}]\n\n`);
      res.end();
    };

    emitter.on("log", onLog);
    emitter.on("done", onDone);

    req.on("close", () => {
      emitter.off("log", onLog);
      emitter.off("done", onDone);
    });
  },
);
