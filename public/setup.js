/* First-run setup wizard ------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);

const state = {
  url: "http://localhost:11434",
  models: [], // [{ name, size, family, parameterSize, quant }]
  recommended: {}, // task -> { model, label, description }
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function setStatus(el, kind, text, sub) {
  el.className = `inline-status ${kind || ""}`;
  el.innerHTML = text + (sub ? `<span class="sub">${sub}</span>` : "");
}

function normalizeUrl(raw) {
  let u = String(raw || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u;
}

// ---- step 1 : connect ----------------------------------------------------

async function testConnection() {
  const input = $("#ollama-url");
  const url = normalizeUrl(input.value.trim());
  input.value = url;

  const btn = $("#btn-test");
  btn.disabled = true;
  setStatus($("#connect-status"), "warn", `Checking ${url} …`);

  const { data } = await api("/api/setup/probe", {
    method: "POST",
    body: JSON.stringify({ url }),
  });
  btn.disabled = false;

  if (data.ok) {
    state.connected = true;
    state.url = url;
    setStatus(
      $("#connect-status"),
      "ok",
      `Connected — Ollama ${data.version ? `v${data.version} ` : ""}· ${data.modelCount} model${data.modelCount === 1 ? "" : "s"} installed.`,
      "Below: pick a model for each role, then finish."
    );
    $("#connect-actions").classList.remove("hidden");
    $("#step-models").hidden = false;
    $("#step-finish").hidden = false;
    await fetchModels();
  } else {
    state.connected = false;
    setStatus(
      $("#connect-status"),
      "err",
      data.error || "Connection failed.",
      "Check the URL. If Ollama is not installed yet, see ollama.com."
    );
    $("#connect-actions").classList.add("hidden");
    $("#step-models").hidden = true;
    $("#step-finish").hidden = true;
  }
}

// ---- step 2 : models -----------------------------------------------------

async function fetchModels() {
  if (!state.connected) return;
  const statusEl = $("#models-status");
  setStatus(statusEl, "warn", "Fetching installed models …");

  const { data } = await api("/api/setup/models", {
    method: "POST",
    body: JSON.stringify({ url: state.url }),
  });

  if (!data.ok) {
    setStatus(statusEl, "err", data.error || "Could not fetch models.");
    return;
  }

  state.models = data.models || [];
  renderRoles();
  updateSaveState();

  if (!state.models.length) {
    setStatus(
      statusEl,
      "err",
      "No models installed yet.",
      "Install them yourself in a terminal, e.g.  ollama pull qwen3.5:4b · ollama pull phi4-mini:3.8b — then hit Refresh."
    );
  } else {
    setStatus(
      statusEl,
      "ok",
      `${state.models.length} model${state.models.length === 1 ? "" : "s"} loaded. Nothing is pre-selected — choose a model for each role.`
    );
  }
}

function renderRoles() {
  const list = $("#role-list");
  list.innerHTML = "";

  for (const [task, meta] of Object.entries(state.recommended)) {
    const installed = state.models.some((m) => m.name === meta.model);

    const row = document.createElement("div");
    row.className = "role-row";

    const head = document.createElement("div");
    head.className = "role-head";

    const title = document.createElement("div");
    title.className = "role-title";
    title.textContent = meta.label;
    const desc = document.createElement("small");
    desc.textContent = meta.description;
    title.appendChild(desc);

    const badge = document.createElement("span");
    badge.className = `role-badge ${installed ? "ok" : "missing"}`;
    badge.textContent = `recommended: ${meta.model}${installed ? " · installed" : " · not installed"}`;
    head.append(title, badge);

    const select = document.createElement("select");
    select.dataset.task = task;

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "— select a model —";
    select.appendChild(placeholder);

    for (const m of state.models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = m.name + (m.parameterSize ? `  (${m.parameterSize})` : "");
      select.appendChild(opt);
    }

    select.disabled = state.models.length === 0;
    select.addEventListener("change", updateSaveState);

    row.append(head, select);
    list.appendChild(row);
  }
}

function readRoleSelections() {
  const out = {};
  for (const sel of document.querySelectorAll("#role-list select")) {
    out[sel.dataset.task] = sel.value;
  }
  return out;
}

function updateSaveState() {
  const selections = readRoleSelections();
  const complete = Object.values(selections).every((v) => Boolean(v));
  $("#btn-save").disabled = !complete;
}

// ---- step 3 : finish -----------------------------------------------------

async function save() {
  const port = Number($("#setup-port").value);
  const body = {
    url: state.url,
    port: port || 5173,
    ...readRoleSelections(),
  };

  const btn = $("#btn-save");
  btn.disabled = true;
  setStatus($("#save-status"), "warn", "Writing .env …");

  const { data } = await api("/api/setup/save", {
    method: "POST",
    body: JSON.stringify(body),
  });
  btn.disabled = false;

  if (data.ok) {
    $("#step-models").hidden = true;
    $("#step-finish").hidden = true;
    $("#save-status").hidden = true;
    $("#setup-badge").textContent = "configured · restarting";
    $("#done-card").hidden = false;
    countdownAndReload(data.restartIn || 3000);
  } else {
    setStatus($("#save-status"), "err", data.error || "Could not save settings.");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function countdownAndReload(millis) {
  const countEl = $("#restart-count");
  const msg = $("#restart-count").closest("p");
  const seconds = Math.max(1, Math.round(millis / 1000));

  for (let i = seconds; i > 0; i -= 1) {
    countEl.textContent = String(i);
    await sleep(1000);
  }

  // Phase 1: wait until the old process has released the port.
  let sawDown = false;
  for (let i = 0; i < 40 && !sawDown; i += 1) {
    try {
      await fetch("/", { cache: "no-store" });
    } catch {
      sawDown = true;
    }
    if (!sawDown) await sleep(300);
  }

  // Phase 2: wait for the freshly restarted server, then load the app.
  for (let i = 0; i < 60 && sawDown; i += 1) {
    try {
      const res = await fetch("/", { cache: "no-store" });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
    } catch {
      /* still booting */
    }
    await sleep(500);
  }

  if (msg) {
    msg.textContent =
      "The app didn't come back automatically. Press R in the launcher to restart it.";
  }
}

// ---- boot ----------------------------------------------------------------

async function init() {
  const { data } = await api("/api/setup/status");
  if (!data || data.setupMode === false) {
    window.location.href = "/";
    return;
  }
  state.recommended = data.recommended || {};
  if (data.port) $("#setup-port").value = data.port;
  if (data.defaultOllamaUrl) $("#ollama-url").value = data.defaultOllamaUrl;

  $("#btn-save").disabled = true;
  $("#btn-test").addEventListener("click", testConnection);
  $("#btn-refresh").addEventListener("click", fetchModels);
  $("#btn-save").addEventListener("click", save);
  $("#ollama-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") testConnection();
  });
}

init();