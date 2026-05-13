import { EventEmitter } from "events";
import * as db from "./db";
import { spawn, ChildProcess } from "child_process";
import { existsSync } from "fs";
import { Config, Deploy } from "./types";

const queue = new Map<string, Deploy[]>();
const running = new Map<string, boolean>();
export const deployEmitters = new Map<number, EventEmitter>();
const runningProcesses = new Map<number, ChildProcess>();

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

export function pm2NameFor(repoName: string): string {
  return `auto-deploy-${repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function stepRunner(
  deployId: number,
  steps: string[],
  cwd: string,
  repoName: string,
  emitter: EventEmitter,
  finalize: (status: "success" | "failed" | "stopped") => void,
): void {
  const pm2Index = steps.findIndex((s) => s.trimStart().startsWith("pm2:"));
  const fgSteps = pm2Index === -1 ? steps : steps.slice(0, pm2Index);
  const pm2Exec =
    pm2Index === -1
      ? null
      : steps[pm2Index].trimStart().slice("pm2:".length).trim();

  function handleChunk(chunk: Buffer) {
    const line = chunk.toString();
    db.createLog(deployId, line, Date.now());
    emitter.emit("log", line);
  }

  function launchPM2() {
    if (!pm2Exec) {
      finalize("success");
      return;
    }

    const pm2Name = pm2NameFor(repoName);
    const stepLabel = `[step ${steps.length}/${steps.length}] pm2: ${pm2Exec}`;

    db.createLog(deployId, `\n${stepLabel}\n`, Date.now());
    emitter.emit("log", `\n${stepLabel}\n`);

    // PM2 can't run `npm run x` directly — it treats the last word as a file path.
    // For npm commands, use `pm2 start npm --name <n> -- run <script>` instead.
    const npmMatch = pm2Exec.match(/^npm\s+(?:run\s+)?(\S+)$/);
    const pm2Start = npmMatch
      ? `pm2 start npm --name ${pm2Name} -- run ${npmMatch[1]}`
      : `pm2 start ${pm2Exec} --name ${pm2Name}`;

    const script = [
      `pm2 delete ${pm2Name} 2>/dev/null || true`,
      pm2Start,
      "pm2 save --force",
    ].join(" && ");

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
          finalize("success");
        }
      },
    );

    runningProcesses.set(deployId, proc);
  }

  if (fgSteps.length === 0) {
    launchPM2();
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
        launchPM2();
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
