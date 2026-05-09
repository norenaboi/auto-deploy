import { EventEmitter } from "events";
import * as db from "./db";
import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";
import { Config, Deploy } from "./types";

// Queue maps
const queue = new Map<string, Deploy[]>();
const running = new Map<string, boolean>();

// One EventEmitter per active deploy — SSE clients subscribe to these
export const deployEmitters = new Map<number, EventEmitter>();

// Track running child processes so we can kill them
const runningProcesses = new Map<number, ChildProcess>();

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

  let finished = false;

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
  runningProcesses.set(deployId, proc);

  function handleChunk(chunk: Buffer) {
    const line = chunk.toString();
    db.createLog(deployId, line, Date.now());
    emitter.emit("log", line);
  }

  proc.stdout.on("data", handleChunk);
  proc.stderr.on("data", handleChunk);

  function finalize(status: "success" | "failed" | "stopped") {
    if (finished) return;
    finished = true;
    deployObj.status = status;
    deployObj.finished_at = Date.now();
    running.delete(config.name);
    runningProcesses.delete(deployId);
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
    // If the process was killed intentionally, finalize() was already called
    // with "stopped", so the `finished` flag prevents double-finalizing.
    finalize(exitCode === 0 ? "success" : "failed");
  });
}

// Stop a running deploy by its deploy ID
export function stopDeploy(deployId: number): boolean {
  const proc = runningProcesses.get(deployId);
  if (!proc) return false;

  const emitter = deployEmitters.get(deployId);
  if (emitter) {
    const stopLine = "[runner] Deploy stopped by user.";
    db.createLog(deployId, stopLine, Date.now());
    emitter.emit("log", stopLine);
  }

  // Mark as stopped before killing so the close handler doesn't overwrite it
  db.updateDeployStatus(deployId, "stopped", Date.now());

  // Kill the entire process group so child processes (docker compose) are also terminated
  try {
    process.kill(-proc.pid!, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }

  runningProcesses.delete(deployId);

  if (emitter) {
    emitter.emit("done", "stopped");
    deployEmitters.delete(deployId);
  }

  return true;
}
