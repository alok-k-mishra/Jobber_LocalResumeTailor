import { generateJson } from "../llm/client.js";
import { auditResultSchema } from "../schemas/index.js";
import { TruthDatabase } from "../core/truthdb.js";
import {
  deterministicClaimValidation,
  buildSensitiveVocabulary,
} from "../core/claims.js";

// Non-factual framing (application statements, enthusiasm, sign-offs) is not a
// candidate claim and must not drive the verdict.
const FRAMING_RE =
  /(i am applying|i am writing to apply|i am excited|i am eager|i am confident|i am keen|i am passionate|i look forward|i would be (delighted|happy|honou?red)|passionate about|thank you for your (time|consideration)|at your (organisation|organization|company|team)|^(dear|sincerely|best regards|regards|yours)\b)/i;

/**
 * Truthfulness validation.
 *
 * Two layers, deterministic first:
 *   1. Code-based validation of the mechanical factual categories (dates,
 *      metrics, technologies, companies/titles, project names, seniority).
 *      If it proves a violation, the content fails closed immediately and the
 *      model is not called at all.
 *   2. A final claim-validation pass with Qwen 3.5 for the semantic scope
 *      judgements code cannot make (context loss, subtle exaggeration).
 *
 * Gemma is not used anywhere in this path.
 */
export async function auditContent(session, { content, validateText = content, label = "content" }) {
  const db = new TruthDatabase(session.truth_db || []);
  const deterministic = deterministicClaimValidation(validateText, db.all(), {
    sensitiveVocab: buildSensitiveVocabulary(session.jd || {}),
    allowedTerms: [session.jd?.job_title, session.jd?.company].filter(Boolean),
  });

  // Deterministic-first: never spend a model call when code already proves an
  // unsupported fact. The regeneration pass receives these findings verbatim.
  if (deterministic.hardFailures.length > 0) {
    return {
      label,
      model: null,
      items: deterministic.items,
      ignored_items: [],
      summary:
        `Deterministic validation found ${deterministic.hardFailures.length} unsupported ` +
        `factual claim(s); the final model validation pass was skipped.`,
      overall: "REVIEW_REQUIRED",
      guard_hard_failures: deterministic.hardFailures,
      guard_soft_warnings: deterministic.softWarnings,
      deterministic: true,
      audited_at: new Date().toISOString(),
    };
  }

  const deterministicFindings = deterministic.items.length
    ? deterministic.items.map((i) => `- [${i.verdict}] ${i.claim}: ${i.detail}`).join("\n")
    : "(none)";

  const { data, model } = await generateJson({
    task: "validation",
    promptName: "truth-audit",
    vars: {
      truth_db: db.toPromptContext() || "(empty)",
      content,
      deterministic_findings: deterministicFindings,
    },
    schema: auditResultSchema,
    label: `truth-audit:${label}`,
    maxTokens: 1200,
  });

  const framingItems = data.items.filter((i) => FRAMING_RE.test(i.claim || ""));
  const factualItems = data.items.filter((i) => !FRAMING_RE.test(i.claim || ""));

  // Vacuous pass is allowed: if the model finds no factual claims to judge, the
  // deterministic validation above is the remaining safety net.
  const llmPass = factualItems.every((i) => i.verdict === "SUPPORTED");

  const overall =
    llmPass && deterministic.hardFailures.length === 0 ? "PASS" : "REVIEW_REQUIRED";

  return {
    label,
    model,
    items: factualItems,
    ignored_items: framingItems,
    summary: data.summary,
    overall,
    guard_hard_failures: deterministic.hardFailures,
    guard_soft_warnings: deterministic.softWarnings,
    audited_at: new Date().toISOString(),
  };
}

export function buildViolationNote(audit) {
  const lines = [];
  for (const item of audit.items || []) {
    if (item.verdict !== "SUPPORTED") {
      lines.push(`- ${item.verdict}: "${item.claim}" — ${item.detail}`);
    }
  }
  for (const w of audit.guard_hard_failures || []) {
    lines.push(`- ${w.type || "UNSUPPORTED"}: ${w.message}`);
  }
  return lines.join("\n");
}
