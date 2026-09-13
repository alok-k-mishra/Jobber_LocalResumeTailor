import { educationCompletion } from "../core/retrieval.js";

export function formatRequirements(requirements = []) {
  return requirements
    .map((r) => {
      const extras = [];
      if ((r.tools || []).length) extras.push(`tools: ${r.tools.join(" / ")}${r.list_type ? ` (${r.list_type})` : ""}`);
      if ((r.normalized_concepts || []).length) extras.push(`concepts: ${r.normalized_concepts.join(", ")}`);
      return (
        `${r.requirement_id} [${r.importance}/${r.category}] ${r.text}` +
        (extras.length ? `\n   ${extras.join(" | ")}` : "") +
        (r.evidence_hint ? `\n   (what would satisfy it: ${r.evidence_hint})` : "")
      );
    })
    .join("\n");
}

export function formatMatches(matches = []) {
  return matches
    .map(
      (m) =>
        `${m.requirement_id}: ${m.status}${m.evidence_strength ? ` (evidence: ${m.evidence_strength})` : ""}` +
        (m.evidence_ids?.length ? ` evidence=[${m.evidence_ids.join(", ")}]` : " evidence=[]") +
        (m.source ? `\n   source: ${m.source}` : "") +
        (m.explanation ? `\n   explanation: ${m.explanation}` : "")
    )
    .join("\n");
}

export function formatResumeFacts(facts = []) {
  return facts
    .map(
      (f, i) =>
        `${f.evidence_id} (${f.category}${f.entity ? ` / ${f.entity}` : ""}) @ ${f.source_location}\n` +
        `   original: ${JSON.stringify(f.original_text)}\n` +
        `   claim: ${f.normalized_claim}`
    )
    .join("\n");
}

/**
 * Bullet-only view of the resume for tailoring input (spec §10).
 *
 * The structured hierarchy is preserved: each entry (Experience/Project) is
 * shown under its metadata line (role · company · dates · tools) and only its
 * bullet lines are listed beneath. Entry headers, company names, titles,
 * locations and dates are CONTEXT ONLY — they are never candidates for a
 * recommendation, so they are deliberately not emitted as items the model can
 * rewrite or reorder. Only Experience/Project-family bullets appear; Skills,
 * Education, Achievements and the Summary come from the truth database context
 * and are handled by their own flows.
 */
export function formatResumeBullets(facts = []) {
  const BULLET_SEC_RE =
    /experience|project|internship|employment|work experience|activity|leadership/i;
  const usable = (facts || []).filter((f) => f?.evidence_id);
  const groups = new Map();
  for (const r of usable) {
    const sec = r.section || r.source_location || "OTHER";
    if (!BULLET_SEC_RE.test(sec)) continue;
    if (!groups.has(sec)) groups.set(sec, []);
    groups.get(sec).push(r);
  }
  const parts = [];
  for (const [sec, recs] of groups) {
    const isContent = (r) => !["entry_header", "skill"].includes(r.item_type || "bullet");
    const bullets = recs.filter(isContent);
    if (!bullets.length) continue;
    const header = recs.find((r) => r.item_type === "entry_header");
    const title = header
      ? entryDisplayLabel(header) || header.original_text || sec
      : sec;
    const lines = bullets.map((r) => {
      const text = (r.original_text || r.normalized_claim || "")
        .replace(/\s+/g, " ")
        .trim();
      return `- [${r.evidence_id}] ${text}`;
    });
    parts.push(`## ${title}\n(entries: ${bullets.map((r) => r.evidence_id).join(", ")})\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}

export function entryDisplayLabel(f) {
  if (!f) return "";
  if (f.item_type === "entry_header") {
    return f.original_text || f.entity || "";
  }
  const role = f.role || "";
  const company = f.company || "";
  const entry = f.entity || "";
  const bits = [];
  if (role && company) bits.push(`${role} — ${company}`);
  else if (role) bits.push(role);
  else if (entry) bits.push(entry);
  if (f.duration) bits.push(f.duration);
  return bits.join(" · ");
}

export function summarizeMatches(matches = []) {
  const counts = {};
  for (const m of matches) counts[m.status] = (counts[m.status] || 0) + 1;
  return counts;
}

export const STATUS_LABEL = {
  MATCHED: "Matched",
  PARTIAL: "Partial",
  NOT_MATCHED: "Not matched",
  UNKNOWN: "Unknown",
  // Legacy statuses from sessions matched before the status vocabulary changed.
  STRONG_MATCH: "Strong",
  PARTIAL_MATCH: "Partial",
  WEAK_MATCH: "Weak",
  NO_EVIDENCE: "No evidence",
  CONTRADICTED: "Contradicted",
};

/**
 * Complete, deterministic rendering of the structured Resume Memory used by the
 * semantic matcher. Every project/experience bullet, its tools, and education
 * completion state are included in full — nothing that carries evidence for a
 * requirement is truncated away.
 */
/**
 * Compact, flat rendering of Resume Memory for long-context prompts. One short
 * line per record (id, status/level/category, tools, claim) instead of the
 * full grouped hierarchy — the matching stage only needs to reason over the
 * claims, and the candidate shortlist already quotes the exact bullet wording.
 * Hard-capped so the reasoning model never has to ingest the whole resume.
 */
export function formatCompactMemoryContext(records = [], { maxChars = 8000 } = {}) {
  const usable = (records || []).filter((r) => r?.evidence_id);
  const lines = usable.map((r) => {
    const text = (r.normalized_claim || r.original_text || "")
      .replace(/\s+/g, " ")
      .trim();
    const tools = (r.technologies || []).filter(Boolean);
    const bits = [`${r.evidence_id}`, `[${r.status}/${r.skill_level}/${r.category}]`];
    if (tools.length) bits.push(`tools: ${tools.join(", ")}`);
    if (r.duration) bits.push(r.duration);
    if (r.category === "education") bits.push(`[${educationCompletion(r)}]`);
    bits.push(text);
    return bits.join(" | ");
  });
  let out = lines.join("\n");
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n[... additional records omitted for length ...]`;
  }
  return out;
}

export function formatMemoryContext(records = []) {
  const usable = (records || []).filter((r) => r?.evidence_id);
  const groups = new Map();
  for (const r of usable) {
    const sec = r.section || r.source_location || "OTHER";
    if (!groups.has(sec)) groups.set(sec, []);
    groups.get(sec).push(r);
  }
  const parts = [];
  for (const [sec, recs] of groups) {
    const lines = [];
    for (const r of recs) {
      const bits = [`${r.evidence_id}`, `[${r.status}/${r.skill_level}/${r.category}]`];
      if (r.role || r.company) bits.push(`${r.role || ""}${r.company ? " at " + r.company : ""}`);
      if (r.degree || r.course || r.institution) {
        bits.push(
          `${r.degree || ""}${r.course ? " – " + r.course : ""}${
            r.institution ? " @ " + r.institution : ""
          }`
        );
      }
      if (r.duration) bits.push(r.duration);
      const tools = (r.technologies || []).filter(Boolean);
      if (tools.length) bits.push(`tools: ${tools.join(", ")}`);
      if (r.category === "education") bits.push(`[${educationCompletion(r)}]`);
      const text = (r.normalized_claim || r.original_text || "")
        .replace(/\s+/g, " ")
        .trim();
      lines.push(`    ${bits.join(" | ")}\n      ${text}`);
    }
    parts.push(`${sec}\n${lines.join("\n")}`);
  }
  return parts.join("\n\n");
}