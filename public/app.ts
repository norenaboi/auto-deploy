// ── Types (mirroring backend) ───────────────────────────────────────────────

type DeployStatus = "pending" | "running" | "success" | "failed" | "stopped";

interface ConfigEntry {
  name: string;
  path: string;
  branch: string;
  steps?: string[];
  auto: boolean;
}

interface Deploy {
  id: number;
  repo: string;
  branch: string;
  commit_sha: string;
  status: DeployStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface Commit {
  id: number;
  commit_sha: string;
  commit_repo: string;
  commit_branch: string;
  message: string;
  timestamp: number;
}

// ── State ───────────────────────────────────────────────────────────────────

let deploys: Deploy[] = [];
let selectedId: number | null = null;
let activeStream: EventSource | null = null;
let pollTimer: number | null = null;

// ── Filter state ─────────────────────────────────────────────────────────────
let filterManual = true;
let filterAuto = true;
let filterRepo = ""; // "" = all repos

// ── Commit filter state ──────────────────────────────────────────────────────────────
let commits: Commit[] = [];
let commitFilterRepo = ""; // "" = all configs

// ── Helpers ─────────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Strip ANSI escape codes so terminal output renders as plain text
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\r/g, "");
}

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function duration(start: number | null, end: number | null): string {
  if (!start) return "—";
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function shortSha(sha: string): string {
  return sha.startsWith("manual-") ? sha : sha.slice(0, 7);
}

// ── API ─────────────────────────────────────────────────────────────────────

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

async function fetchAllDeploys(): Promise<Deploy[]> {
  try {
    return await apiFetch<Deploy[]>("/deploy");
  } catch {
    // 404 just means no deploys yet — anything else is a real error
    return [];
  }
}

async function fetchDeploysByName(repo: string): Promise<Deploy[]> {
  try {
    return await apiFetch<Deploy[]>(`/deploy/${encodeURIComponent(repo)}`);
  } catch {
    return [];
  }
}

async function triggerDeploy(repo: string): Promise<void> {
  const res = await fetch(`/deploy/${encodeURIComponent(repo)}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await res.text());
}

async function stopDeployById(deployId: number): Promise<void> {
  const res = await fetch(`/deploy/stop/${deployId}`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}

async function saveConfig(
  name: string,
  secret?: string,
  pathDir?: string,
  branch?: string,
  steps?: string[],
  auto?: boolean,
): Promise<void> {
  const body: Record<string, unknown> = { name, secret, path: pathDir, branch };
  if (steps && steps.length > 0) body.steps = steps;
  if (auto !== undefined) body.auto = auto;
  const res = await fetch("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
}

async function deleteConfig(name: string): Promise<void> {
  const res = await fetch(`/config/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(await res.text());
}

async function fetchConfigs(): Promise<ConfigEntry[]> {
  try {
    return await apiFetch<ConfigEntry[]>("/configs");
  } catch {
    return [];
  }
}

async function fetchAllCommits(): Promise<Commit[]> {
  try {
    return await apiFetch<Commit[]>("/commits");
  } catch {
    return [];
  }
}

async function doLogout(): Promise<void> {
  await fetch("/logout", { method: "POST" });
  window.location.href = "/login";
}

// ── Commit list ─────────────────────────────────────────────────────────────────────

function getVisibleCommits(): Commit[] {
  if (!commitFilterRepo) return commits;
  return commits.filter((c) => c.commit_repo === commitFilterRepo);
}

function renderCommitList(): void {
  const list = document.getElementById("commit-list")!;
  list.innerHTML = "";

  const visible = getVisibleCommits();

  if (visible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No recent updates";
    list.appendChild(empty);
    return;
  }

  for (const commit of visible) {
    const card = document.createElement("div");
    card.className = "commit-card";

    const top = document.createElement("div");
    top.className = "commit-card-top";

    const config = document.createElement("span");
    config.className = "commit-config";
    config.textContent = commit.commit_repo;

    const sha = document.createElement("span");
    sha.className = "commit-sha";
    sha.textContent = commit.commit_sha.slice(0, 7);

    top.appendChild(config);
    top.appendChild(sha);

    const msg = document.createElement("div");
    msg.className = "commit-message";
    // Only show first line of the commit message
    msg.textContent = commit.message.split("\n")[0];
    msg.title = commit.message;

    const bottom = document.createElement("div");
    bottom.className = "commit-card-bottom";

    const branch = document.createElement("span");
    branch.className = "commit-branch";
    branch.textContent = commit.commit_branch;

    const time = document.createElement("span");
    time.className = "commit-time";
    time.textContent = timeAgo(commit.timestamp);

    bottom.appendChild(branch);
    bottom.appendChild(time);

    card.appendChild(top);
    card.appendChild(msg);
    card.appendChild(bottom);
    list.appendChild(card);
  }
}

function populateCommitConfigSelect(configs: ConfigEntry[]): void {
  const select = document.getElementById(
    "filter-commit-config",
  ) as HTMLSelectElement;
  for (const cfg of configs) {
    const opt = document.createElement("option");
    opt.value = cfg.name;
    opt.textContent = cfg.name;
    select.appendChild(opt);
  }
}

function updateCommitFilterBtnState(): void {
  const btn = document.getElementById("btn-commit-filter")!;
  btn.classList.toggle("btn-filter-active", commitFilterRepo !== "");
}

// ── Filter helpers ──────────────────────────────────────────────────────────────────

function getVisibleDeploys(): Deploy[] {
  return deploys.filter((d) => {
    const isManual = d.commit_sha.startsWith("manual-");
    if (isManual && !filterManual) return false;
    if (!isManual && !filterAuto) return false;
    return true;
  });
}

async function applyFilters(): Promise<void> {
  deploys = filterRepo
    ? await fetchDeploysByName(filterRepo)
    : await fetchAllDeploys();
  renderDeployList();
  // If the selected deploy is no longer visible, clear the selection indicator
  if (selectedId !== null) {
    const selected = deploys.find((d) => d.id === selectedId);
    if (selected) renderLogHeader(selected);
  }
}

// ── Polling ─────────────────────────────────────────────────────────────────

function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(async () => {
    const fresh = filterRepo
      ? await fetchDeploysByName(filterRepo)
      : await fetchAllDeploys();
    if (JSON.stringify(fresh) === JSON.stringify(deploys)) return;

    deploys = fresh;
    renderDeployList();

    // Refresh the log header if the selected deploy's status changed
    if (selectedId !== null) {
      const selected = deploys.find((d) => d.id === selectedId);
      if (selected) renderLogHeader(selected);
    }
  }, 5_000);
}

// ── Deploy List ──────────────────────────────────────────────────────────────

const STATUS_ICON: Record<DeployStatus, string> = {
  pending: "⏳",
  running: "⚙️",
  success: "✅",
  failed: "❌",
  stopped: "🛑",
};

function renderDeployList(): void {
  const list = document.getElementById("deploy-list")!;
  list.innerHTML = "";

  const visible = getVisibleDeploys();

  if (visible.length === 0) {
    list.innerHTML = `<p class="empty-state">No deploys yet.</p>`;
    return;
  }

  for (const deploy of visible) {
    const card = document.createElement("div");
    card.className = `deploy-card status-${deploy.status}${deploy.id === selectedId ? " selected" : ""}`;
    card.dataset.id = String(deploy.id);
    card.innerHTML = `
            <div class="card-top">
                <span class="card-repo">${escHtml(deploy.repo)}</span>
                <span class="card-icon">${STATUS_ICON[deploy.status]}</span>
            </div>
            <div class="card-bottom">
                <span class="card-meta">${escHtml(deploy.branch)} &middot; <code>${shortSha(deploy.commit_sha)}</code></span>
                <span class="card-time">${timeAgo(deploy.created_at)}</span>
            </div>
        `;
    card.addEventListener("click", () => selectDeploy(deploy.id));
    list.appendChild(card);
  }
}

// ── Log Panel ────────────────────────────────────────────────────────────────

function renderLogHeader(deploy: Deploy): void {
  const header = document.getElementById("log-header")!;
  const stopBtn =
    deploy.status === "running"
      ? `<button class="btn btn-danger btn-sm" id="btn-stop">&#9632; Stop</button>`
      : "";
  header.innerHTML = `
        <div class="log-meta">
            <span class="log-repo">${escHtml(deploy.repo)}</span>
            <span class="status-badge status-badge-${deploy.status}">${deploy.status}</span>
            <span class="log-branch">${escHtml(deploy.branch)}</span>
            <code class="log-sha">${shortSha(deploy.commit_sha)}</code>
            <span class="log-duration">&#9201; ${duration(deploy.started_at, deploy.finished_at)}</span>
        </div>
        <div class="log-header-actions">
            ${stopBtn}
            <button class="btn btn-primary btn-sm" id="btn-redeploy">&#9654; Re-deploy</button>
        </div>
    `;
  document.getElementById("btn-redeploy")!.addEventListener("click", () => {
    openTriggerModal(deploy.repo);
  });
  if (deploy.status === "running") {
    document.getElementById("btn-stop")!.addEventListener("click", async () => {
      const btn = document.getElementById("btn-stop") as HTMLButtonElement;
      btn.disabled = true;
      btn.textContent = "Stopping…";
      try {
        await stopDeployById(deploy.id);
      } catch (e: any) {
        btn.disabled = false;
        btn.innerHTML = "&#9632; Stop";
        alert("Failed to stop deploy: " + e.message);
      }
    });
  }
}

function selectDeploy(id: number): void {
  selectedId = id;
  const deploy = deploys.find((d) => d.id === id);
  if (!deploy) return;

  // Update card highlight
  document
    .querySelectorAll(".deploy-card")
    .forEach((el) => el.classList.remove("selected"));
  document
    .querySelector(`.deploy-card[data-id="${id}"]`)
    ?.classList.add("selected");

  // Stop any existing stream before opening a new one
  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }

  renderLogHeader(deploy);
  streamLogs(id);
}

function streamLogs(deployId: number): void {
  const output = document.getElementById("log-output")!;
  output.textContent = "";

  const source = new EventSource(`/logs/stream/${deployId}`);
  activeStream = source;

  source.onmessage = (e: MessageEvent<string>) => {
    // The server sends "[deploy success]" / "[deploy failed]" / "[deploy stopped]" as the final line
    if (e.data.startsWith("[deploy ")) {
      const isStopped = e.data.includes("stopped");
      const isSuccess = e.data.includes("success");
      appendStatusLine(
        output,
        isStopped
          ? "🛑 Deploy stopped."
          : isSuccess
            ? "✅ Deploy finished successfully."
            : "❌ Deploy failed.",
      );
      source.close();
      activeStream = null;
      // Refresh the header badge now that the deploy is done
      const deploy = deploys.find((d) => d.id === deployId);
      if (deploy) {
        deploy.status = isStopped
          ? "stopped"
          : isSuccess
            ? "success"
            : "failed";
        deploy.finished_at = Date.now();
        renderLogHeader(deploy);
        renderDeployList();
      }
      return;
    }
    appendLogLine(output, stripAnsi(e.data));
  };

  source.onerror = () => {
    // The stream closed (deploy was already done when we connected — logs were replayed and the connection ended)
    source.close();
    activeStream = null;
  };
}

function appendLogLine(output: HTMLElement, text: string): void {
  const span = document.createElement("span");
  span.textContent = text + "\n";
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

function appendStatusLine(output: HTMLElement, text: string): void {
  const span = document.createElement("span");
  span.className = "log-status-line";
  span.textContent = "\n" + text;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

// ── Modals ───────────────────────────────────────────────────────────────────

function openModal(content: HTMLElement): void {
  const overlay = document.getElementById("modal-overlay")!;
  const box = document.getElementById("modal-box")!;
  box.innerHTML = "";
  box.appendChild(content);
  overlay.classList.remove("hidden");
  // Close on backdrop click
  overlay.addEventListener(
    "click",
    (e) => {
      if (e.target === overlay) closeModal();
    },
    { once: true },
  );
}

function closeModal(): void {
  document.getElementById("modal-overlay")!.classList.add("hidden");
}

function openConfigModal(prefill?: ConfigEntry): void {
  const isEdit = !!prefill;
  const initAuto = prefill ? prefill.auto !== false : true;

  // ── Detect initial preset from prefill steps ──────────────────────────────
  type Preset = "node" | "docker";
  let activePreset: Preset = "node";
  if (prefill) {
    if (!prefill.steps || prefill.steps[0]?.startsWith("docker compose")) {
      activePreset = "docker";
    }
  }

  // ── Reverse-engineer Node options from prefill steps ─────────────────────
  type PullFlag = "none" | "--rebase" | "--force";
  type InstallMode = "npm install" | "npm ci";
  let initPullFlag: PullFlag = "none";
  let initInstallMode: InstallMode = "npm install";
  let initIncludeBuild = false;

  if (prefill?.steps && activePreset === "node") {
    const steps = prefill.steps;
    if (steps[0]?.endsWith("--rebase")) initPullFlag = "--rebase";
    else if (steps[0]?.endsWith("--force")) initPullFlag = "--force";
    if (steps[1] === "npm ci") initInstallMode = "npm ci";
    if (steps.includes("npm run build")) initIncludeBuild = true;
  }

  // ── Reverse-engineer Docker options from prefill steps ────────────────────
  let initDockerPull = false;
  let initDockerDown = false;
  let initDockerNoCache = false;

  if (prefill?.steps && activePreset === "docker") {
    const steps = prefill.steps;
    initDockerPull = steps.includes("docker compose pull");
    initDockerDown = steps.includes("docker compose down");
    initDockerNoCache = steps.some((s) => s.includes("--no-cache"));
  }

  // ── Build the form element ────────────────────────────────────────────────
  const form = document.createElement("form");
  form.className = "modal-form";

  const secretPlaceholder = isEdit
    ? "Leave blank to keep existing"
    : "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

  form.innerHTML = `
    <h2 class="modal-title">${isEdit ? "Edit Config" : "Add Config"}</h2>

    <div class="config-modal-body">

      <!-- Left column: core fields -->
      <div class="config-modal-left">
        <label>Repo name
          <input name="name" type="text" placeholder="my-app"
            value="${escHtml(prefill?.name ?? "")}" ${isEdit ? "readonly" : ""} required/>
        </label>
        <label>Secret
          <input name="secret" type="password" placeholder="${escHtml(secretPlaceholder)}"/>
        </label>
        <label>Deploy path
          <input name="path" type="text" placeholder="/srv/my-app"
            value="${escHtml(prefill?.path ?? "")}" required/>
        </label>
        <label>Branch
          <input name="branch" type="text" placeholder="main"
            value="${escHtml(prefill?.branch ?? "")}" required/>
        </label>
        <label class="check-label auto-deploy-toggle">
          <input type="checkbox" id="auto-deploy" ${initAuto ? "checked" : ""} />
          <span>Auto-deploy on push</span>
        </label>
      </div>

      <!-- Right column: step builder -->
      <div class="config-modal-right">
        <div class="step-builder">

          <div class="step-builder-header">
            <span class="step-builder-title">Preset</span>
            <div class="preset-picker">
              <button type="button" class="btn-preset-pill${activePreset === "node" ? " active" : ""}" data-preset="node">Node</button>
              <button type="button" class="btn-preset-pill${activePreset === "docker" ? " active" : ""}" data-preset="docker">Docker</button>
            </div>
          </div>

          <!-- Node options -->
          <div class="preset-options${activePreset !== "node" ? " hidden" : ""}" id="node-options">
            <div class="preset-option-row">
              <span class="option-label">Pull flag</span>
              <div class="option-controls">
                <label class="radio-label"><input type="radio" name="pull-flag" value="none" ${initPullFlag === "none" ? "checked" : ""} /><span>none</span></label>
                <label class="radio-label"><input type="radio" name="pull-flag" value="--rebase" ${initPullFlag === "--rebase" ? "checked" : ""} /><span>--rebase</span></label>
                <label class="radio-label"><input type="radio" name="pull-flag" value="--force" ${initPullFlag === "--force" ? "checked" : ""} /><span>--force</span></label>
              </div>
            </div>
            <div class="preset-option-row">
              <span class="option-label">Install</span>
              <div class="option-controls">
                <label class="radio-label"><input type="radio" name="install-mode" value="npm install" ${initInstallMode === "npm install" ? "checked" : ""} /><span>npm install</span></label>
                <label class="radio-label"><input type="radio" name="install-mode" value="npm ci" ${initInstallMode === "npm ci" ? "checked" : ""} /><span>npm ci</span></label>
              </div>
            </div>
            <div class="preset-option-row">
              <span class="option-label">Build step</span>
              <div class="option-controls">
                <label class="check-label"><input type="checkbox" id="include-build" ${initIncludeBuild ? "checked" : ""} /><span>npm run build</span></label>
              </div>
            </div>

          </div>

          <!-- Docker options -->
          <div class="preset-options${activePreset !== "docker" ? " hidden" : ""}" id="docker-options">
            <div class="preset-option-row">
              <span class="option-label">Before</span>
              <div class="option-controls">
                <label class="check-label"><input type="checkbox" id="docker-pull" ${initDockerPull ? "checked" : ""} /><span>compose pull</span></label>
                <label class="check-label"><input type="checkbox" id="docker-down" ${initDockerDown ? "checked" : ""} /><span>compose down</span></label>
              </div>
            </div>
            <div class="preset-option-row">
              <span class="option-label">Build</span>
              <div class="option-controls">
                <label class="check-label"><input type="checkbox" id="docker-no-cache" ${initDockerNoCache ? "checked" : ""} /><span>--no-cache</span></label>
              </div>
            </div>
          </div>

          <!-- Steps preview -->
          <div class="steps-preview-block">
            <span class="steps-preview-label">Steps preview</span>
            <pre class="steps-preview" id="steps-preview"></pre>
          </div>

        </div>
      </div>

    </div>

    <p class="modal-error hidden" id="modal-error"></p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="btn-modal-cancel">${isEdit ? "Back" : "Cancel"}</button>
      <button type="submit" class="btn btn-primary">Save</button>
    </div>
  `;

  // ── Resolve steps from current UI state ─────────────────────────────────
  function resolveSteps(): string[] {
    if (activePreset === "docker") {
      const pull =
        form.querySelector<HTMLInputElement>("#docker-pull")?.checked ?? false;
      const down =
        form.querySelector<HTMLInputElement>("#docker-down")?.checked ?? false;
      const noCache =
        form.querySelector<HTMLInputElement>("#docker-no-cache")?.checked ??
        false;
      const steps: string[] = [];
      if (pull) steps.push("docker compose pull");
      if (down) steps.push("docker compose down");
      steps.push(`docker compose up -d --build${noCache ? " --no-cache" : ""}`);
      return steps;
    }
    // Node preset
    const pullFlagEl = form.querySelector<HTMLInputElement>(
      "input[name='pull-flag']:checked",
    );
    const pullFlag = pullFlagEl?.value ?? "none";
    const installModeEl = form.querySelector<HTMLInputElement>(
      "input[name='install-mode']:checked",
    );
    const installMode = installModeEl?.value ?? "npm install";
    const includeBuild =
      form.querySelector<HTMLInputElement>("#include-build")?.checked ?? false;
    const gitPull = pullFlag === "none" ? "git pull" : `git pull ${pullFlag}`;
    const steps: string[] = [gitPull, installMode];
    if (includeBuild) steps.push("npm run build");
    steps.push("& npm run start");
    return steps;
  }

  // ── Update preview display ────────────────────────────────────────────────
  function updatePreview(): void {
    const previewEl = form.querySelector<HTMLPreElement>("#steps-preview");
    if (previewEl) previewEl.textContent = resolveSteps().join("\n");
  }

  // ── Preset pill switching ─────────────────────────────────────────────────
  form
    .querySelectorAll<HTMLButtonElement>(".btn-preset-pill")
    .forEach((pill) => {
      pill.addEventListener("click", () => {
        activePreset = pill.dataset.preset as Preset;
        form
          .querySelectorAll<HTMLButtonElement>(".btn-preset-pill")
          .forEach((p) => {
            p.classList.toggle("active", p.dataset.preset === activePreset);
          });
        form
          .querySelector<HTMLElement>("#node-options")!
          .classList.toggle("hidden", activePreset !== "node");
        form
          .querySelector<HTMLElement>("#docker-options")!
          .classList.toggle("hidden", activePreset !== "docker");
        updatePreview();
      });
    });

  // ── Live preview on any option change ────────────────────────────────────
  form
    .querySelector("#node-options")!
    .addEventListener("change", updatePreview);
  form.querySelector("#node-options")!.addEventListener("input", updatePreview);
  form
    .querySelector("#docker-options")!
    .addEventListener("change", updatePreview);

  // ── Submit ────────────────────────────────────────────────────────────────
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const errEl = form.querySelector<HTMLElement>("#modal-error")!;
    try {
      const resolvedSteps = resolveSteps();
      const autoChecked =
        form.querySelector<HTMLInputElement>("#auto-deploy")?.checked ?? true;
      await saveConfig(
        data.get("name") as string,
        data.get("secret") as string,
        data.get("path") as string,
        data.get("branch") as string,
        resolvedSteps,
        autoChecked,
      );
      closeModal();
    } catch (err) {
      errEl.textContent =
        err instanceof Error ? err.message : "Something went wrong.";
      errEl.classList.remove("hidden");
    }
  });

  // ── Cancel / Back ─────────────────────────────────────────────────────────
  form.querySelector("#btn-modal-cancel")!.addEventListener("click", () => {
    if (isEdit) {
      openConfigListModal();
    } else {
      closeModal();
    }
  });

  openModal(form);
  updatePreview();

  if (!isEdit) form.querySelector<HTMLInputElement>("[name=name]")?.focus();
  else form.querySelector<HTMLInputElement>("[name=secret]")?.focus();
}

async function openConfigListModal(): Promise<void> {
  const configs = await fetchConfigs();

  const container = document.createElement("div");
  container.className = "modal-form";

  const noConfigs =
    configs.length === 0
      ? `<p class="config-list-empty">No configs yet. Add one below.</p>`
      : "";

  const rows = configs
    .map(
      (c) => `
      <div class="config-list-row" data-name="${escHtml(c.name)}" data-path="${escHtml(c.path)}" data-branch="${escHtml(c.branch)}" data-auto="${c.auto}">
        <div class="config-list-info">
          <span class="config-list-name">${escHtml(c.name)}</span>
          <span class="config-list-meta">${escHtml(c.branch)} &middot; <code>${escHtml(c.path)}</code></span>
        </div>
        <div class="config-list-row-actions">
          <span class="config-auto-badge ${c.auto ? "config-auto-on" : "config-auto-off"}">${c.auto ? "Auto" : "Manual"}</span>
          <button type="button" class="btn btn-secondary btn-sm btn-edit-config">Edit</button>
          <button type="button" class="btn btn-danger btn-sm btn-delete-config">Delete</button>
        </div>
      </div>`,
    )
    .join("");

  container.innerHTML = `
    <h2 class="modal-title">Configs</h2>
    <div class="config-list">${noConfigs}${rows}</div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="btn-modal-cancel">Close</button>
      <button type="button" class="btn btn-primary" id="btn-config-list-add">+ Add Config</button>
    </div>
  `;

  container
    .querySelector("#btn-modal-cancel")!
    .addEventListener("click", closeModal);
  container
    .querySelector("#btn-config-list-add")!
    .addEventListener("click", () => openConfigModal());

  container.querySelectorAll(".btn-edit-config").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = (btn as HTMLElement).closest<HTMLElement>(
        ".config-list-row",
      )!;
      openConfigModal({
        name: row.dataset.name!,
        path: row.dataset.path!,
        branch: row.dataset.branch!,
        auto: row.dataset.auto !== "false",
      });
    });
  });

  container.querySelectorAll(".btn-delete-config").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = (btn as HTMLElement).closest<HTMLElement>(
        ".config-list-row",
      )!;
      const name = row.dataset.name!;

      // Inline confirmation: replace button with confirm/cancel pair
      const deleteBtn = btn as HTMLButtonElement;
      if (deleteBtn.dataset.confirming === "true") return;
      deleteBtn.dataset.confirming = "true";
      deleteBtn.textContent = "Confirm?";
      deleteBtn.classList.add("btn-delete-confirming");

      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn btn-ghost btn-sm";
      cancelBtn.textContent = "Cancel";
      deleteBtn.insertAdjacentElement("afterend", cancelBtn);

      const reset = () => {
        deleteBtn.textContent = "Delete";
        deleteBtn.classList.remove("btn-delete-confirming");
        delete deleteBtn.dataset.confirming;
        cancelBtn.remove();
      };

      cancelBtn.addEventListener("click", reset);

      deleteBtn.addEventListener(
        "click",
        async () => {
          deleteBtn.disabled = true;
          cancelBtn.disabled = true;
          try {
            await deleteConfig(name);
            await openConfigListModal();
          } catch (e: any) {
            reset();
            deleteBtn.disabled = false;
            // Show error inline
            const errEl = document.createElement("span");
            errEl.className = "modal-error";
            errEl.style.fontSize = "0.72rem";
            errEl.textContent = e.message ?? "Delete failed";
            row.insertAdjacentElement("afterend", errEl);
            setTimeout(() => errEl.remove(), 4000);
          }
        },
        { once: true },
      );
    });
  });

  openModal(container);
}

async function openTriggerModal(prefill = ""): Promise<void> {
  const configs = await fetchConfigs();

  const container = document.createElement("div");
  container.className = "modal-form";

  const noConfigs =
    configs.length === 0
      ? `<p class="config-list-empty">No configs yet. Add one first.</p>`
      : "";

  const rows = configs
    .map(
      (c) => `
      <button type="button" class="config-select-row${c.name === prefill ? " selected" : ""}" data-repo="${escHtml(c.name)}">
        <div class="config-list-info">
          <span class="config-list-name">${escHtml(c.name)}</span>
          <span class="config-list-meta">${escHtml(c.branch)} &middot; <code>${escHtml(c.path)}</code></span>
        </div>
        <span class="config-select-check">&#10003;</span>
      </button>`,
    )
    .join("");

  container.innerHTML = `
    <h2 class="modal-title">Run Deploy</h2>
    <div class="config-list">${noConfigs}${rows}</div>
    <p class="modal-error hidden" id="modal-error"></p>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="btn-modal-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="btn-trigger-deploy" ${configs.length === 0 ? "disabled" : ""}>&#9654; Run</button>
    </div>
  `;

  // Track selection
  let selectedRepo = prefill || (configs.length === 1 ? configs[0].name : "");

  // Pre-select single config or prefill
  if (selectedRepo) {
    container
      .querySelector<HTMLElement>(`[data-repo="${selectedRepo}"]`)
      ?.classList.add("selected");
  }

  const deployBtn = container.querySelector<HTMLButtonElement>(
    "#btn-trigger-deploy",
  )!;
  const errEl = container.querySelector<HTMLElement>("#modal-error")!;

  function updateDeployBtn() {
    deployBtn.disabled = !selectedRepo;
  }
  updateDeployBtn();

  container
    .querySelectorAll<HTMLElement>(".config-select-row")
    .forEach((row) => {
      row.addEventListener("click", () => {
        container
          .querySelectorAll(".config-select-row")
          .forEach((r) => r.classList.remove("selected"));
        row.classList.add("selected");
        selectedRepo = row.dataset.repo!;
        updateDeployBtn();
      });
    });

  deployBtn.addEventListener("click", async () => {
    if (!selectedRepo) return;
    try {
      deployBtn.disabled = true;
      deployBtn.textContent = "Starting…";
      await triggerDeploy(selectedRepo);
      closeModal();
      setTimeout(async () => {
        deploys = await fetchAllDeploys();
        renderDeployList();
      }, 800);
    } catch (err) {
      errEl.textContent =
        err instanceof Error ? err.message : "Something went wrong.";
      errEl.classList.remove("hidden");
      deployBtn.disabled = false;
      deployBtn.innerHTML = "&#9654; Run";
    }
  });

  container
    .querySelector("#btn-modal-cancel")!
    .addEventListener("click", closeModal);

  openModal(container);
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  // Load deploys and commits in parallel
  [deploys, commits] = await Promise.all([
    fetchAllDeploys(),
    fetchAllCommits(),
  ]);
  renderDeployList();
  renderCommitList();
  startPolling();

  document
    .getElementById("btn-add-config")!
    .addEventListener("click", openConfigListModal);
  document
    .getElementById("btn-trigger")!
    .addEventListener("click", () => openTriggerModal());
  document.getElementById("btn-logout")!.addEventListener("click", doLogout);

  // ── Filter panel ──────────────────────────────────────────────────────────
  const filterBtn = document.getElementById("btn-deploy-filter")!;
  const filterPanel = document.getElementById("deploy-filter-panel")!;
  const filterManualEl = document.getElementById(
    "filter-manual",
  ) as HTMLButtonElement;
  const filterAutoEl = document.getElementById(
    "filter-auto",
  ) as HTMLButtonElement;
  const filterRepoEl = document.getElementById(
    "filter-repo",
  ) as HTMLSelectElement;

  // Populate repo select from configs + build commit filter pills
  const configs = await fetchConfigs();
  for (const cfg of configs) {
    const opt = document.createElement("option");
    opt.value = cfg.name;
    opt.textContent = cfg.name;
    filterRepoEl.appendChild(opt);
  }
  populateCommitConfigSelect(configs);

  // Toggle filter panel visibility
  filterBtn.addEventListener("click", () => {
    const isHidden = filterPanel.classList.toggle("hidden");
    filterBtn.setAttribute("aria-expanded", String(!isHidden));
    if (!isHidden) {
      filterBtn.classList.add("btn-filter-active");
    } else {
      // Only remove the active class if no filters are actually active
      if (filterManual && filterAuto && filterRepo === "") {
        filterBtn.classList.remove("btn-filter-active");
      }
    }
  });

  function updateFilterButtonState(): void {
    const anyActive = !filterManual || !filterAuto || filterRepo !== "";
    if (anyActive) {
      filterBtn.classList.add("btn-filter-active");
    } else if (filterPanel.classList.contains("hidden")) {
      filterBtn.classList.remove("btn-filter-active");
    }
  }

  // Manual pill button
  filterManualEl.addEventListener("click", async () => {
    filterManual = !filterManual;
    filterManualEl.classList.toggle("active", filterManual);
    updateFilterButtonState();
    // Only re-fetch if repo filter is set; otherwise just re-render
    if (filterRepo) {
      await applyFilters();
    } else {
      renderDeployList();
    }
  });

  // Auto pill button
  filterAutoEl.addEventListener("click", async () => {
    filterAuto = !filterAuto;
    filterAutoEl.classList.toggle("active", filterAuto);
    updateFilterButtonState();
    if (filterRepo) {
      await applyFilters();
    } else {
      renderDeployList();
    }
  });

  // Repo select
  filterRepoEl.addEventListener("change", async () => {
    filterRepo = filterRepoEl.value;
    updateFilterButtonState();
    await applyFilters();
  });

  // ── Commit filter panel toggle ──────────────────────────────────────────
  const commitFilterBtn = document.getElementById("btn-commit-filter")!;
  const commitFilterPanel = document.getElementById("commit-filter-panel")!;

  commitFilterBtn.addEventListener("click", () => {
    const isHidden = commitFilterPanel.classList.toggle("hidden");
    commitFilterBtn.setAttribute("aria-expanded", String(!isHidden));
    if (!isHidden && commitFilterRepo !== "") {
      commitFilterBtn.classList.add("btn-filter-active");
    } else if (isHidden && commitFilterRepo === "") {
      commitFilterBtn.classList.remove("btn-filter-active");
    }
  });

  const commitConfigSelectEl = document.getElementById(
    "filter-commit-config",
  ) as HTMLSelectElement;
  commitConfigSelectEl.addEventListener("change", () => {
    commitFilterRepo = commitConfigSelectEl.value;
    updateCommitFilterBtnState();
    renderCommitList();
  });
}

init();
