import { generateJson } from "../llm/client.js";
import {
  matchVerdictResultSchema,
  USABLE_EVIDENCE_STATUS,
  MATCH_WEIGHTS,
  STATUS_WEIGHT,
} from "../schemas/index.js";
import { TruthDatabase } from "../core/truthdb.js";
import {
  buildRetrieval,
  formatCandidates,
  educationCompletion,
  educationLevelOf,
  educationLevelOfRequirement,
} from "../core/retrieval.js";
import { formatCompactMemoryContext } from "./format.js";
import { formatMatchingLessons } from "../core/learning.js";

/* Statuses that must be backed by citable, usable evidence. */
const EVIDENCE_REQUIRED_STATUSES = ["MATCHED", "PARTIAL"];

/* Deterministic skill-level ranking. */
const LEVEL_RANK = { LISTED: 1, USED: 2, PROJECT: 3, PROFESSIONAL: 4, ADVANCED: 5 };
const BY_LEVEL_RANK = Object.fromEntries(Object.entries(LEVEL_RANK).map(([k, v]) => [v, k]));

const RANK = {
  NOT_MATCHED: 0,
  UNKNOWN: 1,
  PARTIAL: 2,
  MATCHED: 3,
};
const BY_RANK = Object.fromEntries(Object.entries(RANK).map(([k, v]) => [v, k]));

/* Concrete, verifyable technical categories. A skills-list row in one of these
   is a knowledge claim, not evidence of applied use. */
const TECHNICAL_CATEGORIES = new Set([
  "technical_skill",
  "tool",
  "programming",
  "programming_language",
  "framework",
  "database",
  "cloud",
  "analytics_tool",
  "business_tool",
  "certification",
]);

/* Behavioural / soft categories: judge on evidence, never auto-PARTIAL, and
   prefer UNKNOWN when there is nothing to judge. */
const SOFT_CATEGORIES = new Set([
  "soft_skill",
  "communication",
  "collaboration",
  "teamwork",
  "leadership",
  "analytical",
]);

export { SOFT_CATEGORIES };

/* Only-the-candidate conditions: never decide NOT_MATCHED from a resume. */
const PERSONAL_CATEGORIES = new Set([
  "personal_constraint",
  "location",
  "work_authorization",
]);

/* Named tools that a LinkedIn-style analysis watches for. If the JD names one
   of these and the evidence never mentions it, the match is capped to PARTIAL
   regardless of other overlap (the candidate may have a related skill, but the
   named product/capability itself is not established). */
const NAMED_TOOLS = new Set([
  "salesforce", "crm",
  "tableau", "power bi", "looker",
  "pandas", "numpy", "scipy", "scikit-learn",
  "tensorflow", "pytorch",
  "spark", "hadoop", "kafka",
  "docker", "kubernetes",
  "aws", "azure", "gcp",
  "snowflake", "bigquery", "redshift",
  "airflow", "dbt",
  "excel", "google sheets",
  "powerpoint", "google slides",
  "sql", "nosql", "postgresql", "mysql", "mongodb",
  "javascript", "typescript", "python", "java",
  "react", "angular", "vue", "node.js",
  "etl", "figma", "jira", "git",
]);

function normalizeTool(t) {
  return String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function findNamedTools(text) {
  const lower = String(text || "").toLowerCase();
  const found = [];
  for (const tool of NAMED_TOOLS) {
    if (lower.includes(tool)) found.push(tool);
  }
  return found;
}

/**
 * The concrete, named things a requirement is about. Prefers the structured
 * `tools` list produced by Qwen; falls back to deterministic detection when the
 * requirement carries no list (old sessions, manual edits).
 */
export function requirementTools(requirement) {
  const structured = (requirement?.tools || []).map(normalizeTool).filter(Boolean);
  if (structured.length) return [...new Set(structured)];
  return [...new Set(findNamedTools(`${requirement?.text || ""} ${requirement?.evidence_hint || ""}`))];
}

export function requirementListType(requirement) {
  return requirement?.list_type || "SINGLE";
}

/* Tools actually mentioned by the cited evidence (technologies + detected
   named tools inside the record's own wording). */
function evidenceToolSet(citedRecords) {
  const set = new Set();
  for (const r of citedRecords) {
    for (const tech of r.technologies || []) set.add(normalizeTool(tech));
    for (const t of findNamedTools(`${r.normalized_claim || ""} ${r.original_text || ""}`)) {
      set.add(t);
    }
  }
  return set;
}

/* Words that reveal the evidence is weaker than a strong work-experience match. */
const WEAKENING_RE =
  /\b(basic|basics|beginner|introductory|limited|some|simple|small|few|coursework|course assignment|assignment|class|classroom|academic|college|university|learning|exposure|familiar|personal project|tutorial|practice)\b/i;

function capStatus(status, ceiling) {
  if (!EVIDENCE_REQUIRED_STATUSES.includes(status)) return status;
  return RANK[status] > RANK[ceiling] ? BY_RANK[RANK[ceiling]] : status;
}

function isEducationContext(requirement, citedRecords) {
  return (
    requirement?.category === "education" &&
    citedRecords.length > 0 &&
    citedRecords.every((r) => r.category === "education")
  );
}

function recordEducationLevel(record) {
  const candidate = [
    record?.degree,
    record?.education_type,
    record?.normalized_claim,
    record?.course,
    record?.institution,
  ]
    .filter(Boolean)
    .join(" ");
  return educationLevelOf(candidate);
}

export { recordEducationLevel };

/**
 * Deterministic evidence strength, separate from match status.
 *   DIRECT  - the named thing/tool is explicitly used by a real bullet
 *   STRONG  - closely related demonstrated work (project/experience)
 *   INDIRECT- mentioned/listed but not demonstrated (skills rows, summary)
 *   NONE    - nothing usable cited
 */
function deriveEvidenceStrength(match, citedRecords, requirement) {
  if (!citedRecords.length) return "NONE";
  const tools = requirementTools(requirement);
  const mentionsTool = tools.length
    ? tools.some((t) => evidenceToolSet(citedRecords).has(t))
    : false;
  const cats = citedRecords.map((r) => (r.category || "").toLowerCase());
  const demonstrated = cats.some((c) =>
    ["experience", "internship", "project"].includes(c)
  );
  return demonstrated ? (mentionsTool ? "DIRECT" : "STRONG") : mentionsTool ? "INDIRECT" : "INDIRECT";
}

/**
 * Deterministic strength ceiling. Prevents the reasoning model from turning
 * "basic SQL" into a MATCHED or academic work into professional experience.
 *
 * Education requirements get a different treatment: a degree record's
 * skill_level has no meaning, so education is exempt from the level-based caps,
 * and a completed qualifying degree is promoted out of PARTIAL/UNKNOWN (never
 * label a completed Bachelor's "partial").
 */
function applyCaps(match, citedRecords, requirement) {
  if (!EVIDENCE_REQUIRED_STATUSES.includes(match.status) && match.status !== "UNKNOWN") {
    return match;
  }

  const text = citedRecords
    .map((r) => `${r.original_text} ${r.normalized_claim}`)
    .join(" ");
  const levels = citedRecords.map((r) => r.skill_level);
  const reqText = String(requirement?.text || "").toLowerCase();
  const eduCtx = isEducationContext(requirement, citedRecords);
  let status = match.status;
  const notes = [];

  const capTo = (ceiling, why) => {
    if (RANK[status] > RANK[ceiling]) {
      status = BY_RANK[RANK[ceiling]];
      notes.push(why);
    }
  };

  if (eduCtx) {
    // A completed qualifying degree satisfies a degree requirement as MATCHED.
    // B.Tech == Bachelor's; a B.Tech in CS satisfies a CS-related bachelor's.
    const asked = educationLevelOfRequirement(reqText);
    if (asked && !["diploma", "school"].includes(asked) && !requirementAsksOnlyDiploma(reqText)) {
      const completed = citedRecords.some(
        (r) => educationCompletion(r) === "completed"
      );
      const qualifying = citedRecords.some((r) => recordEducationLevel(r) === asked);
      if (completed && qualifying && status !== "MATCHED") {
        status = "MATCHED";
        notes.push(
          `Promoted to MATCHED by education validation: the JD asks for a ${asked}-level degree and the cited, completed degree-level record (e.g. "${completedDegreeLabel(citedRecords, asked)}") satisfies it.`
        );
      } else if (completed && qualifying) {
        // stays MATCHED — no note needed
      }
      // In-progress degree cannot satisfy the requirement to MATCHED.
      if (status === "MATCHED" && !completed) {
        status = "PARTIAL";
        notes.push("Demoted to PARTIAL: the cited degree is not marked completed.");
      }
    }
    return finalize(match, status, notes);
  }

  // A skills-list row only (knowledge claim) cannot be MATCHED for a technical
  // "proficiency"/"experience" requirement. Project/experience bullets that
  // actually use the technology are real evidence and are NOT demoted here.
  const onlySkillsRows =
    TECHNICAL_CATEGORIES.has(requirement?.category) &&
    citedRecords.length > 0 &&
    citedRecords.every((r) => (r.category || "").toLowerCase() === "skill");
  if (status === "MATCHED" && onlySkillsRows && levels.every((l) => l === "LISTED")) {
    capTo("PARTIAL", "Demoted to PARTIAL: the only cited evidence is a skills-list row, which is a knowledge claim, not applied use.");
  }
  if (
    status === "MATCHED" &&
    TECHNICAL_CATEGORIES.has(requirement?.category) &&
    !onlySkillsRows &&
    WEAKENING_RE.test(text)
  ) {
    capTo("PARTIAL", "Demoted to PARTIAL: the cited evidence is explicitly academic, coursework, or otherwise weaker than the requirement.");
  }

  // The requirement wants professional/job experience, but the cited evidence
  // contains no work entry (only skills lists or personal projects).
  const wantsProfessional =
    requirement?.category === "experience" ||
    /\bprofessional\b|\b\d+\+?\s*years?\b|\byears? of experience\b/.test(reqText);
  const hasWorkRecord = citedRecords.some((r) => {
    const cat = (r.category || "").toLowerCase();
    return cat === "experience" || cat === "internship";
  });
  if (wantsProfessional && !hasWorkRecord && !levels.includes("PROFESSIONAL")) {
    capTo("PARTIAL", "Demoted to PARTIAL: the requirement asks for professional/job experience, but the cited evidence is not from a work entry.");
  }

  // Explicit "N+ years" with no matching duration evidence cannot be MATCHED.
  const yearsMatch = reqText.match(/(\d+)\+?\s*years?/);
  if (yearsMatch) {
    const required = Number(yearsMatch[1]);
    const stated = text.match(/(\d+)\+?\s*years?/);
    const statedYears = stated ? Number(stated[1]) : 0;
    if (statedYears < required) {
      capTo("PARTIAL", "Demoted to PARTIAL: the JD asks for a specific number of years that the cited evidence does not state.");
    }
  }

  // Named-tool gating. If the JD names concrete tools, the evidence must show
  // at least one of them (for alternatives) or all of them (for cumulative).
  // "Tableau, Power BI, or Looker" is satisfied by any one; "Python, Pandas,
  // and NumPy" cumulatively requires all three; "CRM systems (e.g.,
  // Salesforce)" requires one of the named examples — a related project alone
  // is at most a partial for the specific product.
  const reqTools = requirementTools(requirement);
  if (reqTools.length) {
    const evTools = evidenceToolSet(citedRecords);
    const present = reqTools.filter((t) => evTools.has(t));
    const listType = requirementListType(requirement);
    const demandedKind = ["CUMULATIVE"].includes(listType) ? "all" : "any";
    const satisfied = listType === "CUMULATIVE" ? present.length === reqTools.length : present.length > 0;
    if (!satisfied) {
      capTo(
        "PARTIAL",
        `Demoted to PARTIAL: the JD names tool(s) [${reqTools.join(", ")}], but the cited evidence does not mention ${
          demandedKind === "all" ? "all of them" : "any of them"
        }. A related skill alone does not establish the named product/capability.`
      );
    }
  }

  // Deterministic matched_skill_level cap: never claim a level above the
  // strongest level among the cited records.
  if (match.matched_skill_level && levels.length) {
    const maxCitedRank = Math.max(...levels.map((l) => LEVEL_RANK[l] || 0));
    const claimedRank = LEVEL_RANK[match.matched_skill_level] || 0;
    if (maxCitedRank && claimedRank > maxCitedRank) {
      match.matched_skill_level = BY_LEVEL_RANK[maxCitedRank];
    }
  }

  return finalize(match, status, notes);
}

function requirementAsksOnlyDiploma(reqText) {
  return /\bdiploma\b/.test(reqText) && !/\b(bachelor|b\.?\s?tech|degree|graduation)\b/.test(reqText);
}

function completedDegreeLabel(citedRecords, level) {
  for (const r of citedRecords) {
    const candidate = [r.degree, r.education_type, r.normalized_claim]
      .filter(Boolean)
      .join(" ");
    if (educationLevelOf(candidate) === level) {
      return (r.normalized_claim || r.original_text || r.degree || "").replace(/\s+/g, " ").trim();
    }
  }
  return "degree";
}

function finalize(match, status, notes) {
  if (notes.length > 0) {
    match.explanation = `${match.explanation || match.reason || ""} [${notes.join(" ")}]`.trim();
  }
  match.status = status;
  return match;
}

/**
 * Fail-closed sanitization: a match that claims evidence must cite existing,
 * usable evidence that was actually offered as a candidate for that
 * requirement. The quoted "evidence" and the "source" path are taken from the
 * real memory records, never from the model's paraphrase. Otherwise it is
 * downgraded to NOT_MATCHED.
 */
export function sanitizeMatch(match, db, candidateIds, requirement) {
  const cited = Array.isArray(match.evidence_ids) ? match.evidence_ids : [];
  const usable = cited.filter((id) => {
    if (candidateIds && !candidateIds.has(id)) return false;
    const rec = db.get(id);
    return rec && USABLE_EVIDENCE_STATUS.includes(rec.status);
  });
  const usableRecords = usable.map((id) => db.get(id)).filter(Boolean);

  const clean = (s) => String(s || "").trim();
  let status = match.status;
  let explanation = clean(match.explanation || match.reason);
  const notes = [];

  if (EVIDENCE_REQUIRED_STATUSES.includes(status) && usableRecords.length === 0) {
    status = "NOT_MATCHED";
    notes.push(
      "Downgraded to NOT_MATCHED by evidence validation: no usable VERIFIED/USER_CONFIRMED candidate evidence was cited."
    );
  }

  const base = {
    requirement_id: match.requirement_id,
    status,
    evidence_ids: [], // re-filled below
    evidence: "",
    source: "",
    explanation: explanation || "No evidence.",
    confidence:
      typeof match.confidence === "number"
        ? Math.min(1, Math.max(0.5, match.confidence))
        : 0.8,
    matched_skill_level: undefined,
    evidence_strength: "NONE",
    rejected_evidence_ids: cited.filter((id) => !usable.includes(id)),
  };

  if (status === "NOT_MATCHED" || status === "UNKNOWN") {
    base.explanation = notes.length
      ? (explanation ? `${explanation} [${notes.join(" ")}]` : notes[0])
      : explanation;
    base.evidence_strength = "NONE";
    return base;
  }

  const primary = usableRecords[0];
  const primarySource = clean(primary?.source_location) || match.source || "";
  const source =
    primarySource &&
    primary?.entity &&
    !primarySource.toLowerCase().includes(String(primary.entity).toLowerCase().slice(0, 24))
      ? `${primarySource} > ${clean(primary.entity)}`
      : primarySource;

  let result = {
    ...base,
    evidence_ids: usable,
    evidence: clean(primary?.original_text || primary?.normalized_claim) || match.evidence,
    source,
    matched_skill_level: match.matched_skill_level,
  };
  if (!result.explanation) result.explanation = "The cited Resume Memory evidence supports this requirement.";

  result = applyCaps(result, usableRecords, requirement);
  result.evidence_strength = deriveEvidenceStrength(result, usableRecords, requirement);
  return result;
}

/* Generic / behavioural requirement language that must never be treated as a
   hard, literal qualification. Used only for fallback status decisions. */
export const GENERIC_SOFT_RE =
  /\b(problem[\s-]?solving|analytical|quantitative|attention to detail|communication skills|interpersonal|teamwork|team player|collaborat|leadership|self[- ]motivat|adaptab|fast[- ]learner|enthusias|proactive|ownership|multi[- ]task|time management|stakeholder|presentation skills|willing\b|passion(?:ate)? for)\b/i;

function isSoftOrPersonalRequirement(req) {
  return (
    SOFT_CATEGORIES.has(req?.category) ||
    PERSONAL_CATEGORIES.has(req?.category) ||
    GENERIC_SOFT_RE.test(`${req?.text || ""} ${req?.evidence_hint || ""}`)
  );
}

/**
 * Deterministic baseline when the reasoning model returns no verdict for a
 * requirement:
 *   - retrievable candidates but no verdict -> UNKNOWN (the resume can
 *     arguably hold evidence, but nothing was decided);
 *   - nothing retrievable + soft/personal condition -> UNKNOWN (a resume can
 *     never decide these; a question resolves them);
 *   - nothing retrievable + concrete qualification -> a genuine NOT_MATCHED.
 */
export function missingMatchFor(requirement, hasCandidates) {
  const soft = isSoftOrPersonalRequirement(requirement);
  const status = hasCandidates ? "UNKNOWN" : soft ? "UNKNOWN" : "NOT_MATCHED";
  return {
    requirement_id: requirement?.requirement_id,
    status,
    evidence_ids: [],
    evidence: "",
    source: "",
    explanation: hasCandidates
      ? "The matcher did not return a result for this requirement."
      : soft
        ? "Resume Memory contains no evidence that can decide this condition."
        : "No candidate evidence exists for this requirement.",
    confidence: 0.5,
    matched_skill_level: undefined,
    evidence_strength: "NONE",
    rejected_evidence_ids: [],
  };
}

/**
 * Deterministic weighted match score. Reproducible from requirement importance
 * weights, category significance and match statuses alone:
 *   MATCHED = 1, PARTIAL = 0.5, NOT_MATCHED = 0, UNKNOWN = 0 (reported apart).
 * Soft/behavioural categories carry a lower significance so a pile of fluffy
 * "great communication / attention to detail" requirements cannot dwarf the
 * concrete technical qualifications. Percent is always computed in code.
 */
export function overallScoreWeight(requirement) {
  const base = MATCH_WEIGHTS[requirement?.importance] || 1;
  const significance = SOFT_CATEGORIES.has(requirement?.category) ? 0.6 : 1;
  return base * significance;
}

export function computeMatchScore(requirements = [], matches = []) {
  const byReq = new Map(matches.map((m) => [m.requirement_id, m]));
  let satisfied = 0;
  let total = 0;
  let matched = 0;
  let partial = 0;
  let notMatched = 0;
  let unknown = 0;

  for (const req of requirements || []) {
    const weight = overallScoreWeight(req);
    total += weight;
    const status = legacyStatusKey(byReq.get(req?.requirement_id)?.status);
    if (status === "MATCHED") {
      satisfied += weight * STATUS_WEIGHT.MATCHED;
      matched += 1;
    } else if (status === "PARTIAL") {
      satisfied += weight * STATUS_WEIGHT.PARTIAL;
      partial += 1;
    } else if (status === "NOT_MATCHED") {
      notMatched += 1;
    } else {
      unknown += 1;
    }
  }

  const round = (n) => Math.round(n * 100) / 100;
  const percent = total > 0 ? Math.round((satisfied * 100) / total) : 0;
  return {
    percent,
    satisfied: round(satisfied),
    total: round(total),
    matched,
    partial,
    not_matched: notMatched,
    unknown,
    label: overallLabel(percent),
  };
}

/* LinkedIn-style headline label derived from the deterministic percent. */
export function overallLabel(percent) {
  if (percent >= 85) return "Strong Match";
  if (percent >= 70) return "Good Match";
  if (percent >= 55) return "Moderate Match";
  if (percent >= 40) return "Weak Match";
  return "Low Match";
}

/* A short, deterministic summary label for a requirement, e.g. the tools when
   they are named, otherwise the requirement text trimmed. */
export function summarizeRequirement(req, maxLen = 46) {
  if ((req?.tools || []).length) {
    return req.tools.join(" / ");
  }
  if (req?.category === "education" && educationLevelOfRequirement(req?.text)) {
    const level = educationLevelOfRequirement(req?.text);
    const cap = level.charAt(0).toUpperCase() + level.slice(1);
    return `${cap}'s degree`;
  }
  const t = String(req?.text || "")
    .replace(/^[^a-z0-9]+/i, "")
    .trim();
  return t.length > maxLen ? `${t.slice(0, maxLen).trim()}…` : t;
}

const STATUS_ORDER = { MATCHED: 0, PARTIAL: 1, NOT_MATCHED: 2, UNKNOWN: 3 };

export function legacyStatusKey(status) {
  if (!status) return "UNKNOWN";
  const map = {
    STRONG_MATCH: "MATCHED",
    PARTIAL_MATCH: "PARTIAL",
    WEAK_MATCH: "PARTIAL",
    NO_EVIDENCE: "NOT_MATCHED",
    CONTRADICTED: "NOT_MATCHED",
  };
  return map[status] || status;
}

/**
 * Deterministic overview that leads the UI: an aggressive-but-fair headline
 * (label + percent) plus concise, evidence-backed strengths / partials / gaps /
 * uncertain / open questions. Nothing here is free text from the model — every
 * item maps back to a sanitized requirement verdict.
 */
export function buildMatchOverview(session, { maxGroup = 5 } = {}) {
  const reqs = session?.jd?.requirements || [];
  const matches = session?.matches || [];
  const byReq = new Map(matches.map((m) => [m.requirement_id, m]));
  const score = computeMatchScore(reqs, matches);

  const groups = { MATCHED: [], PARTIAL: [], NOT_MATCHED: [], UNKNOWN: [] };
  for (const req of reqs) {
    const m = byReq.get(req.requirement_id) || {};
    const key = legacyStatusKey(m.status);
    if (!(key in groups)) continue;
    groups[key].push({ req, m });
  }
  const byWeight = (a, b) => overallScoreWeight(b.req) - overallScoreWeight(a.req);
  for (const key of Object.keys(groups)) groups[key].sort(byWeight);

  const cap = (arr) => arr.slice(0, maxGroup);
  const openQuestions = (session?.questions || []).filter((q) => !q.answered);

  // "Main gap" leads the recommendation copy: the highest-importance
  // NOT_MATCHED requirement (or, failing that, the highest-importance UNKNOWN
  // one — an "area to confirm" rather than a declared gap).
  const topGap = groups.NOT_MATCHED[0];
  const topUnknown = groups.UNKNOWN[0];
  const mainGap = topGap
    ? {
        kind: "gap",
        label: summarizeRequirement(topGap.req),
        requirement_id: topGap.req.requirement_id,
        match_status: topGap.m.status || "NOT_MATCHED",
        note: (topGap.m.explanation || "").split(" [")[0].trim() || "",
      }
    : topUnknown
      ? {
          kind: "confirm",
          label: summarizeRequirement(topUnknown.req),
          requirement_id: topUnknown.req.requirement_id,
          match_status: topUnknown.m.status || "UNKNOWN",
          note: (topUnknown.m.explanation || "").split(" [")[0].trim() || "",
        }
      : null;

  return {
    label: score.label,
    percent: score.percent,
    main_gap: mainGap,
    counts: {
      matched: score.matched,
      partial: score.partial,
      not_matched: score.not_matched,
      unknown: score.unknown,
    },
    strengths: cap(groups.MATCHED.map(({ req }) => summarizeRequirement(req))),
    partials: cap(groups.PARTIAL.map(({ req }) => summarizeRequirement(req))),
    gaps: cap(groups.NOT_MATCHED.map(({ req }) => summarizeRequirement(req))),
    uncertain: cap(groups.UNKNOWN.map(({ req }) => summarizeRequirement(req))),
    questions_for_you: openQuestions.map((q) => q.question),
    requirements: reqs.map((req) => {
      const m = byReq.get(req.requirement_id) || {};
      return { req, match: m };
    }),
  };
}

/** Generic English function words that cannot signal a real topic match. */
const RAW_STOPWORDS = new Set([
  "a", "about", "after", "again", "against", "all", "also", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "between", "both", "but", "by", "can",
  "could", "did", "do", "does", "during", "each", "for", "from", "had", "has", "have", "having",
  "he", "her", "here", "hers", "herself", "him", "himself", "his", "how", "i", "if", "in", "into",
  "is", "it", "its", "itself", "me", "more", "most", "my", "myself", "no", "nor", "not", "of",
  "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own",
  "said", "same", "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs",
  "them", "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too",
  "under", "until", "up", "very", "was", "we", "were", "what", "when", "where", "which", "while",
  "who", "whom", "why", "will", "with", "would", "you", "your", "yours", "yourselves",
]);

/**
 * Loose token overlap between a JD requirement and a user answer, used to
 * decide which other requirements a single confirmation also resolves. This
 * deliberately does NOT use the retrieval tokenizer (its STOPWORDS strip words
 * like team, years and experience — exactly the ones that matter here), so it
 * computes raw tokens with light plural trimming to catch "teams" ↔ "team".
 */
function rawTokens(text) {
  const out = new Set();
  for (const raw of String(text || "").toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const t = raw.replace(/^[.#]+|[.#]+$/g, "");
    if (t.length < 2 || /^\d+$/.test(t) || RAW_STOPWORDS.has(t)) continue;
    out.add(t);
    if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) out.add(t.slice(0, -1));
  }
  return out;
}

export function isSemanticallyRelated(requirement, answer) {
  if (!requirement || !answer) return false;
  if (answer.requirement_id && answer.requirement_id === requirement.requirement_id) return true;
  const key = String(answer.key || "");
  if (
    (key.startsWith("edu_status_") && requirement.category === "education") ||
    (key.startsWith("years_") &&
      (requirement.category === "experience" || /\byears?\b/.test(requirement.text || "")))
  ) {
    return true;
  }
  const reqText = [
    requirement.text,
    ...((requirement.normalized_concepts || []).map(String)),
    ...((requirement.tools || []).map(String)),
    ...((requirement.keywords || []).map(String)),
  ].join(" ");
  const ansText = [
    answer.normalized_claim,
    answer.answer,
    ...((answer.technologies || []).map(String)),
  ].join(" ");
  const rt = rawTokens(reqText);
  const at = rawTokens(ansText);
  for (const t of rt) if (at.has(t)) return true;
  return false;
}

export function summariseAnswer(text, maxLen = 120) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > maxLen ? `${t.slice(0, maxLen).trim()}…` : t;
}

/**
 * Deterministic, immediate re-evaluation of every requirement affected by one
 * answered question. No LLM round-trip: the answer's normalized claim IS the
 * verdict.
 *
 *   - decline ("no")  -> NOT_MATCHED for the answered requirement and any
 *     requirements semantically linked to the answer;
 *   - confirm ("yes") -> MATCHED citing the answer evidence (plus any completed
 *     qualifying education records when the requirement asks for a degree),
 *     then the same fail-closed caps from the full matching pass apply so a
 *     confirmation can never over-claim.
 *
 * Requirements already MATCHED are never re-linked/downgraded by another
 * answer's confirmation; a direct "no" on the answered requirement itself still
 * wins. The session's `match_score` and `match_overview` are recomputed.
 */
export function recomputeAffectedMatches(session, db, { answeredReqId, answerRecord }) {
  const requirements = session?.jd?.requirements || [];
  if (!requirements.length) return session;
  const matches = Array.isArray(session.matches) ? session.matches.slice() : [];
  const byReq = new Map(matches.map((m) => [m.requirement_id, m]));

  const affected = new Set();
  if (answeredReqId) affected.add(answeredReqId);
  for (const req of requirements) {
    if (affected.has(req.requirement_id)) continue;
    const cur = byReq.get(req.requirement_id);
    if (cur && cur.status === "MATCHED") continue; // a confirmation never downgrades a solid match
    if (isSemanticallyRelated(req, answerRecord)) affected.add(req.requirement_id);
  }
  if (!affected.size) return session;

  const records = db.all();
  const retrieval = buildRetrieval(requirements, records, { k: 10 });
  const declined = Boolean(answerRecord?.declined);
  const answerEvidence = answerRecord?.evidence_id ? db.get(answerRecord.evidence_id) : null;

  const updated = matches.slice();
  for (const req of requirements) {
    if (!affected.has(req.requirement_id)) continue;

    const candidateIds = new Set(
      (retrieval.get(req.requirement_id) || []).map((c) => c.record.evidence_id)
    );

    if (declined) {
      const verdict = {
        requirement_id: req.requirement_id,
        status: "NOT_MATCHED",
        evidence_ids: [],
        evidence: "",
        source: "",
        explanation: `You answered no to the question${
          answerRecord?.question ? ` “${summariseAnswer(answerRecord.question)}”` : ""
        } related to this requirement${
          answerRecord?.answer ? `: “${summariseAnswer(answerRecord.answer)}”` : ""
        }. It is marked as not met.`,
        confidence: 1,
        matched_skill_level: undefined,
        evidence_strength: "NONE",
        rejected_evidence_ids: [],
      };
      const idx = updated.findIndex((m) => m.requirement_id === req.requirement_id);
      if (idx >= 0) updated[idx] = verdict;
      else updated.push(verdict);
      continue;
    }

    // A degree requirement is satisfied by a completed, level-matching degree
    // record in the evidence base — attach those so the education caps can
    // promote from the degree itself rather than only the answer text.
    if (req.category === "education") {
      const asked = educationLevelOfRequirement(req.text || "");
      for (const rec of records) {
        if (rec.category !== "education" || educationCompletion(rec) !== "completed") continue;
        if (asked && recordEducationLevel(rec) !== asked) continue;
        candidateIds.add(rec.evidence_id);
      }
    }
    if (answerEvidence) candidateIds.add(answerEvidence.evidence_id);

    const quote = answerRecord?.answer
      ? `“${summariseAnswer(answerRecord.answer)}”`
      : "your answer";
    const base = {
      requirement_id: req.requirement_id,
      status: "MATCHED",
      evidence_ids: answerEvidence ? [answerEvidence.evidence_id] : [],
      evidence: answerEvidence
        ? answerEvidence.original_text || answerEvidence.normalized_claim || ""
        : "",
      source: answerEvidence ? "User answer" : "",
      explanation: `You confirmed this requirement: ${quote}.`,
      confidence: 1,
      matched_skill_level: answerEvidence?.skill_level || undefined,
    };
    const verdict = sanitizeMatch(base, db, candidateIds, req);
    const idx = updated.findIndex((m) => m.requirement_id === req.requirement_id);
    if (idx >= 0) updated[idx] = verdict;
    else updated.push(verdict);
  }

  session.matches = updated;
  session.match_score = computeMatchScore(requirements, updated);
  session.match_overview = buildMatchOverview(session);
  return session;
}

/**
 * Deterministic status baseline for one requirement when the reasoning model is
 * unavailable. Conservative by design — the same caps apply afterwards, so a
 * baseline can never over-claim:
 *   - personal conditions (location/visa/notice) are always UNKNOWN (a question
 *     resolves them, a resume never can);
 *   - soft/behavioural requirements are UNKNOWN unless the evidence DIRECTLY
 *     demonstrates them;
 *   - concrete technical requirements use the retrieved evidence strength:
 *     DIRECT demonstrated use -> MATCHED, anything weaker -> PARTIAL.
 */
function baselineStatusFor(requirement, usableRecords) {
  if (PERSONAL_CATEGORIES.has(requirement?.category)) return "UNKNOWN";
  const soft =
    SOFT_CATEGORIES.has(requirement?.category) ||
    GENERIC_SOFT_RE.test(
      `${requirement?.text || ""} ${requirement?.evidence_hint || ""}`
    );
  const strength = deriveEvidenceStrength({}, usableRecords, requirement);
  if (soft) return strength === "DIRECT" ? "MATCHED" : "UNKNOWN";
  if (strength === "DIRECT") return "MATCHED";
  return "PARTIAL";
}

/**
 * Deterministic match for a requirement when the reasoning model produced no
 * verdict at all. Covers both "model failed entirely" (fallback) and per-
 * requirement omissions, always routed through sanitizeMatch so evidence
 * validation and the strength caps still apply.
 */
export function baselineMatchFor(requirement, candidates, db) {
  const candidateIds = new Set(
    (candidates || []).map((c) => c.record?.evidence_id).filter(Boolean)
  );
  const usableRecords = (candidates || [])
    .map((c) => c.record)
    .filter((r) => r && USABLE_EVIDENCE_STATUS.includes(r.status));
  if (!usableRecords.length) {
    return sanitizeMatch(
      missingMatchFor(requirement, candidateIds.size > 0),
      db,
      candidateIds,
      requirement
    );
  }
  const primary = usableRecords[0];
  const base = {
    requirement_id: requirement?.requirement_id,
    status: baselineStatusFor(requirement, usableRecords),
    evidence_ids: usableRecords.map((r) => r.evidence_id),
    evidence: primary.original_text || primary.normalized_claim || "",
    source: primary.source_location || "",
    explanation:
      "Deterministic fallback verdict from retrieved evidence (the reasoning model was unavailable).",
    confidence: 0.7,
    matched_skill_level: primary.skill_level,
  };
  return sanitizeMatch(base, db, candidateIds, requirement);
}

export async function runMatching(session) {
  if (!session.jd?.requirements?.length) {
    throw new Error("Job description must be analyzed before matching.");
  }
  const db = new TruthDatabase(session.truth_db || []);
  const records = db.all();

  // Keep the reasoning prompt small: fewer candidates per requirement and a
  // compact memory context so Phi-4-mini can reason instead of recalling.
  const retrieval = buildRetrieval(session.jd.requirements, records, { k: 6 });
  const requirementsWithCandidates = formatCandidates(session.jd.requirements, retrieval);
  const memoryContext = formatCompactMemoryContext(records);

  let data = null;
  let model = null;
  try {
    const res = await generateJson({
      task: "reasoning",
      promptName: "matching",
      vars: {
        requirements_with_candidates: requirementsWithCandidates,
        memory_context: memoryContext,
        learned_examples: formatMatchingLessons(session.jd.job_title, 2),
      },
      schema: matchVerdictResultSchema,
      label: "matching",
      maxAttempts: 2,
      maxTokens: 2000,
    });
    data = res.data;
    model = res.model;
  } catch (err) {
    // Never let a slow/failed model kill the whole analysis: fall back to the
    // deterministic verdicts so matching, questions and tailoring still run.
    // eslint-disable-next-line no-console
    console.warn(`[matching] reasoning model failed for ${session.id}: ${err.message}`);
  }

  const byReq = new Map((data?.matches || []).map((m) => [m.requirement_id, m]));
  const sanitized = session.jd.requirements.map((req) => {
    const candidateIds = new Set(
      (retrieval.get(req.requirement_id) || []).map((c) => c.record.evidence_id)
    );
    if (data === null) {
      return baselineMatchFor(req, retrieval.get(req.requirement_id) || [], db);
    }
    const found = byReq.get(req.requirement_id);
    if (!found) {
      return missingMatchFor(
        req,
        candidateIds.size > 0
      );
    }
    return sanitizeMatch(found, db, candidateIds, req);
  });

  session.matches = sanitized;
  session.match_score = computeMatchScore(session.jd.requirements, sanitized);
  session.match_overview = buildMatchOverview(session);
  session.match_model = model || "deterministic-fallback";
  session.stage = "matched";
  return session;
}