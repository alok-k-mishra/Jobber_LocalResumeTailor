import { generateJson } from "../llm/client.js";
import { resumeLineFactsSchema } from "../schemas/index.js";
import { parseResumeFile } from "../parsers/index.js";
import { structureDocument, sectionCategory } from "../parsers/structure.js";
import { TruthDatabase } from "../core/truthdb.js";

/**
 * Facts are built deterministically from the document structure. The LLM is
 * only used to *enrich* (classify ambiguous sections, name technologies),
 * never to invent or reword the source lines: the document is the source of
 * truth for wording, bullets, links and section boundaries.
 *
 * Each line of the document maps to exactly one fact record. `mergeFact`
 * prefers the deterministic parser values for layout-shaped fields (entity,
 * duration, location, links, groups) and only accepts the LLM's enrichment for
 * semantic fields (technologies/responsibilities/outcomes/metrics). Without a
 * live model every line still yields a faithful "LISTED" fact, which fixes the
 * previous behavior where extraction emptiness turned whole sections into
 * garbage claims ("[Experience] ...").
 */
function mergeFact(index, record, llm) {
  const claim = (llm?.normalized_claim || "").trim() || record.original_text;
  const entity = (llm?.entity || "").trim() || record.entity || "";
  const sourceLocation =
    entity && record.category !== "skill" && !String(record.section).toLowerCase().includes(entity.toLowerCase())
      ? `${record.section} > ${entity}`
      : record.section;
  const category =
    record.section !== "Header" && record.category !== "other"
      ? record.category
      : llm?.category || record.category || "other";

  const technologies =
    record.technologies?.length
      ? record.technologies // deterministic split for skills already done
      : llm?.technologies || [];

  return {
    section: record.section,
    source_location: sourceLocation,
    original_text: record.original_text,
    normalized_claim: claim,
    category,
    entity,
    item_type: record.item_type || "line",
    group_id: record.group_id || "",
    duration: record.duration || "",
    location: record.location || "",
    link_text: record.link_text || "",
    link_url: record.link_url || "",
    subcategory: record.subcategory || "",
    flags: record.flags || [],
    role: record.role || "",
    company: record.company || "",
    location_type: record.location_type || "",
    start_month: record.start_month || "",
    start_year: record.start_year || "",
    end_month: record.end_month || "",
    end_year: record.end_year || "",
    is_present: Boolean(record.is_present),
    education_type: record.education_type || "",
    degree: record.degree || "",
    course: record.course || "",
    specialization: record.specialization || "",
    institution: record.institution || "",
    technologies,
    responsibilities: llm?.responsibilities || record.responsibilities || [],
    outcomes: llm?.outcomes || record.outcomes || [],
    metrics: llm?.metrics || record.metrics || [],
    team_context: llm?.team_context || record.team_context || "",
    skill_level: record.item_type === "skill" ? "LISTED" : llm?.skill_level || record.skill_level || "LISTED",
    confidence: record.confidence ?? llm?.confidence ?? 0.7,
    line_index: index,
    page: record.page,
    line: record.line,
  };
}

export async function extractResume(buffer, filename, onProgress = async () => {}, options = {}) {
  const enrich = options.enrich !== false;

  await onProgress({ phase: "read", label: "Reading file and extracting text…" });
  const doc = await parseResumeFile({ buffer, filename });
  if (!doc || !doc.rawText || doc.rawText.length < 30) {
    throw new Error("Could not extract readable text from the resume file.");
  }

  await onProgress({ phase: "segment", label: "Reading resume structure…" });
  const { header, records, sections } = structureDocument(doc);
  if (!records.length) throw new Error("No addressable content found in the resume.");

  const linesBlock = records
    .map(
      (r, i) => `[${i}] (${r.section}${r.item_type === "bullet" ? " bullet" : r.item_type === "entry_header" ? " entry" : ""}) ${r.original_text}`
    )
    .join("\n");

  let llmOut = { data: { facts: [] }, model: "", attempts: 0 };
  if (enrich) {
    await onProgress({ phase: "extract", label: "Classifying facts (Qwen 3.5)…" });
    try {
      llmOut = await generateJson({
        task: "extraction",
        promptName: "resume-extraction",
        vars: { lines: linesBlock },
        schema: resumeLineFactsSchema,
        label: "resume-extraction",
      });
    } catch {
      // enrichment is best-effort; the deterministic parse already yields facts
      llmOut = { data: { facts: [] }, model: "", attempts: 0 };
    }
  }

  await onProgress({ phase: "structure", label: "Structuring and verifying…" });
  const byIndex = new Map();
  for (const f of llmOut.data.facts || []) {
    if (!byIndex.has(f.line_index)) byIndex.set(f.line_index, f);
  }
  const facts = records.map((record, i) => mergeFact(i, record, byIndex.get(i)));

  return {
    facts,
    extraction: {
      name: header.name || "",
      contact: { email: header.email || "", phone: header.phone || "", links: header.links || [] },
      location: header.location || "",
      sections,
      line_count: facts.length,
      model: llmOut.model,
      attempts: llmOut.attempts,
    },
    header,
    rawText: doc.rawText,
    lines: doc.lines,
  };
}

export async function analyzeResume(session, { buffer, filename }) {
  const { facts, extraction, rawText } = await extractResume(buffer, filename);

  session.resume = {
    filename,
    raw_text: rawText,
    extraction: { ...extraction, model: extraction.model },
    extraction_model: extraction.model,
    extraction_attempts: 1,
  };

  const priorAnswers = (session.truth_db || []).filter(
    (r) => r.source_type === "user_answer"
  );
  const db = new TruthDatabase(priorAnswers);
  db.addResumeFacts(facts);
  session.truth_db = db.toJSON();
  session.stage = "resume_analyzed";
  return session;
}

export { sectionCategory };