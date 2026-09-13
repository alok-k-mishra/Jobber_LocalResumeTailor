// ---------------------------------------------------------------------------
// Resume Memory — Jobber UI
// ---------------------------------------------------------------------------

const state = {
  view: "memory", // "memory" | "app"
  appTab: "overview",
  sessionId: null,
  session: null,
  sessions: [],
  sessionsLoaded: false,
  memory: null, // summary {structured, counts,...}
  memoryFacts: [],
  uploaded: null, // pending upload { facts, extraction, structured, diff, rawText, filename }
  memTab: null, // currently open Resume Memory section tab
  busy: false, // a global LLM process is running (resume upload/parse only)
  runningSessions: new Set(), // sessions with an in-flight analysis/tailor/answer — applications run concurrently
  processTimers: new Map(), // sessionId -> poll timer for a process reattached after a refresh
  currentProcess: null, // { type: "analysis"|"tailor", steps: [...], note } shown inside the tab of the running process
  uploading: false, // a resume upload/parse is in flight -> keep its progress visible
  memRemoved: new Set(), // evidence ids / sub ids queued for removal in the editor
  memEventsBound: false, // editor delegation listeners registered once
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function $(id) {
  return document.getElementById(String(id).replace(/^#/, ""));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    const err = new Error(json.error || `Request failed (HTTP ${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function setLastSession(id) {
  try {
    if (id) localStorage.setItem("last-session", id);
    else localStorage.removeItem("last-session");
  } catch {
    /* storage unavailable */
  }
}

function getLastSession() {
  try {
    return localStorage.getItem("last-session");
  } catch {
    return null;
  }
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad(n) {
  return String(n).padStart(3, "0");
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthOptions(selected) {
  let out = `<option value="">Month</option>`;
  for (const m of MONTHS_SHORT) {
    out += `<option value="${m}" ${selected === m ? "selected" : ""}>${m}</option>`;
  }
  return out;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

// Minimal markdown renderer: headings, lists, bold, italics, quotes, paragraphs.
function renderMarkdown(text) {
  if (!text) return "";
  let h = String(text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  h = h.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  h = h.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  h = h.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\*(.+?)\*/g, "<em>$1</em>");
  h = h.replace(/^- (.+)$/gm, "<li>$1</li>");
  h = h.replace(/(?:<li>.*<\/li>\s*)+/g, (m) => `<ul>${m}</ul>`);
  h = h.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  h = h.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
  h = h.replace(/\n\n/g, "</p><p>");
  h = h.replace(/\n/g, "<br>");
  if (!h.startsWith("<")) h = `<p>${h}</p>`;
  return `<div class="md">${h}</div>`;
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

async function loadStatus() {
  try {
    const { ollama } = await api("/api/status");
    const el = $("#status");
    if (ollama.available) {
      const labels = { extraction: "parse", reasoning: "tailor", validation: "verify" };
      const chips = Object.entries(ollama.routing)
        .filter(([, r]) => r.resolved)
        .map(
          ([task, r]) =>
            `<span class="smodel" title="${esc(labels[task] || task)}: ${esc(r.resolved)}">
              <span class="smodel-name">${esc(String(r.resolved).split(":")[0])}</span>
              <span class="smodel-task">${esc(labels[task] || task)}</span>
              ${r.changed ? "<span class=\"smodel-auto\" title=\"tag auto-resolved\">*</span>" : ""}
            </span>`
        )
        .join("");
      el.innerHTML =
        `<span class="pill ok">Local AI ready</span>` +
        (chips ? `<span class="status-models">${chips}</span>` : "") +
        (Object.values(ollama.routing).some((r) => r.changed) ? `<span class="muted tiny">auto-resolved</span>` : "");
    } else {
      el.innerHTML = `<span class="pill off">No Ollama</span><span class="muted tiny">Start Ollama and reload.</span>`;
    }
  } catch {
    $("#status").innerHTML = `<span class="pill off">No Ollama</span>`;
  }
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const NAV_FADE_MS = 120;

function switchView(view) {
  const prevId = ["view-memory", "view-app", "view-questions"].find((id) => {
    const el = $(id);
    return el && !el.classList.contains("hidden");
  });
  const prev = prevId ? $(prevId) : null;
  state.view = view;
  document.querySelectorAll(".side-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
  });
  const go = () => {
    $("#view-memory").classList.toggle("hidden", view !== "memory");
    $("#view-app").classList.toggle("hidden", view !== "app");
    $("#view-questions").classList.toggle("hidden", view !== "questions");
    if (view === "memory") {
      loadMemory().then(renderMemoryView);
    } else if (view === "questions") {
      renderQuestionsView();
    } else {
      renderAppView();
    }
  };
  if (!prev || prev.id === `view-${view}`) { go(); return; }
  prev.classList.add("panel-fading");
  setTimeout(() => { prev.classList.remove("panel-fading"); go(); }, NAV_FADE_MS);
}

function switchAppTab(name) {
  state.appTab = name;
  for (const t of document.querySelectorAll(".app-tab")) {
    t.classList.toggle("active", t.dataset.apptab === name);
  }
  const prev = document.querySelector(".panel:not(.hidden)");
  const go = () => {
    for (const p of document.querySelectorAll(".panel")) p.classList.add("hidden");
    const panel = $(`panel-${name}`);
    if (panel) panel.classList.remove("hidden");
    renderAppPanel(name);
    // A running process redraws its steps in the tab it belongs to, so it stays
    // visible no matter how the user navigates.
    if (state.currentProcess && processTab(state.currentProcess.type) === name) {
      renderStepsInto(name);
    }
  };
  if (!prev || prev.id === `panel-${name}`) { go(); return; }
  prev.classList.add("panel-fading");
  setTimeout(() => { prev.classList.remove("panel-fading"); go(); }, NAV_FADE_MS);
}

// ---------------------------------------------------------------------------
// Applications sidebar
// ---------------------------------------------------------------------------

async function loadSessions() {
  const { sessions } = await api("/api/sessions");
  state.sessions = sessions || [];
  state.sessionsLoaded = true;
  renderSidebar();
}

const PENCIL_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
const TRASH_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

function renderSidebar() {
  const list = $("#app-list");
  list.innerHTML =
    state.sessions
      .map(
        (s) => `
      <div class="app-item ${s.id === state.sessionId ? "active" : ""}" data-sid="${esc(s.id)}">
        <div class="app-item-text">
          <span class="app-item-name">${esc(s.name || "Application")}${s.process ? ` <span class="app-running" title="A process is running in the background">running</span>` : ""}</span>
          <span class="app-item-meta">${esc(jdShortName(s))}${s.job_url ? ` &middot; ${esc(jobLinkDomain(s.job_url) || "link")}` : ""}</span>
        </div>
        <div class="app-item-actions">
          <button class="icon-btn app-rename" data-sid="${esc(s.id)}" type="button" title="Rename application" aria-label="Rename application">${PENCIL_ICON}</button>
          <button class="icon-btn danger app-delete" data-sid="${esc(s.id)}" type="button" title="Delete application" aria-label="Delete application">${TRASH_ICON}</button>
        </div>
      </div>`
      )
      .join("") ||
    '<div class="muted small" style="padding:8px 4px">No applications yet.</div>';
}

function jdShortName(s) {
  if (s.job_title) return `${s.job_title}${s.company ? " · " + s.company : ""}`;
  const d = new Date(s.updated_at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

function jobLinkDomain(url) {
  try {
    return new URL(String(url || "")).hostname;
  } catch {
    return "";
  }
}

async function createApplication() {
  try {
    const { session } = await api("/api/sessions", { method: "POST" });
    state.sessionId = session.id;
    state.session = session;
    setLastSession(session.id);
    state.appTab = "job";
    await loadSessions();
    switchView("app");
  } catch (err) {
    toast("Could not create application: " + err.message);
  }
}

async function openApplication(id) {
  try {
    if (id === state.sessionId) {
      // Already open — make sure the workspace is visible so a click is never
      // a no-op (e.g. after returning from Resume Memory).
      switchView("app");
      return;
    }
    const { session } = await api(`/api/sessions/${id}`);
    state.sessionId = session.id;
    state.session = session;
    setLastSession(session.id);
    state.appTab = session.jd ? "overview" : "job";
    state.currentProcess = null;
    renderSidebar();
    switchView("app");
    if (session.process) startProcessWatch(session.id, session.process);
  } catch (err) {
    toast("Could not open application: " + err.message);
  }
}

async function renameApplication(id) {
  const target = state.sessions.find((s) => s.id === id) || state.session;
  if (!target) return;
  const entered = prompt("Application name:", target.name || "");
  if (entered === null) return;
  const name = entered.trim();
  if (!name || name === target.name) return;
  try {
    const { session } = await api(`/api/sessions/${target.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    if (target.id === state.sessionId) state.session = session;
    renderAppHeader();
    await loadSessions();
    toast("Application renamed.");
  } catch (err) {
    toast("Rename failed: " + err.message);
  }
}

async function deleteApplication(id) {
  const target = state.sessions.find((s) => s.id === id) || state.session;
  if (!target) return;
  if (
    !confirm(
      `Delete this application${target.name ? ` ("${target.name}")` : ""}? This cannot be undone.`
    )
  )
    return;
  try {
    await api(`/api/sessions/${target.id}`, { method: "DELETE" });
    stopProcessWatch(target.id);
    if (target.id === state.sessionId) {
      if (state.currentProcess && processTab(state.currentProcess.type) === "overview") {
        state.currentProcess = null;
      }
      setLastSession(null);
      state.sessionId = null;
      state.session = null;
      state.appTab = "job";
    }
    await loadSessions();
    if (!state.session) switchView("app");
  } catch (err) {
    toast("Delete failed: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// Resume Memory
// ---------------------------------------------------------------------------

async function loadMemory() {
  try {
    const { memory, facts } = await api("/api/resume-memory");
    state.memory = memory;
    state.memoryFacts = facts || [];
  } catch {
    state.memory = null;
    state.memoryFacts = [];
  }
}

const UPLOAD_PHASES = [
  { phase: "read", label: "Reading file and extracting text…" },
  { phase: "segment", label: "Segmenting resume sections…" },
  { phase: "extract", label: "Extracting and enriching facts (Qwen 3.5)…" },
  { phase: "structure", label: "Structuring & comparing…" },
];

function renderUploadProgress(fileName, activePhase) {
  const el = $("#mem-upload-progress");
  if (!el) return;
  const activeIdx = UPLOAD_PHASES.findIndex((p) => p.phase === activePhase);
  el.innerHTML = `<div class="card upload-progress">
    <h2>Parsing ${esc(fileName)}</h2>
    <ul class="progress">${UPLOAD_PHASES.map((p, i) => {
      const cls = i === activeIdx ? "active" : i < activeIdx ? "done" : "";
      return `<li class="${cls}"><span class="dot"></span><span>${esc(p.label)}</span></li>`;
    }).join("")}</ul>
    ${activePhase === "extract" ? `<p class="muted small">The model is reading your resume line-by-line. This is the slow step — usually 30–90 seconds.</p>` : ""}
  </div>`;
}

/**
 * Upload + parse a resume, streaming per-stage progress from the server over
 * SSE so the user always sees what is happening.
 */
async function uploadResume(file) {
  state.busy = true;
  state.uploading = true;
  try {
    const form = new FormData();
    form.append("resume", file);
    // While parsing, the Resume Memory view shows ONLY the progress card so a
    // stray re-render can never reset it to the empty "Master resume" state.
    const container = $("#view-memory");
    container.innerHTML = "";
    const progressHost = document.createElement("div");
    progressHost.id = "mem-upload-progress";
    container.appendChild(progressHost);
    renderUploadProgress(file.name, "read");
    const res = await fetch("/api/resume-memory/upload", { method: "POST", body: form });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || `Upload failed (HTTP ${res.status}).`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let result = null;
    let failed = null;
    const handleBlock = (block) => {
      const evt = (block.split("\n").find((l) => l.startsWith("event:")) || "event: message").slice(6).trim();
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data) return;
      let payload;
      try { payload = JSON.parse(data); } catch { return; }
      if (evt === "progress") renderUploadProgress(file.name, payload.phase);
      else if (evt === "result") result = payload;
      else if (evt === "error") failed = new Error(payload.error || "Upload failed.");
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n\n");
      while (nl !== -1) {
        const block = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        handleBlock(block);
        nl = buf.indexOf("\n\n");
      }
    }
    if (failed) throw failed;
    if (!result) throw new Error("Upload ended without a result from the server.");
    state.uploaded = {
      facts: result.facts || [],
      extraction: result.extraction || {},
      structured: result.structured || null,
      diff: result.diff || null,
      rawText: result.rawText || "",
      filename: file.name,
      isNew: Boolean(result.isNew),
    };
    toast(result.isNew ? "Resume parsed. Review, then save as Resume Memory." : "Resume parsed. Review the changes.");
  } finally {
    state.busy = false;
    state.uploading = false;
  }
}

function renderMemoryView() {
  if (state.uploading) return; // an upload/parse is in flight — keep its progress view
  const container = $("#view-memory");
  const memory = state.memory;
  const uploaded = state.uploaded;

  if (!memory) {
    container.innerHTML = renderMemoryEmpty(uploaded);
  } else {
    container.innerHTML =
      renderMemoryHeader(memory) +
      (uploaded && uploaded.diff ? renderDiffCard(uploaded, memory) : "") +
      renderMemoryEditor(memory.structured, { preview: false });
  }
  bindMemoryEvents();
}

function renderMemoryEmpty(uploaded) {
  let html = `<div class="card">
    <h2>Master resume</h2>
    <p class="muted small">Upload your resume once. Resume Memory parses it into editable, structured data and keeps it as the single source of truth. Every application is analysed against this memory — nothing is re-parsed per job.</p>
    <div class="dropzone" id="dropzone">
      <input type="file" id="resume-input" accept=".pdf,.docx,.txt" hidden />
      <p>No Resume Memory yet</p>
      <button class="btn" type="button" id="resume-btn">Upload resume (PDF, DOCX or TXT)</button>
    </div>
    <p class="muted small" style="margin-top:12px">Uses Qwen 3.5 for parsing and Phi-4-mini for tailoring.</p>
  </div>`;

  if (uploaded && uploaded.isNew) {
    html += `<div class="card">
      <h2>Parsed data — review &amp; edit</h2>
      <p class="muted small">This is what was read from <b>${esc(uploaded.filename)}</b>. Edit anything, then save it as your Resume Memory.</p>
      ${renderMemoryEditor(uploaded.structured, { preview: true })}
      <div class="actions" style="margin-top:4px"><button class="btn" id="discard-upload-btn" type="button">Discard upload</button></div>
    </div>`;
  }
  return html;
}

function renderMemoryHeader(memory) {
  const structured = memory.structured || {};
  return `<div class="card">
    <div class="mem-head">
      <div>
        <h2>Resume Memory</h2>
        <p class="muted small">${esc(memory.filename || "resume")} &middot; ${memory.resume_fact_count ?? 0} resume facts
          ${memory.answer_count ? ` &middot; ${memory.answer_count} stored personal answer(s) reused across applications` : ""}
          &middot; approved ${fmtDate(memory.approved_at)}</p>
      </div>
      <div class="actions" style="margin-top:0">
        <button class="btn" id="replace-resume-btn" type="button">Upload newer resume</button>
        <button class="btn danger" id="delete-memory-btn" type="button">Delete</button>
      </div>
    </div>
    <input type="file" id="resume-input" accept=".pdf,.docx,.txt" hidden />
  </div>`;
}

function renderDiffCard(uploaded, memory) {
  const diff = uploaded.diff;
  if (!diff.changed) {
    return `<div class="card diff-card">
      <h2>Uploaded resume comparison</h2>
      <p class="muted">No changes detected against Resume Memory — the newer resume matches the stored version.</p>
      <button class="btn" id="discard-upload-btn" type="button">Dismiss</button>
    </div>`;
  }
  let html = `<div class="card diff-card">
    <h2>Newer resume detected — choose what refreshes Resume Memory</h2>
    <p class="muted small">${esc(diff.summary)}</p>
    <div class="diff-list">`;
  for (const s of diff.sections) {
    if (s.status !== "changed") continue;
    html += `<div class="diff-section">
      <label><input type="checkbox" class="diff-check" data-section="${esc(s.section)}" checked> <b>${esc(s.section)}</b>
        <span class="muted small">${s.added.length} added &middot; ${s.removed.length} removed &middot; ${s.modified.length} changed</span></label>`;
    for (const a of s.added.slice(0, 6)) {
      html += `<div class="diff-line add"><span class="muted small">+</span> ${esc(a.original_text || a.normalized_claim)}</div>`;
    }
    for (const m of s.modified.slice(0, 6)) {
      html += `<div class="diff-line mod"><div class="muted small">changed:</div> <s>${esc(m.old)}</s><br>→ ${esc(m.new)}</div>`;
    }
    for (const r of s.removed.slice(0, 6)) {
      html += `<div class="diff-line del"><span class="muted small">−</span> ${esc(r.original_text || r.normalized_claim)}</div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  const conflicts = diff.education_conflicts || [];
  if (conflicts.length) {
    const eduSec = conflicts[0].section;
    html += `<div class="diff-section diff-conflict" data-conflict-section="${esc(eduSec)}">
      <div class="diff-conflict-head">Education status conflicts</div>
      <p class="muted small">Resume Memory marks the following as <b>${esc(conflicts[0].status === "COMPLETED" ? "completed / graduated" : "in progress")}</b>, but the newer resume reads the opposite. Review this before applying the Education section.</p>`;
    for (const c of conflicts.slice(0, 5)) {
      html += `<div class="diff-line conflict"><span class="muted small">${esc(c.status)}:</span> ${esc(c.entity || "education")}<br><span class="muted small">newer resume:</span> ${esc(c.new_text)}</div>`;
    }
    html += `<div class="actions" style="margin-top:4px;justify-content:flex-start">
      <button class="btn" id="keep-edu-btn" type="button" data-section="${esc(eduSec)}">Keep Resume Memory</button>
      <button class="btn primary" id="review-edu-btn" type="button">Review change</button>
    </div></div>`;
  }
  html += `</div>
    <div class="actions" style="margin-top:4px">
      <button class="btn primary" id="apply-diff-btn" type="button">Refresh Resume Memory</button>
      <button class="btn" id="discard-upload-btn" type="button">Keep current</button>
    </div>
  </div>`;
  return html;
}

const GROUP_SECTIONS = new Set(["experience", "projects"]);

function entityLabelFor(key) {
  switch (key) {
    case "experience":
      return "Company / role";
    case "projects":
      return "Project";
    case "education":
      return "Institution";
    case "certifications":
      return "Certification";
    default:
      return "Entity";
  }
}

function renderMemBullet(b, { preview, sectionKey }) {
  const fid = b.fact_id || "";
  const isNew = !fid || String(fid).startsWith("NEW-");
  const rows = Math.max(1, Math.min(2, Math.ceil((b.text || "").length / 100)));
  return `<div class="sed-item sed-bullet" data-fid="${esc(fid)}" data-kind="bullet" ${isNew ? 'data-new="1"' : ""}>
    <textarea class="sed-text" rows="${rows}" placeholder="Bullet">${esc(b.text || "")}</textarea>
    ${preview ? "" : `<button class="link-like danger mem-remove" type="button" data-fid="${esc(fid)}" title="Remove bullet"><span class="btn-icon" aria-hidden="true">−</span></button>`}
  </div>`;
}

const LOCATION_TYPES = ["Remote", "Hybrid", "On-site"];

const EDU_TYPES = [
  { type: "High School", degrees: ["SSLC", "HSC", "A Levels", "IB", "Certificate"] },
  { type: "Diploma", degrees: ["Diploma"] },
  { type: "Bachelor's/Undergraduate", degrees: ["B.Tech", "B.E", "B.Sc", "B.A", "B.Com", "BBA", "BCA", "BA LLB", "B.Pharm", "B.Arch", "B.Des"] },
  { type: "Master's/Postgraduate", degrees: ["M.Tech", "M.E", "M.Sc", "M.A", "M.Com", "MBA", "MCA"] },
  { type: "Doctorate", degrees: ["Ph.D", "D.Sc", "Ed.D"] },
];

function eduTypeOptions(selected) {
  const known = EDU_TYPES.some((g) => g.type === selected);
  return (
    EDU_TYPES.map((g) => `<option value="${esc(g.type)}" ${g.type === selected ? "selected" : ""}>${esc(g.type)}</option>`).join("") +
    `<option value="Other" ${!known ? "selected" : ""}>Other</option>`
  );
}

function eduDegreesList() {
  return EDU_TYPES.flatMap((g) => g.degrees);
}

function renderMemEducation(item, { preview }) {
  const fid = item.fact_id || "";
  const isNew = !fid || String(fid).startsWith("NEW-") || fid === "";
  const listId = `edulist-${String(fid || "new").replace(/[^a-zA-Z0-9]/g, "")}`;
  return `<div class="sed-item sed-education" data-fid="${esc(fid)}" data-kind="education" ${isNew ? 'data-new="1"' : ""}>
    <div class="sed-educ-grid">
      <div><label>Type</label><select class="sed-etype">${eduTypeOptions(item.education_type || "")}</select></div>
      <div><label>Degree</label><input class="sed-degree" list="${esc(listId)}" value="${esc(item.degree || "")}" placeholder="Degree (pick or type)">
        <datalist id="${esc(listId)}">${eduDegreesList().map((d) => `<option value="${esc(d)}"></option>`).join("")}</datalist></div>
      <div><label>Course</label><input class="sed-course" value="${esc(item.course || "")}" placeholder="e.g. Computer Science"></div>
      <div><label>Specialization</label><input class="sed-specialization" value="${esc(item.specialization || "")}" placeholder="e.g. Machine Learning"></div>
      <div><label>Institution</label><input class="sed-institution" value="${esc(item.institution || "")}" placeholder="e.g. XYZ Institute of Technology"></div>
      <div><label>Duration</label><input class="sed-duration" value="${esc(item.duration || "")}" placeholder="e.g. 2021 - 2025"></div>
      <div><label>Status</label><select class="sed-edustatus">
        <option value="" ${!item.education_status ? "selected" : ""}>Not set</option>
        <option value="COMPLETED" ${item.education_status === "COMPLETED" ? "selected" : ""}>Completed / graduated</option>
        <option value="IN_PROGRESS" ${item.education_status === "IN_PROGRESS" ? "selected" : ""}>In progress</option>
      </select></div>
    </div>
    ${preview ? "" : `<button class="mem-remove-text" type="button" data-fid="${esc(fid)}" title="Remove education entry">Remove</button>`}
  </div>`;
}

function renderMemEntry(entry, bullets, { preview, sectionKey }) {
  const key = sectionKey;
  const label = entityLabelFor(key);
  const fid = entry.fact_id || "";
  const isNew = !fid || String(fid).startsWith("NEW-") || fid === "";
  const isExp = key === "experience";
  const isProj = key === "projects";
  const ltype = LOCATION_TYPES.includes(entry.location_type) ? entry.location_type : "";
  let html = `<div class="sed-group" data-section="${esc(key)}" data-group="${esc(entry.group_id || "")}" ${!preview && isNew ? 'data-newentry="1"' : ""}>
  <div class="sed-item sed-entry" data-fid="${esc(fid)}" data-kind="entry" ${isNew ? 'data-new="1"' : ""}>
    <div class="sed-entity-grid">${isExp ? `
      <div><label>Company</label><input class="sed-company" value="${esc(entry.company || "")}" placeholder="Company name"></div>
      <div><label>Role</label><input class="sed-role" value="${esc(entry.role || "")}" placeholder="Role / title"></div>` : `
      <div class="sed-entity"><label>${esc(label)}</label><input class="sed-ent" value="${esc(entry.entity || "")}" placeholder="${esc(label)}"></div>`}
    </div>
    ${isExp ? `<div class="sed-dates">
      <div class="sed-date"><label>From</label>
        <select class="sed-from-month">${monthOptions(entry.start_month)}</select>
        <input class="sed-from-year" value="${esc(entry.start_year || "")}" placeholder="Year" inputmode="numeric"></div>
      <div class="sed-date"><label>To</label><div class="sed-to-row">
        <select class="sed-to-month">${monthOptions(entry.end_month)}</select>
        <input class="sed-to-year" value="${esc(entry.end_year || "")}" placeholder="Year" inputmode="numeric">
        <label class="sed-present"><input type="checkbox" class="sed-present" ${entry.is_present ? "checked" : ""}> Present</label>
      </div></div>
    </div>` : ""}
    ${isExp ? `<div class="sed-locrow">
      <div><label>Location</label><input class="sed-location" value="${esc(entry.location || "")}" placeholder="e.g. Bengaluru"></div>
      <div><label>Type</label><select class="sed-loctype"><option value="">—</option>${LOCATION_TYPES.map((t) => `<option ${t === ltype ? "selected" : ""}>${t}</option>`).join("")}</select></div>
    </div>` : ""}
    ${isProj ? `<div class="sed-toolsrow"><label>Tools</label><input class="sed-tools" value="${esc((entry.tools || []).join(", "))}" placeholder="e.g. Python, FastAPI, PostgreSQL"></div>` : ""}
    ${isProj ? `<div class="sed-linkline">
      <div><label>Link text</label><input class="sed-link-text" value="${esc(entry.link?.text || "")}" placeholder="Visible link text"></div>
      <div><label>Link URL</label><input class="sed-link-url" value="${esc(entry.link?.url || "")}" placeholder="https://…"></div></div>` : ""}
    ${preview ? "" : `<button class="mem-remove-text" type="button" data-fid="${esc(fid)}" title="Remove entry and its bullets">Remove</button>`}
  </div>
  <div class="sed-bullets">`;
  for (const b of bullets) html += renderMemBullet(b, { preview, sectionKey: key });
  html += `</div>`;
  if (!preview) html += `<button class="mem-add-bullet" type="button" title="Add bullet" aria-label="Add bullet" data-section="${esc(key)}" data-group="${esc(entry.group_id || "")}"></button>`;
  html += `</div>`;
  return html;
}

function renderMemSection(sec, { preview, current, showTabs }) {
  const key = sec.key;
  const hidden = showTabs && key !== current;
  const isGroup = GROUP_SECTIONS.has(key) && sec.items.some((i) => i.kind === "entry");
  let html = `<div class="card sed-section mem-panel ${hidden ? "hidden" : ""}" data-seckey="${esc(key)}">
    <div class="sed-head"><h3>${esc(sec.title)}</h3><span class="muted small">${sec.items.length} item${sec.items.length !== 1 ? "s" : ""}</span></div>`;

  if (isGroup) {
    const entries = sec.items.filter((i) => i.kind === "entry");
    const byGroup = new Map();
    const orphans = [];
    for (const i of sec.items) {
      if (i.kind !== "bullet") continue;
      const g = i.group_id || "";
      if (g) {
        if (!byGroup.has(g)) byGroup.set(g, []);
        byGroup.get(g).push(i);
      } else {
        orphans.push(i);
      }
    }
    for (const entry of entries) {
      html += renderMemEntry(entry, byGroup.get(entry.group_id) || [], { preview, sectionKey: key });
    }
    for (const b of orphans) html += renderMemBullet(b, { preview, sectionKey: key });
    if (!preview) html += `<button class="btn small mem-add-entry" type="button" data-section="${esc(key)}">Add ${esc(entityLabelFor(key))}</button>`;
  } else if (key === "education") {
    for (const item of sec.items) {
      if (item.kind === "education") {
        html += renderMemEducation(item, { preview });
      } else {
        const rows = Math.max(1, Math.min(3, Math.ceil((item.text || "").length / 90)));
        html += `<div class="sed-item" data-fid="${esc(item.fact_id)}" data-kind="${esc(item.kind || "line")}">
          <textarea class="sed-text" rows="${rows}" placeholder="Text">${esc(item.text || "")}</textarea>
${preview ? "" : `<button class="mem-remove-text" type="button" data-fid="${esc(item.fact_id)}" title="Remove">Remove</button>`}
        </div>`;
      }
    }
    if (!preview) html += `<button class="btn small mem-add-edu" type="button" data-section="education">Add education</button>`;
  } else if (key === "skills") {
    const groups = new Map();
    for (const item of sec.items) {
      const sub = item.subcategory || "";
      if (!groups.has(sub)) groups.set(sub, []);
      groups.get(sub).push(item);
    }
    for (const [sub, items] of groups) {
      const label = (sub ? sub.replace(/_/g, " ") : "General").replace(/\b./g, (c) => c.toUpperCase());
      html += `<div class="sed-subcat-head" data-cat="${esc(sub)}"><h4>${esc(label)}</h4></div>`;
      for (const item of items) {
        html += `<div class="sed-item" data-fid="${esc(item.fact_id)}" data-kind="skill" data-cat="${esc(sub)}">
          <input class="sed-text" value="${esc(item.text || "")}" placeholder="Skill">
          ${preview ? "" : `<button class="mem-remove-text" type="button" data-fid="${esc(item.fact_id)}" title="Remove skill">Remove</button>`}
        </div>`;
      }
      if (!preview) html += `<button class="btn small mem-add-skill" type="button" data-section="skills" data-cat="${esc(sub)}">Add skill in ${esc(label)}</button>`;
    }
    if (!preview) html += `<button class="btn small mem-add-item" type="button" data-section="skills">Add skill</button>`;
  } else {
    for (const item of sec.items) {
      const rows = Math.max(1, Math.min(key === "summary" ? 8 : 3, Math.max(item.text.split("\n").length, Math.ceil((item.text || "").length / 90))));
      html += `<div class="sed-item" data-fid="${esc(item.fact_id)}" data-kind="${esc(item.kind || "line")}">
        ${item.entity ? `<div class="sed-entity"><label>Entity</label><input class="sed-ent" value="${esc(item.entity || "")}"></div>` : ""}
        <textarea class="sed-text" rows="${rows}" placeholder="Text">${esc(item.text || "")}</textarea>
        ${preview ? "" : `<button class="mem-remove-text" type="button" data-fid="${esc(item.fact_id)}" title="Remove">Remove</button>`}
      </div>`;
    }
if (!preview) html += `<button class="btn small mem-add-item" type="button" data-section="${esc(key)}">Add item</button>`;
}
  html += `</div>`;
  return html;
}

function renderMemoryEditor(structured, { preview }) {
  if (!structured || !structured.sections) {
    return `<div class="card"><p class="muted">No structured data yet.</p></div>`;
  }
  const contact = structured.contact || {};
  const qaItems = (state.memoryFacts || []).filter(
    (f) => f.source_type === "user_answer" && f.question && f.answer
  );
  const nonEmpty = (structured.sections || []).filter((sec) => sec.items && sec.items.length > 0);
  const tabs = [
    ...nonEmpty.map((sec) => ({ key: sec.key, title: sec.title, count: sec.items.length })),
    ...(qaItems.length ? [{ key: "qa", title: "Questions & Answers", count: qaItems.length }] : []),
  ];
  const current = tabs.some((t) => t.key === state.memTab) ? state.memTab : tabs[0]?.key || "";
  const showTabs = tabs.length > 1;

  let html = `<div id="mem-editor">
    <div class="card">
      <div class="sed-contact">
        <div><label>Name</label><input id="sed-name" value="${esc(structured.name || "")}"></div>
        <div><label>Email</label><input id="sed-email" value="${esc(contact.email || "")}"></div>
        <div><label>Phone</label><input id="sed-phone" value="${esc(contact.phone || "")}"></div>
        <div><label>Location</label><input id="sed-location" value="${esc(contact.location || "")}"></div>
        <div class="sed-links-wide"><label>Links (comma separated)</label><input id="sed-links" value="${esc((contact.links || []).join(", "))}"></div>
      </div>
    </div>`;

  if (showTabs) {
    html += `<div class="mem-tabs" id="mem-tabs">` +
      tabs
        .map(
          (t) =>
            `<button class="mem-tab ${t.key === current ? "active" : ""}" data-memtab="${esc(t.key)}" type="button">
              <span class="mem-tab-name">${esc(t.title)}</span>
              <span class="mem-tab-count">${t.count}</span>
            </button>`
        )
        .join("") +
      `</div>`;
  }

  for (const sec of nonEmpty) {
    html += renderMemSection(sec, { preview, current, showTabs });
  }

  if (qaItems.length) {
    html += `<div class="card mem-panel qa-panel ${current !== "qa" ? "hidden" : ""}" data-seckey="qa">
      <div class="sed-head"><h3>Questions &amp; Answers</h3><span class="muted small">${qaItems.length} stored answer${qaItems.length > 1 ? "s" : ""} — reused across applications</span></div>
      <p class="muted small">Every question comes only from a requirement in a job description you analysed — never invented. Answer once and future applications reuse it without asking again.</p>` +
      qaItems
        .map(
          (a) => `<div class="qa-entry">
        ${a.requirement_id ? `<div class="q-progress">${esc(a.requirement_id)}${a.skill_level ? ` &middot; ${esc(a.skill_level)}` : ""}</div>` : ""}
        <div class="q-text">${esc(a.question)}</div>
        <div class="answer-note">Answer: <b>${esc(a.answer)}</b></div>
      </div>`
        )
        .join("") +
      `</div>`;
  }
  html += `<div class="actions">
    <button class="btn primary" id="mem-save-btn" type="button">${preview ? "Save as Resume Memory" : "Save Resume Memory"}</button>
    ${preview && state.memory ? `<button class="btn" id="discard-upload-btn" type="button">Discard upload</button>` : ""}
  </div></div>`;
  return html;
}

function addMemItem(btn) {
  const section = btn.dataset.section || "";
  const card = document.createElement("div");
  card.dataset.new = "1";
  if (section === "skills") {
    card.className = "sed-item";
    card.dataset.fid = "";
    card.dataset.kind = "skill";
    card.dataset.cat = "";
    card.innerHTML = `<input class="sed-text" placeholder="Skill"><button class="mem-remove-text" type="button" title="Remove skill">Remove</button>`;
  } else {
    card.className = "sed-item";
    card.dataset.kind = "line";
    card.innerHTML = `<textarea class="sed-text" rows="2" placeholder="Text"></textarea><button class="mem-remove-text" type="button" title="Remove">Remove</button>`;
  }
  btn.insertAdjacentElement("beforebegin", card);
}

function addMemSkillInGroup(btn) {
  const sub = btn.dataset.cat || "";
  const card = document.createElement("div");
  card.className = "sed-item";
  card.dataset.fid = "";
  card.dataset.kind = "skill";
  card.dataset.cat = sub;
  card.dataset.new = "1";
  card.innerHTML = `<input class="sed-text" placeholder="Skill"><button class="mem-remove-text" type="button" title="Remove skill">Remove</button>`;
  btn.insertAdjacentElement("beforebegin", card);
}

function newEntryFieldsHtml(section) {
  const isExp = section === "experience";
  const isProj = section === "projects";
  let html = isExp
    ? `<div><label>Company</label><input class="sed-company" placeholder="Company name"></div>
       <div><label>Role</label><input class="sed-role" placeholder="Role / title"></div>`
    : `<div class="sed-entity"><label>${esc(entityLabelFor(section))}</label><input class="sed-ent" placeholder="${esc(entityLabelFor(section))}"></div>`;
  if (isExp) {
    html += `<div class="sed-dates">
      <div class="sed-date"><label>From</label><select class="sed-from-month">${monthOptions("")}</select><input class="sed-from-year" placeholder="Year" inputmode="numeric"></div>
      <div class="sed-date"><label>To</label><div class="sed-to-row">
        <select class="sed-to-month">${monthOptions("")}</select>
        <input class="sed-to-year" placeholder="Year" inputmode="numeric">
        <label class="sed-present"><input type="checkbox" class="sed-present"> Present</label>
      </div></div>
    </div>`;
  }
  if (isExp) {
    html += `<div class="sed-locrow">
      <div><label>Location</label><input class="sed-location" placeholder="e.g. Bengaluru"></div>
      <div><label>Type</label><select class="sed-loctype"><option value="">—</option>${LOCATION_TYPES.map((t) => `<option>${t}</option>`).join("")}</select></div>
    </div>`;
  }
  if (isProj) {
    html += `<div class="sed-toolsrow"><label>Tools</label><input class="sed-tools" placeholder="e.g. Python, FastAPI, PostgreSQL"></div>`;
    html += `<div class="sed-linkline">
      <div><label>Link text</label><input class="sed-link-text" placeholder="Visible link text"></div>
      <div><label>Link URL</label><input class="sed-link-url" placeholder="https://…"></div></div>`;
  }
  return html;
}

function addMemEntry(btn) {
  const section = btn.dataset.section || "";
  const card = document.createElement("div");
  card.className = "sed-group";
  card.dataset.section = section;
  card.dataset.newentry = "1";
  card.innerHTML = `<div class="sed-item sed-entry sed-newentry" data-kind="entry" data-fid="" data-new="1">
    ${newEntryFieldsHtml(section)}
    <button class="mem-remove-text" type="button" title="Remove entry and its bullets">Remove</button>
  </div>
  <div class="sed-bullets"></div>
  <button class="mem-add-bullet" type="button" title="Add bullet" aria-label="Add bullet" data-section="${esc(section)}"></button>`;
  btn.insertAdjacentElement("beforebegin", card);
}

function addMemEducation(btn) {
  const card = document.createElement("div");
  card.className = "sed-item sed-education";
  card.dataset.fid = "";
  card.dataset.kind = "education";
  card.dataset.new = "1";
  card.innerHTML = renderMemEducation({ fact_id: "", education_type: "", degree: "", course: "", specialization: "", institution: "", duration: "" }, { preview: false });
  btn.insertAdjacentElement("beforebegin", card);
}

function addMemBullet(btn) {
  const groupEl = btn.closest(".sed-group");
  const b = document.createElement("div");
  b.className = "sed-item sed-bullet";
  b.dataset.fid = "";
  b.dataset.kind = "bullet";
  b.dataset.new = "1";
  b.innerHTML = `<textarea class="sed-text" rows="1" placeholder="Bullet"></textarea>
    <button class="link-like danger mem-remove" type="button" title="Remove bullet"><span class="btn-icon" aria-hidden="true">−</span></button>`;
  const box = groupEl && groupEl.querySelector(".sed-bullets");
  if (box) box.appendChild(b);
  else btn.insertAdjacentElement("beforebegin", b);
}

function removeMemItem(btn) {
  const el = btn.closest(".sed-item");
  if (!el) return;
  const group = el.closest(".sed-group");
  if (el.classList.contains("sed-entry")) {
    if (el.dataset.fid) state.memRemoved.add(el.dataset.fid);
    for (const b of group ? group.querySelectorAll(".sed-bullet") : []) {
      if (b.dataset.fid) state.memRemoved.add(b.dataset.fid);
    }
    if (group) group.remove();
    toast("Entry marked for removal. Save to apply.");
    return;
  }
  if (el.dataset.fid) state.memRemoved.add(el.dataset.fid);
  el.remove();
  toast("Item marked for removal. Save to apply.");
}

/**
 * Collect server-applied additions/removals from the editor DOM. Existing
 * items carry real evidence ids (sent in `structured`); this only captures
 * items the user created since the last render (`data-new="1"`) and ids queued
 * for removal.
 */
function collectServerDelta() {
  const removed = Array.from(state.memRemoved || []);
  const added = [];
  for (const grp of document.querySelectorAll(".sed-group")) {
    const section = grp.dataset.seckey || grp.dataset.section || "";
    const entryEl = grp.querySelector(".sed-entry");
    if (!entryEl) continue;
    const isNewEntry = grp.dataset.newentry === "1";
    const bullets = Array.from(grp.querySelectorAll(".sed-bullet"));
    if (isNewEntry) {
      const read = readEditorItem(entryEl, section);
      const def = {
        section,
        kind: "entry",
        entity: read.entity || "",
        company: read.company || "",
        role: read.role || "",
        duration: read.duration || "",
        location: read.location || "",
        location_type: read.location_type || "",
        start_month: read.start_month || "",
        start_year: read.start_year || "",
        end_month: read.end_month || "",
        end_year: read.end_year || "",
        is_present: read.is_present,
        link: read.link,
        tools: read.tools || [],
        bullets: bullets.filter((b) => b.dataset.new === "1").map((b) => ({ text: b.querySelector(".sed-text")?.value || "" })),
      };
      if (def.entity || def.company || def.bullets.length || def.link?.url || def.tools.length) added.push(def);
    } else {
      for (const b of bullets.filter((bd) => bd.dataset.new === "1")) {
        const read = readEditorItem(entryEl, section);
        added.push({
          section,
          kind: "bullet",
          entity: read.entity || read.company || read.role || "",
          group_id: grp.dataset.group || "",
          text: b.querySelector(".sed-text")?.value || "",
        });
      }
    }
  }
  for (const el of document.querySelectorAll('.sed-item[data-new="1"]:not(.sed-entry):not(.sed-bullet)')) {
    const section = el.closest(".sed-section")?.dataset.seckey || "";
    if (el.dataset.kind === "education") {
      const read = readEditorItem(el, section);
      const def = {
        section,
        kind: "education",
        text: read.text || read.institution || read.degree || "",
        education_type: read.education_type || "",
        education_status: read.education_status || "",
        degree: read.degree || "",
        course: read.course || "",
        specialization: read.specialization || "",
        institution: read.institution || "",
        duration: read.duration || "",
      };
      if (def.text || def.institution || def.degree) added.push(def);
      continue;
    }
    const text = el.querySelector(".sed-text")?.value || "";
    if (!String(text).trim()) continue;
    added.push({ section, kind: section === "skills" ? "skill" : "line", text, subcategory: el.dataset.cat || "" });
  }
  return { added, removed };
}

function bindMemoryEvents() {
  const viewEl = $("#view-memory");
  if (viewEl && !state.memEventsBound) {
    state.memEventsBound = true;
    viewEl.addEventListener("click", (e) => {
      const addItemBtn = e.target.closest(".mem-add-item");
      if (addItemBtn) return addMemItem(addItemBtn);
      const addSkillBtn = e.target.closest(".mem-add-skill");
      if (addSkillBtn) return addMemSkillInGroup(addSkillBtn);
      const addEntryBtn = e.target.closest(".mem-add-entry");
      if (addEntryBtn) return addMemEntry(addEntryBtn);
      const addEduBtn = e.target.closest(".mem-add-edu");
      if (addEduBtn) return addMemEducation(addEduBtn);
      const addBulletBtn = e.target.closest(".mem-add-bullet");
      if (addBulletBtn) return addMemBullet(addBulletBtn);
      const removeBtn = e.target.closest(".mem-remove, .mem-remove-text");
      if (removeBtn) return removeMemItem(removeBtn);
    });
  }
  if (viewEl) {
    viewEl.addEventListener("change", (e) => {
      // Keep the degree datalist in sync with the education type.
      const typeSel = e.target.closest(".sed-etype");
      if (!typeSel) return;
      const item = typeSel.closest(".sed-item");
      if (!item) return;
      const list = item.querySelector("datalist");
      const input = item.querySelector(".sed-degree");
      const group = EDU_TYPES.find((g) => g.type === typeSel.value);
      if (list && input) {
        list.innerHTML = (group ? group.degrees : eduDegreesList())
          .map((d) => `<option value="${esc(d)}"></option>`)
          .join("");
        if (!group && typeSel.value !== "Other" && typeSel.value && !eduDegreesList().includes(input.value)) {
          input.value = "";
        }
      }
    });
  }
  const uploadBtn = $("#resume-btn");
  if (uploadBtn) uploadBtn.addEventListener("click", () => $("#resume-input").click());
  const replaceBtn = $("#replace-resume-btn");
  if (replaceBtn) replaceBtn.addEventListener("click", () => $("#resume-input").click());
  const input = $("#resume-input");
  if (input) {
    input.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file || state.busy) return;
      try {
        await uploadResume(file);
      } catch (err) {
        toast(err.message);
      }
      renderMemoryView();
    });
  }
  const saveBtn = $("#mem-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", saveMemoryEdits);
  const tabs = $("#mem-tabs");
  if (tabs) {
    tabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".mem-tab");
      if (!btn) return;
      state.memTab = btn.dataset.memtab;
      for (const t of tabs.querySelectorAll(".mem-tab")) {
        t.classList.toggle("active", t.dataset.memtab === state.memTab);
      }
      for (const p of document.querySelectorAll(".mem-panel")) {
        p.classList.toggle("hidden", p.dataset.seckey !== state.memTab);
      }
    });
  }
  const applyBtn = $("#apply-diff-btn");
  if (applyBtn) applyBtn.addEventListener("click", applyMemoryDiff);
  const discardBtn = $("#discard-upload-btn");
  if (discardBtn) discardBtn.addEventListener("click", () => { state.uploaded = null; renderMemoryView(); });
  const keepEdu = $("#keep-edu-btn");
  if (keepEdu) {
    keepEdu.addEventListener("click", () => {
      const box = document.querySelector(`.diff-check[data-section="${keepEdu.dataset.section}"]`);
      if (box) box.checked = false;
      toast("Keeping Resume Memory's education status — the Education section will be skipped.");
    });
  }
  const reviewEdu = $("#review-edu-btn");
  if (reviewEdu) {
    reviewEdu.addEventListener("click", () => {
      const box = document.querySelector(`.diff-check[data-section="${reviewEdu.dataset.section}"]`);
      if (box) box.checked = true;
      toast("Education change will be applied. Resume Memory's confirmed status is carried over when the newer text doesn't state one.");
    });
  }
  const delBtn = $("#delete-memory-btn");
  if (delBtn) delBtn.addEventListener("click", deleteMemoryAndRefresh);
}

function readEditorItem(itemEl, key) {
  const item = { fact_id: itemEl.dataset.fid || "", kind: itemEl.dataset.kind || "line" };
  const ent = itemEl.querySelector(".sed-ent");
  if (ent) item.entity = ent.value;
  const company = itemEl.querySelector(".sed-company");
  if (company) item.company = company.value;
  const role = itemEl.querySelector(".sed-role");
  if (role) item.role = role.value;
  const dur = itemEl.querySelector(".sed-duration");
  if (dur) item.duration = dur.value;
  const loc = itemEl.querySelector(".sed-location");
  if (loc) item.location = loc.value;
  const loctype = itemEl.querySelector(".sed-loctype");
  if (loctype) item.location_type = loctype.value;
  const fm = itemEl.querySelector(".sed-from-month");
  const fy = itemEl.querySelector(".sed-from-year");
  if (fm || fy) {
    item.start_month = fm ? fm.value : "";
    item.start_year = fy ? fy.value : "";
  }
  const tm = itemEl.querySelector(".sed-to-month");
  const ty = itemEl.querySelector(".sed-to-year");
  if (tm || ty) {
    item.end_month = tm ? tm.value : "";
    item.end_year = ty ? ty.value : "";
  }
  const present = itemEl.querySelector("input.sed-present");
  if (present) item.is_present = present.checked;
  const tools = itemEl.querySelector(".sed-tools");
  if (tools) item.tools = tools.value.split(",").map((s) => s.trim()).filter(Boolean);
  const linkUrl = itemEl.querySelector(".sed-link-url");
  if (linkUrl) item.link = { text: itemEl.querySelector(".sed-link-text")?.value || "", url: linkUrl.value };
  const textEl = itemEl.querySelector(".sed-text");
  if (textEl) item.text = textEl.value;
  if (item.kind === "education") {
    item.education_type = itemEl.querySelector(".sed-etype")?.value || "";
    item.degree = itemEl.querySelector(".sed-degree")?.value || "";
    item.course = itemEl.querySelector(".sed-course")?.value || "";
    item.specialization = itemEl.querySelector(".sed-specialization")?.value || "";
    item.institution = itemEl.querySelector(".sed-institution")?.value || "";
    item.education_status = itemEl.querySelector(".sed-edustatus")?.value || "";
  }
  if (item.kind === "skill") item.subcategory = itemEl.dataset.cat || "";
  return item;
}

function collectEditorPayload() {
  const name = $("#sed-name")?.value || "";
  const email = $("#sed-email")?.value || "";
  const phone = $("#sed-phone")?.value || "";
  const location = $("#sed-location")?.value || "";
  const links = $("#sed-links")?.value.split(/[,\s]+/).filter(Boolean) || [];
  const sections = [];
  for (const secEl of document.querySelectorAll(".sed-section")) {
    const items = [];
    for (const itemEl of secEl.querySelectorAll(".sed-item")) {
      items.push(readEditorItem(itemEl, secEl.dataset.seckey));
    }
    sections.push({ key: secEl.dataset.seckey, title: "", items });
  }
  return { name, contact: { email, phone, location, links }, sections };
}

async function saveMemoryEdits() {
  const payload = collectEditorPayload();
  try {
    if (state.memory) {
      const delta = collectServerDelta();
      const res = await api("/api/resume-memory/edit", {
        method: "POST",
        body: JSON.stringify({ structured: payload, added: delta.added, removed: delta.removed }),
      });
      state.memory = res.memory;
      state.memRemoved.clear();
      toast("Resume Memory saved.");
    } else {
      // First save from an upload preview: fold edits back into facts.
      // Skill entries carry sub ids (`PREVIEW-###~i`); group those by their
      // base fact so the per-skill edits rebuild the technologies list.
      const byFid = new Map();
      const byBase = new Map();
      let primarySummaryBase = "";
      const summaryBases = new Set();
      for (const sec of payload.sections) {
        for (const item of sec.items) {
          const base = item.fact_id.split("~")[0];
          if (item.fact_id.includes("~")) {
            if (!byBase.has(base)) byBase.set(base, []);
            byBase.get(base).push(item);
          } else {
            byFid.set(item.fact_id, item);
          }
          if (sec.key === "summary") {
            for (const id of item.summary_fact_ids || []) summaryBases.add(id.split("~")[0]);
            if (item.fact_id) primarySummaryBase = item.fact_id.split("~")[0];
          }
        }
      }
      const facts = (state.uploaded?.facts || []).map((f, i) => {
        const base = `PREVIEW-${pad(i)}`;
        const edit = byFid.get(base);
        const subs = byBase.get(base);
        if (!edit && !subs) return f;
        if (f.category === "summary" && summaryBases.has(base) && base !== primarySummaryBase) {
          return { ...f, original_text: "", normalized_claim: "" };
        }
        const texts = subs ? subs.map((s) => s.text || "").filter(Boolean) : [];
        const original = edit ? edit.text || f.original_text : texts.length ? texts.join(", ") : f.original_text;
        const claim = edit ? edit.text || f.normalized_claim : texts.length ? texts.join(", ") : f.normalized_claim;
        return {
          ...f,
          original_text: original,
          normalized_claim: claim,
          entity: edit?.entity || f.entity || "",
          technologies: subs ? texts : edit?.tools && edit.tools.length ? edit.tools : f.technologies || [],
          duration: edit?.duration ?? f.duration ?? "",
          location: edit?.location ?? f.location ?? "",
          location_type: edit?.location_type ?? f.location_type ?? "",
          role: edit?.role ?? f.role ?? "",
          company: edit?.company ?? f.company ?? "",
          start_month: edit?.start_month ?? f.start_month ?? "",
          start_year: edit?.start_year ?? f.start_year ?? "",
          end_month: edit?.end_month ?? f.end_month ?? "",
          end_year: edit?.end_year ?? f.end_year ?? "",
          is_present: Boolean(edit?.is_present ?? f.is_present),
          education_type: edit?.education_type ?? f.education_type ?? "",
          education_status: edit?.education_status ?? f.education_status ?? "",
          degree: edit?.degree ?? f.degree ?? "",
          course: edit?.course ?? f.course ?? "",
          specialization: edit?.specialization ?? f.specialization ?? "",
          institution: edit?.institution ?? f.institution ?? "",
          subcategory: edit?.subcategory ?? f.subcategory ?? "",
          link_text: edit?.link?.text ?? f.link_text ?? "",
          link_url: edit?.link?.url ?? f.link_url ?? "",
        };
      });
      const extraction = {
        ...(state.uploaded?.extraction || {}),
        name: payload.name || state.uploaded?.extraction?.name || "",
        contact: { email: payload.contact.email, phone: payload.contact.phone, location: payload.contact.location, links: payload.contact.links },
      };
      const res = await api("/api/resume-memory/save", {
        method: "POST",
        body: JSON.stringify({
          facts,
          extraction,
          filename: state.uploaded?.filename || "resume",
          rawText: state.uploaded?.rawText || "",
        }),
      });
      state.memory = res.memory;
      state.uploaded = null;
      toast("Resume Memory created.");
    }
    await loadMemory();
    renderMemoryView();
  } catch (err) {
    toast("Save failed: " + err.message);
  }
}

async function applyMemoryDiff() {
  if (!state.uploaded || !state.memory) return;
  const accepted = Array.from(document.querySelectorAll(".diff-check:checked")).map((c) => c.dataset.section);
  if (accepted.length === 0) {
    toast("Select at least one section to refresh.");
    return;
  }
  try {
    const { memory } = await api("/api/resume-memory/apply", {
      method: "POST",
      body: JSON.stringify({ acceptedSections: accepted, facts: state.uploaded.facts }),
    });
    state.memory = memory;
    state.uploaded = null;
    await loadMemory();
    renderMemoryView();
    toast("Resume Memory refreshed from the newer resume.");
  } catch (err) {
    toast("Apply failed: " + err.message);
  }
}

async function deleteMemoryAndRefresh() {
  if (!confirm("Delete Resume Memory? Applications already analysed keep their data; new analyses will need a new master resume.")) return;
  await api("/api/resume-memory", { method: "DELETE" });
  state.memory = null;
  state.uploaded = null;
  await loadMemory();
  renderMemoryView();
}

// ---------------------------------------------------------------------------
// Personal Questions
// ---------------------------------------------------------------------------

async function renderQuestionsView() {
  const el = $("#view-questions");
  let questions = [];
  try {
    const res = await api("/api/personal-questions");
    questions = res.questions || [];
  } catch {
    questions = [];
  }
  let html = `<div class="card">
    <h2>Personal Questions</h2>
    <p class="muted small">A reusable pool of personal/behavioural questions, collected only from requirements in job descriptions you analysed — never invented, never derived from your resume. Answer once, and every future application that hits the same requirement reuses the stored answer instead of asking again.</p>
  </div>
  <div class="card">
    <h3>Add a question</h3>
    <div class="pq-form">
      <input id="pq-new-question" placeholder="Question (e.g. Are you willing to work on-site?)">
      <select id="pq-new-type"><option value="yes_no">Yes / No</option><option value="free_text">Free text</option><option value="number">Number</option></select>
      <input id="pq-new-answer" placeholder="Answer (optional)">
      <input id="pq-new-notes" placeholder="Notes / evidence (optional)">
      <input id="pq-new-req" placeholder="Requirement ID (optional)">
      <button class="btn primary" id="pq-new-save" type="button">Add</button>
    </div>
  </div>
  <div class="card">
    <h3>Question bank <span class="muted small">${questions.length} question${questions.length === 1 ? "" : "s"}</span></h3>`;

  if (!questions.length) {
    html += `<p class="muted">No personal questions yet. They appear here the first time you answer an application question, or you can add your own above.</p>`;
  } else {
    html += `<div class="pq-list">`;
    for (const q of questions) {
      html += `<div class="pq-card" data-pqid="${esc(q.id)}">
        <div class="pq-main">
          <input class="pq-question" value="${esc(q.question)}">
          <div class="pq-row">
            <select class="pq-type">
              <option value="yes_no" ${q.answer_type === "yes_no" ? "selected" : ""}>Yes / No</option>
              <option value="free_text" ${q.answer_type === "free_text" ? "selected" : ""}>Free text</option>
              <option value="number" ${q.answer_type === "number" ? "selected" : ""}>Number</option>
            </select>
            <input class="pq-answer" value="${esc(q.answer)}" placeholder="Answer">
            <input class="pq-notes" value="${esc(q.notes_evidence || "")}" placeholder="Notes / evidence">
          </div>
          <div class="pq-row muted small">
            <span>${esc(q.id)}</span>
            ${q.requirement_id ? `<span>&middot; ${esc(q.requirement_id)}</span>` : ""}
            ${q.source ? `<span>&middot; ${esc(q.source)}</span>` : ""}
            ${q.updated_at ? `<span>&middot; ${esc(fmtDate(q.updated_at))}</span>` : ""}
          </div>
        </div>
        <div class="pq-actions">
          <button class="btn small pq-save" type="button" data-pqid="${esc(q.id)}">Save</button>
          <button class="btn small danger pq-delete" type="button" data-pqid="${esc(q.id)}">Delete</button>
        </div>
      </div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  el.innerHTML = html;

  const newSave = $("#pq-new-save");
  if (newSave) {
    newSave.addEventListener("click", async () => {
      const question = $("#pq-new-question").value.trim();
      if (!question) {
        toast("Question text is required.");
        return;
      }
      try {
        await api("/api/personal-questions", {
          method: "POST",
          body: JSON.stringify({
            question,
            answer_type: $("#pq-new-type").value,
            answer: $("#pq-new-answer").value.trim(),
            notes_evidence: $("#pq-new-notes").value.trim(),
            requirement_id: $("#pq-new-req").value.trim(),
            source: "manual",
          }),
        });
        toast("Question saved to the bank.");
        renderQuestionsView();
      } catch (err) {
        toast("Save failed: " + err.message);
      }
    });
  }
  for (const btn of el.querySelectorAll(".pq-save")) {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".pq-card");
      try {
        await api(`/api/personal-questions/${btn.dataset.pqid}`, {
          method: "PUT",
          body: JSON.stringify({
            question: card.querySelector(".pq-question").value.trim(),
            answer_type: card.querySelector(".pq-type").value,
            answer: card.querySelector(".pq-answer").value.trim(),
            notes_evidence: card.querySelector(".pq-notes").value.trim(),
          }),
        });
        toast("Question updated.");
        renderQuestionsView();
      } catch (err) {
        toast("Update failed: " + err.message);
      }
    });
  }
  for (const btn of el.querySelectorAll(".pq-delete")) {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this personal question and its stored answer?")) return;
      try {
        await api(`/api/personal-questions/${btn.dataset.pqid}`, { method: "DELETE" });
        toast("Question deleted.");
        renderQuestionsView();
      } catch (err) {
        toast("Delete failed: " + err.message);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Application workspace
// ---------------------------------------------------------------------------

function renderAppView() {
  if (!state.session) {
    $("#app-header").innerHTML = `<div class="card"><h2>Applications</h2>
      <p class="muted small">Each application keeps its own job description, analysis, tailoring and results. Start one from the sidebar.</p>
      <button class="btn primary" id="app-empty-create" type="button">+ New application</button></div>`;
    $("#app-tabs").classList.add("hidden");
    for (const p of document.querySelectorAll(".panel")) p.classList.add("hidden");
    const c = $("#app-empty-create");
    if (c) c.addEventListener("click", createApplication);
    return;
  }
  renderAppHeader();
  renderAppTabs();
  switchAppTab(state.appTab);
}

function renderAppHeader() {
  const s = state.session;
  const jd = s.jd || {};
  const meta = [
    s.jd ? `${esc(jd.job_title || "Role")}${jd.company ? " · " + esc(jd.company) : ""}` : "No JD analysed",
    jd.location ? esc(jd.location) : "",
    `updated ${fmtDate(s.updated_at)}`,
  ]
    .filter(Boolean)
    .join(" &middot; ");
  $("#app-header").innerHTML = `<div class="card" style="margin-bottom:14px">
      <div class="mem-head">
        <div class="app-title-wrap">
          <h2 class="app-title">${esc(s.name || "Application")}</h2>
          <div class="muted small">${meta}</div>
          <div class="app-job-row">
            <input id="app-job-url" class="input app-job-input" type="url" placeholder="Job posting URL (optional)" value="${esc(s.job_url || "")}" autocomplete="off" spellcheck="false" />
            ${s.job_url ? `<a class="app-link" href="${esc(s.job_url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.job_url)}">Open job posting &#x2197;</a>` : ""}
          </div>
        </div>
      </div>
    </div>`;
  const urlInput = $("#app-job-url");
  if (urlInput) {
    let saving = false;
    const saveUrl = async () => {
      if (saving) return;
      saving = true;
      const next = urlInput.value.trim();
      if (next === (state.session.job_url || "")) {
        saving = false;
        return;
      }
      try {
        const { session } = await api(`/api/sessions/${state.session.id}`, {
          method: "PATCH",
          body: JSON.stringify({ job_url: next }),
        });
        state.session = session;
        renderAppHeader();
        await loadSessions();
        toast(next ? "Job posting link saved." : "Link removed.");
      } catch (err) {
        toast("Could not save link: " + err.message);
      } finally {
        saving = false;
      }
    };
    urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        urlInput.blur();
      }
    });
    urlInput.addEventListener("blur", saveUrl);
  }
}

function renderJdCard() {
  const hasMemory = Boolean(state.memory);
  const s = state.session;
  const panel = $("#panel-job");
  if (!panel) return;
  panel.innerHTML = `<h2>Job description</h2>
    <p class="muted small">Analysis uses only Resume Memory as the candidate source of truth: Qwen parses this JD, Phi-4-mini matches your stored evidence, and questions come from this JD only.</p>
    <textarea id="jd-input" rows="14" placeholder="Paste the complete job description here...">${esc(s.job_description || "")}</textarea>
    <div class="actions" style="margin-top:12px">
      <button class="btn primary" id="analyze-btn" type="button">Analyze against Resume Memory</button>
      <span id="app-error" class="error"></span>
    </div>
    ${hasMemory ? "" : `<p class="muted small" style="margin-top:10px">No Resume Memory yet — create it first so applications analyse against your master resume.</p>`}`;
  $("#analyze-btn").addEventListener("click", runAnalyze);
  const ta = $("#jd-input");
  if (ta) ta.addEventListener("input", () => { state.session.job_description = ta.value; });
}

function renderAppTabs() {
  $("#app-tabs").classList.remove("hidden");
  $("#app-tabs").innerHTML = [
    { id: "job", label: "Job Description" },
    { id: "overview", label: "Overview" },
    { id: "questions", label: "Questions" },
    { id: "match", label: "Match Analysis" },
    { id: "tailoring", label: "Tailoring Plan" },
    { id: "cover", label: "Cover Letter" },
  ]
    .map((t) => `<button class="app-tab ${state.appTab === t.id ? "active" : ""}" data-apptab="${t.id}" type="button">${t.label}</button>`)
    .join("");
}

// ---------------------------------------------------------------------------
// Analyze flow (per application)
// ---------------------------------------------------------------------------

const STEP_LABELS = {
  resume: "Applying Resume Memory to application",
  jd: "Parsing job requirements (Qwen)",
  match: "Matching evidence (Phi-4-mini)",
  questions: "Extracting JD personal/behavioural questions",
  "tailor:start": "Starting the tailoring plan",
  "recommendations:start": "Writing tailored recommendations",
  "recommendations:audit": "Validating recommendations against Resume Memory",
  "cover:start": "Writing cover letter",
  "cover:audit": "Validating cover letter against Resume Memory",
  done: "Saving results",
};

const ANALYSIS_STEP_KEYS = ["resume", "jd", "match", "questions"];
const TAILOR_STEP_KEYS = [
  "tailor:start",
  "recommendations:start",
  "recommendations:audit",
  "cover:start",
  "cover:audit",
  "done",
];
const COVER_STEP_KEYS = ["cover:start", "cover:audit", "done"];

// Process progress renders inside the tab a process belongs to: analysis shows
// in Overview, tailoring in the Tailoring Plan tab, the cover letter in its own
// tab.
function processTab(type) {
  if (type === "cover") return "cover";
  return type === "tailor" ? "tailoring" : "overview";
}

function renderStepsInto(name) {
  const panel = $(`panel-${name}`);
  const p = state.currentProcess;
  if (!panel || !p) return;
  panel.innerHTML = `<div class="card">
    <h2>Working…</h2>
    <ul class="progress">${p.steps
      .map((s) => `<li class="${s.state}"><span class="dot"></span><span>${esc(s.label)}</span></li>`)
      .join("")}</ul>
    ${p.note || ""}
  </div>`;
}

function beginProcess(type, firstStep, note) {
  state.currentProcess = {
    type,
    steps: [{ step: firstStep, label: STEP_LABELS[firstStep] || firstStep, state: "active" }],
    note: note || "",
  };
  switchAppTab(processTab(type));
}

// Build step states from a persisted server phase (used when reattaching to a
// process after the page was refreshed or reopened).
function processStepsForPhase(type, phase) {
  const keys =
    type === "tailor" ? TAILOR_STEP_KEYS : type === "cover" ? COVER_STEP_KEYS : ANALYSIS_STEP_KEYS;
  const idx = keys.indexOf(phase);
  const shown = idx >= 0 ? keys.slice(0, idx + 1) : keys;
  return shown.map((k, i) => ({
    step: k,
    label: STEP_LABELS[k] || k,
    state: i < shown.length - 1 ? "done" : "active",
  }));
}

// Accumulate server progress events in order: the latest step is active, everything
// before it is done.
function makeStepTracker() {
  const order = [];
  return {
    push(key, label) {
      if (!order.some((s) => s.step === key)) {
        order.push({ step: key, label: label || STEP_LABELS[key] || key });
      }
      return order.map((s, i) => ({ ...s, state: i < order.length - 1 ? "done" : "active" }));
    },
    allDone() {
      return order.map((s) => ({ ...s, state: "done" }));
    },
  };
}

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n\n");
    while (nl !== -1) {
      const block = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      if (block.trim()) {
        const evt = (block.split("\n").find((l) => l.startsWith("event:")) || "event: message").slice(6).trim();
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (data) {
          let payload;
          try {
            payload = JSON.parse(data);
          } catch {
            payload = null;
          }
          if (payload !== null) onEvent(evt, payload);
        }
      }
      nl = buf.indexOf("\n\n");
    }
  }
}

async function finishProcess(id, session, opts = {}) {
  state.currentProcess = null;
  state.session = session;
  await loadSessions();
  if (id !== state.sessionId) {
    toast(
      session.recommendations?.length
        ? session.cover_letter?.letter
          ? "Tailoring plan + cover letter ready."
          : "Tailoring plan ready."
        : "Analysis complete."
    );
    return;
  }
  if (session.recommendations?.length) {
    state.appTab = opts.tab || "tailoring";
    renderAppView();
    toast(
      opts.kind === "cover"
        ? "Cover letter ready."
        : opts.autoTailored
          ? "Strong match — tailoring plan ready."
          : session.cover_letter?.letter
            ? "Tailoring plan + cover letter ready."
            : "Tailoring plan ready."
    );
  } else {
    state.appTab = "overview";
    renderAppView();
    toast("Analysis complete.");
  }
}

function stopProcessWatch(id) {
  const t = state.processTimers.get(id);
  if (t) {
    clearInterval(t);
    state.processTimers.delete(id);
  }
}

const REATTACH_NOTE = `<p class="muted small">This process is running in the background. You can leave this page — it keeps going and the result appears here when it finishes.</p>`;

async function pollProcess(id) {
  try {
    const { process } = await api(`/api/sessions/${id}/process`);
    if (process) {
      if (!state.currentProcess || state.currentProcess.type !== process.type) {
        state.currentProcess = {
          type: process.type,
          steps: processStepsForPhase(process.type, process.phase),
          note: REATTACH_NOTE,
        };
        if (id === state.sessionId) renderStepsInto(processTab(process.type));
      }
      return;
    }
  } catch {
    return;
  }
  stopProcessWatch(id);
  state.runningSessions.delete(id);
  state.currentProcess = null;
  if (id === state.sessionId) {
    try {
      const { session } = await api(`/api/sessions/${id}`);
      await finishProcess(id, session);
    } catch {
      /* application may have been deleted mid-run */
    }
  }
}

function startProcessWatch(id, process) {
  state.runningSessions.add(id);
  if (process && id === state.sessionId) {
    state.currentProcess = {
      type: process.type,
      steps: processStepsForPhase(process.type, process.phase),
      note: REATTACH_NOTE,
    };
    switchAppTab(processTab(process.type));
  }
  if (state.processTimers.has(id)) return;
  const timer = setInterval(() => pollProcess(id), 3500);
  state.processTimers.set(id, timer);
}

async function runAnalyze() {
  const id = state.sessionId;
  if (state.runningSessions.has(id)) {
    toast("Analysis is already running for this application.");
    return;
  }
  if (!state.memory) {
    toast("Create Resume Memory first (sidebar → Resume Memory).");
    switchView("memory");
    return;
  }
  const jd = $("#jd-input").value.trim();
  if (jd.length < 40) {
    $("#app-error").textContent = "Please paste the complete job description (at least a few lines).";
    return;
  }
  const errEl = $("#app-error");
  if (errEl) errEl.textContent = "";
  const tracker = makeStepTracker();
  beginProcess(
    "analysis",
    "resume",
    `<p class="muted small">Qwen parses the JD, Phi-4-mini matches your Resume Memory evidence, then we surface any personal questions. This can take a few minutes — you can switch tabs or leave and come back.</p>`
  );
  state.runningSessions.add(id);
  try {
    const res = await fetch(`/api/sessions/${id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_description: jd }),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || `Analysis failed (HTTP ${res.status}).`);
    }
    let result = null;
    let failed = null;
    await readSSE(res, (evt, payload) => {
      if (evt === "progress" && payload.step) {
        state.currentProcess = {
          type: "analysis",
          steps: tracker.push(payload.step, payload.label),
          note: state.currentProcess ? state.currentProcess.note : "",
        };
        renderStepsInto("overview");
      } else if (evt === "result") {
        result = payload;
      } else if (evt === "error") {
        failed = new Error(payload.error || "Analysis failed.");
      }
    });
    if (failed) throw failed;
    if (!result) throw new Error("Analysis ended without a result from the server.");
    state.currentProcess = null;
    await finishProcess(id, result.session, { autoTailored: result.autoTailored });
  } catch (err) {
    state.currentProcess = null;
    if (id === state.sessionId) {
      const panel = $("#panel-overview");
      if (panel) {
        panel.innerHTML = `<div class="card">
          <h2>Analysis</h2>
          <p class="error">${esc(err.message)}</p>
          <div class="actions"><button class="btn primary" id="analyze-retry" type="button">Back to job description</button></div>
        </div>`;
        $("#analyze-retry").addEventListener("click", () => switchAppTab("job"));
      }
    } else {
      toast("Analysis failed: " + err.message);
    }
  } finally {
    state.runningSessions.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Application panels
// ---------------------------------------------------------------------------

function renderAppPanel(name) {
  if (name === "job") renderJdCard();
  else if (name === "overview") renderOverview();
  else if (name === "questions") renderQuestions();
  else if (name === "match") renderMatch();
  else if (name === "tailoring") renderTailoring();
  else if (name === "cover") renderCover();
}

const MATCH_LABELS = {
  MATCHED: "Matched",
  PARTIAL: "Partial",
  NOT_MATCHED: "Not matched",
  UNKNOWN: "Unknown",
  STRONG_MATCH: "Strong",
  PARTIAL_MATCH: "Partial",
  WEAK_MATCH: "Weak",
  NO_EVIDENCE: "No evidence",
  CONTRADICTED: "Contradicted",
};

const MATCH_GROUPS = [
  { key: "MATCHED", title: "Strong matches" },
  { key: "PARTIAL", title: "Partial matches" },
  { key: "NOT_MATCHED", title: "Gaps" },
  { key: "UNKNOWN", title: "Unknown" },
];

function matchCounts(matches) {
  const legacy = { STRONG_MATCH: "MATCHED", PARTIAL_MATCH: "PARTIAL", WEAK_MATCH: "PARTIAL", NO_EVIDENCE: "NOT_MATCHED", CONTRADICTED: "NOT_MATCHED" };
  const counts = { MATCHED: 0, PARTIAL: 0, NOT_MATCHED: 0, UNKNOWN: 0 };
  for (const m of matches) {
    const k = legacy[m.status] || m.status || "NOT_MATCHED";
    if (k in counts) counts[k] += 1;
  }
  return counts;
}

// The server overview uses {matched, partial, not_matched, unknown}; older
// clients expect {MATCHED, PARTIAL, NOT_MATCHED, UNKNOWN}. Normalize to the
// canonical upper-case keys so the counts line never prints "undefined".
function normalizeCounts(c, matches) {
  if (!c) return matchCounts(matches || []);
  const num = (v) => (Number.isFinite(v) ? v : null);
  if (num(c.MATCHED) !== null) {
    return {
      MATCHED: num(c.MATCHED) ?? 0,
      PARTIAL: num(c.PARTIAL) ?? 0,
      NOT_MATCHED: num(c.NOT_MATCHED) ?? 0,
      UNKNOWN: num(c.UNKNOWN) ?? 0,
    };
  }
  return {
    MATCHED: num(c.matched) ?? 0,
    PARTIAL: num(c.partial) ?? 0,
    NOT_MATCHED: num(c.not_matched) ?? (num(c.gaps) ?? 0),
    UNKNOWN: num(c.unknown) ?? 0,
  };
}

function labelForPercent(p) {
  if (p >= 85) return "Strong Match";
  if (p >= 70) return "Good Match";
  if (p >= 55) return "Moderate Match";
  if (p >= 40) return "Weak Match";
  return "Low Match";
}

function shortReq(r) {
  if ((r.tools || []).length) return r.tools.join(" / ");
  return (r.text || "").replace(/^[^a-z0-9]+/i, "").trim().slice(0, 46);
}

// Deterministic recommendation summary that leads the UI. Prefers the
// server-computed match_overview; legacy sessions (no match_overview) fall back
// to grouping the stored match statuses in the same way.
function effectiveOverview(s) {
  const ov = s.match_overview;
  if (ov && Array.isArray(ov.strengths)) {
    return {
      label: ov.label || labelForPercent(ov.percent),
      percent: typeof ov.percent === "number" ? ov.percent : null,
      counts: normalizeCounts(ov.counts, s.matches || []),
      strengths: ov.strengths || [],
      partials: ov.partials || [],
      gaps: ov.gaps || [],
      uncertain: ov.uncertain || [],
      questions_for_you: ov.questions_for_you || [],
      main_gap: ov.main_gap || deriveMainGap(ov.requirements || [], s.matches || []),
      requirements: ov.requirements || [],
    };
  }
  const matches = s.matches || [];
  const reqs = s.jd?.requirements || [];
  const byReq = new Map(matches.map((m) => [m.requirement_id, m]));
  const legacy = { STRONG_MATCH: "MATCHED", PARTIAL_MATCH: "PARTIAL", WEAK_MATCH: "PARTIAL", NO_EVIDENCE: "NOT_MATCHED", CONTRADICTED: "NOT_MATCHED" };
  const groups = { MATCHED: [], PARTIAL: [], NOT_MATCHED: [], UNKNOWN: [] };
  const rows = reqs.map((r) => ({ req: r, match: byReq.get(r.requirement_id) || {} }));
  for (const { req, match } of rows) {
    const raw = match.status;
    const k = legacy[raw] || raw || "UNKNOWN";
    if (k in groups) groups[k].push({ req, match });
  }
  const score = s.match_score || {};
  return {
    label: score.label || labelForPercent(score.percent),
    percent: typeof score.percent === "number" ? score.percent : null,
    counts: matchCounts(matches),
    strengths: groups.MATCHED.slice(0, 5).map(({ req }) => shortReq(req)),
    partials: groups.PARTIAL.slice(0, 5).map(({ req }) => shortReq(req)),
    gaps: groups.NOT_MATCHED.slice(0, 5).map(({ req }) => shortReq(req)),
    uncertain: groups.UNKNOWN.slice(0, 5).map(({ req }) => shortReq(req)),
    questions_for_you: (s.questions || []).filter((q) => !q.answered).map((q) => q.question),
    main_gap: deriveMainGap(rows),
    requirements: rows,
  };
}

// Highest-importance NOT_MATCHED requirement is the "Main gap"; with no gap it
// falls back to the highest-importance UNKNOWN ("area to confirm"), otherwise
// none. Mirrors the server's buildMatchOverview.main_gap.
function deriveMainGap(rows) {
  const weightOf = (req) => ({ CRITICAL: 3, IMPORTANT: 2, NICE_TO_HAVE: 1 })[req?.importance] || 1;
  const legacy = { STRONG_MATCH: "MATCHED", PARTIAL_MATCH: "PARTIAL", WEAK_MATCH: "PARTIAL", NO_EVIDENCE: "NOT_MATCHED", CONTRADICTED: "NOT_MATCHED" };
  const statusOf = (match) => legacy[match?.status] || match?.status || "UNKNOWN";
  const gaps = (rows || []).filter((r) => statusOf(r.match) === "NOT_MATCHED");
  const unsure = (rows || []).filter((r) => statusOf(r.match) === "UNKNOWN");
  const byWeight = (a, b) => weightOf(b.req) - weightOf(a.req);
  gaps.sort(byWeight);
  unsure.sort(byWeight);
  const top = gaps[0] || unsure[0];
  if (!top) return null;
  const isGap = statusOf(top.match) === "NOT_MATCHED";
  return {
    kind: isGap ? "gap" : "confirm",
    label: shortReq(top.req),
    requirement_id: top.req.requirement_id,
    match_status: top.match.status || (isGap ? "NOT_MATCHED" : "UNKNOWN"),
    note: (top.match.explanation || "").split(" [")[0].trim() || "",
  };
}

// Deterministic "should I apply" tl;dr + the concrete things that would raise
// the match. Pure function of the overview data, so it works for both fresh
// and legacy sessions.
function applyGuidanceFor(ov) {
  const p = typeof ov.percent === "number" ? ov.percent : null;
  if (p === null) return null;
  let verdict;
  let tone;
  if (p >= 85) {
    verdict = "Strong match — apply. Resume Memory covers most of what this job asks, so you are genuinely competitive.";
    tone = "good";
  } else if (p >= 70) {
    verdict = "Good match — apply. You are competitive; close the partials/gaps below to be safe.";
    tone = "good";
  } else if (p >= 55) {
    verdict = "Moderate match — apply after tackling the gaps below or tailoring for the specifics.";
    tone = "partial";
  } else if (p >= 40) {
    verdict = "Weak match — improve the important gaps below before applying, or the recruiter may pass on you.";
    tone = "unknown";
  } else {
    verdict = "Low match — the resume misses too many core requirements for this role. Consider whether it is the right fit.";
    tone = "gap";
  }

  const legacy = { STRONG_MATCH: "MATCHED", PARTIAL_MATCH: "PARTIAL", WEAK_MATCH: "PARTIAL", NO_EVIDENCE: "NOT_MATCHED", CONTRADICTED: "NOT_MATCHED" };
  const statusOf = (match) => legacy[match?.status] || match?.status || "UNKNOWN";
  const weightOf = (req) => ({ CRITICAL: 3, IMPORTANT: 2, NICE_TO_HAVE: 1 })[req?.importance] || 1;
  const fundamentals = (req) =>
    req.importance === "CRITICAL" ? "a critical requirement" : req.importance === "IMPORTANT" ? "an important requirement" : "a nice-to-have";

  const improvements = (ov.requirements || [])
    .map((row) => ({ req: row.req, st: statusOf(row.match) }))
    .filter((x) => x.st !== "MATCHED")
    .sort((a, b) => weightOf(b.req) - weightOf(a.req))
    .slice(0, 4)
    .map(({ req, st }) => {
      const label = shortReq(req);
      if (st === "NOT_MATCHED") {
        return { label, note: `No evidence for ${fundamentals(req)} — add something demonstrable to your resume.`, cls: "gap" };
      }
      if (st === "PARTIAL") {
        return { label, note: `Partial for ${fundamentals(req)} — move it from a mention to demonstrated work.`, cls: "partial" };
      }
      return { label, note: `${fundamentals(req).charAt(0).toUpperCase() + fundamentals(req).slice(1)} can't be judged from a resume — confirm it under Questions.`, cls: "unknown" };
    });

  return { verdict, tone, improvements };
}

function renderApplyTldr(ov) {
  const g = applyGuidanceFor(ov);
  if (!g) return "";
  const badge = { good: "Apply", partial: "Apply with work", unknown: "Check first", gap: "Reconsider" }[g.tone] || "Apply";
  let html = `<div class="apply-card ${g.tone}"><span class="apply-badge">${esc(badge)}</span><div class="apply-verdict">${esc(g.verdict)}</div></div>`;
  if (g.improvements.length) {
    html += `<div class="ov-group"><div class="ov-head">Improve your chances</div>
      <div class="apply-improve">${g.improvements
        .map((i) => `<div class="apply-item ${i.cls}"><b>${esc(i.label)}</b> <span class="muted small">&mdash; ${esc(i.note)}</span></div>`)
        .join("")}</div></div>`;
  }
  return html;
}

function mainGapLine(ov) {
  const g = ov.main_gap;
  if (!g) return `<div class="ov-main-gap ok">No major gaps — every important requirement has evidence.</div>`;
  const prefix = g.kind === "confirm" ? "Area to confirm" : "Main gap";
  const tail = g.kind === "confirm"
    ? ' &mdash; answer it in &ldquo;Questions &amp; confirmations&rdquo; to resolve it.'
    : "";
  const note = g.note ? `<span class="note"> ${esc(g.note)}</span>` : "";
  return `<div class="ov-main-gap"><b>${prefix}:</b> ${esc(g.label)}${tail}${note}</div>`;
}

const OVERVIEW_GROUPS = [
  { key: "strengths", title: "Strengths", cls: "good" },
  { key: "partials", title: "Partial matches", cls: "partial" },
  { key: "gaps", title: "Gaps", cls: "gap" },
  { key: "uncertain", title: "Uncertain / needs confirmation", cls: "unknown" },
];

function ovGroupHtml(ov) {
  let html = "";
  for (const g of OVERVIEW_GROUPS) {
    const items = ov[g.key] || [];
    if (!items.length) continue;
    html += `<div class="ov-group">
      <div class="ov-head ${g.cls}">${g.title}</div>
      <div class="chips">${items.map((t) => `<span class="chip ov-chip ${g.cls}">${esc(t)}</span>`).join("")}</div>
    </div>`;
  }
  if (ov.questions_for_you && ov.questions_for_you.length) {
    html += `<div class="ov-group"><div class="ov-head ask">Questions for you</div>
      <div class="chips">${ov.questions_for_you.map((q) => `<span class="chip ov-chip ask">${esc(q)}</span>`).join("")}</div></div>`;
  }
  return html;
}

function renderOverview() {
  const panel = $("#panel-overview");
  const s = state.session;
  if (!s?.jd) {
    panel.innerHTML = `<div class="card"><p class="muted">Analyse a job description to see the job overview and how your Resume Memory matches it.</p></div>`;
    return;
  }
  const jd = s.jd;
  const reqs = jd.requirements || [];
  const byReq = new Map((s.matches || []).map((m) => [m.requirement_id, m]));
  const ov = effectiveOverview(s);
  const counts = ov.counts;

  const chips = (list) => (list && list.length ? `<div class="chips">${list.map((k) => `<span class="chip">${esc(k)}</span>`).join("")}</div>` : "");

  let html = `<div class="card">
    <h2>Job at a glance</h2>
    ${jd.summary ? `<div class="md">${renderMarkdown(jd.summary)}</div>` : ""}
    ${chips(jd.keywords)}
  </div>
  <div class="card">
    <h2>Recommendation</h2>
    <div class="match-overall">
      <span class="match-percent ${ov.percent === null ? "muted" : ""}">${ov.percent === null ? "—" : ov.percent + "%"}</span>
      <span class="match-percent-label">${esc(ov.label)}${ov.percent === null ? " (run Match Analysis to score)" : " — fit label from importance-weighted requirement evidence"}</span>
    </div>
    <div class="match-counts">
      <span class="mc matched">${counts.MATCHED} matched</span>
      <span class="mc partial">${counts.PARTIAL} partial</span>
      <span class="mc gap">${counts.NOT_MATCHED} gaps</span>
      <span class="mc unknown">${counts.UNKNOWN} unknown</span>
    </div>
    ${renderApplyTldr(ov)}
    ${mainGapLine(ov)}
    ${ovGroupHtml(ov)}
  </div>
  <div class="card">
    <h2>Requirements</h2>
    <table>
      <tr><th>Requirement</th><th>Importance</th><th>Match</th></tr>`;
  for (const req of reqs) {
    const m = byReq.get(req.requirement_id) || {};
    const label = MATCH_LABELS[m.status] || "Not matched";
    html += `<tr><td><b>${esc(req.requirement_id)}</b> ${esc(req.text)}</td>
      <td><span class="imp ${req.importance}">${req.importance}</span></td>
      <td><span class="badge ${m.status || "NOT_MATCHED"}">${label}</span></td></tr>`;
  }
  html += `</table></div>`;
  panel.innerHTML = html;
}

function renderQuestions() {
  const panel = $("#panel-questions");
  const s = state.session;
  if (!s) { panel.innerHTML = ""; return; }
  const questions = s.questions || [];
  const answered = (s.answers || []).filter((a) => !a.declined);

  let html = `<div class="card">
    <h2>Questions &amp; confirmations</h2>
    <p class="muted small">Questions come only from requirements in this JD. Technical gaps (a concrete tool the resume could not demonstrate) and user-specific conditions (relocation, work authorization, soft-skill style) are raised as confirmations. Already-answered questions are reused by a stable key, so you are only asked about genuinely new ones. Answers are stored in Resume Memory for future applications.</p>`;

  if (!s.jd) {
    html += `<p class="muted" style="margin-top:12px">Analyse the JD first.</p></div>`;
    panel.innerHTML = html;
    return;
  }

  if (answered.length) {
    html += `<h3 style="margin-top:16px">Stored answers (reused)</h3><div class="options">`;
    for (const a of answered) {
      html += `<div class="question-box">
        <div class="q-text">${esc(a.question)}</div>
        <div class="answer-note">Answer: <b>${esc(a.answer)}</b> <span class="muted small">${esc(a.skill_level || "")}</span></div>
      </div>`;
    }
    html += `</div>`;
  }

  const pending = questions.filter((q) => !q.answered);
  if (pending.length === 0) {
    html += `<p class="muted" style="margin-top:14px">No new questions in this JD — every relevant technical gap and condition already has a stored answer (or the JD contains none).</p>`;
  } else {
    html += `<h3 style="margin-top:16px">Needs your confirmation</h3><div class="options">`;
    for (const q of pending) {
      html += `<div class="question-box">
        ${q.requirement_id ? `<div class="q-progress">${esc(q.requirement_id)}</div>` : ""}
        <div class="q-text">${esc(q.question)}</div>
        ${q.why ? `<div class="q-why">${esc(q.why)}</div>` : ""}
        <div class="options" data-qid="${esc(q.question_id)}">
          ${(q.options && q.options.length ? q.options : ["Yes", "No"]).map((o) => `<button class="btn small q-answer" data-q="${esc(q.question_id)}" data-o="${esc(o)}">${esc(o)}</button>`).join("")}
          <input class="q-custom" data-q="${esc(q.question_id)}" placeholder="Optional details..." style="margin-left:8px">
        </div>
      </div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  panel.innerHTML = html;

  for (const btn of panel.querySelectorAll(".q-answer")) {
    btn.addEventListener("click", async (e) => {
      await submitAnswer(e.target.dataset.q, e.target.dataset.o);
    });
  }
  for (const inp of panel.querySelectorAll(".q-custom")) {
    inp.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && e.target.value.trim()) {
        await submitAnswer(e.target.dataset.q, e.target.value.trim());
      }
    });
  }
}

async function submitAnswer(questionId, answer) {
  const id = state.sessionId;
  if (state.runningSessions.has(id)) {
    toast("A process is already running for this application.");
    return;
  }
  state.runningSessions.add(id);
  try {
    const { session } = await api(`/api/sessions/${id}/answers`, {
      method: "POST",
      body: JSON.stringify({ question_id: questionId, answer }),
    });
    state.session = session;
    await loadMemory(); // answers persist into Resume Memory
    if (id === state.sessionId) renderQuestions();
    toast("Answer stored in Resume Memory.");
  } catch (err) {
    toast("Answer failed: " + err.message);
  } finally {
    state.runningSessions.delete(id);
  }
}

function renderMatch() {
  const panel = $("#panel-match");
  const s = state.session;
  if (!s?.jd) {
    panel.innerHTML = `<div class="card"><p class="muted">Analyse the job description first.</p></div>`;
    return;
  }
  const reqs = s.jd.requirements || [];
  const matches = s.matches || [];
  const byReq = new Map(matches.map((m) => [m.requirement_id, m]));
  const counts = matchCounts(matches);
  const score = s.match_score;
  const truthDb = s.truth_db || [];
  const hasAnalysis = typeof score?.percent === "number";
  const ov = effectiveOverview(s);

  let html = `<div class="card">
    <h2>Match analysis</h2>
    ${hasAnalysis
      ? renderApplyTldr(ov)
      : `<p class="muted small">Every requirement is judged only against the evidence in the entire Resume Memory — Summary, Experience and every project bullet, Skills, Education, and Achievements. Match status and Evidence Strength are separate: a requirement can be Matched with direct bullet evidence, or Partial with only a skills-list mention. Click an evidence ID to inspect the source fact.</p>`
    }
    <div class="match-overall">
      ${hasAnalysis ? `<span class="match-percent">${score.percent}%</span>` : `<span class="match-percent muted">—</span>`}
      <span class="match-percent-label">${score?.label || labelForPercent(score?.percent)}${hasAnalysis ? " — fit label from importance-weighted requirement evidence." : ""}</span>
    </div>
    <div class="match-counts">
      <span class="mc matched">${counts.MATCHED} matched</span>
      <span class="mc partial">${counts.PARTIAL} partial</span>
      <span class="mc gap">${counts.NOT_MATCHED} gaps</span>
      <span class="mc unknown">${counts.UNKNOWN} unknown</span>
    </div>
  </div>`;

  for (const g of MATCH_GROUPS) {
    const rows = reqs
      .filter((r) => (byReq.get(r.requirement_id) || {}).status === g.key)
      .map((r) => ({ req: r, m: byReq.get(r.requirement_id) || {} }));
    if (!rows.length) continue;
    html += `<div class="card match-group"><h3>${g.title} <span class="muted small">(${rows.length})</span></h3>
      <table>
        <tr><th>Requirement</th><th>Importance</th><th>Match</th><th>Evidence</th><th>Explanation</th></tr>`;
    for (const { req, m } of rows) {
      const label = MATCH_LABELS[m.status] || "Not matched";
      const quote = m.evidence ? `<span class="match-evidence">"${esc(m.evidence)}"</span>` : "";
      const ids = (m.evidence_ids || []).map((id) => `<span class="evidence-link" data-evidence="${esc(id)}">${esc(id)}</span>`).join(" ");
      const source = m.source ? `<div class="match-source">${esc(m.source)}</div>` : "";
      const strength = m.evidence_strength && m.evidence_strength !== "NONE" ? `<span class="strength ${esc(m.evidence_strength.toLowerCase())}">${esc(m.evidence_strength)}</span>` : "";
      html += `<tr>
        <td><b>${esc(req.requirement_id)}</b><div>${esc(req.text)}</div></td>
        <td><span class="imp ${req.importance}">${req.importance}</span></td>
        <td><span class="badge ${m.status || "NOT_MATCHED"}">${label}</span>${strength ? `<div style="margin-top:4px">${strength}</div>` : ""}</td>
        <td>${quote || "—"}${ids ? `<div class="match-meta">${ids}</div>` : ""}${source}</td>
        <td>${m.explanation ? esc(m.explanation) : "—"}</td>
      </tr>`;
    }
    html += `</table></div>`;
  }

  const evidenceStats = new Map();
  for (const m of matches) {
    if (m.status !== "MATCHED" && m.status !== "PARTIAL") continue;
    for (const id of m.evidence_ids || []) {
      const st = evidenceStats.get(id) || { matched: 0, partial: 0 };
      if (m.status === "MATCHED") st.matched += 1;
      else st.partial += 1;
      evidenceStats.set(id, st);
    }
  }
  const byId = new Map(truthDb.map((r) => [r.evidence_id, r]));
  const relevant = [...evidenceStats.entries()]
    .map(([id, st]) => ({ id, st, rec: byId.get(id) }))
    .filter((x) => x.rec)
    .sort((a, b) => b.st.matched - a.st.matched || b.st.partial - a.st.partial)
    .slice(0, 10);
  if (relevant.length) {
    html += `<div class="card match-group"><h3>Relevant resume evidence</h3>
      <p class="muted small">The Resume Memory facts that contributed to your strongest matches.</p>`;
    for (const { id, st, rec } of relevant) {
      const text = (rec.original_text || rec.normalized_claim || "").replace(/\s+/g, " ").trim();
      html += `<div class="relevant-ev">
        <div class="match-meta"><span class="evidence-link" data-evidence="${esc(id)}">${esc(id)}</span>
          <span class="muted small">${esc(rec.section || "")}</span>
          <span class="muted small">${st.matched} match${st.matched === 1 ? "" : "es"} / ${st.partial} partial</span></div>
        <blockquote>${esc(text)}</blockquote>
      </div>`;
    }
    html += `</div>`;
  }

  panel.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Tailoring plan (non-destructive, grouped by resume entry)
// ---------------------------------------------------------------------------

const UI_ACTION_MAP = {
  REWRITE: (sec) => (/summar/i.test(sec || "") ? "REWRITE_SUMMARY" : "REWRITE_BULLET"),
  REPLACE: (sec) => (/summar/i.test(sec || "") ? "REWRITE_SUMMARY" : "REWRITE_BULLET"),
  REORDER: (sec) => {
    if (/skill|competenc/i.test(sec || "")) return "REORDER_SKILL";
    if (/experience|internship|employment|activity|leadership/i.test(sec || "")) return "REORDER_EXPERIENCE";
    if (/project/i.test(sec || "")) return "REORDER_PROJECT";
    return "REORDER_BULLET";
  },
  DE_EMPHASIZE: () => "KEEP",
  REMOVE: () => "KEEP",
  CONFIRM_FIRST: () => "KEEP",
  OPTIONAL_ADD: () => "KEEP",
};

function uiAction(r) {
  const a = String(r.action || "KEEP").toUpperCase();
  const map = UI_ACTION_MAP[a];
  return map ? map(r.section || "") : a;
}

const SUM_SEC_RE = /summar/i;
const EXP_SEC_RE = /experience|internship|employment|activity|leadership/i;
const PROJ_SEC_RE = /project/i;

function orderedListBlock(label, text) {
  const items = String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!items.length) return "";
  return `<div class="rec-field"><div class="label">${esc(label)}</div>
    <ol>${items.map((l) => `<li>${esc(l)}</li>`).join("")}</ol></div>`;
}

function currentBlock(text) {
  if (!text) return "";
  return `<div class="rec-field"><div class="label">Current</div><blockquote>${esc(text)}</blockquote></div>`;
}

function suggestedBlock(r) {
  if (!r.recommended_text || r.recommended_text === r.current_text) return "";
  return `<div class="rec-field"><div class="label">Suggested</div><div>${renderMarkdown(r.recommended_text)}</div></div>`;
}

function whyBlock(r) {
  if (!r.reason) return "";
  return `<div class="rec-field"><div class="label">Why</div><div>${renderMarkdown(r.reason)}</div></div>`;
}

function notesBlock(r) {
  const problems = (r.problems || []).map((p) => `<div class="error small">- ${esc(p)}</div>`).join("");
  const guard = (r.guard_warnings || []).length ? `<div class="warn small">${(r.guard_warnings || []).map((w) => esc(w.message)).join("<br>")}</div>` : "";
  return `${problems}${guard}`;
}

function groupByEntry(list) {
  const m = new Map();
  for (const r of list) {
    const key = r.entry_key || r.section || "Other";
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(r);
  }
  return [...m.entries()];
}

function byPriority(a, b) {
  return (a.priority || 99) - (b.priority || 99);
}

// Renders every bullet-level recommendation inside one experience/project entry
// as "#### Bullet N" with Current / Suggested / Why.
function renderEntryBlock(label, recsIn) {
  let h = `<h3>${esc(label)}</h3>`;
  let n = 0;
  const sorted = [...recsIn].sort(byPriority);
  for (const r of sorted) {
    const a = uiAction(r);
    if (a === "REORDER_BULLET") {
      h += `<div class="rec bullet-rec"><h4>Bullet order</h4>
        ${orderedListBlock("Current order", r.current_text)}
        ${orderedListBlock("Suggested order", r.recommended_text)}
        ${whyBlock(r)}</div>`;
    } else {
      n += 1;
      h += `<div class="rec bullet-rec"><h4>Bullet ${n}</h4>
        ${currentBlock(r.current_text)}
        ${suggestedBlock(r)}
        ${whyBlock(r)}
        ${notesBlock(r)}</div>`;
    }
  }
  return `<div class="entry-group">${h}</div>`;
}

function renderTailoring() {
  const panel = $("#panel-tailoring");
  const s = state.session;
  if (!s?.jd) {
    panel.innerHTML = `<div class="card"><p class="muted">Analyse the job description first.</p></div>`;
    return;
  }
  const recs = s.recommendations || [];
  if (!recs.length) {
    panel.innerHTML = `<div class="card">
      <h1>Tailoring Recommendations</h1>
      <p class="muted small">Suggestions only — your resume is never modified automatically. The plan rewrites the wording of the Summary and relevant Experience/Project bullets to match this job, keeps strong content exactly as written, and may optionally reorder your verified skills. Every rewrite is grounded in Resume Memory and checked against it automatically. Nothing is ever removed or reordered except (optionally) your skills list.</p>
      <div class="actions"><button class="btn primary" id="tailor-btn" type="button">Generate tailoring plan</button></div>
    </div>`;
    $("#tailor-btn").addEventListener("click", runTailor);
    return;
  }

  let html = `<div class="card">
    <h1>Tailoring Recommendations</h1>
    <p class="muted small">Suggestions only. Rewrites improve the wording of your existing content to match this job; nothing is added, nothing is removed, and the resume's structure (titles, companies, dates, entries) stays exactly as it is. Nothing is applied until you edit your Master Resume yourself.</p>
    <div class="actions" style="margin-top:8px"><button class="btn primary" id="retailor-btn" type="button">Regenerate</button></div>
  </div>`;

  // Overall Tailoring Strategy
  const strategy = (s.tailoring_strategy || "").trim();
  if (strategy) {
    html += `<div class="card"><h2>Overall Tailoring Strategy</h2>${renderMarkdown(strategy)}</div>`;
  }

  // Partition recommendations by their (normalized) action.
  const summaryRecs = [];
  const expRecs = [];
  const projRecs = [];
  const skillRecs = [];
  const keepRecs = [];
  const miscRecs = [];
  for (const r of recs) {
    const a = uiAction(r);
    const sec = r.section_label || r.section || "";
    if (a === "REWRITE_SUMMARY") summaryRecs.push(r);
    else if (a === "REORDER_SKILL") skillRecs.push(r);
    else if (a === "REWRITE_BULLET") {
      if (EXP_SEC_RE.test(sec)) expRecs.push(r);
      else if (PROJ_SEC_RE.test(sec)) projRecs.push(r);
      else miscRecs.push(r);
    } else if (a === "KEEP" || /REORDER|EMPHASIZE/.test(a)) keepRecs.push(r);
    else miscRecs.push(r);
  }

  // Summary
  if (summaryRecs.length) {
    html += `<div class="card"><h2>Summary</h2>`;
    for (const r of summaryRecs) {
      html += `<div class="rec">
        ${currentBlock(r.current_text)}
        ${suggestedBlock(r)}
        ${whyBlock(r)}
        ${notesBlock(r)}
      </div>`;
    }
    html += `</div>`;
  }

  // Experience (bullet rewrites, grouped per entry)
  if (expRecs.length) {
    html += `<div class="card"><h2>Experience</h2>`;
    for (const [key, list] of groupByEntry(expRecs)) {
      const label = list.find((r) => r.entry_label)?.entry_label || key;
      html += renderEntryBlock(label, list);
    }
    html += `</div>`;
  }

  // Projects (bullet rewrites, grouped per entry)
  if (projRecs.length) {
    html += `<div class="card"><h2>Projects</h2>`;
    for (const [key, list] of groupByEntry(projRecs)) {
      const label = list.find((r) => r.entry_label)?.entry_label || key;
      html += renderEntryBlock(label, list);
    }
    html += `</div>`;
  }

  // Skills (optional ordering of existing verified skills only)
  if (skillRecs.length) {
    html += `<div class="card"><h2>Skills</h2>
      <div class="rec">
        <h3>Optional Skill Ordering</h3>
        <p class="muted small">Only the order of your verified skills is suggested. Skills are never added, removed or renamed, and this is entirely optional.</p>
        ${orderedListBlock("Current skill order", skillRecs.map((r) => r.current_text).join("\n"))}
        ${orderedListBlock("Suggested skill order", skillRecs.map((r) => r.recommended_text).join("\n"))}
        ${whyBlock(skillRecs[0])}
      </div>
    </div>`;
  }

  // Keep unchanged (strong bullets already aligned with the JD)
  if (keepRecs.length) {
    html += `<div class="card"><h2>Keep Unchanged</h2>
      <p class="muted small">These verified bullets already provide strong evidence for this job; they are kept exactly as written so the resume stays truthful.</p>`;
    for (const r of keepRecs) {
      html += `<div class="rec keep-rec">
        <blockquote>${esc(r.current_text || "")}</blockquote>`;
      const meta = r.section_label || r.section ? `<div class="match-meta"><span class="muted small">${esc(r.section_label || r.section || "")}</span></div>` : "";
      html += `${meta}</div>`;
    }
    html += `</div>`;
  }

  // Miscellaneous (anything not covered by the standard groupings)
  if (miscRecs.length) {
    html += `<div class="card"><h2>Other suggestions</h2>`;
    for (const r of miscRecs) {
      html += `<div class="rec">
        <div class="rec-head"><span class="rec-action ${esc(uiAction(r))}">${esc(uiAction(r))}</span><b>${esc(r.section || "")}</b></div>
        ${currentBlock(r.current_text)}
        ${suggestedBlock(r)}
        ${whyBlock(r)}
        ${notesBlock(r)}
      </div>`;
    }
    html += `</div>`;
  }

  panel.innerHTML = html;

  const regen = $("#retailor-btn");
  if (regen) regen.addEventListener("click", runTailor);
}

async function runTailor() {
  const id = state.sessionId;
  if (state.runningSessions.has(id)) {
    toast("Tailoring is already running for this application.");
    return;
  }
  if (!state.session?.jd) {
    toast("Analyse the JD first.");
    return;
  }
  const tracker = makeStepTracker();
  beginProcess(
    "tailor",
    "tailor:start",
    `<p class="muted small">The model improves the wording of your Summary and relevant Experience/Project bullets, validates everything against Resume Memory, and keeps strong content unchanged. Nothing is reordered (except an optional skills ordering) and nothing is ever removed. On the first generate it also writes the cover letter in the same run; later runs regenerate only this plan (the Cover Letter tab regenerates independently). This can take a few minutes — you can switch to another application while it runs.</p>`
  );
  state.runningSessions.add(id);
  try {
    const res = await fetch(`/api/sessions/${id}/tailor`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || `Tailoring failed (HTTP ${res.status}).`);
    }
    let result = null;
    let failed = null;
    await readSSE(res, (evt, payload) => {
      if (evt === "progress" && payload.step) {
        state.currentProcess = {
          type: "tailor",
          steps: tracker.push(payload.step, payload.label),
          note: state.currentProcess ? state.currentProcess.note : "",
        };
        renderStepsInto("tailoring");
      } else if (evt === "result") {
        result = payload;
      } else if (evt === "error") {
        failed = new Error(payload.error || "Tailoring failed.");
      }
    });
    if (failed) throw failed;
    if (!result) throw new Error("Tailoring ended without a result from the server.");
    state.currentProcess = null;
    await finishProcess(id, result.session);
  } catch (err) {
    state.currentProcess = null;
    if (id === state.sessionId) {
      const panel = $("#panel-tailoring");
      if (panel) {
        panel.innerHTML = `<div class="card">
          <h2>Tailoring plan</h2>
          <p class="error">${esc(err.message)}</p>
          <div class="actions"><button class="btn primary" id="tailor-retry" type="button">Try again</button></div>
        </div>`;
        $("#tailor-retry").addEventListener("click", runTailor);
      }
    } else {
      toast("Tailoring failed: " + err.message);
    }
  } finally {
    state.runningSessions.delete(id);
  }
}

function renderCover() {
  const panel = $("#panel-cover");
  const s = state.session;
  if (!s?.jd) {
    panel.innerHTML = `<div class="card"><p class="muted">Analyse the job description first.</p></div>`;
    return;
  }
  const cover = s.cover_letter;
  if (!cover?.letter) {
    panel.innerHTML = `<div class="card">
      <h1>Cover Letter</h1>
      <p class="muted small">Generated independently from the job description, its analysis, and your Resume Memory's strongest matching evidence. It is separate from the tailoring plan above: generating one never affects the other, and neither ever modifies your resume.</p>
      <div class="actions"><button class="btn primary" id="gen-letter-btn" type="button">Generate cover letter</button></div>
    </div>`;
    $("#gen-letter-btn").addEventListener("click", () => runCover());
    return;
  }
  panel.innerHTML = `<div class="card">
    <h1>Cover Letter</h1>
    <p class="muted small">Editable draft, written from Resume Memory evidence only and validated automatically against it. Save your changes, copy it, or regenerate.</p>
    <textarea id="cover-letter-editor" rows="16" spellcheck="false">${esc(cover.letter)}</textarea>
    <div class="actions" style="margin-top:8px">
      <button class="btn primary" id="cl-save-btn" type="button">Save changes</button>
      <button class="btn" id="cl-copy-btn" type="button">Copy</button>
      <button class="btn" id="cl-pdf-btn" type="button">Download PDF</button>
      <button class="btn" id="cl-regen-btn" type="button">Regenerate</button>
      <span class="muted small" id="cl-note"></span>
    </div>
  </div>`;
  $("#cl-save-btn").addEventListener("click", async () => {
    try {
      const { session } = await api(`/api/sessions/${state.sessionId}/cover-letter`, {
        method: "PATCH",
        body: { letter: $("#cover-letter-editor").value },
      });
      state.session = session;
      $("#cl-note").textContent = "Saved.";
    } catch (err) {
      $("#cl-note").textContent = "Could not save: " + err.message;
    }
  });
  $("#cl-copy-btn").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#cover-letter-editor").value).catch(() => {});
    $("#cl-note").textContent = "Copied.";
  });
  $("#cl-pdf-btn").addEventListener("click", async () => {
    try {
      const res = await fetch(`/api/sessions/${state.sessionId}/cover-letter.pdf`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || `PDF failed (HTTP ${res.status}).`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cover-letter.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      $("#cl-note").textContent = "PDF failed: " + err.message;
    }
  });
  $("#cl-regen-btn").addEventListener("click", () => runCover());
}

// Independent cover-letter generation (its own SSE process on the Cover Letter tab).
async function runCover() {
  const id = state.sessionId;
  if (state.runningSessions.has(id)) {
    toast("A process is already running for this application.");
    return;
  }
  if (!state.session?.jd) {
    toast("Analyse the JD first.");
    return;
  }
  const tracker = makeStepTracker();
  beginProcess(
    "cover",
    "cover:start",
    `<p class="muted small">The model writes the cover letter from the JD, its analysis, and your Resume Memory, then validates it against that evidence. This can take a few minutes — you can switch to another application while it runs.</p>`
  );
  state.runningSessions.add(id);
  try {
    const res = await fetch(`/api/sessions/${id}/cover-letter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error || `Cover letter failed (HTTP ${res.status}).`);
    }
    let result = null;
    let failed = null;
    await readSSE(res, (evt, payload) => {
      if (evt === "progress" && payload.step) {
        state.currentProcess = {
          type: "cover",
          steps: tracker.push(payload.step, payload.label),
          note: state.currentProcess ? state.currentProcess.note : "",
        };
        renderStepsInto("cover");
      } else if (evt === "result") {
        result = payload;
      } else if (evt === "error") {
        failed = new Error(payload.error || "Cover letter generation failed.");
      }
    });
    if (failed) throw failed;
    if (!result) throw new Error("Cover letter ended without a result from the server.");
    state.currentProcess = null;
    await finishProcess(id, result.session, { kind: "cover", tab: "cover" });
  } catch (err) {
    state.currentProcess = null;
    if (id === state.sessionId) {
      const panel = $("#panel-cover");
      if (panel) {
        panel.innerHTML = `<div class="card">
          <h1>Cover Letter</h1>
          <p class="error">${esc(err.message)}</p>
          <div class="actions"><button class="btn primary" id="cover-retry" type="button">Try again</button></div>
        </div>`;
        $("#cover-retry").addEventListener("click", () => runCover());
      }
    } else {
      toast("Cover letter failed: " + err.message);
    }
  } finally {
    state.runningSessions.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Evidence drawer
// ---------------------------------------------------------------------------

async function openEvidence(id) {
  try {
    const { evidence } = await api(`/api/sessions/${state.sessionId}/evidence/${id}`);
    $("#drawer-body").innerHTML = `<h3>Evidence ${esc(evidence.evidence_id)}</h3><div class="ev">
      <div class="id">${esc(evidence.evidence_id)} &middot; ${esc(evidence.status)} &middot; level: ${esc(evidence.skill_level)}</div>
      <p><b>Normalized claim:</b> ${esc(evidence.normalized_claim)}</p>
      ${evidence.source_location ? `<p><b>Source:</b> ${esc(evidence.source_location)}</p>` : ""}
      ${evidence.original_text ? `<p><b>Original:</b></p><blockquote>${esc(evidence.original_text)}</blockquote>` : ""}
      ${evidence.question ? `<p><b>Question:</b> ${esc(evidence.question)}</p>` : ""}
      ${evidence.answer ? `<p><b>Answer:</b></p><blockquote>${esc(evidence.answer)}</blockquote>` : ""}</div>`;
    $("#drawer").classList.remove("hidden");
    $("#drawer-backdrop").classList.remove("hidden");
  } catch {
    $("#drawer-body").innerHTML = "<p class='muted'>Evidence not found.</p>";
    $("#drawer").classList.remove("hidden");
    $("#drawer-backdrop").classList.remove("hidden");
  }
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
  $("#drawer-backdrop").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function bindEvents() {
  $("#nav-memory").addEventListener("click", () => switchView("memory"));
  $("#nav-questions").addEventListener("click", () => switchView("questions"));
  $("#new-app-btn").addEventListener("click", createApplication);
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-backdrop").addEventListener("click", closeDrawer);

  document.addEventListener("click", (e) => {
    const renameBtn = e.target.closest(".app-rename");
    if (renameBtn) {
      e.preventDefault();
      e.stopPropagation();
      renameApplication(renameBtn.dataset.sid);
      return;
    }
    const delBtn = e.target.closest(".app-delete");
    if (delBtn) {
      e.preventDefault();
      e.stopPropagation();
      deleteApplication(delBtn.dataset.sid);
      return;
    }
    const appItem = e.target.closest(".app-item");
    if (appItem) { openApplication(appItem.dataset.sid); return; }
    const appTab = e.target.closest(".app-tab");
    if (appTab) { switchAppTab(appTab.dataset.apptab); return; }
    const ev = e.target.closest(".evidence-link");
    if (ev) { openEvidence(ev.dataset.evidence); return; }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  bindEvents();
  loadStatus();
  try {
    await Promise.all([loadSessions(), loadMemory()]);
  } catch (err) {
    toast(err.message);
  }
  // Reopen the last application if one of its processes is still running, so a
  // page refresh shows the process instead of hiding it.
  const lastId = getLastSession();
  if (lastId) {
    try {
      const { session } = await api(`/api/sessions/${lastId}`);
      if (session.process) {
        state.sessionId = session.id;
        state.session = session;
        renderSidebar();
        state.view = "app";
        switchView("app");
        startProcessWatch(session.id, session.process);
      }
    } catch {
      setLastSession(null);
    }
  }
  switchView(state.view);
}

init().catch((err) => console.error("Init failed:", err));