import express from "express";
import multer from "multer";
import path from "node:path";
import { config, detectOllama, statusSnapshot, ROOT } from "./config.js";
import {
  createSession,
  saveSession,
  getSession,
  listSessions,
  deleteSession,
} from "./core/session.js";
import { analyzeResume, extractResume } from "./pipeline/resume.js";
import { analyzeJd } from "./pipeline/jd.js";
import { runMatching } from "./pipeline/matching.js";
import { generateQuestions, recordAnswer } from "./pipeline/questions.js";
import { runTailoring, runCoverLetter } from "./pipeline/tailor.js";
import { coverLetterPdf } from "./pdf.js";
import { TruthDatabase } from "./core/truthdb.js";
import {
  loadMemory,
  saveMemory,
  getMemory,
  deleteMemory,
  effectiveTruthDb,
  diffResume,
  applyAcceptedChanges,
  applyStructuredEdits,
  applyStructuredDelta,
  createMemoryFromExtraction,
  buildStructuredFromFacts,
  memorySummary,
} from "./core/resumeMemory.js";
import {
  listQuestions,
  getQuestion,
  addQuestion,
  updateQuestion,
  deleteQuestion,
} from "./core/personalQuestions.js";
import {
  recordAnalysis,
  learningSummary,
} from "./core/learning.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireSession(req, res, next) {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found." });
  req.session = session;
  next();
}

function sseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

// Guarded send: the client may disconnect while a long local job still runs.
function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* client left; the job keeps running server-side */
  }
}

function markPhase(session, type, phase) {
  if (!session.process || session.process.type !== type) {
    session.process = { type, phase, started_at: new Date().toISOString() };
  } else {
    session.process.phase = phase;
  }
  return session;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

app.get(
  "/api/status",
  asyncRoute(async (_req, res) => {
    await detectOllama();
    res.json({
      app: "Jobber",
      privacy: "All processing is local. No data leaves this machine.",
      ollama: statusSnapshot(),
    });
  })
);

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

app.get("/api/sessions", (_req, res) => {
  res.json({ sessions: listSessions() });
});

app.post(
  "/api/sessions",
  asyncRoute(async (req, res) => {
    const session = createSession((req.body || {}).name);
    saveSession(session);
    res.status(201).json({ session });
  })
);

app.get("/api/sessions/:id", requireSession, (req, res) => {
  res.json({ session: req.session });
});

app.patch(
  "/api/sessions/:id",
  requireSession,
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (typeof body.name === "string") req.session.name = body.name.slice(0, 120);
    if (typeof body.job_description === "string") req.session.job_description = body.job_description;
    if (typeof body.job_url === "string") req.session.job_url = body.job_url.slice(0, 2000);
    saveSession(req.session);
    res.json({ session: req.session });
  })
);

app.delete("/api/sessions/:id", (req, res) => {
  res.json({ deleted: deleteSession(req.params.id) });
});

app.patch(
  "/api/sessions/:id/cover-letter",
  requireSession,
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    if (typeof body.letter !== "string") {
      return res.status(400).json({ error: "Provide a letter string." });
    }
    if (!req.session.cover_letter) req.session.cover_letter = { letter: "", claims: [] };
    req.session.cover_letter.letter = body.letter;
    saveSession(req.session);
    res.json({ session: req.session });
  })
);

// Generate an independent cover letter (separate from tailoring recommendations).
app.post(
  "/api/sessions/:id/cover-letter",
  requireSession,
  asyncRoute(async (req, res) => {
    if (req.session.process) {
      return res.status(409).json({ error: "A process is already running for this application." });
    }
    req.session.truth_db = effectiveTruthDb(req.session).toJSON();
    sseHeaders(res);
    const send = (event, data) => sseSend(res, event, data);
    try {
      markPhase(req.session, "cover", "cover:start");
      saveSession(req.session);
      await runCoverLetter(req.session, {
        onProgress: (p) => {
          if (p.step) {
            markPhase(req.session, "cover", p.step);
            saveSession(req.session);
          }
          send("progress", p);
        },
      });
      req.session.process = null;
      saveSession(req.session);
      recordAnalysis(req.session);
      send("result", { session: req.session });
      try { res.end(); } catch { /* already closed */ }
    } catch (err) {
      req.session.process = null;
      try { saveSession(req.session); } catch { /* best effort */ }
      send("error", { error: err.message || "Cover letter generation failed." });
      try { res.end(); } catch { /* already closed */ }
    }
  })
);

// ---------------------------------------------------------------------------
// Resume Memory
// ---------------------------------------------------------------------------

app.get(
  "/api/resume-memory",
  asyncRoute(async (_req, res) => {
    const memory = getMemory();
    res.json({ memory: memorySummary(memory), facts: memory?.truth_db || [] });
  })
);

app.post(
  "/api/resume-memory/upload",
  upload.single("resume"),
  asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No resume file uploaded." });
    // Stream progress + result as Server-Sent Events so the UI can show where
    // the (slow, local) LLM extraction is without blocking the page.
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const filename = req.file.originalname;
      const { facts, extraction, rawText } = await extractResume(
        req.file.buffer,
        filename,
        (p) => send("progress", p)
      );
      const structured = buildStructuredFromFacts(facts, extraction);
      send("progress", { phase: "structure", label: "Comparing with current Resume Memory…" });
      const memory = getMemory();
      if (!memory) {
        send("result", { isNew: true, facts, extraction, structured, rawText });
      } else {
        const diff = diffResume(facts, memory);
        send("result", { isNew: false, diff, facts, extraction, structured, rawText });
      }
      res.end();
    } catch (err) {
      send("error", { error: err.message || "Upload failed." });
      res.end();
    }
  })
);

app.post(
  "/api/resume-memory/save",
  asyncRoute(async (_req, res) => {
    const body = _req.body || {};
    if (!body.facts || !body.extraction) {
      return res.status(400).json({ error: "Provide facts and extraction." });
    }
    const memory = createMemoryFromExtraction({
      facts: body.facts,
      extraction: body.extraction,
      filename: body.filename || "resume",
      raw_text: body.rawText || "",
    });
    saveMemory(memory);
    res.json({ memory: memorySummary(memory) });
  })
);

app.post(
  "/api/resume-memory/apply",
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const memory = getMemory();
    if (!memory) return res.status(404).json({ error: "No Resume Memory exists." });
    if (!body.facts) return res.status(400).json({ error: "Provide facts from the diff." });
    const accepted = new Set(body.acceptedSections || []);
    applyAcceptedChanges(memory, body.facts, accepted);
    saveMemory(memory);
    res.json({ memory: memorySummary(memory) });
  })
);

app.post(
  "/api/resume-memory/edit",
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    let memory = getMemory();
    if (!memory) return res.status(404).json({ error: "No Resume Memory exists." });
    if (body.structured || body.added?.length || body.removed?.length) {
      memory = applyStructuredDelta(memory, {
        structured: body.structured,
        added: body.added,
        removed: body.removed,
      });
    }
    if (body.truth_db) {
      memory.truth_db = body.truth_db;
      memory.structured = buildStructuredFromFacts(
        memory.truth_db.filter((r) => r.source_type === "resume"),
        memory.extraction
      );
    }
    if (body.filename) memory.filename = body.filename;
    saveMemory(memory);
    res.json({ memory: memorySummary(memory) });
  })
);

app.delete(
  "/api/resume-memory",
  asyncRoute(async (_req, res) => {
    const ok = deleteMemory();
    res.json({ deleted: ok });
  })
);

// ---------------------------------------------------------------------------
// Personal Questions bank
// ---------------------------------------------------------------------------

app.get("/api/personal-questions", (_req, res) => {
  res.json({ questions: listQuestions() });
});

app.get("/api/personal-questions/:id", (req, res) => {
  const item = getQuestion(req.params.id);
  if (!item) return res.status(404).json({ error: "Question not found." });
  res.json({ question: item });
});

app.post(
  "/api/personal-questions",
  asyncRoute(async (req, res) => {
    const body = req.body || {};
    const item = addQuestion({
      question: body.question,
      answer_type: body.answer_type,
      answer: body.answer,
      notes_evidence: body.notes_evidence,
      source: body.source,
      requirement_id: body.requirement_id,
    });
    res.status(201).json({ question: item });
  })
);

app.put(
  "/api/personal-questions/:id",
  asyncRoute(async (req, res) => {
    const item = updateQuestion(req.params.id, req.body || {});
    if (!item) return res.status(404).json({ error: "Question not found." });
    res.json({ question: item });
  })
);

app.delete("/api/personal-questions/:id", (req, res) => {
  res.json({ deleted: deleteQuestion(req.params.id) });
});

// ---------------------------------------------------------------------------
// In-context learning store
// ---------------------------------------------------------------------------

app.get("/api/learning", (_req, res) => {
  res.json({ learning: learningSummary() });
});

// ---------------------------------------------------------------------------
// Resume upload + analysis
// ---------------------------------------------------------------------------

app.post(
  "/api/sessions/:id/resume",
  requireSession,
  upload.single("resume"),
  asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No resume file uploaded." });
    const memory = getMemory();
    if (memory) {
      // Reuse approved Resume Memory instead of re-extracting.
      const db = new TruthDatabase(memory.truth_db || []);
      req.session.truth_db = db.toJSON();
      req.session.resume = {
        filename: memory.filename,
        raw_text: memory.raw_text || "",
        extraction: memory.extraction || null,
      };
      req.session.stage = "resume_analyzed";
      saveSession(req.session);
      return res.json({ session: req.session, memoryReused: true });
    }
    await analyzeResume(req.session, {
      buffer: req.file.buffer,
      filename: req.file.originalname,
    });
    // Auto-create Resume Memory so future JD analysis can reuse it.
    const mem = createMemoryFromExtraction({
      facts: req.session.truth_db.filter((r) => r.source_type === "resume"),
      extraction: req.session.resume?.extraction || null,
      filename: req.file.originalname,
      rawText: req.session.resume?.raw_text || "",
    });
    saveMemory(mem);
    saveSession(req.session);
    res.json({ session: req.session });
  })
);

// ---------------------------------------------------------------------------
// Resume memory reuse (lightweight — no re-extraction)
// ---------------------------------------------------------------------------

app.post(
  "/api/sessions/:id/resume-memory-reuse",
  requireSession,
  asyncRoute(async (req, res) => {
    const memory = getMemory();
    if (!memory) return res.status(404).json({ error: "No Resume Memory exists." });
    const db = new TruthDatabase(memory.truth_db || []);
    req.session.truth_db = db.toJSON();
    req.session.resume = { filename: memory.filename, raw_text: memory.raw_text || "", extraction: memory.extraction || null };
    req.session.stage = "resume_analyzed";
    saveSession(req.session);
    res.json({ session: req.session });
  })
);

// ---------------------------------------------------------------------------
// Job description
// ---------------------------------------------------------------------------

app.post(
  "/api/sessions/:id/jd",
  requireSession,
  asyncRoute(async (req, res) => {
    const { job_description } = req.body || {};
    if (!job_description || job_description.trim().length < 40) {
      return res
        .status(400)
        .json({ error: "Please paste a complete job description (at least a few lines)." });
    }
    req.session.job_description = job_description;
    // Re-analysis: drop results computed against the previous JD so the
    // application never shows stale matches/tailoring for a new job.
    if (req.session.jd) {
      req.session.matches = [];
      req.session.questions = [];
      req.session.answers = [];
      req.session.recommendations = [];
      req.session.cover_letter = null;
    }
    await analyzeJd(req.session);
    if (req.session.jd?.job_title && !req.session.name) {
      req.session.name = req.session.jd.job_title;
    }
    saveSession(req.session);
    res.json({ session: req.session });
  })
);

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

app.post(
  "/api/sessions/:id/match",
  requireSession,
  asyncRoute(async (req, res) => {
    req.session.truth_db = effectiveTruthDb(req.session).toJSON();
    await runMatching(req.session);
    saveSession(req.session);
    res.json({ session: req.session });
  })
);

// ---------------------------------------------------------------------------
// Questions + answers
// ---------------------------------------------------------------------------

app.post(
  "/api/sessions/:id/questions",
  requireSession,
  asyncRoute(async (req, res) => {
    req.session.truth_db = effectiveTruthDb(req.session).toJSON();
    await generateQuestions(req.session);
    saveSession(req.session);
    res.json({ session: req.session });
  })
);

app.post(
  "/api/sessions/:id/answers",
  requireSession,
  asyncRoute(async (req, res) => {
    const { question_id, answer } = req.body || {};
    if (!question_id) return res.status(400).json({ error: "question_id is required." });
    await recordAnswer(req.session, { question_id, answer });
    req.session.truth_db = effectiveTruthDb(req.session).toJSON();
    saveSession(req.session);
    res.json({ session: req.session });
  })
);

// ---------------------------------------------------------------------------
// Analysis (resume reuse -> JD -> match -> questions) as one server-driven job
// ---------------------------------------------------------------------------

app.post(
  "/api/sessions/:id/analyze",
  requireSession,
  asyncRoute(async (req, res) => {
    const { job_description } = req.body || {};
    if (!job_description || job_description.trim().length < 40) {
      return res
        .status(400)
        .json({ error: "Please paste a complete job description (at least a few lines)." });
    }
    const memory = getMemory();
    if (!memory) {
      return res.status(400).json({ error: "Create Resume Memory first." });
    }
    if (req.session.process) {
      return res.status(409).json({ error: "A process is already running for this application." });
    }
    sseHeaders(res);
    const send = (event, data) => sseSend(res, event, data);
    const step = (phase, label) => {
      markPhase(req.session, "analysis", phase);
      saveSession(req.session);
      send("progress", { step: phase, label });
    };
    try {
      step("resume", "Applying Resume Memory to application…");
      const db = new TruthDatabase(memory.truth_db || []);
      req.session.truth_db = db.toJSON();
      req.session.resume = {
        filename: memory.filename,
        raw_text: memory.raw_text || "",
        extraction: memory.extraction || null,
      };
      req.session.stage = "resume_analyzed";
      saveSession(req.session);

      step("jd", "Parsing job requirements (Qwen)…");
      req.session.job_description = job_description;
      // Re-analysis: drop results computed against the previous JD so the
      // application never shows stale matches/tailoring for a new job.
      if (req.session.jd) {
        req.session.matches = [];
        req.session.questions = [];
        req.session.answers = [];
        req.session.recommendations = [];
        req.session.cover_letter = null;
      }
      await analyzeJd(req.session);
      if (req.session.jd?.job_title && !req.session.name) {
        req.session.name = req.session.jd.job_title;
      }
      saveSession(req.session);

      step("match", "Matching evidence (Phi-4-mini)…");
      req.session.truth_db = effectiveTruthDb(req.session).toJSON();
      await runMatching(req.session);
      saveSession(req.session);

      step("questions", "Extracting JD personal/behavioural questions…");
      await generateQuestions(req.session);
      saveSession(req.session);

      // Auto-start tailoring when the match is strong and nothing is unanswered.
      // The process marker transitions from analysis -> tailor with no gap, so a
      // page refresh can always see the process as running until it finishes.
      const percent = req.session.match_score?.percent;
      const pending = (req.session.questions || []).filter((q) => !q.answered).length;
      let autoTailored = false;
      if (typeof percent === "number" && percent > 50 && pending === 0) {
        autoTailored = true;
        markPhase(req.session, "tailor", "tailor:start");
        saveSession(req.session);
        send("progress", {
          step: "tailor:start",
          label: "Match looks strong with no open questions — starting the tailoring plan…",
        });
        await runTailoring(req.session, {
          onProgress: (p) => {
            if (p.step) {
              markPhase(req.session, "tailor", p.step);
              saveSession(req.session);
            }
            send("progress", p);
          },
        });
        saveSession(req.session);
      }

      req.session.process = null;
      saveSession(req.session);
      recordAnalysis(req.session);
      send("result", { session: req.session, autoTailored });
      try {
        res.end();
      } catch {
        /* already closed */
      }
    } catch (err) {
      req.session.process = null;
      try {
        saveSession(req.session);
      } catch {
        /* best effort */
      }
      send("error", { error: err.message || "Analysis failed." });
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
  })
);

// ---------------------------------------------------------------------------
// Process reattach (polled by the UI after a page refresh)
// ---------------------------------------------------------------------------

app.get("/api/sessions/:id/process", requireSession, (req, res) => {
  res.json({ process: req.session.process || null });
});

// ---------------------------------------------------------------------------
// Tailoring Recommendations (content-only). The first time the tailoring plan
// is generated it also writes the cover letter in the same run (so "Generate
// tailoring plan" produces both); later runs regenerate only the plan, and the
// cover letter has its own independent POST /cover-letter stage.
// ---------------------------------------------------------------------------

app.post(
  "/api/sessions/:id/tailor",
  requireSession,
  asyncRoute(async (req, res) => {
    if (req.session.process) {
      return res.status(409).json({ error: "A process is already running for this application." });
    }
    // Stream per-stage progress as Server-Sent Events so the UI shows
    // what the (slow, local) tailoring pipeline is doing instead of blocking.
    // Matching is NOT refreshed here: matches are kept up to date the moment
    // questions are answered (recomputeAffectedMatches), so a refresh adds
    // latency without changing the recommendation inputs.
    req.session.truth_db = effectiveTruthDb(req.session).toJSON();
    const firstRun = (req.session.recommendations || []).length === 0;
    sseHeaders(res);
    const send = (event, data) => sseSend(res, event, data);
    try {
      markPhase(req.session, "tailor", "tailor:start");
      saveSession(req.session);
      await runTailoring(req.session, {
        onProgress: (p) => {
          if (p.step) {
            markPhase(req.session, "tailor", p.step);
            saveSession(req.session);
          }
          send("progress", p);
        },
      });

      // First generate writes the cover letter together with the plan. A cover
      // failure is non-fatal: the recommendations are already valid, so we
      // record the error and still deliver the plan (the Cover Letter tab can
      // retry independently).
      if (firstRun) {
        try {
          await runCoverLetter(req.session, {
            onProgress: (p) => {
              if (p.step) {
                markPhase(req.session, "tailor", p.step);
                saveSession(req.session);
              }
              send("progress", p);
            },
          });
        } catch (coverErr) {
          req.session.cover_error = coverErr.message || "Cover letter generation failed.";
          try {
            saveSession(req.session);
          } catch {
            /* best effort */
          }
        }
      }

      markPhase(req.session, "tailor", "done");
      saveSession(req.session);
      req.session.process = null;
      saveSession(req.session);
      recordAnalysis(req.session);
      send("result", { session: req.session });
      try {
        res.end();
      } catch {
        /* already closed */
      }
    } catch (err) {
      req.session.process = null;
      try {
        saveSession(req.session);
      } catch {
        /* best effort */
      }
      send("error", { error: err.message || "Tailoring failed." });
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
  })
);

// Download the saved cover letter as a PDF (plain text rendered to A4 pages).
app.get("/api/sessions/:id/cover-letter.pdf", requireSession, (req, res) => {
  const letter = String(req.session.cover_letter?.letter || "").trim();
  if (!letter) {
    return res.status(404).json({ error: "No cover letter yet for this application." });
  }
  const jd = req.session.jd || {};
  const role = jd.job_title || "application";
  const filename =
    `cover-letter-${String(role).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "application"}.pdf`;
  // The letter body carries no header: the document starts directly with the
  // salutation and the sign-off block ends the document.
  const pdf = coverLetterPdf(letter);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(Buffer.from(pdf));
});

// ---------------------------------------------------------------------------
// Evidence inspector
// ---------------------------------------------------------------------------

app.get("/api/sessions/:id/evidence", requireSession, (req, res) => {
  const db = new TruthDatabase(req.session.truth_db || []);
  res.json({ evidence: db.all() });
});

app.get("/api/sessions/:id/evidence/:evidenceId", requireSession, (req, res) => {
  const db = new TruthDatabase(req.session.truth_db || []);
  const record = db.get(req.params.evidenceId);
  if (!record) return res.status(404).json({ error: "Evidence not found." });
  res.json({ evidence: record });
});

// ---------------------------------------------------------------------------
// Static UI
// ---------------------------------------------------------------------------

app.use(
  express.static(path.join(ROOT, "public"), {
    // Frontend was recently rewritten; revalidate every load so a stale
    // browser cache can't serve an old JS/HTML that binds to other IDs.
    setHeaders(res) {
      res.setHeader("Cache-Control", "no-cache");
    },
  })
);

app.use((err, _req, res, _next) => {
  const message =
    err?.message?.includes("Ollama") || err?.message?.includes("Ollama is unavailable")
      ? err.message
      : err?.message || "Unexpected error.";
  const status = /Ollama is unavailable/i.test(message) ? 503 : 500;
  // eslint-disable-next-line no-console
  console.error(`[error] ${message}`);
  res.status(status).json({ error: message });
});

async function start() {
  await detectOllama();
  const snap = statusSnapshot();
  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Jobber running at http://localhost:${config.port}`);
    if (snap.available) {
      console.log(`Ollama: ${snap.baseUrl}`);
      console.log(`Models: ${snap.models.join(", ")}`);
      for (const [task, r] of Object.entries(snap.routing)) {
        console.log(
          `  ${task}: ${r.resolved || "(none)"}${r.changed ? ` (resolved from ${r.desired})` : ""}`
        );
      }
    } else {
      console.warn(`Ollama unavailable: ${snap.error}`);
    }
  });
}

start();

export { app };
