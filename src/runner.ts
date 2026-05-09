import { EventEmitter } from "events";
import * as db from "./db";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { Config, Deploy } from "./types";

// Queue maps
const queue = new Map<string, Deploy[]>();
const running = new Map<string, boolean>();

// One EventEmitter per active deploy — SSE clients subscribe to these
export const deployEmitters = new Map<number, EventEmitter>();

// Queue
export function queueDeploy(config: Config, sha256?: string) {
  let settings = config.settings;
  let deployObj: Deploy = {
    id: 0,
    repo: config.name,
    branch: settings.branch,
    commit_sha: sha256 ?? `manual-${Date.now()}`,
    status: "pending",
    created_at: Date.now(),
    started_at: null,
    finished_at: null,
  };
  if (running.get(config.name)) {
    queue.set(config.name, [...(queue.get(config.name) ?? []), deployObj]);
    return;
  }
  deploy(deployObj, config);
}

// Deployment
export function deploy(deployObj: Deploy, config: Config) {
  const dirPath = config.settings.path;

  deployObj.started_at = Date.now();
  deployObj.status = "running";
  running.set(config.name, true);
  const saved = db.createDeploy(deployObj);
  const deployId = saved.id;

  // Create an emitter that SSE clients will subscribe to
  const emitter = new EventEmitter();
  deployEmitters.set(deployId, emitter);

  if (!existsSync(dirPath)) {
    const errLine = `[runner error] Deploy path does not exist: ${dirPath}`;
    db.createLog(deployId, errLine, Date.now());
    emitter.emit("log", errLine);
    finalize("failed");
    return;
  }

  const proc = spawn("docker", ["compose", "up", "-d", "--build"], {
    cwd: dirPath,
  });

  function handleChunk(chunk: Buffer) {
    const line = chunk.toString();
    db.createLog(deployId, line, Date.now());
    emitter.emit("log", line);
  }

  proc.stdout.on("data", handleChunk);
  proc.stderr.on("data", handleChunk);

  let finished = false;
  function finalize(status: "success" | "failed") {
    if (finished) return;
    finished = true;
    deployObj.status = status;
    deployObj.finished_at = Date.now();
    running.delete(config.name);
    db.updateDeployStatus(deployId, status, deployObj.finished_at);
    emitter.emit("done", status);
    deployEmitters.delete(deployId);

    const nextQueue = queue.get(config.name);
    if (nextQueue && nextQueue.length > 0) {
      const next = nextQueue.shift()!;
      if (nextQueue.length === 0) queue.delete(config.name);
      deploy(next, config);
    }
  }

  proc.on("error", (err) => {
    const errLine = `[spawn error] ${err.message}`;
    db.createLog(deployId, errLine, Date.now());
    emitter.emit("log", errLine);
    finalize("failed");
  });

  proc.on("close", (exitCode) => {
    finalize(exitCode === 0 ? "success" : "failed");
  });
}
