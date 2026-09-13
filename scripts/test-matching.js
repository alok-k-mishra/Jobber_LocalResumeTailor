import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { TruthDatabase } from "../server/core/truthdb.js";
import {
  sanitizeMatch,
  computeMatchScore,
  buildMatchOverview,
  missingMatchFor,
  summarizeRequirement,
  legacyStatusKey,
  overallLabel,
  requirementTools,
  recomputeAffectedMatches,
  isSemanticallyRelated,
} from "../server/pipeline/matching.js";
import {
  deterministicTechnicalQuestions,
  deterministicUserSpecificQuestions,
  deterministicSoftQuestions,
  deterministicEducationQuestions,
  deterministicYearsQuestions,
  isAnswered,
  technicalQuestionKey,
  generateQuestions,
} from "../server/pipeline/questions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Tiny harness
// ---------------------------------------------------------------------------

const failures = [];
let count = 0;

function check(name, cond, detail = "") {
  count += 1;
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(a, b, where) {
  check(`${where}: deep equal`, isDeepStrictEqual(a, b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}

function isDeepEq(a, b) {
  return isDeepStrictEqual(a, b);
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

let seq = 0;
function record(overrides = {}) {
  seq += 1;
  const text = overrides.text != null ? overrides.text : "Used a named technology to complete a real task.";
  return {
    evidence_id: `E-T${String(seq).padStart(3, "0")}`,
    source_type: "resume",
    source_location: "Projects",
    original_text: text,
    normalized_claim: text,
    status: "VERIFIED",
    confidence: 1,
    skill_level: "LISTED",
    technologies: [],
    section: "Projects",
    category: "project",
    entity: "",
    responsibilities: [],
    outcomes: [],
    metrics: [],
    team_context: "",
    duration: "",
    is_present: false,
    degree: "",
    education_type: "",
    institution: "",
    ...overrides,
  };
}

function req(overrides = {}) {
  return {
    requirement_id: overrides.requirement_id || "JD-REQ-001",
    importance: "CRITICAL",
    category: "technical_skill",
    text: "Requirements placeholder.",
    tools: [],
    list_type: "SINGLE",
    normalized_concepts: [],
    evidence_type: "",
    keywords: [],
    ...overrides,
  };
}

function evidenceMatch(evidence_ids, overrides = {}) {
  return {
    requirement_id: "JD-REQ-001",
    status: "MATCHED",
    evidence_ids,
    evidence: "",
    source: "",
    explanation: "reasoning model verdict under test",
    confidence: 0.8,
    matched_skill_level: undefined,
    ...overrides,
  };
}

function cleanMatchJson(m) {
  return JSON.parse(JSON.stringify(m));
}

// ---------------------------------------------------------------------------
// §27 + user checklist: education semantics
// ---------------------------------------------------------------------------

{
  const edu = record({
    category: "education",
    degree: "B.Tech",
    education_type: "Bachelor's/Undergraduate",
    education_status: "COMPLETED",
    duration: "2022 - 2026",
    text: "Bachelor of Technology, Computer Science and Engineering",
    source_location: "Education",
    section: "Education",
    skill_level: "LISTED",
  });
  const reqEdu = req({
    category: "education",
    importance: "CRITICAL",
    text: "Graduation - B./B.Tech",
    normalized_concepts: ["bachelor degree", "engineering"],
  });
  const db = new TruthDatabase([edu]);
  const m = sanitizeMatch(
    evidenceMatch([edu.evidence_id], { status: "PARTIAL", explanation: "claimed partial" }),
    db,
    new Set([edu.evidence_id]),
    reqEdu
  );
  check("§27 education: completed B.Tech is MATCHED, not PARTIAL", m.status === "MATCHED", m.status);
  check("§27 education: promotion the only demotion reason gone", /Promoted to MATCHED by education validation/.test(m.explanation), m.explanation);
  check("§27 education: evidence verbatim from memory", /Bachelor of Technology/.test(m.evidence), m.evidence);
  check("§27 education: evidence id retained", isDeepEq(m.evidence_ids, [edu.evidence_id]));
}

{
  const inProgress = record({
    category: "education",
    degree: "B.Tech",
    is_present: true,
    text: "B.Tech in Computer Science (2022 - Present)",
    source_location: "Education",
    section: "Education",
    duration: "2022 - present",
    skill_level: "LISTED",
  });
  const reqEdu = req({ category: "education", text: "Graduation - B./B.Tech" });
  const db = new TruthDatabase([inProgress]);
  const m = sanitizeMatch(
    evidenceMatch([inProgress.evidence_id], { status: "PARTIAL" }),
    db,
    new Set([inProgress.evidence_id]),
    reqEdu
  );
  check("§27 education: in-progress B.Tech is NOT promoted to MATCHED", m.status !== "MATCHED", m.status);
}

// §27: completion is never inferred from a duration/end-date/degree name alone.
// A "2022 - 2026" B.Tech with no status, no present flag and no ongoing wording
// is "completion unknown" and must NOT be promoted.
{
  const unknownEdu = record({
    category: "education",
    degree: "B.Tech",
    education_type: "Bachelor's/Undergraduate",
    duration: "2022 - 2026",
    text: "Bachelor of Technology, Computer Science and Engineering",
    source_location: "Education",
    section: "Education",
    skill_level: "LISTED",
  });
  const reqEdu = req({
    category: "education",
    importance: "CRITICAL",
    text: "Graduation - B./B.Tech",
    normalized_concepts: ["bachelor degree", "engineering"],
  });
  const db = new TruthDatabase([unknownEdu]);
  const m = sanitizeMatch(
    evidenceMatch([unknownEdu.evidence_id], { status: "MATCHED", explanation: "claimed matched" }),
    db,
    new Set([unknownEdu.evidence_id]),
    reqEdu
  );
  check("§27 education: completion-unknown B.Tech (2022-2026) is NOT promoted", m.status !== "MATCHED", m.status);
  check("§27 education: no silent graduation inference", /not marked completed/.test(m.explanation), m.explanation);
}

// ---------------------------------------------------------------------------
// §27 + user checklist: project usage vs skills list
// ---------------------------------------------------------------------------

{
  const pyProj = record({
    category: "project",
    skill_level: "PROJECT",
    technologies: ["python", "pandas", "numpy"],
    text: "Built a retail operations KPI dashboard in Python using pandas and numpy.",
  });
  const reqPy = req({
    category: "programming",
    text: "Strong proficiency in Python (Pandas, NumPy)",
    tools: ["python", "pandas", "numpy"],
    list_type: "CUMULATIVE",
  });
  const db = new TruthDatabase([pyProj]);
  const m = sanitizeMatch(evidenceMatch([pyProj.evidence_id]), db, new Set([pyProj.evidence_id]), reqPy);
  check("§27 python project bullet: MATCHED", m.status === "MATCHED", m.status);
  check("§27 python project bullet: DIRECT evidence strength", m.evidence_strength === "DIRECT", m.evidence_strength);
  check("§27 python project bullet: source bound", m.source === "Projects", m.source);
}

{
  const pySk = record({
    category: "skill",
    skill_level: "LISTED",
    technologies: ["python", "pandas", "numpy"],
    text: "Python, Pandas, NumPy",
    source_location: "Skills & Technologies",
    section: "Skills & Technologies",
  });
  const reqPy = req({ category: "programming", text: "Strong proficiency in Python (Pandas, NumPy)", tools: ["python", "pandas", "numpy"], list_type: "CUMULATIVE" });
  const db = new TruthDatabase([pySk]);
  const m = sanitizeMatch(evidenceMatch([pySk.evidence_id]), db, new Set([pySk.evidence_id]), reqPy);
  check("§27 python skills-list only: PARTIAL, not MATCHED", m.status === "PARTIAL", m.status);
  check("§27 skills-list: demotion reason present", /skills-list row/.test(m.explanation), m.explanation);
}

// ---------------------------------------------------------------------------
// §27 + user checklist: years of experience never inferred
// ---------------------------------------------------------------------------

{
  const sqlProj = record({
    category: "project",
    skill_level: "PROJECT",
    technologies: ["sql"],
    text: "Wrote SQL queries to analyse sales and retention for a growth team.",
  });
  const reqYears = req({ category: "database", text: "3+ years of experience with SQL", tools: ["sql"] });
  const db = new TruthDatabase([sqlProj]);
  const m = sanitizeMatch(evidenceMatch([sqlProj.evidence_id]), db, new Set([sqlProj.evidence_id]), reqYears);
  check("§27 3+ years: evidence without stated years is PARTIAL, not invented MATCHED", m.status === "PARTIAL", m.status);
  check("§27 years: no fabricated duration anywhere", !/\b\d+\s*\+?\s*years?\b/i.test(m.evidence), m.evidence);
}

// ---------------------------------------------------------------------------
// §9 / §27 + user checklist: named-tool gating (Salesforce / CRM)
// ---------------------------------------------------------------------------

{
  const crmExp = record({
    category: "experience",
    skill_level: "USED",
    technologies: ["crm"],
    text: "Used CRM software for lead pipeline tracking.",
    source_location: "Experience",
    section: "Experience",
  });
  const reqSF = req({ category: "business_tool", text: "Experience with Salesforce", tools: ["salesforce"] });
  const db = new TruthDatabase([crmExp]);
  const m = sanitizeMatch(evidenceMatch([crmExp.evidence_id]), db, new Set([crmExp.evidence_id]), reqSF);
  check("§9 Salesforce named, CRM-only evidence: PARTIAL (never MATCHED)", m.status === "PARTIAL", m.status);
  check("§9 Salesforce: gap explained", /names tool\(s\) \[salesforce\]/.test(m.explanation), m.explanation);

  const gap = missingMatchFor(reqSF, false);
  check("§9 Salesforce, no CRM evidence at all: NOT_MATCHED gap", gap.status === "NOT_MATCHED", gap.status);
  check("§9 no-evidence gap: strength NONE", gap.evidence_strength === "NONE");
}

// ---------------------------------------------------------------------------
// §17 / §18 / §27 + user checklist: alternatives & examples
// ---------------------------------------------------------------------------

{
  const tabl = record({
    category: "experience",
    skill_level: "USED",
    technologies: ["tableau"],
    text: "Built Tableau dashboards for weekly growth reporting.",
    source_location: "Experience",
    section: "Experience",
  });
  const reqViz = req({
    category: "analytics_tool",
    text: "Tableau, Power BI, or Looker",
    tools: ["tableau", "power bi", "looker"],
    list_type: "ALTERNATIVES",
  });
  const db = new TruthDatabase([tabl]);
  const m = sanitizeMatch(evidenceMatch([tabl.evidence_id]), db, new Set([tabl.evidence_id]), reqViz);
  check("§18 alternatives: one satisfied alternative (Tableau) is MATCHED", m.status === "MATCHED", m.status);
  check("§18 alternatives: DIRECT strength", m.evidence_strength === "DIRECT", m.evidence_strength);

  const excel = record({
    category: "project",
    skill_level: "PROJECT",
    technologies: ["excel"],
    text: "Built an Excel dashboard for sales tracking.",
  });
  const db2 = new TruthDatabase([excel]);
  const m2 = sanitizeMatch(evidenceMatch([excel.evidence_id]), db2, new Set([excel.evidence_id]), reqViz);
  check("§18 alternatives: none of the named tools shown is PARTIAL", m2.status === "PARTIAL", m2.status);
}

// ---------------------------------------------------------------------------
// §27 + user checklist: generic analytical language is not auto-PARTIAL
// ---------------------------------------------------------------------------

{
  const ana = record({
    category: "experience",
    skill_level: "PROFESSIONAL",
    technologies: [],
    text: "Led the retail operations business metrics analysis for monthly reviews.",
    source_location: "Experience",
    section: "Experience",
  });
  const reqAnalytical = req({
    category: "analytical",
    text: "Exceptional analytical and quantitative skills, with the ability to collect, organize, analyze, and disseminate information with attention to detail",
  });
  const db = new TruthDatabase([ana]);
  const m = sanitizeMatch(evidenceMatch([ana.evidence_id]), db, new Set([ana.evidence_id]), reqAnalytical);
  check("§27 generic analytical + solid project: MATCHED preserved (not auto-PARTIAL)", m.status === "MATCHED", m.status);

  const anaSkill = record({
    category: "skill",
    skill_level: "LISTED",
    technologies: [],
    text: "Analytical thinking, problem solving",
    source_location: "Skills & Technologies",
    section: "Skills & Technologies",
  });
  const db2 = new TruthDatabase([anaSkill]);
  const m2 = sanitizeMatch(evidenceMatch([anaSkill.evidence_id]), db2, new Set([anaSkill.evidence_id]), reqAnalytical);
  check("§27 skills-only + soft category: MATCHED not demoted (no technical skills cap)", m2.status === "MATCHED", m2.status);
}

// ---------------------------------------------------------------------------
// §23 / §7: evidence validation fails closed
// ---------------------------------------------------------------------------

{
  const rec = record({ text: "Built predictive models with Python." });
  const db = new TruthDatabase([rec]);
  const reqT = req({ category: "programming", text: "Predictive modelling in Python", tools: ["python"] });

  const bad = sanitizeMatch(
    evidenceMatch(["E-DOES-NOT-EXIST", rec.evidence_id], { status: "MATCHED" }),
    db,
    new Set([rec.evidence_id]),
    reqT
  );
  check("§23 unknown evidence id dropped, usable kept", isDeepEq(bad.evidence_ids, [rec.evidence_id]), JSON.stringify(bad.evidence_ids));
  check("§23 rejected evidence recorded", isDeepEq(bad.rejected_evidence_ids, ["E-DOES-NOT-EXIST"]), JSON.stringify(bad.rejected_evidence_ids));

  const none = sanitizeMatch(
    evidenceMatch(["E-DOES-NOT-EXIST"], { status: "MATCHED" }),
    db,
    new Set(),
    reqT
  );
  check("§23 no usable evidence -> NOT_MATCHED", none.status === "NOT_MATCHED", none.status);
  check("§23 no usable evidence -> rejected_evidence_ids tracked", isDeepEq(none.rejected_evidence_ids, ["E-DOES-NOT-EXIST"]));
}

// ---------------------------------------------------------------------------
// Score determinism, labels, overview
// ---------------------------------------------------------------------------

function scoreFixture() {
  const r1 = req({ requirement_id: "JD-REQ-01", importance: "CRITICAL", category: "database", text: "SQL for data extraction", tools: ["sql"] });
  const r2 = req({ requirement_id: "JD-REQ-02", importance: "CRITICAL", category: "analytical", text: "Analytical and quantitative skills" });
  const r3 = req({ requirement_id: "JD-REQ-03", importance: "IMPORTANT", category: "database", text: "ETL pipeline experience", tools: ["etl"] });
  const r4 = req({ requirement_id: "JD-REQ-04", importance: "NICE_TO_HAVE", category: "cloud", text: "Cloud deployment", tools: ["aws"] });
  const r5 = req({ requirement_id: "JD-REQ-05", importance: "CRITICAL", category: "analytics_tool", text: "Dashboard reporting", tools: ["tableau"] });
  const matches = [
    { requirement_id: "JD-REQ-01", status: "MATCHED" },
    { requirement_id: "JD-REQ-02", status: "MATCHED" },
    { requirement_id: "JD-REQ-03", status: "PARTIAL" },
    { requirement_id: "JD-REQ-04", status: "NOT_MATCHED" },
    { requirement_id: "JD-REQ-05", status: "MATCHED" },
  ];
  return { requirements: [r1, r2, r3, r4, r5], matches };
}

{
  const fixtures = [scoreFixture(), scoreFixture()];
  const a = computeMatchScore(fixtures[0].requirements, fixtures[0].matches);
  const b = computeMatchScore(fixtures[1].requirements, fixtures[1].matches);
  eq(a, b, "percent determinism (identical input twice)");
  check("score deterministic: percent", a.percent === 81, `${a.percent}`);
  check("score deterministic: label", a.label === "Good Match", a.label);
  check("score counts", isDeepEq([a.matched, a.partial, a.not_matched, a.unknown], [3, 1, 1, 0]));

  check("label thresholds: 85 Strong", overallLabel(85) === "Strong Match");
  check("label thresholds: 70 Good", overallLabel(70) === "Good Match");
  check("label thresholds: 55 Moderate", overallLabel(55) === "Moderate Match");
  check("label thresholds: 40 Weak", overallLabel(40) === "Weak Match");
  check("label thresholds: 39 Low", overallLabel(39) === "Low Match");

  const overview = buildMatchOverview({
    jd: { requirements: fixtures[0].requirements },
    matches: fixtures[0].matches,
    questions: [
      { question: "Have you used Looker?", answered: false },
      { question: "Answered already?", answered: true },
    ],
  });
  check("overview: label+percent lead", overview.label === "Good Match" && overview.percent === 81);
  check("overview: strengths from MATCHED by weight", isDeepEq(overview.strengths, [
    "sql",
    "tableau",
    "Analytical and quantitative skills",
  ]), JSON.stringify(overview.strengths));
  check("overview: partials", isDeepEq(overview.partials, ["etl"]));
  check("overview: gaps", isDeepEq(overview.gaps, ["aws"]));
  check("overview: uncertain empty", isDeepEq(overview.uncertain, []));
  check("overview: open questions only", isDeepEq(overview.questions_for_you, ["Have you used Looker?"]));
  check("overview: main_gap is the top NOT_MATCHED (aws)", isDeepEq(overview.main_gap, {
    kind: "gap",
    label: "aws",
    requirement_id: "JD-REQ-04",
    match_status: "NOT_MATCHED",
    note: "",
  }), JSON.stringify(overview.main_gap));
}

{
  // Main gap falls back to the top UNKNOWN when there is no NOT_MATCHED.
  const uncertain = buildMatchOverview({
    jd: { requirements: [
      req({ requirement_id: "Y1", importance: "CRITICAL", text: "Python for analysis" }),
      req({ requirement_id: "Y2", importance: "IMPORTANT", text: "Willing to relocate" }),
    ] },
    matches: [
      { requirement_id: "Y1", status: "MATCHED" },
      { requirement_id: "Y2", status: "UNKNOWN", explanation: "No evidence. [waiting-answer]" },
    ],
    questions: [],
  });
  check("overview: main_gap kind 'confirm' when only UNKNOWN", uncertain.main_gap?.kind === "confirm" && uncertain.main_gap?.label === "Willing to relocate", JSON.stringify(uncertain.main_gap));
  check("overview: main_gap note strips cap bracket markers", uncertain.main_gap?.note === "No evidence.", JSON.stringify(uncertain.main_gap));

  const cleared = buildMatchOverview({
    jd: { requirements: [req({ requirement_id: "Y3", text: "SQL" })] },
    matches: [{ requirement_id: "Y3", status: "MATCHED" }],
    questions: [],
  });
  check("overview: no main_gap when everything has evidence", cleared.main_gap === null, JSON.stringify(cleared.main_gap));
}

{
  const legacy = buildMatchOverview({
    jd: { requirements: [req({ requirement_id: "X1", text: "Old strong" }), req({ requirement_id: "X2", text: "Old weak" })] },
    matches: [
      { requirement_id: "X1", status: "STRONG_MATCH" },
      { requirement_id: "X2", status: "PARTIAL_MATCH" },
    ],
    questions: [],
  });
  check("legacy: STRONG_MATCH -> strengths", isDeepEq(legacy.strengths, ["Old strong"]), JSON.stringify(legacy.strengths));
  check("legacy: PARTIAL_MATCH -> partials", isDeepEq(legacy.partials, ["Old weak"]), JSON.stringify(legacy.partials));
}

// ---------------------------------------------------------------------------
// missingMatchFor: UNKNOWN vs NOT_MATCHED fallback (§3, §9, §10)
// ---------------------------------------------------------------------------

{
  const concrete = req({ category: "database", text: "Proficiency with SQL", tools: ["sql"] });
  check("fallback: concrete technical, no candidates -> NOT_MATCHED", missingMatchFor(concrete, false).status === "NOT_MATCHED");
  check("fallback: concrete technical, candidates but no verdict -> UNKNOWN", missingMatchFor(concrete, true).status === "UNKNOWN");

  const soft = req({ category: "analytical", text: "Problem-solving skills" });
  check("fallback: soft, no candidates -> UNKNOWN", missingMatchFor(soft, false).status === "UNKNOWN");

  const personal = req({ category: "work_authorization", text: "Working right to work in the UK" });
  check("fallback: personal condition, no candidates -> UNKNOWN", missingMatchFor(personal, false).status === "UNKNOWN");
  check("fallback: never fabricates evidence", missingMatchFor(personal, false).evidence_ids.length === 0);
}

// ---------------------------------------------------------------------------
// Deterministic technical questions + cross-JD reuse (§12)
// ---------------------------------------------------------------------------

{
  const lookerReq = req({
    requirement_id: "JD-REQ-10",
    importance: "CRITICAL",
    category: "analytics_tool",
    text: "Proficiency with data visualization tools (e.g., Tableau, Power BI, Looker)",
    tools: ["looker"],
    list_type: "EXAMPLES",
  });
  const lookerMatch = [{ requirement_id: "JD-REQ-10", status: "UNKNOWN", evidence_strength: "NONE" }];
  const empty = { byKey: new Map(), byText: new Map() };

  const fresh = deterministicTechnicalQuestions([lookerReq], lookerMatch, empty, 6);
  check("§12 new Looker question generated", fresh.length === 1 && fresh[0].question === "Have you used Looker?", JSON.stringify(fresh));
  check("§12 canonical key stable", fresh[0].key === "tech_looker", fresh[0].key);

  const answeredByKey = { byKey: new Map([["tech_looker", "Yes"]]), byText: new Map() };
  check("§12 stored answer reused (by key): no re-ask", deterministicTechnicalQuestions([lookerReq], lookerMatch, answeredByKey, 6).length === 0);
  check("technicalQuestionKey is order-independent", technicalQuestionKey(["bi", "tableau"]) === technicalQuestionKey(["tableau", "bi"]));

  const answeredByText = { byKey: new Map(), byText: new Map([["haveyouusedlooker", "Yes"]]) };
  check("§12 stored answer reused (by question text)", deterministicTechnicalQuestions([lookerReq], lookerMatch, answeredByText, 6).length === 0);
  check("isAnswered via key", isAnswered(answeredByKey, "tech_looker", ""));
  check("isAnswered via text", isAnswered(answeredByText, null, "Have you used Looker?"));

  const demoed = [{ requirement_id: "JD-REQ-10", status: "MATCHED", evidence_strength: "DIRECT" }];
  check("§12 already-demonstrated tool: no question", deterministicTechnicalQuestions([lookerReq], demoed, empty, 6).length === 0);

  const salesforceReq = req({
    requirement_id: "JD-REQ-11",
    importance: "IMPORTANT",
    category: "business_tool",
    text: "Experience with CRM systems (e.g., Salesforce)",
    tools: ["salesforce"],
    list_type: "EXAMPLES",
  });
  const sf = deterministicTechnicalQuestions([salesforceReq], [{ requirement_id: "JD-REQ-11", status: "NOT_MATCHED", evidence_strength: "NONE" }], empty, 6);
  check("§12 Salesforce gap question", sf[0]?.question === "Have you used Salesforce?", JSON.stringify(sf));
  check("§12 Salesforce key", sf[0]?.key === "tech_salesforce", sf[0]?.key);

  const altReq = req({
    requirement_id: "JD-REQ-12",
    importance: "CRITICAL",
    category: "analytics_tool",
    text: "Tableau, Power BI, or Looker",
    tools: ["tableau", "power bi", "looker"],
    list_type: "ALTERNATIVES",
  });
  const alt = deterministicTechnicalQuestions([altReq], [{ requirement_id: "JD-REQ-12", status: "UNKNOWN", evidence_strength: "NONE" }], empty, 6);
  check("§12 alternatives: one confirmation questions covers them", alt[0]?.question === "Have you used Tableau, Power BI, or Looker?", JSON.stringify(alt));
  check("§12 alternatives: sorted canonical key", alt[0]?.key === `tech_${["looker", "powerbi", "tableau"].join("")}`, alt[0]?.key);

  check("requirementTools prefers structured list", isDeepEq(requirementTools(lookerReq), ["looker"]));
}

// ---------------------------------------------------------------------------
// Deterministic user-specific condition questions (§12 personal)
// ---------------------------------------------------------------------------

{
  const relocReq = req({
    requirement_id: "JD-REQ-13",
    importance: "IMPORTANT",
    category: "personal_constraint",
    text: "Willing to relocate to Bengaluru",
  });
  const empty = { byKey: new Map(), byText: new Map() };
  const qs = deterministicUserSpecificQuestions(
    [relocReq],
    [{ requirement_id: "JD-REQ-13", status: "UNKNOWN", evidence_strength: "NONE" }],
    empty,
    6
  );
  check("§12 relocation condition question raised", qs.length === 1 && /are you able to meet this requirement/.test(qs[0].question), JSON.stringify(qs));
  check("§12 condition key stable", qs[0].key === "cond_relocate", qs[0].key);

  const answered = { byKey: new Map([["cond_relocate", "Yes"]]), byText: new Map() };
  check("§12 reloc answered previously: not re-asked", deterministicUserSpecificQuestions([relocReq], [{ requirement_id: "JD-REQ-13", status: "UNKNOWN" }], answered, 6).length === 0);
}

// ---------------------------------------------------------------------------
// summarizeRequirement
// ---------------------------------------------------------------------------

{
  check("summary: tools verbatim", summarizeRequirement(req({ tools: ["tableau", "power bi", "looker"] })) === "tableau / power bi / looker");
  check("summary: education level", summarizeRequirement(req({ category: "education", text: "Graduation - B./B.Tech" })) === "Bachelor's degree");
  check("summary: trimmed text fallback", summarizeRequirement(req({ text: "Proficiency with SQL for data extraction" })) === "Proficiency with SQL for data extraction");
  check("legacy status mapping", legacyStatusKey("STRONG_MATCH") === "MATCHED" && legacyStatusKey("PARTIAL_MATCH") === "PARTIAL" && legacyStatusKey("WEAK_MATCH") === "PARTIAL" && legacyStatusKey("NO_EVIDENCE") === "NOT_MATCHED" && legacyStatusKey("CONTRADICTED") === "NOT_MATCHED" && legacyStatusKey("UNKNOWN") === "UNKNOWN");
}

// ---------------------------------------------------------------------------
// Data model: the persisted old session must keep loading and rendering
// ---------------------------------------------------------------------------

{
  const file = path.join(ROOT, "data", "sessions", "4e4f6867-8d87-47a3-b196-7fbdc8f1e36f.json");
  const raw = fs.readFileSync(file, "utf8");
  const s = JSON.parse(raw);
  const canonical = new Set(["MATCHED", "PARTIAL", "NOT_MATCHED", "UNKNOWN"]);
  const matches = s.matches || [];
  check("legacy session: matches present", matches.length > 0, `${matches.length}`);
  for (const m of matches) {
    const mapped = legacyStatusKey(m.status);
    check(`legacy session: status "${m.status}" maps/loses no render info`, canonical.has(mapped) || mapped === m.status, mapped);
  }
  check("legacy session: each match carries requirement_id/evidence_ids", matches.every((m) => m.requirement_id && Array.isArray(m.evidence_ids)), JSON.stringify(matches[0] || null));
  check("legacy session: overview derivable without match_score (UI fallback)", (() => {
    const ov = buildMatchOverview(s);
    return typeof ov.label === "string" && typeof ov.percent === "number" && Array.isArray(ov.strengths);
  })());
  check("legacy session: match_score optional — absent in a legacy model, structurally valid when present", s.match_score === undefined || (typeof s.match_score.percent === "number" && typeof s.match_score.label === "string"), JSON.stringify(s.match_score));
}

// ---------------------------------------------------------------------------
// §25: live re-evaluation of affected matches from a single answer
// ---------------------------------------------------------------------------

{
  // Salesforce "No" -> NOT_MATCHED immediately, no LLM round-trip.
  const sfReq = req({
    requirement_id: "JD-REQ-20",
    category: "business_tool",
    text: "Hands-On Salesforce CRM (Salesforce Lighting/Admin)",
    tools: ["salesforce"],
  });
  const session = {
    jd: { requirements: [sfReq] },
    truth_db: [],
    matches: [{ requirement_id: "JD-REQ-20", status: "UNKNOWN", evidence_ids: [], explanation: "no evidence yet" }],
    answers: [],
    questions: [{ question_id: "Q-1", question: "Hands-On Salesforce CRM...", answered: false }],
  };
  const db = new TruthDatabase([]);
  const out = recomputeAffectedMatches(session, db, {
    answeredReqId: "JD-REQ-20",
    answerRecord: {
      question: "Hands-On Salesforce CRM (Salesforce Lighting/Admin) — are you able to meet this requirement?",
      answer: "No, I have no Salesforce experience",
      key: "tech_salesforce",
      requirement_id: "JD-REQ-20",
      declined: true,
      normalized_claim: "",
    },
  });
  const m = out.matches.find((x) => x.requirement_id === "JD-REQ-20");
  check("§25 Salesforce No -> NOT_MATCHED immediately", m.status === "NOT_MATCHED", m.status);
  check("§25 decline explanation cites the user answer", /answered no/i.test(m.explanation), m.explanation);
  check("§25 match_score recomputed after the answer", typeof out.match_score?.percent === "number", JSON.stringify(out.match_score));
  check("§25 overview rebuilt after the answer", typeof out.match_overview?.percent === "number", JSON.stringify(out.match_overview));
}

{
  // SQL "Yes" -> MATCHED citing the USER_CONFIRMED answer evidence.
  const userAnswer = record({
    source_type: "user_answer",
    category: "other",
    status: "USER_CONFIRMED",
    normalized_claim: "Uses SQL for data extraction and daily reporting.",
    original_text: "Yes, I use SQL every day for reporting",
    technologies: [],
  });
  const sqlReq = req({
    requirement_id: "JD-REQ-21",
    category: "database",
    text: "Proficiency with SQL for data extraction",
    tools: ["sql"],
  });
  const session = {
    jd: { requirements: [sqlReq] },
    truth_db: [userAnswer],
    matches: [{ requirement_id: "JD-REQ-21", status: "UNKNOWN", evidence_ids: [], explanation: "no evidence yet" }],
    answers: [],
    questions: [],
  };
  const db = new TruthDatabase([userAnswer]);
  const out = recomputeAffectedMatches(session, db, {
    answeredReqId: "JD-REQ-21",
    answerRecord: {
      question: "Have you used SQL?",
      answer: "Yes, I use SQL every day for reporting",
      key: "tech_sql",
      requirement_id: "JD-REQ-21",
      declined: false,
      normalized_claim: "Uses SQL for data extraction and daily reporting.",
      skill_level: "USED",
      evidence_id: userAnswer.evidence_id,
    },
  });
  const m = out.matches.find((x) => x.requirement_id === "JD-REQ-21");
  check("§25 SQL Yes -> MATCHED immediately", m.status === "MATCHED", m.status);
  check("§25 confirmed match cites the answer evidence", m.evidence_ids.includes(userAnswer.evidence_id), JSON.stringify(m.evidence_ids));
  check("§25 evidence verbatim from the user answer", /I use SQL/.test(m.evidence), m.evidence);
}

{
  // Confirming answers never downgrade an already-MATCHED unrelated requirement,
  // and a "No" on the answered requirement still wins over its own MATCHED.
  const rrReq = req({
    requirement_id: "JD-REQ-22",
    category: "database",
    text: "Strong proficiency in a report runner",
    tools: ["reportrunner"],
  });
  const sfReq = req({
    requirement_id: "JD-REQ-23",
    category: "business_tool",
    text: "Salesforce CRM experience",
    tools: ["salesforce"],
  });
  const session = {
    jd: { requirements: [rrReq, sfReq] },
    truth_db: [],
    matches: [
      { requirement_id: "JD-REQ-22", status: "MATCHED", evidence_ids: [], explanation: "solid match" },
      { requirement_id: "JD-REQ-23", status: "PARTIAL", evidence_ids: [], explanation: "claimed partial" },
    ],
    answers: [],
    questions: [],
  };
  const out = recomputeAffectedMatches(session, new TruthDatabase([]), {
    answeredReqId: "JD-REQ-23",
    answerRecord: {
      question: "Are you comfortable with Salesforce?",
      answer: "No",
      key: "tech_salesforce",
      requirement_id: "JD-REQ-23",
      declined: true,
      normalized_claim: "",
    },
  });
  const rr = out.matches.find((x) => x.requirement_id === "JD-REQ-22");
  const sf = out.matches.find((x) => x.requirement_id === "JD-REQ-23");
  check("§25 unrelated MATCHED survives another answer", rr.status === "MATCHED", rr.status);
  check("§25 direct No still downgrades its own requirement", sf.status === "NOT_MATCHED", sf.status);
}

// ---------------------------------------------------------------------------
// §25: isSemanticallyRelated — which requirements one answer also resolves
// ---------------------------------------------------------------------------

{
  const teamworkReq = req({ requirement_id: "JD-REQ-30", category: "collaboration", text: "Collaborate with cross-functional teams on analytics" });
  const lonerReq = req({ requirement_id: "JD-REQ-31", category: "analytical", text: "Deep familiarity with customer churn modeling" });
  const ans = { key: "soft_collaboration", requirement_id: "JD-REQ-30", answer: "Yes, I work with data and product teams daily", normalized_claim: "Works with cross-functional teams on shared analytics goals." };
  check("§25 semantic: answer links to matching teamwork req", isSemanticallyRelated(teamworkReq, ans), "");
  check("§25 semantic: unrelated churn-modeling req not linked", !isSemanticallyRelated(lonerReq, ans), "");
  const eduReq = req({ requirement_id: "JD-REQ-32", category: "education", text: "Bachelor's degree required" });
  check("§25 semantic: edu_status answer links to education req", isSemanticallyRelated(eduReq, { key: "edu_status_bachelor", requirement_id: "JD-REQ-32", answer: "Yes, completed" }), "");
}

// ---------------------------------------------------------------------------
// §25: question coverage — education status, years, soft gap-fill, dedupe
// ---------------------------------------------------------------------------

{
  const emptyStore = { byKey: new Map(), byText: new Map(), byReq: new Set() };
  const unknownMatch = (id) => ({ requirement_id: id, status: "UNKNOWN", evidence_strength: "NONE" });

  // Soft skill gap-fill covers interpersonal/analytical wording the LLM might skip.
  const interReq = req({ requirement_id: "JD-REQ-40", importance: "IMPORTANT", category: "soft_skill", text: "Effective interpersonal skills and stakeholder communication" });
  const soft = deterministicSoftQuestions([interReq], [unknownMatch("JD-REQ-40")], emptyStore, 6);
  check("§25 soft gap-fill raises an interpersonal question", soft.length === 1 && /interpersonal/i.test(soft[0].question), JSON.stringify(soft));
  check("§25 soft key stable prefix", soft[0].key.startsWith("soft_"), soft[0].key);

  // Education status question only fires for a matching-level record with
  // unknown completion.
  const unknownEdu = record({
    category: "education", degree: "B.Tech", education_type: "Bachelor's/Undergraduate",
    duration: "2022 - 2026", text: "B.Tech Computer Science", section: "Education",
  });
  const eduSession = {
    jd: { requirements: [] },
    truth_db: [unknownEdu],
  };
  const eduReq = req({ requirement_id: "JD-REQ-41", importance: "CRITICAL", category: "education", text: "Graduation - B.Tech" });
  const eduQ = deterministicEducationQuestions(
    { ...eduSession, jd: { requirements: [eduReq] } },
    [unknownMatch("JD-REQ-41")],
    emptyStore,
    6
  );
  check("§25 education-status question raised for completion-unknown record", eduQ.length === 1 && eduQ[0].key === "edu_status_bachelor", JSON.stringify(eduQ));
  const completedEdu = { ...unknownEdu, evidence_id: "E-COMPLETED", education_status: "COMPLETED" };
  const completedSession = { ...eduSession, truth_db: [completedEdu] };
  const eduQ2 = deterministicEducationQuestions({ ...completedSession, jd: { requirements: [eduReq] } }, [unknownMatch("JD-REQ-41")], emptyStore, 6);
  check("§25 no education question once completion is known", eduQ2.length === 0, JSON.stringify(eduQ2));

  // Years-of-experience question fires for experience/“N+ years” requirements.
  const yrsReq = req({ requirement_id: "JD-REQ-42", importance: "CRITICAL", category: "experience", text: "3+ years of experience with data warehouses" });
  const yrs = deterministicYearsQuestions([yrsReq], [unknownMatch("JD-REQ-42")], emptyStore, 6);
  check("§25 years question raised", yrs.length === 1 && yrs[0].key === "years_experience", JSON.stringify(yrs));
  check("§25 years options are explicit numbers", yrs[0].options.includes("3") && yrs[0].options.includes("5+"), JSON.stringify(yrs[0].options));
}

// §25: one requirement is never double-asked — technical and years layers both
// target the same req, generateQuestions (deterministic layers only, no LLM)
// must emit exactly one question.
{
  const overlapReq = req({
    requirement_id: "JD-REQ-50",
    importance: "CRITICAL",
    category: "technical_skill",
    text: "3+ years experience with Kinesis for streaming analytics",
    tools: ["kinesis"],
  });
  const session = {
    jd: { requirements: [overlapReq] },
    truth_db: [],
    matches: [{ requirement_id: "JD-REQ-50", status: "UNKNOWN", evidence_strength: "NONE" }],
    answers: [],
    questions: [],
  };
  const out = await generateQuestions(session);
  const for50 = out.questions.filter((q) => q.requirement_id === "JD-REQ-50");
  check("§25 no duplicate question for the same requirement", for50.length <= 1, JSON.stringify(for50));
  if (for50.length === 1) {
    check("§25 technical layer wins the overlapping requirement", for50[0].key === "tech_kinesis", for50[0].key);
  }
  for (const q of out.questions) {
    check("§25 every question carries a state marker", q.state === "UNANSWERED", q.state);
  }
}

// ---------------------------------------------------------------------------
// §25 + §27: education status survives upload diffing and applying
// ---------------------------------------------------------------------------

{
  const { diffResume, applyAcceptedChanges } = await import("../server/core/resumeMemory.js");
  const memory = {
    truth_db: [
      {
        evidence_id: "RESUME-EDU-001",
        source_type: "resume",
        status: "VERIFIED",
        section: "EDUCATION",
        category: "education",
        degree: "B.Tech",
        education_type: "Bachelor's/Undergraduate",
        institution: "VIT Bhopal University",
        education_status: "COMPLETED",
        original_text: "Bachelor of Technology (2022 - 2026)",
        normalized_claim: "Bachelor of Technology (2022 - 2026)",
      },
    ],
  };
  const newFacts = [
    {
      section: "EDUCATION",
      category: "education",
      degree: "B.Tech",
      education_type: "Bachelor's/Undergraduate",
      institution: "VIT Bhopal University",
      original_text: "B.Tech (expected graduation May 2027)",
      normalized_claim: "B.Tech (expected graduation May 2027)",
    },
  ];
  const diff = diffResume(newFacts, memory);
  check("§27 diff surfaces education_status conflict", (diff.education_conflicts || []).length > 0, JSON.stringify(diff.education_conflicts));
  const accepted = applyAcceptedChanges(memory, newFacts, new Set(["EDUCATION"]));
  const kept = (accepted.truth_db || []).find((r) => r.category === "education");
  check("§27 applying a newer resume carries the confirmed education_status over", kept.education_status === "COMPLETED", JSON.stringify(kept));
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const okCount = count - failures.length;
console.log(`\nMatching harness: ${okCount}/${count} checks passed`);
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}