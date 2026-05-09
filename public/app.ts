// ── Types (mirroring backend) ───────────────────────────────────────────────

type DeployStatus = "pending" | "running" | "success" | "failed" | "stopped";

interface ConfigEntry {
  name: string;
  path: string;
  branch: string;
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

// ── State ───────────────────────────────────────────────────────────────────

let deploys: Deploy[] = [];
let selectedId: number | null = null;
let activeStream: EventSource | null = null;
let pollTimer: number | null = null;

// ── Filter state ─────────────────────────────────────────────────────────────
let filterManual = true;
let filterAuto = true;
let filterRepo = ""; // "" = all repos

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
): Promise<void> {
  const res = await fetch("/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, secret, path: pathDir, branch }),
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

async function doLogout(): Promise<void> {
  await fetch("/logout", { method: "POST" });
  window.location.href = "/login";
}

// ── Filter helpers ────────────────────────────────────────────────────────────

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
  const form = document.createElement("form");
  form.className = "modal-form";
  form.innerHTML = `
        <h2 class="modal-title">${isEdit ? "Edit Config" : "Add Config"}</h2>
        <label>Repo name     <input name="name"   type="text"      placeholder="my-app"       value="${escHtml(prefill?.name ?? "")}" ${isEdit ? "readonly" : ""} /></label>
        <label>Webhook secret <input name="secret" type="password"  placeholder="${isEdit ? "Leave blank to keep existing" : "&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"}" /></label>
        <label>Deploy path   <input name="path"   type="text"      placeholder="/srv/my-app"  value="${escHtml(prefill?.path ?? "")}" /></label>
        <label>Branch        <input name="branch" type="text"      placeholder="main"         value="${escHtml(prefill?.branch ?? "")}" /></label>
        <p class="modal-error hidden" id="modal-error"></p>
        <div class="modal-actions">
            <button type="button" class="btn btn-ghost"    id="btn-modal-cancel">${isEdit ? "Back" : "Cancel"}</button>
            <button type="submit" class="btn btn-primary">Save</button>
        </div>
    `;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const errEl = form.querySelector<HTMLElement>("#modal-error")!;
    try {
      await saveConfig(
        data.get("name") as string,
        data.get("secret") as string,
        data.get("path") as string,
        data.get("branch") as string,
      );
      closeModal();
    } catch (err) {
      errEl.textContent =
        err instanceof Error ? err.message : "Something went wrong.";
      errEl.classList.remove("hidden");
    }
  });

  form.querySelector("#btn-modal-cancel")!.addEventListener("click", () => {
    if (isEdit) {
      openConfigListModal();
    } else {
      closeModal();
    }
  });
  openModal(form);
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
      <div class="config-list-row" data-name="${escHtml(c.name)}" data-path="${escHtml(c.path)}" data-branch="${escHtml(c.branch)}">
        <div class="config-list-info">
          <span class="config-list-name">${escHtml(c.name)}</span>
          <span class="config-list-meta">${escHtml(c.branch)} &middot; <code>${escHtml(c.path)}</code></span>
        </div>
        <button type="button" class="btn btn-secondary btn-sm btn-edit-config">Edit</button>
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
      });
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
  deploys = await fetchAllDeploys();
  renderDeployList();
  startPolling();

  document
    .getElementById("btn-add-config")!
    .addEventListener("click", openConfigListModal);
  document
    .getElementById("btn-trigger")!
    .addEventListener("click", () => openTriggerModal());
  document.getElementById("btn-logout")!.addEventListener("click", doLogout);

  // ── Filter panel ──────────────────────────────────────────────────────────
  const filterBtn = document.getElementById("btn-filter")!;
  const filterPanel = document.getElementById("filter-panel")!;
  const filterManualEl = document.getElementById(
    "filter-manual",
  ) as HTMLButtonElement;
  const filterAutoEl = document.getElementById(
    "filter-auto",
  ) as HTMLButtonElement;
  const filterRepoEl = document.getElementById(
    "filter-repo",
  ) as HTMLSelectElement;

  // Populate repo select from configs
  const configs = await fetchConfigs();
  for (const cfg of configs) {
    const opt = document.createElement("option");
    opt.value = cfg.name;
    opt.textContent = cfg.name;
    filterRepoEl.appendChild(opt);
  }

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
}

init();
