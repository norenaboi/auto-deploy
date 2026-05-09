import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { Deploy, Log } from "./types";

const DB_DIR = path.join(__dirname, "..", "data");
const DB_PATH = path.join(DB_DIR, "database.db");

// Create the data folder if it doesn't exist
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

export const db = new Database(DB_PATH, {});

// --- db init -----------------------------------------------------------------

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS deploys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    repo        TEXT    NOT NULL,
    branch      TEXT    NOT NULL,
    commit_sha  TEXT    NOT NULL UNIQUE,
    status      TEXT    NOT NULL,
    created_at  INTEGER DEFAULT NULL,
    started_at  INTEGER DEFAULT NULL,
    finished_at INTEGER DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    deploy_id       INTEGER NOT NULL REFERENCES deploys(id) ON DELETE CASCADE,
    line            TEXT    NOT NULL,
    logged_at       INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_logs_deploy_id ON logs(deploy_id);
`);

// --- Statements -----------------------------------------------------------------

const stmtInsertDeploy = db.prepare<{
  repo: string;
  branch: string;
  commit_sha: string;
  status: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}>(
  `INSERT INTO deploys (repo, branch, commit_sha, status, created_at, started_at, finished_at) VALUES (@repo, @branch, @commit_sha, @status, @created_at, @started_at, @finished_at)`,
);

const stmtGetAllDeploys = db.prepare<[], Deploy>(
  `SELECT * FROM deploys ORDER BY created_at DESC`,
);

const stmtGetDeployById = db.prepare<[number], Deploy | undefined>(
  `SELECT * FROM deploys WHERE id = ?`,
);

const stmtGetDeploysByName = db.prepare<[string], Deploy>(
  `SELECT * FROM deploys WHERE repo = ?`,
);

// --- Logs -----------------------------------------------------------------

const stmtInsertLog = db.prepare<{
  deploy_id: number;
  line: string;
  logged_at: number;
}>(
  `INSERT INTO logs (deploy_id, line, logged_at) VALUES (@deploy_id, @line, @logged_at)`,
);

const stmtGetLogById = db.prepare<[number], Log>(
  `SELECT * FROM logs WHERE id = ?`,
);

const stmtGetLogsByDeployId = db.prepare<[number], Log>(
  `SELECT * FROM logs WHERE deploy_id = ?`,
);

const stmtGetAllLogs = db.prepare<[], Log>(
  `SELECT * FROM logs ORDER BY logged_at DESC`,
);

const stmtUpdateDeployStatus = db.prepare<{
  status: string;
  finished_at: number | null;
  id: number;
}>(
  `UPDATE deploys SET status = @status, finished_at = @finished_at WHERE id = @id`,
);

// --- Helpers -----------------------------------------------------------------

export function createDeploy(deploy: Deploy): Deploy {
  try {
    const { lastInsertRowid } = stmtInsertDeploy.run({
      repo: deploy.repo,
      branch: deploy.branch,
      commit_sha: deploy.commit_sha,
      status: deploy.status,
      created_at: deploy.created_at,
      started_at: deploy.started_at,
      finished_at: deploy.finished_at,
    });
    return stmtGetDeployById.get(Number(lastInsertRowid)) as Deploy;
  } catch (err: any) {
    if (err?.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw Object.assign(
        new Error(
          `A deploy with commit SHA "${deploy.commit_sha}" already exists.`,
        ),
        {
          code: "DUPLICATE_COMMIT_SHA",
        },
      );
    }
    throw err;
  }
}

export function getAllDeploys(): Deploy[] {
  return stmtGetAllDeploys.all();
}

export function getDeployById(id: number): Deploy | undefined {
  return stmtGetDeployById.get(id);
}

export function getDeploysByName(name: string): Deploy[] {
  return stmtGetDeploysByName.all(name);
}

export function createLog(
  deploy_id: number,
  line: string,
  logged_at: number,
): Log {
  const { lastInsertRowid } = stmtInsertLog.run({ deploy_id, line, logged_at });
  return stmtGetLogById.get(Number(lastInsertRowid)) as Log;
}

export function getAllLogs(): Log[] {
  return stmtGetAllLogs.all();
}

export function getLogsByDeployId(deploy_id: number): Log[] {
  return stmtGetLogsByDeployId.all(deploy_id);
}

export function updateDeployStatus(
  id: number,
  status: string,
  finished_at: number | null,
): void {
  stmtUpdateDeployStatus.run({ id, status, finished_at });
}
