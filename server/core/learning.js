import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

const STORE_PATH = path.join(config.dataDir, "learning-store.json");
const MAX_ENTRIES = 60;

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const store = JSON.parse(raw);
    return Array.isArray(store && store.entries) ? store : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

function saveStore(store) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

function clamp(s, n) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n).trim()}…` : t;
}

export function learningEnabled() {
  return Boolean(config.learning);
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Compact, prompt-ready rendering of a past JD parse (requirements only). */
function requirementLessons(session) {
  const reqs = (session?.jd?.requirements || []).slice(0, 8);
  return reqs
    .map((r) => {
      const tools = (r.tools || []).slice(0, 5).join(", ");
      return (
        `[${r.importance}/${r.category}]` +
        (tools ? ` tools: ${tools}` : "") +
        ` ${r.text || "(no text)"}` +
        (r.evidence_type ? ` (what would satisfy: ${r.evidence_type})` : "")
      );
    })
    .join("\n");
}

/** Compact sample verdicts for a past match analysis. */
function matchSamples(session) {
  const reqBy = new Map((session?.jd?.requirements || []).map((r) => [r.requirement_id, r]));
  const picks = (session?.matches || [])
    .filter((m) => m.status && m.status !== "UNKNOWN")
    .slice(0, 3);
  return picks
    .map((m) => {
      const req = reqBy.get(m.requirement_id);
      const label = clamp(req?.text || m.requirement_id, 90);
      return (
        `Requirement "${label}" [${m.status}]` +
        (m.evidence_strength ? ` (evidence: ${m.evidence_strength})` : "") +
        (m.evidence_ids?.length ? ` citing ${m.evidence_ids.join(", ")}` : "") +
        ` -> ${clamp(m.explanation || m.reason || "", 130)}`
      );
    })
    .join("\n");
}

function recommendationSamples(session) {
  const recs = (session?.recommendations || [])
    .filter((r) => r.action === "REWRITE_SUMMARY" || r.action === "REWRITE_BULLET")
    .slice(0, 2);
  return recs
    .map(
      (r) =>
        `Section: ${r.section_label || r.section || "?"} — action ${r.action}\n` +
        `  current: ${clamp(r.current_text, 140)}\n` +
        `  suggested: ${clamp(r.recommended_text, 200)}\n` +
        `  reason: ${clamp(r.reason, 140)}`
    )
    .join("\n");
}

function questionSamples(session) {
  return (session?.questions || [])
    .slice(0, 4)
    .map((q) => q.question)
    .join(" | ");
}

/**
 * Persist a compact, prompt-ready summary of one completed analysis into the
 * learning store so future analyses can learn from it (in-context, not
 * fine-tuned). Idempotent per session: re-recording replaces the entry with the
 * newest state (recommendations/cover letter get richer as tailoring runs).
 */
export function recordAnalysis(session) {
  if (!session || !session.jd || !config.learning) return null;
  const store = loadStore();
  const jd = session.jd;
  const entry = {
    id: session.id,
    job_title: jd.job_title || "",
    company: jd.company || "",
    match_percent:
      typeof session.match_score?.percent === "number" ? session.match_score.percent : null,
    requirements: requirementLessons(session),
    match_samples: matchSamples(session),
    recommendation_samples: recommendationSamples(session),
    question_samples: questionSamples(session),
    tailoring_strategy: clamp(session.tailoring_strategy, 300),
    cover_letter: clamp(session.cover_letter?.letter, 700),
    analysed_at: new Date().toISOString(),
  };
  const idx = store.entries.findIndex((e) => e.id === session.id);
  if (idx >= 0) store.entries.splice(idx, 1);
  store.entries.push(entry);
  if (store.entries.length > MAX_ENTRIES) store.entries = store.entries.slice(-MAX_ENTRIES);
  saveStore(store);
  return entry;
}

// ---------------------------------------------------------------------------
// Retrieval + formatting
// ---------------------------------------------------------------------------

/**
 * Pick the most relevant past analyses: title overlap with the current job
 * first (so similar roles set the tone), then the most recent.
 */
function selectEntries({ jobTitle = "", limit = 2 } = {}) {
  const entries = (loadStore().entries || []).filter(Boolean).slice(-MAX_ENTRIES);
  if (!entries.length) return [];
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const q = norm(jobTitle);
  const qw = q ? new Set(q.split(/\s+/).filter((w) => w.length > 3)) : new Set();
  const scored = entries
    .map((e) => {
      const t = norm(e.job_title || "");
      const tw = new Set(t.split(/\s+/).filter((w) => w.length > 3));
      let score = 0;
      for (const w of qw) if (tw.has(w)) score += 1;
      if (!score && q && t) {
        if (q.includes(t) || t.includes(q)) score = 1;
      }
      return { e, score, ts: Date.parse(e.analysed_at) || 0 };
    })
    .sort((a, b) => b.score - a.score || b.ts - a.ts);
  return scored.slice(0, limit).map((s) => s.e);
}

function exampleHead(e, i, extra = "") {
  const head = `Example ${i + 1} — job "${e.job_title || "(untitled)"}"`;
  return `${head}${e.company ? ` at ${e.company}` : ""}${
    typeof e.match_percent === "number" ? ` (that analysis scored ${e.match_percent}%)` : ""
  }${extra}`;
}

/** Prompt block for the JD-extraction stage: how past JDs were parsed. */
export function formatJdExtractionLessons(jobTitle = "", limit = 2) {
  if (!config.learning) return "";
  const sel = selectEntries({ jobTitle, limit });
  if (!sel.length) return "";
  return (
    "LESSONS FROM YOUR PREVIOUS JD ANALYSES — this is how you parsed the user's past " +
    "job descriptions. Match the SAME precision, categories and importance levels. " +
    "Do not copy text — parse ONLY the current job description below.\n\n" +
    sel.map((e, i) => `${exampleHead(e, i)}\n${e.requirements || "(no requirements parsed)"}`).join("\n\n")
  );
}

/** Prompt block for the matching stage: how similar verdicts were reached. */
export function formatMatchingLessons(jobTitle = "", limit = 2) {
  if (!config.learning) return "";
  const sel = selectEntries({ jobTitle, limit });
  if (!sel.length) return "";
  return (
    "LESSONS FROM YOUR PREVIOUS MATCH ANALYSES — sample verdicts on the user's past " +
    "applications (with the reasoning that was accepted). Use the same evidence-first " +
    "judgement and caps. Only the CURRENT requirements and Resume Memory below are authoritative.\n\n" +
    sel
      .map((e, i) => {
        const reqs = e.requirements ? `Requirements:\n${e.requirements}\n` : "";
        return `${exampleHead(e, i)}\n${reqs}Verdict samples:\n${
          e.match_samples || "(no verdict samples)"
        }`;
      })
      .join("\n\n")
  );
}

/** Prompt block for the recommendation stage: past accepted rewrites. */
export function formatRecommendationLessons(jobTitle = "", limit = 2) {
  if (!config.learning) return "";
  const sel = selectEntries({ jobTitle, limit });
  if (!sel.length) return "";
  return (
    "LESSONS FROM YOUR PREVIOUS TAILORING PLANS — accepted rewrite examples for the " +
    "user's past applications. Copy the STYLE (tight, evidence-led wording) — never " +
    "the content. Every suggestion must still be supported by the CURRENT truth database.\n\n" +
    sel
      .map((e, i) => {
        const strat = e.tailoring_strategy
          ? `  strategy: ${e.tailoring_strategy}\n`
          : "  strategy: (not saved)\n";
        return `${exampleHead(e, i)}\n${strat}${
          e.recommendation_samples
            ? `  accepted rewrites:\n${e.recommendation_samples}`
            : "  accepted rewrites: (none)"
        }`;
      })
      .join("\n\n")
  );
}

/** Prompt block for the cover-letter stage: a past approved letter. */
export function formatCoverLetterLessons(jobTitle = "", limit = 1) {
  if (!config.learning) return "";
  const sel = selectEntries({ jobTitle, limit });
  if (!sel.length) return "";
  return (
    "LESSON FROM YOUR PREVIOUS COVER LETTER — a past letter the user kept (style to " +
    "follow; content, employer and claims must come ONLY from the CURRENT inputs below).\n\n" +
    sel
      .map(
        (e, i) =>
          `${exampleHead(e, i)}\n${e.cover_letter || "(no saved cover letter)"}`
      )
      .join("\n\n")
  );
}

/** Prompt block for the JD-questions stage: stable, confirmable question keys. */
export function formatQuestionLessons(jobTitle = "", limit = 2) {
  if (!config.learning) return "";
  const sel = selectEntries({ jobTitle, limit });
  if (!sel.length) return "";
  return (
    "LESSONS FROM YOUR PREVIOUS QUESTION EXTRACTION — the kinds of personal/behavioural " +
    "confirmations the user accepted for past applications. Only the CURRENT requirements " +
    "below are in scope.\n\n" +
    sel
      .map(
        (e, i) =>
          `${exampleHead(e, i)}\n  questions previously asked: ${
            e.question_samples || "(none)"
          }`
      )
      .join("\n\n")
  );
}

/** Compact summary for the UI ("models have learned from N analyses"). */
export function learningSummary() {
  const entries = loadStore().entries || [];
  return {
    enabled: config.learning,
    count: entries.length,
    entries: entries
      .slice(-MAX_ENTRIES)
      .reverse()
      .map((e) => ({
        id: e.id,
        job_title: e.job_title || "",
        company: e.company || "",
        match_percent: e.match_percent,
        analysed_at: e.analysed_at,
      })),
  };
}