/**
 * Deterministic candidate retrieval.
 *
 * Before the LLM judges a requirement, we shortlist the evidence records most
 * likely to be relevant using token overlap and technology matches. The model
 * then only has to adjudicate a small, explicit set — which makes evidence IDs
 * far more reliable and lets us skip the model entirely when nothing matches.
 */

export const STOPWORDS = new Set(
  `a an the and or of to in for with on at by from as is are be been being this that these those
   you your we our they their he she it its will would should can could may might must
   experience experienced strong proficiency proficient knowledge familiar familiarity
   including include includes such plus preferred required requirement requirements
   role job work working using use used years year ability able excellent good great
   skills skill tools tool technologies technology etc via across within into
   develop developing build building maintain maintaining support supporting
   collaborate collaboration team teams cross functional
   during after before while when since although though however additionally
   furthermore moreover therefore thus meanwhile also finally overall
   throughout within across upon over under between among including alongside
   beyond despite toward towards regarding concerning my our your their its
   i we they he she it me us them him her who whom whose there here`
    .split(/\s+/)
    .filter(Boolean)
);

/* Qualification / abbreviation synonyms so the shortlist can bridge
   "B.Tech" ↔ "bachelor of technology" ↔ "undergraduate" ↔ "graduation", etc.
   Keys are single token forms produced by tokenize(); values are tokens that
   should also be considered present when the key is found. */
const SYNONYMS = {
  "b.tech":     ["bachelor", "technology", "engineering", "degree", "undergraduate"],
  "b.e":        ["bachelor", "engineering", "degree"],
  "b.sc":       ["bachelor", "science", "degree"],
  "b.a":        ["bachelor", "arts", "degree"],
  "bcom":       ["bachelor", "commerce", "degree"],
  "m.tech":     ["master", "technology"],
  "m.e":        ["master", "engineering"],
  "m.sc":       ["master", "science"],
  "mba":        ["master", "business", "administration"],
  "mca":        ["master", "computer", "application"],
  "ph.d":       ["doctorate", "doctor"],
  "bachelor":   ["b.tech", "degree", "undergraduate"],
  "undergraduate": ["b.tech", "bachelor", "degree", "graduation"],
  "graduation": ["b.tech", "bachelor", "degree", "undergraduate"],
  "degree":     ["b.tech", "bachelor", "undergraduate", "graduation"],
  "technology": ["tech"],
  "tech":       ["technology"],
  "cse":        ["computer", "science", "engineering"],
  "ai":         ["artificial", "intelligence"],
  "js":         ["javascript"],
  "typescript": ["ts"],
  "csharp":     ["c#", "csharp"],
  "c++":        ["cpp"],
  "node":       ["node.js"],
};

export function tokenize(text) {
  const base = String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  const expanded = new Set(base);
  for (const t of base) {
    const extra = SYNONYMS[t];
    if (extra) for (const e of extra) expanded.add(e);
  }
  return expanded;
}

function evidenceText(record) {
  return [
    record.normalized_claim,
    record.original_text,
    (record.technologies || []).join(" "),
    record.entity,
    record.section,
    record.role,
    record.company,
    record.degree,
    record.course,
    record.specialization,
    record.institution,
    record.duration,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Education completion state. Gives the matcher an explicit, deterministic
 * signal and decides which strength caps apply.
 *
 * The ONLY authoritative signals are:
 *   1. the user-controlled `education_status` field ("COMPLETED"/"IN_PROGRESS"),
 *   2. `is_present` (structurally "still there" even without a status),
 *   3. explicit ongoing wording visible in the record itself.
 *
 * A duration range, an end year, a degree type, or an education_level is NOT
 * used to infer completion: a record that stops at "2022 - 2026" might still be
 * running, and a degree name in itself never proves graduation. When nothing
 * authoritative says one way or the other, the matcher treats the record as
 * "completion unknown" (never "completed"), so it can't be promoted off a guess.
 */
export function educationCompletion(record) {
  if (record?.category !== "education") return "";
  if (record.education_status === "COMPLETED") return "completed";
  if (record.education_status === "IN_PROGRESS") return "in progress";
  if (record.is_present) return "in progress";
  const text = `${record.normalized_claim || ""} ${record.original_text || ""}`;
  const hasOngoing =
    /(?:in\s+progress|pursuing|ongoing|expected\s+(?:to\s+)?(?:complete|graduate)|currently\s+studying|studying|enrolled|runner\b)/i.test(
      text
    ) && !/\b(?:completed|graduated)\b/i.test(text);
  if (hasOngoing) return "in progress";
  return "completion unknown";
}

const BACHELOR_DEGREES = new Set([
  "b.tech", "b.e", "b.sc", "b.a", "bcom", "bba", "bca",
  "ba llb", "b.ed", "b.pharm", "b.arch", "b.des", "b.tech",
]);
const MASTER_DEGREES = new Set([
  "m.tech", "m.e", "m.sc", "m.a", "mcom", "mba", "mca", "m.ed", "llm",
]);
const DOCTORAL_DEGREES = new Set(["ph.d", "d.sc", "d.ed", "doctorate"]);

function normalizeDegreeToken(d) {
  return String(d || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Education semantics: which general level a degree stands for.
 *   B.Tech, B.E, B.Sc, B.A, BBA, BCA -> "bachelor"
 *   M.Tech, M.Sc, MBA, MCA          -> "master"
 *   Ph.D, D.Sc, Ed.D                -> "doctorate"
 *   Diploma / SSLC / HSC            -> "diploma" / "school"
 * Unknown degrees return "".
 */
export function educationLevelOf(degree) {
  const d = normalizeDegreeToken(degree);
  if (!d) return "";
  if (BACHELOR_DEGREES.has(d)) return "bachelor";
  if (/\bb\.?\s?tech\b|\bb\.?\s?e\b|\bb\.?\s?sc\b|\bb\.?\s?a\b|\bse\b|\bbachelor\b|\bundergraduate\b|\bgraduation\b/.test(d)) return "bachelor";
  if (MASTER_DEGREES.has(d)) return "master";
  if (/\bm\.?\s?tech\b|\bm\.?\s?e\b|\bm\.?\s?sc\b|\bm\.?\s?a\b|\bmaster\b|\bpost[-\s]?graduate\b/.test(d)) return "master";
  if (DOCTORAL_DEGREES.has(d)) return "doctorate";
  if (/\bph\.?\s?d\b|\bdoctorate\b|\bd\.?\s?sc\b/.test(d)) return "doctorate";
  if (/\bdiploma\b/i.test(d)) return "diploma";
  if (/\bsslc\b|\bhsc\b/i.test(d)) return "school";
  return "";
}

/**
 * Which general level a JD education requirement is asking for. Returns
 * "bachelor" | "master" | "doctorate" | "" (mixed or unparseable).
 */
export function educationLevelOfRequirement(text) {
  const t = String(text || "").toLowerCase();
  const asksMaster = /\b(m\.?\s?tech|m\.?\s?e(?:\.|ng)?|m\.?\s?sc|m\.?\s?a|master[’'s]?|post.?graduation|postgraduate|mba|mca)\b/.test(t);
  const asksDoctorate = /\b(ph\.?\s?d|doctorate)\b/.test(t);
  const asksBachelor = /\b(b\.?\s?tech|b\.?\s?sc|b\.?\s?e(?:\.|ng)?|b\.?\s?a|bachelor|undergraduate|graduation|engineering degree|btech)\b/.test(t);
  const asksDiploma = /\bdiploma\b/.test(t);
  if (asksDoctorate) return "doctorate";
  if (asksMaster && !asksBachelor) return "master";
  if (asksBachelor && !asksMaster) return "bachelor";
  if (asksDiploma) return "diploma";
  return ""; // mixed requirement or unclear
}

export { normalizeDegreeToken };

function buildIdf(records) {
  const df = new Map();
  const docs = records.map((r) => tokenize(evidenceText(r)));
  for (const set of docs) {
    for (const t of set) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  const N = records.length || 1;
  for (const [t, d] of df) idf.set(t, Math.log(1 + N / (1 + d)));
  return idf;
}

const CATEGORY_AFFINITY = {
  experience: ["experience", "internship"],
  responsibility: ["experience", "internship", "project"],
  project: ["project"],
  education: ["education"],
  certification: ["certification"],
  technical_skill: ["project", "experience", "internship", "skill"],
  tool: ["project", "experience", "internship", "skill"],
  programming: ["project", "experience", "internship", "skill"],
  programming_language: ["project", "experience", "internship", "skill"],
  framework: ["project", "experience", "internship", "skill"],
  database: ["project", "experience", "internship", "skill"],
  cloud: ["project", "experience", "internship", "skill"],
  analytics_tool: ["project", "experience", "internship", "skill"],
  business_tool: ["project", "experience", "internship", "skill"],
  domain: ["experience", "internship", "project", "skill"],
  domain_knowledge: ["experience", "internship", "project", "skill"],
  analytical: ["experience", "internship", "project", "summary"],
  communication: ["experience", "internship", "project", "leadership", "activity"],
  collaboration: ["experience", "internship", "project", "leadership", "activity"],
  teamwork: ["experience", "internship", "project", "leadership", "activity"],
  soft_skill: ["experience", "internship", "project", "leadership", "activity", "summary"],
  leadership: ["experience", "internship", "project", "leadership", "activity"],
  personal_constraint: [],
  location: [],
  work_authorization: [],
  other: [],
};

export function shortlist(requirement, records, { k = 6, idf = null } = {}) {
  const raw = `${requirement.text} ${requirement.evidence_hint || ""} ${
    (requirement.normalized_concepts || []).join(" ")
  } ${(requirement.tools || []).join(" ")} ${(requirement.keywords || []).join(" ")}`;
  const reqTokens = new Set(tokenize(raw));
  if (reqTokens.size === 0) return [];

  const affinity = CATEGORY_AFFINITY[requirement.category] || [];

  const scored = records
    .map((r) => {
      const evTokens = new Set(tokenize(evidenceText(r)));
      let score = 0;
      const matched = [];
      for (const t of reqTokens) {
        if (evTokens.has(t)) {
          const weight = idf ? idf.get(t) || 1 : 1;
          score += weight;
          matched.push(t);
        }
      }
      // Exact technology match is a strong signal.
      for (const tech of r.technologies || []) {
        const tt = String(tech).toLowerCase();
        if (reqTokens.has(tt)) {
          score += 2;
          matched.push(tech);
        }
      }
      if (affinity.includes(r.category)) score += 0.5;
      // Education requirements: degree-level records are always strong
      // candidates even when the wording differs.
      if (requirement.category === "education" && r.category === "education") score += 1;
      return { record: r, score, matched };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return scored;
}

const IMPORTANCE_WEIGHT = { CRITICAL: 3, IMPORTANT: 2, NICE_TO_HAVE: 1 };

/**
 * Score every evidence record against all requirements (weighted by JD
 * importance). Used for deterministic, truthful reordering recommendations.
 */
export function scoreFacts(requirements, records) {
  const idf = buildIdf(records);
  const scores = new Map();
  for (const req of requirements) {
    const cands = shortlist(req, records, { idf, k: 8 });
    const weight = IMPORTANCE_WEIGHT[req.importance] || 1;
    for (const c of cands) {
      const id = c.record.evidence_id;
      const prev =
        scores.get(id) || { evidence_id: id, score: 0, requirement_ids: [] };
      prev.score += weight * (1 + c.score);
      if (!prev.requirement_ids.includes(req.requirement_id)) {
        prev.requirement_ids.push(req.requirement_id);
      }
      scores.set(id, prev);
    }
  }
  return scores;
}

export function buildRetrieval(requirements, records, { k = 6 } = {}) {
  const idf = buildIdf(records);
  const map = new Map();
  for (const req of requirements) {
    map.set(req.requirement_id, shortlist(req, records, { idf, k }));
  }
  return map;
}

export function formatCandidates(requirements, retrieval) {
  return requirements
    .map((req) => {
      const cands = retrieval.get(req.requirement_id) || [];
      const lines = cands.length
        ? cands
            .map((c) => {
              const r = c.record;
              const sign = r.category === "education" ? `/${educationCompletion(r)}` : "";
              const text = (r.normalized_claim || r.original_text || "")
                .replace(/\s+/g, " ")
                .trim();
              return `    ${r.evidence_id} [${r.status}/${r.skill_level}/${r.category}${sign}] ${text}`;
            })
            .join("\n")
        : "    (no candidate evidence found)";
      const meta = [];
      if ((req.normalized_concepts || []).length) meta.push(`concepts: ${req.normalized_concepts.join(", ")}`);
      if ((req.tools || []).length) meta.push(`tools: ${req.tools.join(", ")} (${req.list_type || "SINGLE"})`);
      return `${req.requirement_id} [${req.importance}/${req.category}] ${req.text}${
        meta.length ? `\n  ${meta.join(" | ")}` : ""
      }\n  candidates:\n${lines}`;
    })
    .join("\n\n");
}
