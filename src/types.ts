export type Deploy = {
  id: number;
  repo: string;
  branch: string;
  commit_sha: string;
  status: "pending" | "running" | "success" | "failed" | "stopped";
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

export type Commit = {
  id: number;
  commit_sha: string;
  commit_repo: string;
  commit_branch: string;
  message: string;
  timestamp: number;
};

export type Log = {
  id: number;
  deploy_id: number;
  line: string;
  logged_at: number;
};

export type Config = {
  name: string;
  settings: Settings;
};

export type Settings = {
  secret: string;
  path: string;
  branch: string;
  steps?: string[];
  auto?: boolean;
};
