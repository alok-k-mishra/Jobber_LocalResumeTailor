import { generateJson } from "../llm/client.js";
import { jdExtractionSchema } from "../schemas/index.js";
import { formatJdExtractionLessons } from "../core/learning.js";

function pad(n) {
  return String(n).padStart(3, "0");
}

const TITLE_WORDS =
  /(engineer|developer|analyst|scientist|manager|designer|intern|consultant|architect|specialist|lead|administrator|associate|director|coordinator|officer|executive|programmer|researcher)/i;

function jdLines(jdText) {
  return String(jdText)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/^[#*\-\s]+/, "").trim())
    .filter(Boolean);
}

function guessTitle(jdText) {
  const lines = jdLines(jdText).slice(0, 8);
  const labelled = lines.find((l) => /^(job\s*title|position|role)\s*[:\-]/i.test(l));
  if (labelled) return labelled.replace(/^[^:\-]+[:\-]\s*/, "").trim();
  const byWords = lines.find((l) => TITLE_WORDS.test(l) && l.length <= 80);
  if (byWords) {
    const atSplit = byWords.split(/\s+[-–—|]\s+|\s+at\s+/i)[0];
    return atSplit.trim();
  }
  return lines[0] || "";
}

function guessCompany(jdText) {
  const lines = jdLines(jdText).slice(0, 8);
  const labelled = lines.find((l) => /^company\s*[:\-]/i.test(l));
  if (labelled) return labelled.replace(/^company\s*[:\-]\s*/i, "").trim();
  for (const l of lines) {
    const at = l.match(/\bat\s+([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3})\b/);
    if (at) return at[1].trim();
  }
  return "";
}

export async function analyzeJd(session) {
  const jdText = (session.job_description || "").trim();
  if (jdText.length < 40) {
    throw new Error("Job description is too short to analyze.");
  }

  const { data, model, attempts } = await generateJson({
    task: "extraction",
    promptName: "jd-extraction",
    vars: {
      jd_text: jdText,
      learned_examples: formatJdExtractionLessons("", 2),
    },
    schema: jdExtractionSchema,
    label: "jd-extraction",
    maxTokens: 3000,
  });

  // Requirement IDs are assigned deterministically, never by the model.
  data.requirements = data.requirements.map((r, i) => ({
    ...r,
    requirement_id: `JD-REQ-${pad(i + 1)}`,
  }));

  // Deterministic fallbacks for title/company so downstream prompts and the
  // cover letter never have to guess (and never borrow an employer name).
  if (!data.job_title) data.job_title = guessTitle(jdText);
  if (!data.company) data.company = guessCompany(jdText);

  session.jd = { ...data, model, attempts };
  session.stage = "jd_analyzed";
  return session;
}
