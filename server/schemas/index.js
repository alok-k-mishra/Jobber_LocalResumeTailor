import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared enums (mirror the specification exactly)
// ---------------------------------------------------------------------------

export const EVIDENCE_STATUS = [
  "VERIFIED",
  "USER_CONFIRMED",
  "INFERRED",
  "MISSING",
  "CONTRADICTED",
];

export const USABLE_EVIDENCE_STATUS = ["VERIFIED", "USER_CONFIRMED"];

export const SKILL_LEVELS = [
  "LISTED",
  "USED",
  "PROJECT",
  "PROFESSIONAL",
  "ADVANCED",
];

export const IMPORTANCE = ["CRITICAL", "IMPORTANT", "NICE_TO_HAVE"];

export const MATCH_STATUS = [
  "MATCHED",
  "PARTIAL",
  "NOT_MATCHED",
  "UNKNOWN",
];

/* Evidence strength is a separate axis from match status: DIRECT (a bullet
   explicitly uses the thing), STRONG (closely related demonstrated work),
   INDIRECT (mentioned/listed but not demonstrated), NONE (no usable record). */
export const EVIDENCE_STRENGTH = ["DIRECT", "STRONG", "INDIRECT", "NONE"];

/* How a list of tools inside one requirement should be read. */
export const REQUIREMENT_LIST_TYPE = [
  "SINGLE", // one concrete thing is named
  "ALTERNATIVES", // "A or B or C" — any one satisfies the requirement
  "CUMULATIVE", // "A, B, and C" — every item is required
  "EXAMPLES", // "e.g. A, B, C" — illustrations of a broader concept
];

/* Tailoring is strictly non-destructive: nothing is ever removed from the
   candidate's resume, and tailoring only rewrites wording or keeps existing
   evidence. Ordering actions (REORDER_*) are NOT part of the default tailoring
   output: reordering resume entries, titles, companies, dates or bullets is a
   structural decision the tool does not make on its own. REORDER_SKILL is the
   single optional, deterministic exception (surfacing verified skills). */
export const RECOMMENDATION_ACTIONS = [
  "KEEP",
  "REWRITE_SUMMARY",
  "REWRITE_BULLET",
  "REORDER_SKILL",
];

// Legacy actions persisted by earlier app versions. The model never emits these
// anymore, but loading an old session must not crash. They map onto the new
// taxonomy in pipeline/recommendations.js `normalizeAction`.
export const LEGACY_RECOMMENDATION_ACTIONS = [
  "REWRITE",
  "REORDER",
  "REPLACE",
  "DE_EMPHASIZE",
  "REMOVE",
  "CONFIRM_FIRST",
  "OPTIONAL_ADD",
  "REORDER_BULLET",
  "REORDER_PROJECT",
  "REORDER_EXPERIENCE",
  "EMPHASIZE",
];

// Actions the reasoning model may emit for Tailoring Recommendations. This is
// deliberately a content-only set: the model rewrites wording or keeps it — it
// never proposes reordering any resume material. Reordering surfaces at most as
// a deterministic, optional skill ordering, computed in code, never by the LLM.
export const TAILORING_ACTIONS = ["KEEP", "REWRITE_SUMMARY", "REWRITE_BULLET"];

export const AUDIT_VERDICTS = [
  "SUPPORTED",
  "UNSUPPORTED",
  "EXAGGERATED",
  "CONTEXT_LOSS",
  "CONTRADICTED",
];

const skillLevel = z.enum(SKILL_LEVELS);
const strArr = z.array(z.string()).default([]);

// ---------------------------------------------------------------------------
// Evidence record (the atom of the Truth Database)
// ---------------------------------------------------------------------------

export const evidenceRecordSchema = z.object({
  evidence_id: z.string(),
  source_type: z.enum(["resume", "user_answer"]),
  source_location: z.string().default(""),
  original_text: z.string().default(""),
  normalized_claim: z.string(),
  status: z.enum(EVIDENCE_STATUS),
  confidence: z.number().min(0).max(1).default(1),
  skill_level: skillLevel.default("LISTED"),
  technologies: strArr,
  // structured context retained from extraction (must be in the schema or zod
  // strips it on reload)
  section: z.string().default(""),
  category: z.string().default("other"),
  entity: z.string().default(""),
  responsibilities: strArr,
  outcomes: strArr,
  metrics: strArr,
  team_context: z.string().default(""),
  // deterministic document-structure fields produced by the line parser.
  // Kept in the zod schema so reloading a persisted resume keeps them.
  item_type: z.enum(["entry_header", "bullet", "line", "skill"]).optional(),
  group_id: z.string().optional(),
  duration: z.string().optional(),
  location: z.string().optional(),
  link_text: z.string().optional(),
  link_url: z.string().optional(),
  subcategory: z.string().optional(),
  flags: z.array(z.string()).optional(),
  // structured authoring fields (editable in Resume Memory; the parser fills
  // them when recoverable). Optional so existing records keep loading.
  role: z.string().optional(),
  company: z.string().optional(),
  location_type: z.string().optional(), // "Remote" | "On-site" | "Hybrid" | ""
  start_month: z.string().optional(),
  start_year: z.string().optional(),
  end_month: z.string().optional(),
  end_year: z.string().optional(),
  is_present: z.boolean().optional(),
  education_type: z.string().optional(),
  degree: z.string().optional(),
  course: z.string().optional(),
  specialization: z.string().optional(),
  institution: z.string().optional(),
  // Explicit user-controlled completion state for education records.
  // "COMPLETED" | "IN_PROGRESS" | "" (unset = unknown). Deliberately NOT part of
  // the LLM extraction schemas: only the user (via editor or question answers)
  // sets this, so the model never guesses a graduation status.
  education_status: z
    .enum(["COMPLETED", "IN_PROGRESS"])
    .optional()
    .or(z.literal("").optional()),
  // provenance in the original document (PDF page / ordinal line)
  page: z.number().optional(),
  line: z.number().optional(),
  // user-answer specific
  question: z.string().optional(),
  answer: z.string().optional(),
  // canonical reuse key, stable across job applications (e.g. "tech_salesforce")
  key: z.string().optional(),
  requirement_id: z.string().optional(),
  created_at: z.string().optional(),
});

// ---------------------------------------------------------------------------
// LLM: resume extraction
// ---------------------------------------------------------------------------

export const resumeFactSchema = z.object({
  section: z.string(),
  source_location: z.string().default(""),
  original_text: z.string(),
  normalized_claim: z.string(),
  category: z
    .enum([
      "summary",
      "skill",
      "experience",
      "internship",
      "project",
      "education",
      "certification",
      "achievement",
      "leadership",
      "activity",
      "other",
    ])
    .default("other"),
  entity: z.string().default(""),
  technologies: strArr,
  responsibilities: strArr,
  outcomes: strArr,
  metrics: strArr,
  team_context: z.string().default(""),
  skill_level: skillLevel.default("LISTED"),
  confidence: z.number().min(0).max(1).default(1),
  role: z.string().optional(),
  company: z.string().optional(),
  location_type: z.string().optional(),
  start_month: z.string().optional(),
  start_year: z.string().optional(),
  end_month: z.string().optional(),
  end_year: z.string().optional(),
  is_present: z.boolean().optional(),
  education_type: z.string().optional(),
  degree: z.string().optional(),
  course: z.string().optional(),
  specialization: z.string().optional(),
  institution: z.string().optional(),
});

export const resumeExtractionSchema = z.object({
  name: z.string().default(""),
  contact: z
    .object({
      email: z.string().default(""),
      phone: z.string().default(""),
      location: z.string().default(""),
      links: strArr,
    })
    .default({ email: "", phone: "", location: "", links: [] }),
  summary: z.string().default(""),
  sections: z.array(z.string()).default([]),
  facts: z.array(resumeFactSchema),
});

// Line-anchored extraction: the model enriches each deterministically parsed
// resume line by index. Original wording is never taken from the model.
export const resumeLineFactSchema = z.object({
  line_index: z.number(),
  category: z
    .enum([
      "summary",
      "skill",
      "experience",
      "internship",
      "project",
      "education",
      "certification",
      "achievement",
      "leadership",
      "activity",
      "other",
    ])
    .default("other"),
  normalized_claim: z.string(),
  entity: z.string().default(""),
  technologies: strArr,
  responsibilities: strArr,
  outcomes: strArr,
  metrics: strArr,
  team_context: z.string().default(""),
  skill_level: skillLevel.default("LISTED"),
  confidence: z.number().min(0).max(1).default(1),
  role: z.string().optional(),
  company: z.string().optional(),
  location_type: z.string().optional(),
  start_month: z.string().optional(),
  start_year: z.string().optional(),
  end_month: z.string().optional(),
  end_year: z.string().optional(),
  is_present: z.boolean().optional(),
  education_type: z.string().optional(),
  degree: z.string().optional(),
  course: z.string().optional(),
  specialization: z.string().optional(),
  institution: z.string().optional(),
});

export const resumeLineFactsSchema = z.object({
  facts: z.array(resumeLineFactSchema),
});

// ---------------------------------------------------------------------------
// LLM: JD extraction
// ---------------------------------------------------------------------------

export const jdRequirementSchema = z.object({
  requirement_id: z.string().optional(),
  text: z.string(),
  category: z
    .enum([
      "technical_skill",
      "tool",
      "programming",
      "programming_language",
      "framework",
      "database",
      "cloud",
      "analytics_tool",
      "business_tool",
      "soft_skill",
      "communication",
      "collaboration",
      "teamwork",
      "leadership",
      "analytical",
      "personal_constraint",
      "certification",
      "location",
      "work_authorization",
      "education",
      "experience",
      "domain",
      "domain_knowledge",
      "project",
      "responsibility",
      "other",
    ])
    .default("other"),
  importance: z.enum(IMPORTANCE).default("IMPORTANT"),
  // Normalized capability concepts (e.g. ["data visualization", "reporting"])
  // so the matcher can recognize "Tableau project experience" as evidence for
  // "proficiency with data visualization tools".
  normalized_concepts: strArr,
  // Concrete tools / technologies named by the JD (e.g. ["Tableau","Power BI"]).
  tools: strArr,
  // How a multi-tool list should be read (alternatives vs cumulative vs examples).
  list_type: z.enum(REQUIREMENT_LIST_TYPE).default("SINGLE"),
  // What kind of evidence would satisfy the requirement
  // (e.g. "project_usage", "professional_experience", "degree", "skills_list").
  evidence_type: z.string().default(""),
  keywords: strArr,
  evidence_hint: z.string().default(""),
});

export const jdExtractionSchema = z.object({
  job_title: z.string().default(""),
  company: z.string().default(""),
  location: z.string().default(""),
  summary: z.string().default(""),
  requirements: z.array(jdRequirementSchema),
  keywords: strArr,
});

// ---------------------------------------------------------------------------
// LLM: answer normalization (user answer -> scoped evidence claim)
// ---------------------------------------------------------------------------

export const answerNormalizationSchema = z.object({
  declined: z.boolean().default(false),
  normalized_claim: z.string().default(""),
  skill_level: skillLevel.default("USED"),
  scope: z.string().default(""),
});

// ---------------------------------------------------------------------------
// LLM: matching
// ---------------------------------------------------------------------------

export const matchSchema = z.object({
  requirement_id: z.string(),
  status: z.enum(MATCH_STATUS),
  evidence_ids: strArr,
  reason: z.string().default(""),
  evidence: z.string().default(""),
  source: z.string().default(""),
  explanation: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.8),
  matched_skill_level: skillLevel.optional(),
  // How strong the cited evidence is (recomputed deterministically in code).
  evidence_strength: z.enum(EVIDENCE_STRENGTH).optional(),
  rejected_evidence_ids: strArr,
});

/* Lean model-facing verdict: the verbatim `evidence`/`source`/`reason` fields
   are stripped (sanitizeMatch re-fills them from the real memory records) so
   the reasoning model writes far fewer tokens. Persisted matches still use the
   full matchSchema above. */
export const matchVerdictSchema = z.object({
  requirement_id: z.string(),
  status: z.enum(MATCH_STATUS),
  evidence_ids: strArr,
  explanation: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.8),
  matched_skill_level: skillLevel.optional(),
});

export const matchVerdictResultSchema = z.object({
  matches: z.array(matchVerdictSchema),
});

export const matchResultSchema = z.object({
  matches: z.array(matchSchema),
});

// ---------------------------------------------------------------------------
// LLM: summary rewrite (fallback when the recommendation pass produced no
// REWRITE_SUMMARY). Output is mapped into a recommendation before validation.
// ---------------------------------------------------------------------------

export const summaryRewriteSchema = z.object({
  rewritten_summary: z.string().min(1),
  reason: z.string().default(""),
  confidence: z.number().min(0).max(1).default(0.8),
  evidence_ids: strArr,
});

// ---------------------------------------------------------------------------
// LLM: questions
// ---------------------------------------------------------------------------

export const questionSchema = z.object({
  question_id: z.string().optional(),
  requirement_id: z.string().default(""),
  question: z.string(),
  why: z.string().default(""),
  options: strArr,
  // Canonical reuse key (e.g. "Tech_Looker", "Relocation", "Onsite_availability").
  // Stored with the answer so semantically-equivalent questions across
  // applications are reused instead of re-asked.
  key: z.string().default(""),
  answered: z.boolean().default(false),
  // lifecycle marker: "UNANSWERED" | "ANSWERED" (declined) | "RESOLVED"
  // (confirmed) | "SKIPPED" (never surfaced). Kept alongside `answered` for
  // legacy persistence compatibility.
  state: z
    .enum(["UNANSWERED", "ANSWERED", "RESOLVED", "SKIPPED"])
    .optional(),
});

export const questionResultSchema = z.object({
  questions: z.array(questionSchema),
});

// ---------------------------------------------------------------------------
// LLM: recommendations
// ---------------------------------------------------------------------------

export const RECOMMENDATION_DIMENSIONS = [
  "ACTION",
  "PROBLEM",
  "IMPLEMENTATION",
  "TECHNICAL",
  "OWNERSHIP",
  "COLLABORATION",
  "IMPACT",
  "SCALE",
];

export const recommendationSchema = z.object({
  recommendation_id: z.string().optional(),
  section: z.string().default(""),
  action: z.enum(RECOMMENDATION_ACTIONS),
  priority: z.number().default(5),
  dimension: z.enum(RECOMMENDATION_DIMENSIONS).optional(),
  current_text: z.string().default(""),
  recommended_text: z.string().default(""),
  reason: z.string().default(""),
  evidence_ids: strArr,
  jd_requirement_ids: strArr,
  confidence: z.number().min(0).max(1).default(0.8),
  // UI grouping metadata filled in deterministically after generation so the
  // recommendations can be shown per resume entry (Experience/Projects/Skills).
  entry_label: z.string().optional(),
  entry_key: z.string().optional(),
  section_label: z.string().optional(),
  bullet_index: z.number().optional(),
});

export const recommendationResultSchema = z.object({
  // 1-2 sentence overview of the tailoring strategy for this JD.
  strategy: z.string().default(""),
  recommendations: z.array(
    recommendationSchema.extend({
      // Content-only for the model: it may rewrite wording or keep it, never
      // reorder. Satisfies "constrain before output" — an LLM suggestion to
      // reorder entries/bullets is a schema failure here, not a recommendation.
      action: z.enum(TAILORING_ACTIONS),
    })
  ),
});

// ---------------------------------------------------------------------------
// LLM: cover letter
// ---------------------------------------------------------------------------

export const coverLetterClaimSchema = z.object({
  claim: z.string(),
  evidence_ids: strArr,
});

export const coverLetterSchema = z.object({
  letter: z.string(),
  claims: z.array(coverLetterClaimSchema).default([]),
});

// ---------------------------------------------------------------------------
// LLM: truth audit
// ---------------------------------------------------------------------------

export const auditItemSchema = z.object({
  claim: z.string(),
  verdict: z.enum(AUDIT_VERDICTS),
  evidence_ids: strArr,
  detail: z.string().default(""),
});

export const auditResultSchema = z.object({
  items: z.array(auditItemSchema),
  overall: z.enum(["PASS", "REVIEW_REQUIRED"]),
  summary: z.string().default(""),
});

// ---------------------------------------------------------------------------
// Deterministic weighted match score (computed from requirement importance and
// match statuses; never produced by the model)
// ---------------------------------------------------------------------------

export const MATCH_WEIGHTS = { CRITICAL: 3, IMPORTANT: 2, NICE_TO_HAVE: 1 };
export const STATUS_WEIGHT = { MATCHED: 1, PARTIAL: 0.5, NOT_MATCHED: 0, UNKNOWN: 0 };

export const matchScoreSchema = z.object({
  percent: z.number().default(0),
  satisfied: z.number().default(0),
  total: z.number().default(0),
  matched: z.number().default(0),
  partial: z.number().default(0),
  not_matched: z.number().default(0),
  unknown: z.number().default(0),
  // LinkedIn-style overall label derived from the deterministic percent.
  label: z.string().default(""),
});

// ---------------------------------------------------------------------------
// Session (persisted locally as JSON)
// ---------------------------------------------------------------------------

export const sessionSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  created_at: z.string(),
  updated_at: z.string(),
  resume: z
    .object({
      filename: z.string().default(""),
      raw_text: z.string().default(""),
      extraction: z.any().nullable().default(null),
    })
    .default({ filename: "", raw_text: "", extraction: null }),
  truth_db: z.array(evidenceRecordSchema).default([]),
  job_description: z.string().default(""),
  jd: z.any().nullable().default(null),
  matches: z.array(matchSchema).default([]),
  match_score: matchScoreSchema.optional(),
  questions: z.array(questionSchema).default([]),
  answers: z.array(z.any()).default([]),
  recommendations: z.array(recommendationSchema).default([]),
  cover_letter: z.any().nullable().default(null),
  audit: z.any().nullable().default(null),
  stage: z.string().default("created"),
});
