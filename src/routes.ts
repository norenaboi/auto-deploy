import express, { Router, Request, Response } from "express";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import * as db from "./db";
import { Config } from "./types";
import { queueDeploy, deployEmitters } from "./runner";
export const router = Router();

// Helpers
function getConfig(repoName: string): Config {
  const configFile = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
  if (configFile[repoName]) {
    return { name: repoName, settings: configFile[repoName] } as Config;
  }
  throw new Error(`No config found for repo ${repoName}`);
}

function editConfig(
  name: string,
  secret?: string,
  pathDir?: string,
  branch?: string,
) {
  const configData = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
  if (secret) configData[name].secret = secret;
  if (pathDir) configData[name].path = pathDir;
  if (branch) configData[name].branch = branch;
  fs.writeFileSync("./config.json", JSON.stringify(configData));
}

function saveConfig(config: Config) {
  const configData = JSON.parse(fs.readFileSync("./config.json", "utf-8"));
  configData[config.name] = config.settings;
  fs.writeFileSync("./config.json", JSON.stringify(configData));
}

router.post(
  "/webhook/:repo",
  express.raw({ type: "*/*" }),
  (req: Request, res: Response) => {
    const raw = req.body;
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
    queueDeploy(config, payload.head_commit.id);

    return res.send("OK");
  },
);

router.get("/history/id/:id", (req: Request, res: Response) => {
  if (typeof req.params.id !== "string") {
    return res.status(400).send("Invalid id");
  }
  const id: number = parseInt(req.params.id);
  const deploy = db.getDeployById(id);
  if (!deploy) return res.status(404).send("No deploy found");
  return res.send(deploy);
});

router.get("/history/name/:repo", (req: Request, res: Response) => {
  if (typeof req.params.repo !== "string") {
    return res.status(400).send("Invalid repo name");
  }
  const repoName: string = req.params.repo;
  const deploys = db.getDeploysByName(repoName);
  if (deploys.length === 0)
    return res.status(404).send("No deploys found by the repo " + repoName);
  return res.send(deploys);
});

router.get("/history/sha/:commitsha", (req: Request, res: Response) => {
  if (typeof req.params.commitsha !== "string") {
    return res.status(400).send("Invalid commit sha");
  }
  const commitSha: string = req.params.commitsha;
  const deploy = db.getDeployByCommitSha(commitSha);
  if (!deploy)
    return res
      .status(404)
      .send("No deploy found by the commit sha " + commitSha);
  return res.send(deploy);
});

router.get("/history/deploys", (req: Request, res: Response) => {
  const deploys = db.getAllDeploys();
  if (deploys.length === 0) return res.status(404).send("No deploys found");
  return res.send(deploys);
});

router.post("/deploy/:repo", (req: Request, res: Response) => {
  if (typeof req.params.repo !== "string") {
    return res.status(400).send("Invalid repo name");
  }
  const repoName: string = req.params.repo;
  try {
    const config = getConfig(repoName);
    queueDeploy(config);
    return res.send("OK");
  } catch (e) {
    return res.status(404).send("No config found for repo " + repoName);
  }
});

router.post("/config", (req: Request, res: Response) => {
  if (typeof req.body !== "object") {
    return res.status(400).send("Invalid request body");
  }
  const { name, secret, path, branch } = req.body;
  if (
    typeof name !== "string" ||
    typeof secret !== "string" ||
    typeof path !== "string" ||
    typeof branch !== "string"
  ) {
    return res.status(400).send("Invalid request body");
  }

  let secretTemp: string | undefined;
  let pathTemp: string | undefined;
  let branchTemp: string | undefined;
  let config = getConfig(name);
  try {
    if (config) {
      if (secret) {
        secretTemp = secret;
      }
      if (path) {
        pathTemp = path;
      }
      if (branch) {
        branchTemp = branch;
      }
      if (secret || path || branch) {
        editConfig(name, secretTemp, pathTemp, branchTemp);
        return res.send("OK");
      } else {
        return res.status(400).send("The config already exists");
      }
    }
  } catch (e) {
    const settings = { secret, path, branch };
    const config = { name, settings };
    saveConfig(config);
    return res.send("OK");
  }
});

router.get("/logs/stream/:deployId", (req: Request, res: Response) => {
  const deployId = parseInt(req.params.deployId as string, 10);
  if (isNaN(deployId)) return res.status(400).send("Invalid deploy id");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Always replay whatever has already been saved (handles late-joining clients)
  const existingLogs = db.getLogsByDeployId(deployId);
  for (const log of existingLogs) {
    res.write(`data: ${log.line}\n\n`);
  }

  const emitter = deployEmitters.get(deployId);
  if (!emitter) {
    // Deploy is already done — historical logs were sent above, close the stream
    res.end();
    return;
  }

  const onLog = (line: string) => res.write(`data: ${line}\n\n`);
  const onDone = (status: string) => {
    res.write(`data: [deploy ${status}]\n\n`);
    res.end();
  };

  emitter.on("log", onLog);
  emitter.on("done", onDone);

  // Clean up listeners when the browser closes the tab
  req.on("close", () => {
    emitter.off("log", onLog);
    emitter.off("done", onDone);
  });
});

router.get("/", (req: Request, res: Response) => {
  return res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

router.get("*path", (req: Request, res: Response) => {
  return res.sendFile(path.join(__dirname, "..", "public", "404.html"));
});
