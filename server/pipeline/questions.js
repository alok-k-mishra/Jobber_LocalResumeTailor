import { generateJson } from "../llm/client.js";
import {
  questionResultSchema,
  answerNormalizationSchema,
} from "../schemas/index.js";
import { TruthDatabase } from "../core/truthdb.js";
import {
  memoryUserAnswers,
  findMemoryAnswer,
  persistUserAnswer,
  getMemory,
  saveMemory,
} from "../core/resumeMemory.js";
import { listQuestions, upsertAnswerFromEvidence } from "../core/personalQuestions.js";
import { formatRequirements } from "./format.js";
import {
  requirementTools,
  buildMatchOverview,
  recomputeAffectedMatches,
  recordEducationLevel,
  SOFT_CATEGORIES,
  GENERIC_SOFT_RE,
} from "./matching.js";
import {
  educationCompletion,
  educationLevelOfRequirement,
} from "../core/retrieval.js";
import { formatQuestionLessons } from "../core/learning.js";

const MAX_QUESTIONS = 6;

function pad(n) {
  return String(n).padStart(3, "0");
}

// Personal / behavioural categories: things only the candidate can confirm.
const PERSONAL_CATEGORIES = [
  "soft_skill",
  "communication",
  "collaboration",
  "teamwork",
  "leadership",
  "personal_constraint",
  "location",
  "work_authorization",
];

// Concrete, verifyable categories whose gap is solved by direct confirmation.
// A "Have you used ...?" question lets the User confirm applied use even when
// the resume is silent — that answer becomes USER_CONFIRMED evidence.
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

// Statuses that mean "not yet established from the resume" and therefore merit
// a confirmation question.
const NEEDS_CONFIRMATION = new Set(["NOT_MATCHED", "UNKNOWN"]);
const PARTIAL_TECH_NEEDS_CONFIRMATION = new Set(["PARTIAL"]);

// User-specific conditions that are explicit Yes/No confirmations.
const USER_SPECIFIC_KEYWORDS = [
  "office", "onsite", "remote", "hybrid", "relocate", "relocation",
  "travel", "shift", "night", "weekend", "authorization", "work authorization",
  "visa", "sponsorship", "notice", "notice period", "salary", "expectation",
  "driving", "license",
];

/**
 * A requirement is a candidate for a personal/behavioural question only when it
 * is a personal category OR explicitly names a user-specific condition. This is
 * how we avoid random personality questions: everything derives from the JD.
 */
function isPersonalCandidate(req) {
  if (PERSONAL_CATEGORIES.includes(req.category)) return true;
  const text = String(req.text || "").toLowerCase();
  return USER_SPECIFIC_KEYWORDS.some((k) => text.includes(k));
}

/**
 * Build a normalized key for deduplication.
 */
function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Stored answer reuse
// ---------------------------------------------------------------------------

/**
 * Collect every already-provided answer (this session, Resume Memory, and the
 * persistent question bank) into canonical-key and question-text indexes, so a
 * question is never re-asked when the same confirmation already exists. Keys
 * are stable across applications; question text is the deterministic fallback.
 */
export function collectStoredAnswers(session) {
  const byKey = new Map();
  const byText = new Map();
  const byReq = new Set();
  const add = (a) => {
    const text = String(a?.answer || "").trim();
    if (!text) return;
    if (a?.key) byKey.set(String(a.key), text);
    const qn = norm(a?.question);
    if (qn) byText.set(qn, text);
    if (a?.requirement_id) byReq.add(String(a.requirement_id));
  };
  for (const b of listQuestions() || []) add({ key: b.key, question: b.question, answer: b.answer, requirement_id: b.requirement_id });
  for (const a of memoryUserAnswers() || []) add(a);
  for (const a of session?.answers || []) add(a);
  return { byKey, byText, byReq };
}

export function isAnswered(stored, key, questionText) {
  if (key && stored.byKey.has(String(key))) return true;
  const qn = norm(questionText);
  if (qn && stored.byText.has(qn)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Deterministic technical questions
// ---------------------------------------------------------------------------

function matchStatusOf(req, matches) {
  const m = (matches || []).find((x) => x.requirement_id === req.requirement_id);
  return m ? m.status : undefined;
}

function evidenceStrengthOf(req, matches) {
  const m = (matches || []).find((x) => x.requirement_id === req.requirement_id);
  return m ? m.evidence_strength : undefined;
}

const TOOL_BRAND = {
  "power bi": "Power BI",
  "sql": "SQL",
  "nosql": "NoSQL",
  "etl": "ETL",
  "api": "API",
  "html": "HTML",
  "css": "CSS",
  "aws": "AWS",
  "gcp": "GCP",
};

function displayTool(t) {
  const lower = String(t || "").toLowerCase();
  if (TOOL_BRAND[lower]) return TOOL_BRAND[lower];
  return lower
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ")
    .replace(/\bBi\b/g, "BI");
}

function niceList(tools) {
  const shown = tools.map(displayTool);
  if (shown.length <= 1) return shown[0] || "";
  if (shown.length === 2) return `${shown[0]} or ${shown[1]}`;
  return `${shown.slice(0, -1).join(", ")}, or ${shown[shown.length - 1]}`;
}

/**
 * Order-independent canonical key for a tool-confirmation question, so a
 * "Have you used Looker?" answer collected under one JD is reused for the next.
 */
export function technicalQuestionKey(tools) {
  return `tech_${tools
    .map((t) => norm(t))
    .filter(Boolean)
    .sort()
    .join("")}`;
}

/**
 * Deterministic technical questions for requirements the resume could not
 * demonstrate: the JD names concrete tools, they are important, and the cited
 * evidence did not show applied use (DIRECT) of them. A confirmatory question
 * upgrades a candidate's silent gap into verifiable USER_CONFIRMED evidence.
 */
export function deterministicTechnicalQuestions(requirements, matches, stored, budget) {
  const out = [];
  for (const req of requirements) {
    if (out.length >= budget) break;
    if (!["CRITICAL", "IMPORTANT"].includes(req.importance)) continue;
    if (!TECHNICAL_CATEGORIES.has(req.category)) continue;

    const tools = requirementTools(req);
    if (!tools.length) continue;

    const status = matchStatusOf(req, matches);
    const strength = evidenceStrengthOf(req, matches);
    const alreadyDemonstrated = status === "MATCHED" || strength === "DIRECT";
    const gapy =
      NEEDS_CONFIRMATION.has(status) || PARTIAL_TECH_NEEDS_CONFIRMATION.has(status);
    if (alreadyDemonstrated || !gapy) continue;

    const key = technicalQuestionKey(tools);
    const question = `Have you used ${niceList(tools)}?`;
    if (isAnswered(stored, key, question)) continue;

    out.push({
      question_id: "",
      requirement_id: req.requirement_id,
      key,
      question,
      why: `The job description requires ${req.importance.toLowerCase()} experience with ${niceList(tools)}, but the resume does not demonstrate applied use. Confirming it turns this into verifiable evidence the tailor can use.`,
      options: ["Yes", "No"],
      answered: false,
    });
  }
  return out;
}

/**
 * User-specific condition keys derived deterministically from the JD wording
 * (e.g. "cond_relocation") so answers reuse across applications.
 */
function conditionKey(requirement) {
  const text = String(requirement.text || "").toLowerCase();
  const hit = USER_SPECIFIC_KEYWORDS.find((k) => text.includes(k));
  return `cond_${hit ? norm(hit) : norm(String(requirement.text).slice(0, 24))}`;
}

export function deterministicUserSpecificQuestions(requirements, matches, stored, budget) {
  const out = [];
  for (const req of requirements) {
    if (out.length >= budget) break;
    const text = String(req.text || "");
    const isCondition =
      USER_SPECIFIC_KEYWORDS.some((k) => text.toLowerCase().includes(k)) ||
      ["personal_constraint", "location", "work_authorization"].includes(req.category);
    if (!isCondition) continue;
    const status = matchStatusOf(req, matches);
    if (!(status === undefined || NEEDS_CONFIRMATION.has(status))) continue;

    const key = conditionKey(req);
    const question = `"${text.trim()}" — are you able to meet this requirement?`;
    if (isAnswered(stored, key, question)) continue;

    out.push({
      question_id: "",
      requirement_id: req.requirement_id,
      key,
      question,
      why: "This is a user-specific condition in the JD that cannot be confirmed from a resume.",
      options: ["Yes", "No"],
      answered: false,
    });
  }
  return out;
}

/**
 * Deterministic gap-fill for behavioural/soft requirements (interpersonal,
 * analytical, communication, leadership...) that the LLM layer did not pick up
 * and the resume left UNKNOWN. These can only ever be confirmed by the user.
 */
export function deterministicSoftQuestions(requirements, matches, stored, budget) {
  const out = [];
  for (const req of requirements) {
    if (out.length >= budget) break;
    const isSoft =
      SOFT_CATEGORIES.has(req.category) ||
      GENERIC_SOFT_RE.test(`${req.text || ""} ${req.evidence_hint || ""}`);
    if (!isSoft) continue;
    const status = matchStatusOf(req, matches);
    if (!(status === undefined || status === "UNKNOWN")) continue;

    const key = `soft_${norm(String(req.text || "").slice(0, 28))}`;
    const question = `The job description mentions: “${String(req.text || "").trim()}”. Can you describe how you meet this?`;
    if (isAnswered(stored, key, question)) continue;

    out.push({
      question_id: "",
      requirement_id: req.requirement_id,
      key,
      question,
      why: "This behavioural/soft requirement cannot be proven from a resume — your own confirmation resolves it.",
      options: ["Yes", "No"],
      answered: false,
    });
  }
  return out;
}

/**
 * Education status confirmation: the JD asks for a degree level, the resume has
 * a matching-level record whose completion is unknown, and only the user can
 * say whether it was finished. A confirmed answer marks the corresponding
 * education record COMPLETED, which is what lets the matcher promote it.
 */
export function deterministicEducationQuestions(session, matches, stored, budget) {
  const out = [];
  const records = (session?.truth_db || []).filter((r) => r.category === "education");
  for (const req of session?.jd?.requirements || []) {
    if (out.length >= budget) break;
    if (req.category !== "education") continue;
    const asked = educationLevelOfRequirement(req.text || "");
    if (!asked || ["diploma", "school"].includes(asked)) continue;
    const status = matchStatusOf(req, matches);
    if (!(status === undefined || NEEDS_CONFIRMATION.has(status))) continue;

    const unclear = records.filter(
      (r) =>
        recordEducationLevel(r) === asked &&
        educationCompletion(r) === "completion unknown"
    );
    if (!unclear.length) continue;

    const sample = unclear[0];
    const key = `edu_status_${asked}`;
    const shown = (sample.original_text || sample.normalized_claim || "").replace(/\s+/g, " ").trim();
    const question = `Your resume shows: “${shown}”. Have you completed your ${asked} degree?`;
    if (isAnswered(stored, key, question)) continue;

    out.push({
      question_id: "",
      requirement_id: req.requirement_id,
      key,
      question,
      why: `The JD requires a ${asked}-level degree and your resume's ${asked} record does not state whether it was completed. Completion status is only ever set by you.`,
      options: ["Yes, completed", "Not yet finished"],
      answered: false,
    });
  }
  return out;
}

const YEARS_RE = /\d+\s*[-–]\s*\d+\s*years?|(\d+)\+?\s*(?:or\s+more\s+)?years?/i;

/**
 * Determine, from a JD requirement, the minimum years it asks for.
 */
export function yearsRequiredOf(text) {
  const m = YEARS_RE.exec(String(text || ""));
  if (!m) return null;
  if (m[1]) return Number(m[1]); // plain "3 years" / "3+ years" / "3 or more years"
  const range = String(text || "").match(/(\d+)\s*[-–]\s*(\d+)\s*years?/i);
  if (range) return Number(range[1]);
  return null;
}

/**
 * Years-of-experience confirmation. A resume project or internship never counts
 * as professional experience (a deterministic cap already enforces that), so a
 * "years of experience" requirement the resume could not establish is asked
 * directly. Free-form (pick a range button or type the exact number).
 */
export function deterministicYearsQuestions(requirements, matches, stored, budget) {
  const out = [];
  for (const req of requirements) {
    if (out.length >= budget) break;
    const wantsYears =
      req.category === "experience" ||
      /(?:years?\s+of\s+experience|\d+\+?\s*years?)/i.test(req.text || "");
    if (!wantsYears) continue;
    const status = matchStatusOf(req, matches);
    if (!(status === undefined || NEEDS_CONFIRMATION.has(status))) continue;

    const topic = requirementTools(req)[0] || (req.normalized_concepts || [])[0] || req.category;
    const key = `years_${norm(String(topic || "experience"))}`;
    const question = `The JD asks for: “${String(req.text || "").trim()}”. How many years of relevant professional experience do you have?`;
    if (isAnswered(stored, key, question)) continue;

    out.push({
      question_id: "",
      requirement_id: req.requirement_id,
      key,
      question,
      why: "Years of experience can only be confirmed by you; the matcher never counts projects or internships as professional experience.",
      options: ["1", "2", "3", "4", "5+"],
      answered: false,
    });
  }
  return out;
}

/**
 * Generate questions from the JD. Two deterministic layers always run (the
 * concrete technical-tool gaps and the user-specific conditions), and the
 * extraction model refines the behavioural/soft-skill confirmations in between.
 * Every question carries a stable key, and anything already answered (stored
 * answer with the same key or question text) is never re-asked.
 */
export async function generateQuestions(session) {
  if (!session.jd?.requirements?.length) {
    throw new Error("Job description must be analyzed before generating questions.");
  }

  const requirements = session.jd.requirements;
  const matches = session.matches || [];
  const stored = collectStoredAnswers(session);

  const questions = [];
  const seenKeys = new Set([...stored.byKey.keys()].map((k) => norm(k)));
  const seenTexts = new Set([...stored.byText.keys()].map((s) => norm(s)));
  const seenReqIds = new Set();
  const validReqIds = new Set(requirements.map((r) => r.requirement_id));
  const push = (q) => {
    if (questions.length >= MAX_QUESTIONS) return false;
    const textKey = norm(q.question);
    const nk = q.key ? norm(q.key) : "";
    if (!textKey) return false;
    if (seenTexts.has(textKey)) return false;
    if (nk && seenKeys.has(nk)) return false;
    if (q.requirement_id && seenReqIds.has(q.requirement_id)) return false;
    seenTexts.add(textKey);
    if (nk) seenKeys.add(nk);
    if (q.requirement_id) seenReqIds.add(q.requirement_id);
    questions.push({
      question_id: `Q-${pad(questions.length + 1)}`,
      requirement_id: validReqIds.has(q.requirement_id) ? q.requirement_id : "",
      key: q.key || "",
      question: q.question,
      why: q.why || "",
      options: q.options && q.options.length ? q.options : ["Yes", "No"],
      answered: false,
      state: "UNANSWERED",
    });
    return true;
  };

  session.questions = [];
  session.stage = "questions_ready";

  // Layer 1: deterministic technical-tool gaps (highest value).
  for (const q of deterministicTechnicalQuestions(requirements, matches, stored, MAX_QUESTIONS)) push(q);

  // Layer 2: behavioural / soft-skill confirmations via the extraction model.
  const personalCandidates = requirements.filter(
    (r) => {
      if (!isPersonalCandidate(r)) return false;
      if (stored.byReq.has(r.requirement_id)) return false;
      const status = matchStatusOf(r, matches);
      return status === undefined || NEEDS_CONFIRMATION.has(status);
    }
  );
  const remaining = MAX_QUESTIONS - questions.length;
  if (remaining > 0 && personalCandidates.length > 0) {
    try {
      const { data, model } = await generateJson({
        task: "extraction",
        promptName: "jd-questions",
        vars: {
          max_questions: remaining,
          requirements: formatRequirements(personalCandidates),
          answered_requirement_ids: [...stored.byReq].join(", ") || "(none)",
          previous_answers: [
            ...stored.byKey.entries(),
            ...stored.byText.entries(),
          ]
            .map(([k, ans]) => `${k}: ${ans.trim()}`)
            .slice(0, 24)
            .join("\n") || "(none)",
          learned_examples: formatQuestionLessons(session.jd.job_title, 2),
        },
        schema: questionResultSchema,
        label: "jd-questions",
        maxTokens: 500,
      });

      const validReqIds = new Set(personalCandidates.map((r) => r.requirement_id));
      for (const q of data.questions || []) {
        if (questions.length >= MAX_QUESTIONS) break;
        if (q.requirement_id && !validReqIds.has(q.requirement_id)) continue;
        if (isAnswered(stored, q.key, q.question)) continue;
        push(q);
      }
      session.question_model = model;
    } catch {
      // Model unavailable: the deterministic layers still cover the hard gaps.
    }
  }

  // Layer 3: deterministic education-status confirmations (a completed degree
  // promotes a degree requirement; only the user can confirm completion).
  for (const q of deterministicEducationQuestions(session, matches, stored, MAX_QUESTIONS)) push(q);

  // Layer 4: deterministic years-of-experience confirmations.
  for (const q of deterministicYearsQuestions(requirements, matches, stored, MAX_QUESTIONS)) push(q);

  // Layer 5: deterministic user-specific conditions (e.g. relocation / visa).
  for (const q of deterministicUserSpecificQuestions(requirements, matches, stored, MAX_QUESTIONS)) push(q);

  // Layer 6: deterministic behavioural/soft gap-fill for anything the LLM layer
  // did not pick up and the resume left UNKNOWN.
  for (const q of deterministicSoftQuestions(requirements, matches, stored, MAX_QUESTIONS)) push(q);

  session.questions = questions;
  return session;
}

/**
 * Turn a user's answer into scoped evidence. The extraction model normalizes
 * the answer but is constrained by the prompt to preserve the user's exact
 * scope. Declined/negative answers produce no evidence. Confirmed answers are
 * stored in Resume Memory and the persistent bank (by canonical key and question
 * text) so future applications reuse them.
 */
export async function recordAnswer(session, { question_id, answer }) {
  const question = (session.questions || []).find((q) => q.question_id === question_id);
  if (!question) throw new Error(`Unknown question ${question_id}.`);
  const text = String(answer || "").trim();
  if (!text) throw new Error("Answer is empty.");

  const requirement = (session.jd?.requirements || []).find(
    (r) => r.requirement_id === question.requirement_id
  );

  const { data } = await generateJson({
    task: "extraction",
    promptName: "evidence-normalization",
    vars: {
      question: question.question,
      requirement_text: requirement?.text || "(none)",
      answer: text,
    },
    schema: answerNormalizationSchema,
    label: "evidence-normalization",
    maxTokens: 250,
  });

  const db = new TruthDatabase(session.truth_db || []);
  const answerCategory = answerCategoryForKey(question.key);
  const answerRecord = {
    question_id,
    question: question.question,
    key: question.key || "",
    requirement_id: question.requirement_id,
    answer: text,
    declined: Boolean(data.declined) || !data.normalized_claim,
    normalized_claim: data.normalized_claim || "",
    skill_level: data.skill_level,
    scope: data.scope || "",
    category: answerCategory,
    answered_at: new Date().toISOString(),
  };

  let evidenceId = null;
  if (!answerRecord.declined) {
    // Reuse the stored memory answer when the same confirmation already exists.
    const memAnswer = findMemoryAnswer(question.requirement_id, question.question);
    if (memAnswer) {
      memAnswer.answer = text;
      memAnswer.original_text = text;
      memAnswer.normalized_claim = data.normalized_claim;
      memAnswer.skill_level = data.skill_level;
      memAnswer.category = answerCategory;
      memAnswer.key = question.key || memAnswer.key || "";
      memAnswer.updated_at = new Date().toISOString();
      persistUserAnswer(memAnswer);
      evidenceId = memAnswer.evidence_id;
    } else {
      const evidence = db.addUserAnswer({
        question: question.question,
        answer: text,
        normalized_claim: data.normalized_claim,
        requirement_id: question.requirement_id,
        key: question.key || "",
        category: answerCategory,
        skill_level: data.skill_level || "USED",
      });
      evidenceId = evidence.evidence_id;
      persistUserAnswer(evidence);
    }
    // Ensure the reused/created evidence is part of this session's db too.
    if (evidenceId && !db.get(evidenceId)) {
      const fromMemory = memoryUserAnswers().find((a) => a.evidence_id === evidenceId);
      if (fromMemory) db.records.push(fromMemory);
    }
    answerRecord.evidence_id = evidenceId;
    // Keep the persistent personal question bank in sync with the answer so
    // future applications reuse it instead of re-asking.
    upsertAnswerFromEvidence({
      question: question.question,
      answer: text,
      requirement_id: question.requirement_id,
      normalized_claim: data.normalized_claim || "",
      options: question.options,
      key: question.key || "",
    });
  }

  // Education-status answers mark the matching-level education record(s) so the
  // deterministic matcher can promote/depromote on the degree itself. Written
  // to both this session's copy and Resume Memory (the source of truth).
  const eduLevel = String(question.key || "").startsWith("edu_status_")
    ? String(question.key).slice("edu_status_".length)
    : "";
  if (eduLevel) {
    const eduStatus = answerRecord.declined ? "IN_PROGRESS" : "COMPLETED";
    for (const rec of db.all()) {
      if (rec.category === "education" && recordEducationLevel(rec) === eduLevel) {
        rec.education_status = eduStatus;
      }
    }
    const mem = getMemory();
    if (mem && mem.truth_db) {
      for (const rec of mem.truth_db) {
        if (rec.category === "education" && recordEducationLevel(rec) === eduLevel) {
          rec.education_status = eduStatus;
        }
      }
      saveMemory(mem);
    }
  }

  session.truth_db = db.toJSON();
  question.answered = true;
  question.state = answerRecord.declined ? "ANSWERED" : "RESOLVED";
  session.answers = (session.answers || []).filter((a) => a.question_id !== question_id);
  session.answers.push(answerRecord);
  session.stage = "answers_recorded";

  // Re-evaluate the affected requirements immediately and deterministically —
  // the answer itself is the verdict, no LLM round-trip is needed.
  if (session.matches && session.matches.length) {
    session = recomputeAffectedMatches(session, db, {
      answeredReqId: question.requirement_id,
      answerRecord,
    });
  }
  return session;
}

/**
 * Resume category semantics for a confirmation answer, so the deterministic
 * caps judge it like the equivalent resume proof. Years-of-experience answers
 * are experience evidence; education-status answers are education evidence;
 * everything else stays a generic user answer.
 */
function answerCategoryForKey(key) {
  if (String(key || "").startsWith("years_")) return "experience";
  if (String(key || "").startsWith("edu_status_")) return "education";
  return "other";
}