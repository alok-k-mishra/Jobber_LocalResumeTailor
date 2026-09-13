import { generateJson } from "../llm/client.js";
import { recommendationResultSchema, summaryRewriteSchema } from "../schemas/index.js";
import { TruthDatabase } from "../core/truthdb.js";
import {
  semanticTruthGuard,
  buildSensitiveVocabulary,
} from "../core/claims.js";
import { tokenize, scoreFacts } from "../core/retrieval.js";
import { formatRecommendationLessons } from "../core/learning.js";
import {
  formatRequirements,
  formatMatches,
  formatMemoryContext,
  formatResumeBullets,
  entryDisplayLabel,
} from "./format.js";

const MAX_RECOMMENDATIONS = 8;

/* Tailoring is about CONTENT. Every actionable outcome must be grounded in
   verified evidence. Rewriting needs evidence; KEEP (leave as-is) and the
   optional REORDER_SKILL never alter anything, so they do not. */
const EVIDENCE_REQUIRED_ACTIONS = ["REWRITE_SUMMARY", "REWRITE_BULLET"];

const SKILL_SECTION_RE = /skill|competenc/i;
const BULLET_SECTION_RE = /experience|project|internship|employment|activity|leadership/i;
const SUMMARY_SECTION_RE = /summar/i;

// Resume metadata (entry headers, company names, titles, dates, locations) is
// NOT tailoring content. Only bullets/lines are candidates for rewriting.
function isContentFact(f) {
  const t = f?.item_type || "bullet";
  return t !== "entry_header" && t !== "skill";
}

// Legacy actions users may have persisted in older sessions. They map onto the
// content-only taxonomy. Reordering of any resume material is deliberately not
// a tailoring action any more; the only reorder that may surface is the
// deterministic, optional REORDER_SKILL (computed in code, never by the model).
function normalizeAction(action, section = "") {
  switch (action) {
    case "KEEP":
    case "REWRITE_SUMMARY":
    case "REWRITE_BULLET":
      return action;
    case "REWRITE":
    case "REPLACE":
      return SUMMARY_SECTION_RE.test(section) ? "REWRITE_SUMMARY" : "REWRITE_BULLET";
    case "REORDER_SKILL":
      return "REORDER_SKILL";
    case "DE_EMPHASIZE":
    case "REMOVE":
    case "OPTIONAL_ADD":
    case "CONFIRM_FIRST":
    case "REORDER_BULLET":
    case "REORDER_PROJECT":
    case "REORDER_EXPERIENCE":
    case "EMPHASIZE":
    case "REORDER":
    default:
      // Non-destructive: content is never removed, and tailoring no longer
      // shuffles resumes. Such suggestions collapse to KEEP.
      return "KEEP";
  }
}

function monthName(m) {
  return { Jan: "Jan", Feb: "Feb", Mar: "Mar", Apr: "Apr", May: "May", Jun: "Jun",
    Jul: "Jul", Aug: "Aug", Sep: "Sep", Oct: "Oct", Nov: "Nov", Dec: "Dec" }[m] || "";
}

function dateRange(f) {
  if (!f) return "";
  const start = `${monthName(f.start_month)}${f.start_year ? " " + f.start_year : ""}`.trim();
  const end = f.is_present
    ? "Present"
    : `${monthName(f.end_month)}${f.end_year ? " " + f.end_year : ""}`.trim();
  if (start && end) return `${start} – ${end}`;
  return start || end;
}

// Human label and stable key for the resume entry a recommendation belongs to,
// filled deterministically so the UI can group experience/projects per entry.
// The entry header (role · company · dates) is treated as metadata: it labels
// the group but is never itself a tailoring candidate.
function entryMetaOf(facts) {
  const header = facts.find((f) => f?.item_type === "entry_header");
  const f = facts.find((r) => r) || {};
  const section = f.section || "";
  let label = "";
  if (header) {
    label = entryDisplayLabel(header) || header.original_text || "";
  } else if (SUMMARY_SECTION_RE.test(section)) {
    label = "Summary";
  } else if (SKILL_SECTION_RE.test(section)) {
    label = "Skills";
  } else if (/project/i.test(section)) {
    label = f.entity || "Project";
  } else {
    const role = f.role || "";
    const company = f.company || "";
    const roleLine = role && company ? `${role} — ${company}` : role || company || "";
    label = [roleLine, dateRange(f)].filter(Boolean).join(" · ");
    if (!label && f.entity) label = f.entity;
    if (!label) label = section || "Entry";
  }
  const key = f.group_id || `${section}:${f.entity}:${f.role}:${f.company}`;
  return { entry_label: label, entry_key: key || f.evidence_id, section_label: section };
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

/**
 * Bind a recommendation to real resume evidence by token overlap. The reasoning
 * model is not trusted to emit reliable evidence IDs.
 */
function bindEvidence(rec, resumeFacts) {
  const target = tokenize(`${rec.current_text || ""} ${rec.reason || ""}`);
  if (!target.size) return null;
  let best = null;
  let bestScore = 0;
  for (const f of resumeFacts) {
    if (!isContentFact(f)) continue;
    const toks = new Set(
      tokenize(`${f.original_text} ${f.normalized_claim} ${f.entity}`)
    );
    let score = 0;
    for (const t of target) if (toks.has(t)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return bestScore >= 2 ? best : null;
}

/**
 * Validate one model recommendation against the resumed evidence and the
 * semantic truth guard.
 *
 *  - KEEP never alters anything, so it is always acceptable.
 *  - REWRITE_* must be grounded in verified evidence and must pass the semantic
 *    guard. If it does not, the proposal is discarded internally: it becomes a
 *    KEEP (the resume stays exactly as the candidate wrote it) and the failure
 *    is recorded only for the internal audit, never shown to the user.
 */
export function validateRecommendation(rec, db, reqIds, resumeFacts, sensitiveVocab, allowedTerms) {
  const problems = [];
  const provided = (rec.evidence_ids || []).filter((id) => db.hasUsable([id]));
  const bound = provided.length ? null : bindEvidence(rec, resumeFacts);
  const evidenceIds = uniq([...provided, ...(bound ? [bound.evidence_id] : [])]);
  const evidenceRecords = evidenceIds.map((id) => db.get(id)).filter(Boolean);
  const primary = bound || evidenceRecords[0];

  if (primary?.original_text) rec.current_text = primary.original_text;
  rec.action = normalizeAction(rec.action, rec.section || "");

  // Keep REWRITE_SUMMARY / REWRITE_BULLET aligned with the section they target
  // (the model may pick the wrong variant for a summary line or a bullet).
  if (rec.action === "REWRITE_BULLET" && SUMMARY_SECTION_RE.test(rec.section || "")) {
    rec.action = "REWRITE_SUMMARY";
  } else if (
    rec.action === "REWRITE_SUMMARY" &&
    primary &&
    isContentFact(primary) &&
    !SUMMARY_SECTION_RE.test(rec.section || "")
  ) {
    rec.action = "REWRITE_BULLET";
  }

  // Structural guard (spec §10): a rewrite must target a bullet/line, never an
  // entry header, company name, title, date or skill entry. Metadata stays
  // structurally attached to its entry; it is not rewrite material.
  if (rec.action === "REWRITE_BULLET" && primary && !isContentFact(primary)) {
    problems.push(
      "The proposal targets a resume header or skill entry. Only experience/project bullet wording may be rewritten, so it stays unchanged."
    );
    rec.action = "KEEP";
    rec.recommended_text = "";
  }

  let guardWarnings = [];
  const isRewrite = rec.recommended_text && rec.recommended_text !== rec.current_text;
  if (isRewrite && evidenceRecords.length) {
    guardWarnings = semanticTruthGuard(rec.recommended_text, evidenceRecords, {
      sensitiveVocab,
      allowedTerms,
    });
  }

  if (guardWarnings.length > 0) {
    rec.rejected_recommended_text = rec.recommended_text;
    rec.recommended_text = rec.current_text || "";
    problems.push(
      "The proposed rewrite was rejected because it exceeded the supporting evidence: " +
        guardWarnings.map((w) => w.message).join(" ")
    );
  }

  if (EVIDENCE_REQUIRED_ACTIONS.includes(rec.action) && evidenceIds.length === 0) {
    // No verified evidence, so nothing can be tailored. The non-destructive
    // fallback is to keep the existing content exactly as it is.
    problems.push("No verified evidence supports this change, so the content stays unchanged.");
    rec.action = "KEEP";
    rec.recommended_text = "";
  }

  // KEEP is always acceptable (it never alters the resume), so a suggestion
  // that collapsed to KEEP remains allowed even with a note on record.
  const allowed = problems.length === 0 || rec.action === "KEEP";

  return {
    ...rec,
    ...entryMetaOf(evidenceRecords),
    evidence_ids: evidenceIds,
    rejected_evidence_ids: (rec.evidence_ids || []).filter(
      (id) => !evidenceIds.includes(id)
    ),
    jd_requirement_ids: (rec.jd_requirement_ids || []).filter((id) => reqIds.has(id)),
    problems,
    guard_warnings: guardWarnings,
    allowed,
    deterministic: false,
  };
}

/**
 * Deterministic, always-truthful recommendations:
 *   - OPTIONAL skill ordering (reorder existing verified skills only);
 *   - KEEP for the strongest bullets that already align with the JD.
 * It never rewrites wording and never reorders experience/project entries,
 * titles, companies, dates or bullets. Resume structure is untouched.
 */
export function buildDeterministicRecommendations(session, db, scores) {
  const reqIds = new Set(session.jd.requirements.map((r) => r.requirement_id));
  const reqText = new Map(session.jd.requirements.map((r) => [r.requirement_id, r.text]));
  const resumeFacts = db.all().filter((r) => r.source_type === "resume");
  const recs = [];

  const scoreOf = (f) => scores.get(f.evidence_id)?.score || 0;
  const reqsOf = (f) =>
    (scores.get(f.evidence_id)?.requirement_ids || []).filter((id) => reqIds.has(id));

  // ---- Optional skill ordering (only reorders existing verified skills) ----
  const skillFacts = resumeFacts.filter(
    (f) => SKILL_SECTION_RE.test(f.section || "") && f.item_type === "skill"
  );
  if (skillFacts.length >= 2) {
    const ordered = [...skillFacts].sort((a, b) => scoreOf(b) - scoreOf(a));
    const changed = ordered.some((f, i) => f.evidence_id !== skillFacts[i].evidence_id);
    if (changed) {
      recs.push({
        recommendation_id: "",
        section: skillFacts[0].section,
        action: "REORDER_SKILL",
        priority: 5,
        current_text: skillFacts.map((f) => f.original_text).join("\n"),
        recommended_text: ordered.map((f) => f.original_text).join("\n"),
        reason:
          "Optional: surface the verified skills most relevant to this JD first. Skills are never added, removed or renamed — only the order changes, and you can ignore this.",
        evidence_ids: skillFacts.map((f) => f.evidence_id),
        jd_requirement_ids: uniq(ordered.flatMap(reqsOf)),
        confidence: 1,
        problems: [],
        guard_warnings: [],
        allowed: true,
        deterministic: true,
        optional: true,
        ...entryMetaOf(skillFacts),
      });
    }
  }

  // ---- Keep unchanged: bullets that already provide strong verified evidence ----
  const alignedBullets = resumeFacts
    .filter((f) => BULLET_SECTION_RE.test(f.section || "") && isContentFact(f))
    .filter((f) => scoreOf(f) > 0)
    .sort((a, b) => scoreOf(b) - scoreOf(a) || reqsOf(b).length - reqsOf(a).length)
    .slice(0, 4);

  const needText = (id) => {
    const t = reqText.get(id) || "";
    return t.length > 90 ? t.slice(0, 90) + "…" : t;
  };

  for (const f of alignedBullets) {
    const reqs = reqsOf(f);
    recs.push({
      recommendation_id: "",
      section: f.section || "",
      action: "KEEP",
      priority: 6,
      current_text: f.original_text,
      recommended_text: f.original_text,
      reason:
        (reqs.length
          ? `Already provides strong verified evidence for ` +
            reqs.map(needText).join("; ") +
            ". "
          : "") +
        "The wording is left exactly as written to keep the resume truthful for this JD.",
      evidence_ids: [f.evidence_id],
      jd_requirement_ids: reqs,
      confidence: 1,
      problems: [],
      guard_warnings: [],
      allowed: true,
      deterministic: true,
      ...entryMetaOf([f]),
    });
  }

  return recs;
}

export function mergeRecommendations(llmRecs, detRecs) {
  // From the LLM keep only genuine, grounded rewrites of the summary or a
  // bullet. KEEP and any optional ordering are owned by the deterministic pass.
  const llmKeep = llmRecs.filter(
    (r) => r.allowed && ["REWRITE_SUMMARY", "REWRITE_BULLET"].includes(r.action)
  );
  const all = [...llmKeep, ...detRecs];

  const seen = new Set();
  const out = [];
  for (const r of all) {
    const key = `${r.action}:${[...(r.evidence_ids || [])].sort().join(",")}:${(
      r.recommended_text || ""
    ).slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }

  // Content first: summary rewrites, then experience, then project bullet
  // rewrites, then the optional skill ordering, then keep-unchanged. Never
  // reorders anything on the resume.
  const rank = { REWRITE_SUMMARY: 0, REWRITE_BULLET: 1, REORDER_SKILL: 2, KEEP: 3 };
  const sectionOrder = (r) => {
    const s = `${r.section || ""} ${r.section_label || ""}`;
    if (SUMMARY_SECTION_RE.test(s)) return 0;
    if (SKILL_SECTION_RE.test(s)) return 3;
    if (/project/i.test(s)) return 2;
    if (BULLET_SECTION_RE.test(s)) return 1;
    return 4;
  };
  out.sort((a, b) => {
    const sa = sectionOrder(a);
    const sb = sectionOrder(b);
    if (sa !== sb) return sa - sb;
    const ra = rank[a.action] ?? 9;
    const rb = rank[b.action] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.priority || 99) - (b.priority || 99);
  });
  return out
    .slice(0, MAX_RECOMMENDATIONS)
    .map((r, i) => ({ ...r, recommendation_id: `REC-${String(i + 1).padStart(3, "0")}` }));
}

export async function generateRecommendations(
  session,
  { violations = "", model: modelOverride } = {}
) {
  if (!session.jd?.requirements?.length) {
    throw new Error("Job description must be analyzed before recommendations.");
  }
  const db = new TruthDatabase(session.truth_db || []);
  const reqIds = new Set(session.jd.requirements.map((r) => r.requirement_id));
  const resumeFacts = db.all().filter((r) => r.source_type === "resume");
  const sensitiveVocab = buildSensitiveVocabulary(session.jd);
  const allowedTerms = [session.jd.job_title, session.jd.company];

  let truthContext = formatMemoryContext(db.all()) || "(empty)";
  if (violations) {
    truthContext +=
      "\n\nCRITICAL CORRECTIONS FROM THE PREVIOUS AUDIT — you MUST NOT repeat these violations:\n" +
      violations +
      "\nOnly make recommendations fully supported by the evidence at its exact scope.";
  }

  const { data, model } = await generateJson({
    task: "reasoning",
    promptName: "recommendation-generation",
    vars: {
      max_recommendations: 5,
      requirements: formatRequirements(session.jd.requirements),
      matches: formatMatches(session.matches),
      truth_db: truthContext,
      resume_bullets: formatResumeBullets(resumeFacts),
      learned_examples: formatRecommendationLessons(session.jd.job_title, 2),
    },
    schema: recommendationResultSchema,
    model: modelOverride,
    label: "recommendation-generation",
    maxTokens: 2200,
  });

  session.tailoring_strategy = (data.strategy || "").trim();

  const llmRecs = (data.recommendations || [])
    .slice(0, 5)
    .map((rec, i) => ({
      ...rec,
      recommendation_id: `LLM-${String(i + 1).padStart(3, "0")}`,
    }))
    .map((rec) =>
      validateRecommendation(rec, db, reqIds, resumeFacts, sensitiveVocab, allowedTerms)
    );

  const scores = scoreFacts(session.jd.requirements, db.all());
  const detRecs = buildDeterministicRecommendations(session, db, scores);

  session.rejected_rewrites = llmRecs
    .filter((r) => r.rejected_recommended_text)
    .map((r) => ({
      section: r.section,
      proposed: r.rejected_recommended_text,
      reason: r.problems.join(" "),
    }));

  session.recommendations = mergeRecommendations(llmRecs, detRecs);
  await ensureSummaryRecommendation(
    session,
    db,
    reqIds,
    resumeFacts,
    sensitiveVocab,
    allowedTerms
  );
  session.recommendation_model = model;
  session.stage = "recommendations_ready";
  return session;
}

/**
 * Guarantee that the tailoring plan always includes a Summary rewrite (the
 * Summary is the primary keyword-placement surface for ATS screening). If the
 * main pass produced no REWRITE_SUMMARY, this runs one small focused rewrite of
 * the existing Summary and routes it through the same evidence validation and
 * fail-closed guards as every other recommendation.
 */
async function ensureSummaryRecommendation(
  session,
  db,
  reqIds,
  resumeFacts,
  sensitiveVocab,
  allowedTerms
) {
  if (session.recommendations.some((r) => r.action === "REWRITE_SUMMARY")) return;

  const summaryFacts = resumeFacts.filter(
    (f) => SUMMARY_SECTION_RE.test(f.section || "") && isContentFact(f)
  );
  const primary = summaryFacts[0];
  if (!primary) return;

  const cited = new Map();
  for (const m of session.matches || []) {
    for (const id of m.evidence_ids || []) cited.set(id, (cited.get(id) || 0) + 1);
  }
  const topRecords = [...cited.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id]) => db.get(id))
    .filter(Boolean);

  try {
    const { data } = await generateJson({
      task: "reasoning",
      promptName: "summary-rewrite",
      vars: {
        job_title: session.jd.job_title || "",
        company: session.jd.company || "",
        requirements: formatRequirements(session.jd.requirements.slice(0, 8)),
        matches: formatMatches(session.matches),
        current_summary: primary.original_text || primary.normalized_claim || "",
        truth_db: formatMemoryContext([primary, ...topRecords]),
      },
      schema: summaryRewriteSchema,
      label: "summary-rewrite",
      maxTokens: 400,
    });

    const rec = validateRecommendation(
      {
        action: "REWRITE_SUMMARY",
        section: primary.section,
        current_text: primary.original_text || primary.normalized_claim || "",
        recommended_text: data.rewritten_summary,
        reason: data.reason || "Reworded to lead with this job's keywords and strongest verified evidence.",
        evidence_ids: data.evidence_ids || [],
        jd_requirement_ids: [],
        priority: 1,
        confidence: data.confidence ?? 0.8,
      },
      db,
      reqIds,
      resumeFacts,
      sensitiveVocab,
      allowedTerms
    );

    if (rec.action === "REWRITE_SUMMARY" && rec.allowed && rec.recommended_text) {
      session.recommendations = mergeRecommendations([rec], session.recommendations);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[recommendations] summary rewrite failed for ${session.id}: ${err.message}`);
  }
}