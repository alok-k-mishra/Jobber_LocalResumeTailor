import { generateJson } from "../llm/client.js";
import { coverLetterSchema } from "../schemas/index.js";
import { TruthDatabase } from "../core/truthdb.js";
import {
  validateClaim,
  novelContentGuard,
  buildSensitiveVocabulary,
} from "../core/claims.js";
import { formatRequirements, formatMatches, formatMemoryContext } from "./format.js";
import { formatCoverLetterLessons } from "../core/learning.js";

/**
 * Make the letter's closing block deterministic. Models often glue the sign-off
 * onto the last paragraph ("...so I would be glad to hear from you. Sincerely,
 * Aman Verma" all on one line). This splits the closing so the sign-off stands
 * on its own paragraph and the candidate's name follows on its own line.
 */
const SIGN_OFF_RE =
  /\b(sincerely\s*[,.]*|yours\s+sincerely\s*[,.]*|yours\s+faithfully\s*[,.]*|yours\s+truly\s*[,.]*|(?:best|kind|warm)\s+regards\s*[,.]*)\b/i;

function properSignOff(phrase) {
  const p = String(phrase || "").toLowerCase();
  if (p.includes("yours sincerely")) return "Yours sincerely,";
  if (p.includes("yours faithfully")) return "Yours faithfully,";
  if (p.includes("yours truly")) return "Yours truly,";
  if (p.includes("best regards")) return "Best regards,";
  if (p.includes("kind regards")) return "Kind regards,";
  if (p.includes("warm regards")) return "Warm regards,";
  return "Sincerely,";
}

export function normalizeSignOff(letter, name = "") {
  const text = String(letter || "").trim();
  const m = text.match(SIGN_OFF_RE);
  if (!m) return text;
  const before = text
    .slice(0, m.index)
    .replace(/[,\s;:…—-]+$/, "")
    .trim();
  const after = text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.;:…—-]*/, "")
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const signature = after.shift() || name || "";
  const blocks = [before, properSignOff(m[0])];
  if (signature) blocks.push(signature.replace(/\s+/g, " ").trim());
  for (const rest of after) blocks.push(rest);
  return blocks.join("\n\n");
}

export async function generateCoverLetter(session, { violations = "" } = {}) {
  const db = new TruthDatabase(session.truth_db || []);

  const vars = {
    candidate_name: session.resume?.extraction?.name || "the candidate",
    job_title: session.jd?.job_title || "",
    company: session.jd?.company || "",
    requirements: formatRequirements(session.jd?.requirements),
    matches: formatMatches(session.matches),
    truth_db: formatMemoryContext(db.all()) || "(empty)",
    learned_examples: formatCoverLetterLessons(session.jd?.job_title, 1),
  };

  // A regeneration pass appends the auditor's findings as hard constraints.
  if (violations) {
    vars.truth_db +=
      "\n\nCRITICAL CORRECTIONS FROM THE PREVIOUS AUDIT — you MUST NOT repeat these violations:\n" +
      violations +
      "\nRewrite the letter so every factual candidate statement is fully supported at the exact scope of its evidence.";
  }

  const { data, model, attempts } = await generateJson({
    task: "reasoning",
    promptName: "cover-letter",
    vars,
    schema: coverLetterSchema,
    label: "cover-letter",
    maxTokens: 1200,
  });

  // Per-claim validation: IDs must exist and be usable, AND the claim text must
  // not introduce JD vocabulary the evidence does not support. This mirrors the
  // audit guard so the letter's own claim list flags injections (e.g. a JD
  // keyword the candidate never claimed) before the final audit runs.
  const sensitiveVocab = buildSensitiveVocabulary(session.jd || {});
  const allowedTerms = [session.jd?.job_title, session.jd?.company].filter(Boolean);
  const claimValidation = (data.claims || []).map((c) => {
    const v = validateClaim(c, db);
    if (!v.allowed) return v;
    const novel = novelContentGuard(c.claim || "", db.all(), sensitiveVocab, allowedTerms);
    if (novel.length > 0) {
      return {
        ...v,
        allowed: false,
        problems: [...v.problems, ...novel.map((w) => w.message)],
      };
    }
    return v;
  });
  const unsupported = claimValidation.filter((v) => !v.allowed);

  const candidateName = vars.candidate_name;
  let letter = data.letter.trim();

  // Deterministic cleanup: strip citations the model may have leaked into the
  // visible letter, and resolve obvious name placeholders.
  letter = letter
    .replace(/\s*\((?:RESUME|USER-ANS|JD-REQ)-[A-Z0-9-]+\)/g, "")
    .replace(/\s*\[(?:RESUME|USER-ANS|JD-REQ)-[A-Z0-9-]+\]/g, "");

  const deterministicIssues = [];
  const namePlaceholder = /\[(?:your\s*)?(?:full\s*)?name\]|\[candidate\s*name\]/i;
  if (namePlaceholder.test(letter) && candidateName && candidateName !== "the candidate") {
    letter = letter.replace(namePlaceholder, candidateName);
  }

  // Sign-off hygiene: the closing must read "...[final sentence]\n\nSincerely,\n\nName".
  letter = normalizeSignOff(
    letter,
    candidateName && candidateName !== "the candidate" ? candidateName : ""
  );

  const placeholders = letter.match(/\[[^\]]{1,40}\]/g) || [];
  if (placeholders.length) {
    deterministicIssues.push(
      `The letter contains unresolved placeholders: ${placeholders.join(", ")}.`
    );
  }

  return {
    letter,
    claims: data.claims || [],
    claim_validation: claimValidation,
    unsupported_claims: unsupported,
    deterministic_issues: deterministicIssues,
    model,
    attempts,
  };
}
