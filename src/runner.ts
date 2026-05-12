import { EventEmitter } from "events";
import * as db from "./db";
import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";
import { Config, Deploy } from "./types";

const queue = new Map<string, Deploy[]>();
const running = new Map<string, boolean>();
export const deployEmitters = new Map<number, EventEmitter>();
const runningProcesses = new Map<number, ChildProcess>();
const backgroundProcesses = new Map<string, ChildProcess>();

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

export function deploy(deployObj: Deploy, config: Config) {
  const dirPath = config.settings.path;

  deployObj.started_at = Date.now();
  deployObj.status = "running";
  running.set(config.name, true);
  const saved = db.createDeploy(deployObj);
  const deployId = saved.id;

  const emitter = new EventEmitter();
  deployEmitters.set(deployId, emitter);

  let finished = false;

  const steps = config.settings.steps;
  if (!steps) {
    const errLine = `[runner error] No steps defined for deploy: ${deployObj.repo}`;
    db.createLog(deployId, errLine, Date.now());
    emitter.emit("log", errLine);
    finalize("failed");
    return;
  }

  if (!existsSync(dirPath)) {
    const errLine = `[runner error] Deploy path does not exist: ${dirPath}`;
    db.createLog(deployId, errLine, Date.now());
    emitter.emit("log", errLine);
    finalize("failed");
    return;
  }

  const prevBg = backgroundProcesses.get(config.name);
  if (prevBg) {
    const killLine = `[runner] Killing previous background process (pid ${prevBg.pid}) before new deploy.`;
    db.createLog(deployId, killLine, Date.now());
    emitter.emit("log", killLine);
    try {
      process.kill(-prevBg.pid!, "SIGTERM");
    } catch {
      try {
        prevBg.kill("SIGTERM");
      } catch {}
    }
    backgroundProcesses.delete(config.name);
  }

  stepRunner(deployId, steps, dirPath, config.name, emitter, finalize);

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
}

function spawnShell(
  script: string,
  cwd: string,
  onChunk: (chunk: Buffer) => void,
  onError: (err: Error) => void,
  onClose: (exitCode: number | null) => void,
): ChildProcess {
  const proc = spawn("sh", ["-c", script], { cwd });
  proc.stdout.on("data", onChunk);
  proc.stdout.on("error", () => {});
  proc.stderr.on("data", onChunk);
  proc.stderr.on("error", () => {});
  proc.on("error", onError);
  proc.on("close", onClose);
  return proc;
}

function stepRunner(
  deployId: number,
  steps: string[],
  cwd: string,
  repoName: string,
  emitter: EventEmitter,
  finalize: (status: "success" | "failed" | "stopped") => void,
): void {
  const bgIndex = steps.findIndex((s) => s.trimStart().startsWith("&"));
  const fgSteps = bgIndex === -1 ? steps : steps.slice(0, bgIndex);
  const bgStep =
    bgIndex === -1 ? null : steps[bgIndex].trimStart().slice(1).trimStart();

  function handleChunk(chunk: Buffer) {
    const line = chunk.toString();
    db.createLog(deployId, line, Date.now());
    emitter.emit("log", line);
  }

  function launchBackground() {
    if (!bgStep) {
      finalize("success");
      return;
    }
    const bgHeader = `\n[step ${steps.length}/${steps.length}] ${bgStep} (background)\n`;
    db.createLog(deployId, bgHeader, Date.now());
    emitter.emit("log", bgHeader);

    const bg = spawn("sh", ["-c", bgStep], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backgroundProcesses.set(repoName, bg);

    let capturing = true;

    function stopCapturing() {
      if (!capturing) return;
      capturing = false;
      bg.stdout?.destroy();
      bg.stderr?.destroy();
    }

    const captureTimeout = setTimeout(stopCapturing, 5000);

    function onBgChunk(chunk: Buffer) {
      if (!capturing) return;
      const line = chunk.toString();
      db.createLog(deployId, line, Date.now());
      emitter.emit("log", line);
    }
    bg.stdout?.on("data", onBgChunk);
    bg.stderr?.on("data", onBgChunk);

    bg.on("exit", (code) => {
      clearTimeout(captureTimeout);
      stopCapturing();
      if (code !== null && code !== 0) {
        const exitLine = `[runner] Background process exited with code ${code}.`;
        db.createLog(deployId, exitLine, Date.now());
        emitter.emit("log", exitLine);
      }
      if (backgroundProcesses.get(repoName) === bg) {
        backgroundProcesses.delete(repoName);
      }
    });

    bg.unref();

    finalize("success");
  }

  if (fgSteps.length === 0) {
    launchBackground();
    return;
  }

  const script = fgSteps
    .map((s, i) => `echo "[step ${i + 1}/${steps.length}] ${s}" && ${s}`)
    .join(" && ");

  const proc = spawnShell(
    script,
    cwd,
    handleChunk,
    (err) => {
      const errLine = `[spawn error] ${err.message}`;
      db.createLog(deployId, errLine, Date.now());
      emitter.emit("log", errLine);
      finalize("failed");
    },
    (exitCode) => {
      runningProcesses.delete(deployId);
      if (exitCode === null) {
        finalize("stopped");
      } else if (exitCode !== 0) {
        finalize("failed");
      } else {
        launchBackground();
      }
    },
  );

  runningProcesses.set(deployId, proc);
}

export function stopDeploy(deployId: number): boolean {
  const proc = runningProcesses.get(deployId);
  if (!proc) return false;

  const emitter = deployEmitters.get(deployId);
  if (emitter) {
    const stopLine = "[runner] Deploy stopped by user.";
    db.createLog(deployId, stopLine, Date.now());
    emitter.emit("log", stopLine);
  }

  db.updateDeployStatus(deployId, "stopped", Date.now());

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
