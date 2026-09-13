import { generateRecommendations } from "./recommendations.js";
import { auditContent, buildViolationNote } from "./audit.js";
import { generateCoverLetter } from "./coverletter.js";
import {
  validateClaims,
  stripUnsupportedClaims,
  buildSensitiveVocabulary,
} from "../core/claims.js";
import { TruthDatabase } from "../core/truthdb.js";

function recommendationsToAuditText(recs = []) {
  return recs
    .map(
      (r) =>
        `Proposed change for section "${r.section || "(unspecified)"}":\n` +
        `- Existing resume text: ${r.current_text || "(n/a)"}\n` +
        `- Proposed replacement text: ${r.recommended_text || "(n/a)"}\n` +
        `- Rationale: ${r.reason || ""}`
    )
    .join("\n\n");
}

// Only the candidate-facing wording is checked by the deterministic validator;
// the surrounding audit labels and section metadata are not candidate claims.
function recommendationsToValidateText(recs = []) {
  return recs
    .map((r) => r.recommended_text || r.current_text || "")
    .filter(Boolean)
    .join("\n");
}

function deterministicOnlyAudit(recs) {
  return {
    label: "recommendations",
    model: null,
    items: [],
    summary:
      recs.length === 0
        ? "No rewrites were generated; there is nothing to validate."
        : "Deterministic recommendations are evidence-preserving by construction: rewrites were validated against Resume Memory, KEEP leaves verified content untouched, and the only reordering (if present) is an optional skills ordering.",
    overall: "PASS",
    guard_hard_failures: [],
    guard_soft_warnings: [],
    audited_at: new Date().toISOString(),
  };
}

// Combine audit sections into the session-level audit. Overall is PASS only if
// every audit section that exists is PASS.
function mergeAudit(existing, update) {
  const merged = { ...(existing || {}) };
  for (const [key, value] of Object.entries(update)) merged[key] = value;
  const sections = ["recommendations", "cover_letter"]
    .map((k) => merged[k])
    .filter(Boolean);
  merged.overall = sections.every((a) => a.overall === "PASS")
    ? "PASS"
    : "REVIEW_REQUIRED";
  merged.generated_at = new Date().toISOString();
  return merged;
}

/**
 * Tailoring Recommendations ONLY — rewrite the summary and relevant bullets,
 * keep the strong content, and (optionally) reorder verified skills.
 *
 * This is an expert content editor, not a document sorter: it never reorders
 * experience entries, titles, companies, dates or bullets, and it never writes
 * the cover letter (that is a separate, independent stage).
 */
export async function runTailoring(session, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  // ---- Recommendations (pass 1) ----
  onProgress({ step: "recommendations:start", label: "Writing tailored recommendations (pass 1)…" });
  await generateRecommendations(session);
  const llmRecs = session.recommendations.filter((r) => !r.deterministic);
  onProgress({ step: "recommendations:audit", label: "Validating recommendations against Resume Memory…" });
  let recAudit =
    llmRecs.length === 0
      ? deterministicOnlyAudit(session.recommendations)
      : await auditContent(session, {
          content: recommendationsToAuditText(llmRecs),
          validateText: recommendationsToValidateText(llmRecs),
          label: "recommendations",
        });

  if (recAudit.overall !== "PASS") {
    await generateRecommendations(session, { violations: buildViolationNote(recAudit) });
    const llmRecs2 = session.recommendations.filter((r) => !r.deterministic);
    recAudit =
      llmRecs2.length === 0
        ? deterministicOnlyAudit(session.recommendations)
        : await auditContent(session, {
            content: recommendationsToAuditText(llmRecs2),
            validateText: recommendationsToValidateText(llmRecs2),
            label: "recommendations:final",
          });
  }

  // Enforce evidence on recommendations (fail closed at the data level).
  const db = new TruthDatabase(session.truth_db || []);
  for (const rec of session.recommendations) {
    const validation = validateClaims(
      [{ claim: rec.recommended_text || rec.current_text, evidence_ids: rec.evidence_ids }],
      db
    )[0];
    rec.claim_allowed = validation.allowed;
    rec.claim_problems = validation.problems;
  }

  session.audit = mergeAudit(session.audit, { recommendations: recAudit });
  session.stage = session.recommendations?.length ? "recommendations_ready" : "recommendations_ready";
  onProgress({ step: "done", label: "Tailoring plan saved." });
  return session;
}

/**
 * Cover letter generation — completely independent of tailoring. Uses the JD,
 * the JD analysis, Resume Memory, and the strongest matching evidence, and
 * produces its own letter with its own validation cycle.
 */
export async function runCoverLetter(session, options = {}) {
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};

  onProgress({ step: "cover:start", label: "Writing cover letter…" });
  let cover = await generateCoverLetter(session);
  onProgress({ step: "cover:audit", label: "Validating cover letter against Resume Memory…" });
  let coverAudit = await auditContent(session, {
    content: cover.letter,
    label: "cover-letter:pass1",
  });

  const needsRetry =
    coverAudit.overall !== "PASS" ||
    cover.unsupported_claims.length > 0 ||
    cover.deterministic_issues.length > 0;

  if (needsRetry) {
    const notes = [buildViolationNote(coverAudit)];
    for (const u of cover.unsupported_claims) {
      notes.push(`- UNSUPPORTED CLAIM: "${u.claim}" (${u.problems.join(" ")})`);
    }
    for (const d of cover.deterministic_issues) notes.push(`- ${d}`);
    cover = await generateCoverLetter(session, { violations: notes.filter(Boolean).join("\n") });
    coverAudit = await auditContent(session, {
      content: cover.letter,
      label: "cover-letter:final",
    });
  }

  // Deterministic issues are a hard fail regardless of the model's audit.
  if (cover.deterministic_issues.length > 0 && coverAudit.overall === "PASS") {
    coverAudit.overall = "REVIEW_REQUIRED";
    coverAudit.guard_hard_failures = [
      ...(coverAudit.guard_hard_failures || []),
      ...cover.deterministic_issues.map((m) => ({ type: "PLACEHOLDER", message: m })),
    ];
  }

  // ---- Deterministic enforcement (final safety net) ----
  const db = new TruthDatabase(session.truth_db || []);
  const enforcement = stripUnsupportedClaims(cover.letter, db.all(), {
    sensitiveVocab: buildSensitiveVocabulary(session.jd || {}),
    allowedTerms: [session.jd?.job_title, session.jd?.company].filter(Boolean),
  });
  if (enforcement.removed.length > 0) {
    cover.letter = enforcement.text;
    cover.enforcement = { removed: enforcement.removed };
    const removedTerms = enforcement.removed.map((r) => r.term.toLowerCase());
    coverAudit.items = (coverAudit.items || []).filter(
      (i) => !removedTerms.some((term) => String(i.claim || "").toLowerCase().includes(term))
    );
    coverAudit.guard_hard_failures = enforcement.remainingHardFailures;
    coverAudit.guard_soft_warnings = enforcement.softWarnings;
    coverAudit.overall =
      enforcement.remainingHardFailures.length > 0 || enforcement.softWarnings.length > 0
        ? "REVIEW_REQUIRED"
        : "PASS";
    coverAudit.summary = [
      coverAudit.summary,
      `Deterministic enforcement removed ${enforcement.removed.length} unsupported mention(s): ${enforcement.removed
        .map((r) => `"${r.term}"`)
        .join(", ")}.`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  session.cover_letter = {
    ...cover,
    audit: coverAudit,
  };
  session.audit = mergeAudit(session.audit, { cover_letter: coverAudit });
  session.stage = "cover_ready";
  onProgress({ step: "done", label: "Cover letter saved." });
  return session;
}