import crypto from "node:crypto";
import { evidenceRecordSchema, USABLE_EVIDENCE_STATUS } from "../schemas/index.js";

const CATEGORY_PREFIX = {
  summary: "SUM",
  skill: "SKILL",
  experience: "EXP",
  internship: "INT",
  project: "PROJ",
  education: "EDU",
  certification: "CERT",
  achievement: "ACH",
  leadership: "LEAD",
  activity: "ACT",
  other: "OTH",
};

/**
 * The Resume Truth Database.
 *
 * Immutable, evidence-ID-addressed store of everything the system knows about
 * the candidate. The LLM never owns this data; it only proposes facts that are
 * then normalized and stored here with explicit provenance.
 */
export class TruthDatabase {
  constructor(records = []) {
    this.records = [];
    this.counters = new Map();
    for (const r of records) {
      const parsed = evidenceRecordSchema.parse(r);
      this.records.push(parsed);
      this.bumpCounter(parsed.evidence_id);
    }
  }

  bumpCounter(evidenceId) {
    const m = /^([A-Z-]+?)-(\d+)$/.exec(evidenceId);
    if (!m) return;
    const prefix = m[1];
    const n = Number(m[2]);
    const current = this.counters.get(prefix) || 0;
    if (n > current) this.counters.set(prefix, n);
  }

  nextId(prefix) {
    const next = (this.counters.get(prefix) || 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}-${String(next).padStart(3, "0")}`;
  }

  /**
   * Ingest resume facts produced by the extraction model. IDs are assigned here
   * deterministically; the model is never trusted to mint identifiers.
   */
  addResumeFacts(facts) {
    const added = [];
    for (const fact of facts) {
      const prefix = `RESUME-${CATEGORY_PREFIX[fact.category] || "OTH"}`;
      const record = evidenceRecordSchema.parse({
        evidence_id: this.nextId(prefix),
        source_type: "resume",
        source_location: fact.source_location || fact.section || "",
        original_text: fact.original_text,
        normalized_claim: fact.normalized_claim,
        status: "VERIFIED",
        confidence: fact.confidence ?? 1,
        skill_level: fact.skill_level || "LISTED",
        technologies: fact.technologies || [],
        section: fact.section || "",
        category: fact.category || "other",
        entity: fact.entity || "",
        responsibilities: fact.responsibilities || [],
        outcomes: fact.outcomes || [],
        metrics: fact.metrics || [],
        team_context: fact.team_context || "",
        // deterministic document-structure + provenance
        item_type: fact.item_type || "line",
        group_id: fact.group_id || "",
        duration: fact.duration || "",
        location: fact.location || "",
        link_text: fact.link_text || "",
        link_url: fact.link_url || "",
        subcategory: fact.subcategory || "",
        flags: fact.flags || [],
        role: fact.role || "",
        company: fact.company || "",
        location_type: fact.location_type || "",
        start_month: fact.start_month || "",
        start_year: fact.start_year || "",
        end_month: fact.end_month || "",
        end_year: fact.end_year || "",
        is_present: Boolean(fact.is_present),
        education_type: fact.education_type || "",
        degree: fact.degree || "",
        course: fact.course || "",
        specialization: fact.specialization || "",
        institution: fact.institution || "",
        education_status: fact.education_status || "",
        page: fact.page,
        line: fact.line,
        created_at: new Date().toISOString(),
      });
      this.records.push(record);
      added.push(record);
    }
    return added;
  }

  /**
   * Convert a user's answer into first-class evidence. The normalized claim is
   * constrained to the scope of the answer; we never strengthen it here.
   * `category` lets a confirmation reuse the resume's category semantics (e.g.
   * a "years of experience" answer counts as experience evidence, an education
   * status answer as education evidence) so the deterministic caps judge it like
   * the equivalent resume proof.
   */
  addUserAnswer({ question, answer, normalized_claim, requirement_id, key, category, skill_level }) {
    const record = evidenceRecordSchema.parse({
      evidence_id: this.nextId("USER-ANS"),
      source_type: "user_answer",
      source_location: "User answer",
      original_text: answer,
      normalized_claim,
      status: "USER_CONFIRMED",
      confidence: 1,
      skill_level: skill_level || "USED",
      technologies: [],
      category: category || "other",
      question,
      answer,
      key: key || "",
      requirement_id,
      created_at: new Date().toISOString(),
    });
    this.records.push(record);
    return record;
  }

  get(id) {
    return this.records.find((r) => r.evidence_id === id) || null;
  }

  all() {
    return this.records;
  }

  get size() {
    return this.records.length;
  }

  usable(ids = []) {
    return ids
      .map((id) => this.get(id))
      .filter((r) => r && USABLE_EVIDENCE_STATUS.includes(r.status));
  }

  hasUsable(ids = []) {
    return this.usable(ids).length > 0;
  }

  /** Compact view passed to reasoning prompts. */
  toPromptContext() {
    return this.records
      .map((r) => {
        const bits = [
          `${r.evidence_id} [${r.status}/${r.skill_level}]`,
          `  claim: ${r.normalized_claim}`,
          r.source_location ? `  source: ${r.source_location}` : "",
          r.original_text ? `  original: ${JSON.stringify(r.original_text)}` : "",
          r.question ? `  question: ${r.question}` : "",
          r.answer ? `  answer: ${JSON.stringify(r.answer)}` : "",
        ].filter(Boolean);
        return bits.join("\n");
      })
      .join("\n\n");
  }

  toJSON() {
    return this.records;
  }

  fingerprint() {
    const h = crypto.createHash("sha1");
    for (const r of this.records) h.update(`${r.evidence_id}:${r.normalized_claim}`);
    return h.digest("hex").slice(0, 12);
  }
}
