import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, saveSession } from "../server/core/session.js";
import { analyzeResume } from "../server/pipeline/resume.js";
import { analyzeJd } from "../server/pipeline/jd.js";
import { runMatching } from "../server/pipeline/matching.js";
import { generateQuestions, recordAnswer } from "../server/pipeline/questions.js";
import { runTailoring } from "../server/pipeline/tailor.js";
import { statusSnapshot } from "../server/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resumePath = path.join(__dirname, "fixtures/resume.pdf");
const jdPath = path.join(__dirname, "fixtures/jd.txt");

const t0 = Date.now();
const stageTimes = [];

function log(step, extra = "") {
  console.log(`\n=== ${step} ${extra}`);
}

async function stage(label, fn) {
  const start = Date.now();
  const result = await fn();
  const seconds = (Date.now() - start) / 1000;
  stageTimes.push({ label, seconds });
  console.log(`    [${label}: ${seconds.toFixed(1)}s]`);
  return result;
}

async function main() {
  const session = createSession();

  log("1. Resume extraction");
  await stage("resume extraction", () =>
    analyzeResume(session, {
      buffer: fs.readFileSync(resumePath),
      filename: "resume.pdf",
    })
  );
  console.log(`facts: ${session.truth_db.length}`);
  for (const f of session.truth_db) {
    console.log(`  ${f.evidence_id} [${f.skill_level}] ${f.normalized_claim}`);
  }

  log("2. JD analysis");
  session.job_description = fs.readFileSync(jdPath, "utf8");
  await stage("jd analysis", () => analyzeJd(session));
  console.log(`title: ${session.jd.job_title} @ ${session.jd.company}`);
  for (const r of session.jd.requirements) {
    console.log(`  ${r.requirement_id} [${r.importance}] ${r.text}`);
  }

  log("3. Matching");
  await stage("matching", () => runMatching(session));
  for (const m of session.matches) {
    console.log(`  ${m.requirement_id} ${m.status} ev=[${m.evidence_ids.join(",")}]`);
  }

  log("4. Questions");
  await stage("questions", () => generateQuestions(session));
  for (const q of session.questions) {
    console.log(`  ${q.question_id} (${q.requirement_id}) ${q.question}`);
  }

  if (session.questions.length) {
    log("5. Answering first question");
    const q = session.questions[0];
    await stage("answer normalization", () =>
      recordAnswer(session, {
        question_id: q.question_id,
        answer: "Yes, I used SQL during my internship for basic reporting.",
      })
    );
    console.log("truth_db size:", session.truth_db.length);
  }

  log("6. Tailoring (recommendations + cover letter + audits)");
  await stage("tailoring", () => runTailoring(session));
  console.log(`recommendations: ${session.recommendations.length}`);
  for (const r of session.recommendations) {
    console.log(
      `  ${r.recommendation_id} [${r.action}] ${r.section} allowed=${r.claim_allowed} ev=[${r.evidence_ids.join(",")}]`
    );
  }
  console.log("\nCover letter:\n" + session.cover_letter.letter);
  console.log(
    "\nCover-letter claim validation:",
    session.cover_letter.claim_validation.map((v) => (v.allowed ? "OK" : "REJECTED")).join(", ")
  );
  console.log("Rejected rewrites (truth guard):", session.rejected_rewrites.length);
  for (const r of session.rejected_rewrites) {
    console.log(`  - ${r.proposed}`);
  }

  console.log("\n=== FINAL TRUTHFULNESS:", session.audit.overall, "===");
  for (const t of session.audit.trace) console.log(`  ${t.stage}: ${t.overall} (${t.model || "deterministic"})`);
  const coverAudit = session.audit.cover_letter;
  for (const i of coverAudit.items) {
    console.log(`  [${i.verdict}] ${i.claim.slice(0, 80)}`);
  }
  if (coverAudit.guard_hard_failures.length) {
    console.log("  hard guard failures:");
    for (const w of coverAudit.guard_hard_failures) console.log(`    - ${w.message}`);
  }

  console.log("\n=== MODELS USED ===");
  for (const [task, r] of Object.entries(statusSnapshot().routing)) {
    console.log(`  ${task}: ${r.resolved || "(none)"}`);
  }

  console.log("\n=== STAGE TIMING ===");
  for (const s of stageTimes) console.log(`  ${s.label}: ${s.seconds.toFixed(1)}s`);

  session.id = "smoke-last";
  saveSession(session);
  console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err.message);
  process.exit(1);
});
