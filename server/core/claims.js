import { USABLE_EVIDENCE_STATUS } from "../schemas/index.js";
import { tokenize, STOPWORDS } from "./retrieval.js";

const CAP_TOKEN_RE = /\b(?:[A-Z][a-zA-Z0-9+#.]{1,}|[A-Z]{2,})\b/g;
const RAW_TOKEN_RE = /[a-z0-9+#.]+/g;

// Raw token extraction that strips trailing sentence punctuation while keeping
// meaningful internal dots (e.g. "node.js"). Without this, a sentence-final
// novel term such as "Kubernetes." would not match the generated-token set and
// would slip past the novel-term guard.
function rawTokens(text) {
  return (String(text || "").toLowerCase().match(RAW_TOKEN_RE) || [])
    .map((t) => t.replace(/\.+$/, ""))
    .filter(Boolean);
}

function stemToken(t) {
  let s = String(t).toLowerCase();
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

/**
 * Vocabulary of domain/tool terms the JD cares about. Used to detect keywords
 * that the model injects into generated content without candidate evidence
 * (spec §47: no fake keyword stuffing).
 */
export function buildSensitiveVocabulary(jd) {
  const set = new Set();
  const add = (w) => {
    if (w && w.length >= 3) set.add(w);
  };
  for (const k of jd?.keywords || []) add(k);
  for (const r of jd?.requirements || []) {
    for (const m of String(r.text).match(CAP_TOKEN_RE) || []) add(m);
  }
  // The target job title and company are legitimately named in a cover letter,
  // so they must not be treated as injected keywords.
  const allowed = new Set(
    [...tokenize(`${jd?.job_title || ""} ${jd?.company || ""}`)].map(stemToken)
  );
  for (const term of [...set]) {
    if (allowed.has(stemToken(term))) set.delete(term);
  }
  return set;
}

/**
 * Truthful-tailoring guard for rewrites.
 *
 * The old closed-vocabulary guard rejected any rewrite whose wording was not
 * literally present in the evidence. That was too strict for the semantic
 * standard: the model is allowed to paraphrase, restructure and re-inflect the
 * candidate's verified facts. What it may NOT do is introduce facts the resume
 * never claims (metrics, dates, domain terms, changed employers/roles/projects)
 * or inflate scope/seniority. This guard returns warnings only for those
 * meaning-level violations, so genuine paraphrases survive.
 */
const STRONG_SCOPE_TERMS = [
  "led",
  "lead",
  "leading",
  "headed",
  "head of",
  "managed",
  "managing",
  "owned",
  "owning",
  "architected",
  "spearheaded",
  "spearhead",
  "directed",
  "supervised",
  "oversaw",
  "mentored",
  "coached",
  "pioneered",
  "production",
  "enterprise",
  "scalable",
  "cross-functional",
  "stakeholder",
  "stakeholders",
  "expert",
  "expertise",
  "advanced",
  "professional",
  "deployed",
  "orchestrated",
  "transformed",
  "revamped",
  // Architecture/scope nouns that imply a heavier deliverable than an ad-hoc
  // script or analysis. Only flagged as possible exaggeration when the term is
  // absent from the evidence (e.g. "built a data pipeline" from a "cleaned and
  // validated location data in Python" bullet).
  "pipeline",
  "pipelines",
  "framework",
  "frameworks",
  "platform",
  "platforms",
  "engine",
  "microservices",
  "solution",
  "solutions",
  "architecture",
  "stack",
];

export function semanticTruthGuard(
  generatedText,
  evidenceRecords,
  { sensitiveVocab = new Set(), allowedTerms = [] } = {}
) {
  const warnings = [
    ...deterministicGuard(generatedText, evidenceRecords),
    ...novelContentGuard(generatedText, evidenceRecords, sensitiveVocab, allowedTerms),
  ];
  return warnings;
}

/**
 * Strict closed-vocabulary guard for rewrites: every content word in the
 * generated text must already exist (by stem) in the supporting evidence.
 * The model may delete, reorder and lightly re-inflect the candidate's own
 * words, but it may not introduce new content words.
 *
 * DEPRECATED: superseded by semanticTruthGuard, which allows paraphrase. Kept
 * only so older callers can still import it; new code must not use it.
 */
export function closedVocabularyGuard(generatedText, evidenceRecords, extraAllowed = []) {
  const evText = evidenceRecords
    .map(
      (r) =>
        `${r.original_text} ${r.normalized_claim} ${(r.technologies || []).join(" ")} ${r.entity || ""}`
    )
    .join(" ");
  const allowed = new Set([...tokenize(evText)].map(stemToken));
  for (const w of extraAllowed) {
    for (const t of tokenize(w)) allowed.add(stemToken(t));
  }

  const warnings = [];
  const seen = new Set();
  for (const token of tokenize(generatedText)) {
    const stem = stemToken(token);
    if (allowed.has(stem)) continue;
    if (seen.has(stem)) continue;
    seen.add(stem);
    warnings.push({
      type: "NOVEL_CONTENT_WORD",
      message: `Word "${token}" in the rewrite is not present in the candidate's evidence, so the rewrite is not allowed to introduce it.`,
    });
  }
  return warnings;
}

// Common technologies/tools/platforms. A generated rewrite that names one of
// these without the evidence naming it is an invented technology — a hard,
// fact-level violation. Ordinary English words are deliberately NOT tracked:
// a legitimate paraphrase may freely change generic wording.
const TECH_TERMS = new Set([
  "python", "sql", "mysql", "postgresql", "postgres", "sqlite", "oracle", "mssql",
  "excel", "tableau", "powerbi", "power bi", "pandas", "numpy", "scipy",
  "scikit-learn", "sklearn", "tensorflow", "pytorch", "keras", "dplyr", "ggplot",
  "spark", "pyspark", "hadoop", "hive", "kafka", "airflow", "dbt", "snowflake",
  "bigquery", "redshift", "databricks", "s3", "ec2", "lambda", "terraform",
  "docker", "kubernetes", "k8s", "git", "github", "gitlab", "jenkins", "ci/cd",
  "react", "react.js", "reactjs", "next.js", "node", "node.js", "nodejs",
  "express", "django", "flask", "fastapi", "spring", "java", "javascript",
  "typescript", "c#", "c++", "php", "ruby", "rails", "golang", "html", "css",
  "sass", "tailwind", "bootstrap", "angular", "vue", "flutter", "dart", "kotlin",
  "swift", "cypress", "selenium", "jest", "mocha", "pytest", "aws", "azure",
  "gcp", "google cloud", "nginx", "apache", "linux", "mongo", "mongodb", "redis",
  "elasticsearch", "stata", "spss", "matlab", "jupyter", "jupyterlab", "colab",
  "langchain", "openai", "tableau prep", "alteryx", "etl", "etls",
]);

// Capitalized English nouns that appear all over resumes at sentence starts and
// are NOT evidence that a new entity was invented. (e.g. "Performance",
// "Dashboard", "Reporting", "Conversion" in a rewrite are normal wording, not
// an invented company/product.)
const GENERIC_CAPS = new Set([
  "dashboard", "dashboards", "performance", "reporting", "report", "reports",
  "insight", "insights", "analysis", "analytics", "summary", "summary",
  "optimization", "automation", "visualization", "visualisation", "revenue",
  "sales", "marketing", "operations", "customer", "customers", "client",
  "clients", "conversion", "conversions", "experience", "education", "skills",
  "projects", "profile", "career", "model", "models", "budget", "budgeting",
  "forecasting", "planning", "pricing", "inventory", "logistics", "efficiency",
  "efficiencies", "effectiveness", "quality", "accuracy", "consistency",
  "turnaround", "delivery", "process", "processes", "stakeholder",
  "stakeholders", "data", "record", "records",
  // Corporate suffixes that routinely appear in company names but carry no
  // evidence by themselves ("Globex Corporation" is caught via "Globex").
  "corporation", "corp", "inc", "llc", "ltd", "limited", "group", "industries",
  "systems", "technologies", "labs",
]);

const TOKEN_RE = /[A-Za-z0-9+#.]+/g;

function isSentenceInitial(text, startIndex) {
  if (startIndex <= 0) return true;
  const before = text.slice(0, startIndex).replace(/\s+/g, "");
  return /[.!?]$/m.test(before);
}

/**
 * Fact-level domain guard for rewrites.
 *
 * A rewrite is allowed to paraphrase in any ordinary English: re-inflect,
 * restructure, shorten, or merge wording, so long as the underlying facts and
 * their scope are preserved. Presence of an individual word is NOT checked —
 * that is what made validation over-strict. This guard instead flags only
 * fact-level additions the evidence never claimed:
 *
 *   - JD keyword/technology injected without evidence;
 *   - acronyms, technologies, versions, or named entities (e.g. a company,
 *     tool or project name) that appear nowhere in the supporting evidence;
 *   - seniority/ownership and architecture words handled by deterministicGuard.
 *
 * Ordinary words ("behavior", "returns", "track", "support", ...) never fire
 * here, so a genuine semantic paraphrase such as
 *   "track conversion, returns, repeat-purchase behavior, ..."
 * from evidence "tracking ... conversion rate, return rate, repeat-purchase
 * rate..." passes cleanly.
 */
export function novelContentGuard(
  generatedText,
  evidenceRecords,
  sensitiveVocab = new Set(),
  allowedTerms = []
) {
  const evText = evidenceRecords
    .map(
      (r) =>
        `${r.original_text} ${r.normalized_claim} ${(r.technologies || []).join(" ")} ${r.entity || ""} ${r.role || ""} ${r.company || ""} ${r.degree || ""} ${r.course || ""} ${r.institution || ""}`
    )
    .join(" ");
  const evRaw = new Set(rawTokens(evText));
  const evStems = new Set([...tokenize(evText)].map(stemToken));

  const genText = String(generatedText || "");
  const genRaw = new Set(rawTokens(genText));
  const tokens = genText.match(TOKEN_RE) || [];

  // Components of dotted names that the evidence itself contains ("ASP.NET",
  // "node.js") are grounded as a unit; do not re-flag "ASP" or "NET" alone.
  const groundedDotted = new Set();
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if (low.includes(".") && evRaw.has(low)) {
      for (const p of low.split(".")) if (p) groundedDotted.add(p);
    }
  }

  const allowed = new Set(
    allowedTerms.flatMap((t) => [...tokenize(t)].map(stemToken))
  );
  const sensitiveLower = new Set(
    [...sensitiveVocab].map((w) => String(w).toLowerCase())
  );

  const warnings = [];
  const seen = new Set();
  const flag = (term) => {
    if (seen.has(term)) return;
    seen.add(term);
    warnings.push({
      type: "NOVEL_TERM",
      message: `"${term}" appears in the generated content but not in the supporting evidence (possible keyword injection or changed fact).`,
    });
  };
  // A token is only worth checking if it is NOT explained by the evidence.
  const unexplained = (term) => {
    const c = String(term || "").toLowerCase();
    if (c.length < 3) return false;
    if (STOPWORDS.has(c)) return false;
    if (allowed.has(stemToken(c))) return false;
    if (groundedDotted.has(c)) return false;
    if (evRaw.has(c) || evStems.has(stemToken(c))) return false;
    // Hyphenated/apostrophe words map onto the evidence token-by-token
    // ("SKU-level" -> "sku" + "level"; both must be grounded).
    const parts = c.split(/[-'\u2019]/).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => evRaw.has(p))) return false;
    return true;
  };
  const consider = (term) => {
    if (unexplained(term)) flag(term);
  };

  // 1) JD-sensitive vocabulary injected without candidate evidence.
  for (const w of sensitiveVocab) {
    const low = String(w || "").toLowerCase();
    if (low.length < 3) continue;
    if (genRaw.has(low)) consider(w);
  }

  // 2) Full/partial acronyms and named entities rendered in ALL CAPS.
  for (const tok of tokens) {
    if (!/[A-Z]{2,}/.test(tok)) continue;
    consider(tok);
  }

  // 3) Technologies, versions and dotted tool names.
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    const tech =
      TECH_TERMS.has(low) ||
      /\d/.test(low) ||
      /^[a-z0-9]+\.[a-z0-9]+$/.test(low);
    if (tech) consider(tok);
  }

  // 4) Mid-sentence capitalized tokens (possible invented entity). Sentence-
  //    initial capitalization is ambiguous casing for an ordinary resume noun,
  //    so only domain-ish tokens from step 2/3 catch those positions.
  const wordToks = genText.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  for (const tok of wordToks) {
    if (!/^[A-Z]/.test(tok)) continue;
    if (!/[a-z]/.test(tok)) continue; // all-caps handled above
    const low = tok.toLowerCase();
    if (GENERIC_CAPS.has(low)) continue;
    const idx = genText.indexOf(tok);
    if (isSentenceInitial(genText, idx)) continue;
    consider(tok);
  }

  // 5) Adjacent capitalized tokens can form a proper-noun phrase ("Globex
  //    Corporation", "Acme Analytics"). Generic compound nouns ("Data Quality",
  //    "Customer Experience") and sentence-initial verbs ("Joined", "Built")
  //    are not names — skip those, but flag any name-like member that the
  //    evidence does not explain.
  for (let i = 0; i < wordToks.length - 1; i++) {
    const a = wordToks[i];
    const b = wordToks[i + 1];
    if (!/^[A-Z]/.test(a) || !/^[A-Z]/.test(b)) continue;
    for (const tok of [a, b]) {
      const low = tok.toLowerCase();
      if (GENERIC_CAPS.has(low)) continue;
      const idx = genText.indexOf(tok);
      if (isSentenceInitial(genText, idx)) continue;
      consider(tok);
    }
  }

  return warnings;
}

/**
 * Validate a single generated claim against the Truth Database.
 *
 * Fail-closed rule (spec §7, §8, §54): a claim is allowed only when it has at
 * least one evidence id and every referenced piece of evidence exists and is
 * either VERIFIED or USER_CONFIRMED.
 */
export function validateClaim({ claim, evidence_ids = [] }, db) {
  const problems = [];
  if (!claim || !String(claim).trim()) problems.push("Claim text is empty.");
  if (!Array.isArray(evidence_ids) || evidence_ids.length === 0) {
    problems.push("Claim has no evidence IDs.");
    return { claim, evidence_ids, allowed: false, problems, statuses: [] };
  }

  const statuses = [];
  for (const id of evidence_ids) {
    const rec = db.get(id);
    if (!rec) {
      problems.push(`Evidence ${id} does not exist.`);
      statuses.push({ evidence_id: id, status: "MISSING" });
      continue;
    }
    statuses.push({ evidence_id: id, status: rec.status });
    if (!USABLE_EVIDENCE_STATUS.includes(rec.status)) {
      problems.push(
        `Evidence ${id} has status ${rec.status}; only VERIFIED or USER_CONFIRMED may be used.`
      );
    }
  }

  return {
    claim,
    evidence_ids,
    allowed: problems.length === 0,
    problems,
    statuses,
  };
}

export function validateClaims(claims, db) {
  return claims.map((c) => validateClaim(c, db));
}

/**
 * Deterministic, non-LLM guard against the most common exaggerations:
 * invented numeric metrics and inflated seniority/scope language. Only strong
 * scope terms (ownership, management, production/enterprise scale) are treated
 * as suspicious; ordinary action verbs ("built", "analyzed", "developed") are
 * allowed because they are part of legitimate paraphrase. Returns a list of
 * warnings for the auditor to consider; it does not rewrite anything.
 */
export function deterministicGuard(generatedText, evidenceRecords) {
  const text = String(generatedText || "");
  const lower = text.toLowerCase();
  const evidenceBlob = evidenceRecords
    .map((r) => `${r.original_text} ${r.normalized_claim}`)
    .join(" ")
    .toLowerCase();

  const warnings = [];

  const numbers = text.match(/\b\d+(?:\.\d+)?%?\b/g) || [];
  for (const n of numbers) {
    if (!evidenceBlob.includes(n)) {
      warnings.push({
        type: "UNSUPPORTED_METRIC",
        message: `Metric/number "${n}" does not appear in any supporting evidence.`,
      });
    }
  }

  for (const term of STRONG_SCOPE_TERMS) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(lower) && !re.test(evidenceBlob)) {
      warnings.push({
        type: "POSSIBLE_EXAGGERATION",
        message: `Seniority/ownership term "${term}" is not supported by the evidence wording.`,
      });
    }
  }

  return warnings;
}

const YEAR_RE = /\b(?:19|20)\d{2}\b/g;
const YEAR_TOKEN_RE = /^(?:19|20)\d{2}$/;

function firstQuoted(message) {
  const m = String(message || "").match(/"([^"]+)"/);
  return m ? m[1] : String(message || "");
}

/**
 * Code-based factual validation of generated content against the evidence.
 *
 * This is the primary, always-on guard for the mechanical factual categories:
 * dates/years, metrics and numbers, technologies, companies/titles and project
 * names, plus unsupported seniority wording. It returns audit-shaped items so
 * the deterministic verdicts can be merged with (or stand in for) the model
 * validation pass. Hard failures are categories where code can prove the
 * generated content added a fact the candidate's evidence does not contain;
 * soft warnings flag wording that may overstate scope.
 */
export function deterministicClaimValidation(
  generatedText,
  evidenceRecords,
  { sensitiveVocab = new Set(), allowedTerms = [] } = {}
) {
  const text = String(generatedText || "");
  const evidenceBlob = evidenceRecords
    .map((r) => `${r.original_text} ${r.normalized_claim}`)
    .join(" ")
    .toLowerCase();

  const items = [];
  const hardFailures = [];
  const softWarnings = [];
  const seen = new Set();

  const flag = (type, claim, detail, verdict, hard) => {
    const key = `${type}:${claim}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ claim, verdict, evidence_ids: [], detail, source: "deterministic" });
    const warning = { type, message: detail };
    if (hard) hardFailures.push(warning);
    else softWarnings.push(warning);
  };

  // Dates and years.
  for (const year of new Set(text.match(YEAR_RE) || [])) {
    if (!evidenceBlob.includes(year)) {
      flag(
        "UNSUPPORTED_DATE",
        `Date/year "${year}"`,
        `Date/year "${year}" in the generated content does not appear in any supporting evidence.`,
        "UNSUPPORTED",
        true
      );
    }
  }

  // Metrics and other numbers (years handled above).
  for (const n of new Set(text.match(/\b\d+(?:\.\d+)?%?\b/g) || [])) {
    if (YEAR_TOKEN_RE.test(n)) continue;
    if (!evidenceBlob.includes(n)) {
      flag(
        "UNSUPPORTED_METRIC",
        `Metric/number "${n}"`,
        `Metric/number "${n}" does not appear in any supporting evidence.`,
        "UNSUPPORTED",
        true
      );
    }
  }

  // Unsupported seniority/ownership wording (soft: may overstate scope).
  for (const w of deterministicGuard(text, evidenceRecords)) {
    if (w.type !== "POSSIBLE_EXAGGERATION") continue;
    flag("POSSIBLE_EXAGGERATION", `Seniority term "${firstQuoted(w.message)}"`, w.message, "EXAGGERATED", false);
  }

  // Novel proper nouns / acronyms / JD keywords: companies, titles,
  // technologies and project names that are absent from the evidence.
  for (const w of novelContentGuard(text, evidenceRecords, sensitiveVocab, allowedTerms)) {
    flag("NOVEL_TERM", `Unsupported term "${firstQuoted(w.message)}"`, w.message, "UNSUPPORTED", true);
  }

  return { items, hardFailures, softWarnings };
}

// ---------------------------------------------------------------------------
// Enforcement: remove content the deterministic guard proves unsupported
// ---------------------------------------------------------------------------

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPresent(text, term) {
  return new RegExp(`\\b${escapeRegex(term)}\\b`, "i").test(String(text || ""));
}

/**
 * Remove a single unsupported term from generated prose. Tries the realistic
 * in-line cases first ("..., including Term", "..., such as Term", bare list
 * items "..., Term, ...", parentheticals); only then drops whole sentences so
 * an unresolvable claim never ships. Returns the edited text and the removed
 * fragment so callers can surface exactly what was cleaned up.
 */
function removeUnsupportedTerm(text, term) {
  const esc = escapeRegex(term);
  const listBoundary = `(?=[,.;]|\\s+(?:and|or)\\b|$)`;
  const attempts = [
    new RegExp(`,\\s*(?:including|such as|like|particularly|notably|e\\.?g\\.?)\\s+${esc}${listBoundary}`, "gi"),
    new RegExp(`\\s+(?:including|such as|like|particularly|notably|e\\.?g\\.?)\\s+${esc}${listBoundary}`, "gi"),
    new RegExp(`,\\s*${esc}${listBoundary}`, "gi"),
    new RegExp(`\\(\\s*(?:including|such as|like|e\\.?g\\.?)?\\s*${esc}\\s*\\)`, "gi"),
  ];
  for (const re of attempts) {
    if (!re.test(text)) continue;
    return { text: String(text).replace(re, "").replace(/\s{2,}/g, " ").trim(), removedText: String(text).match(re)[0].trim() };
  }

  const parts = String(text).split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = [];
  const dropped = [];
  for (const sentence of parts) {
    if (termPresent(sentence, term)) dropped.push(sentence);
    else kept.push(sentence);
  }
  return { text: kept.join(" ").trim(), removedText: dropped.join(" ").trim() };
}

/**
 * Deterministic post-generation enforcement: repeatedly strip content that the
 * deterministic guard proves unsupported (novel JD terms, dates and metrics
 * absent from the evidence) so a letter/rewrite never ships a hard-guard
 * failure. Soft warnings (possible exaggerations) are returned but never drive
 * removal. Fails open on ambiguity, only removing provably-bad content.
 */
export function stripUnsupportedClaims(text, evidenceRecords, opts = {}) {
  let current = String(text || "").trim();
  const removed = [];
  for (let pass = 0; pass < 8; pass++) {
    const verdict = deterministicClaimValidation(current, evidenceRecords, opts);
    if (verdict.hardFailures.length === 0) break;
    const term = firstQuoted(verdict.hardFailures[0].message);
    if (!term) break;
    const { text: next, removedText } = removeUnsupportedTerm(current, term);
    if (next === current || !next) break;
    removed.push({ type: verdict.hardFailures[0].type, term, removedText, pass });
    current = next;
  }
  const finalVerdict = deterministicClaimValidation(current, evidenceRecords, opts);
  return {
    text: current,
    removed,
    remainingHardFailures: finalVerdict.hardFailures,
    softWarnings: finalVerdict.softWarnings,
  };
}
