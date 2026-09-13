import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { TruthDatabase } from "./truthdb.js";
import { evidenceRecordSchema } from "../schemas/index.js";
import { splitDateRange } from "../parsers/segment.js";

const MEMORY_PATH = path.join(config.dataDir, "resume-memory.json");

// ---------------------------------------------------------------------------
// Structured resume representation
//
// The Truth Database (memory.truth_db) stays the source of truth. The
// "structured" view below is a derived, editable organisation of the same
// facts by resume section, so the UI can present a parsed master resume that
// is still fully backed by evidence.
// ---------------------------------------------------------------------------

export const STRUCTURED_SECTIONS = [
  { key: "summary", title: "Summary", categories: ["summary"] },
  { key: "experience", title: "Experience", categories: ["experience", "internship"] },
  { key: "projects", title: "Projects", categories: ["project"] },
  { key: "education", title: "Education", categories: ["education"] },
  { key: "skills", title: "Skills & Technologies", categories: ["skill"] },
  { key: "certifications", title: "Certifications", categories: ["certification"] },
  { key: "achievements", title: "Achievements", categories: ["achievement"] },
  { key: "leadership", title: "Leadership & Activities", categories: ["leadership", "activity"] },
  { key: "other", title: "Other", categories: ["other"] },
];

function factIdFor(f, i) {
  return f.evidence_id || `PREVIEW-${String(i).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Summary collapse + structured education grouping
// ---------------------------------------------------------------------------

const DEGREE_RE =
  /\b(?:b\.?\s?tech|m\.?\s?tech|b\.?\s?e(?:\.|ng)?|m\.?\s?e(?:\.|ng)?|b\.?\s?sc|m\.?\s?sc|ph\.?\s?d|mba|b\.?\s?a|m\.?\s?a|b\.?\s?com|m\.?\s?com|bba|bca|mca|b\.?\s?ed|m\.?\s?ed|b\.?\s?pharm|llb|llm|diploma|ba\s?llb|b\.?\s?arch|b\.?\s?des)\b/i;
const INSTITUTION_RE = /\b(?:university|college|institute|school|academy)\b/i;
const MONTH_TOK = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const RANGE_ONLY_RE = new RegExp(
  `^\\s*(?:${MONTH_TOK}\\s*)?(?:19|20)\\d{2}\\s*[-–—]\\s*` +
    `(?:(?:present|current|now)|(?:${MONTH_TOK}\\s*)?(?:19|20)\\d{2})\\s*$`,
  "i"
);
const YEAR_RANGE_RE = /(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|(?:present|current|now))/i;

const DEGREES = [
  "B.Tech", "M.Tech", "B.E", "M.E", "B.Sc", "M.Sc", "B.A", "M.A",
  "B.Com", "M.Com", "BBA", "BCA", "MCA", "MBA", "Ph.D", "LLB", "LLM",
  "B.Ed", "M.Ed", "BA LLB", "B.Pharm", "B.Arch", "B.Des", "Diploma",
  "SSLC", "HSC",
].sort((a, b) => b.length - a.length);

/**
 * Collapse many flat summary facts into a single one (Summary is one field).
 * Keeps the collapsed fact at the position of the first summary line.
 */
function collapseSummaryFacts(facts) {
  const list = (facts || []).slice();
  const summary = list.filter((f) => f.category === "summary");
  if (summary.length <= 1) return list;
  const first = summary[0];
  const idx = list.indexOf(first);
  const collapsed = { ...first };
  collapsed.original_text = summary
    .map((f) => (f.original_text || "").trim())
    .filter(Boolean)
    .join("\n");
  collapsed.normalized_claim = summary
    .map((f) => (f.normalized_claim || "").trim())
    .filter(Boolean)
    .join("\n");
  collapsed.line = Math.min(...summary.map((f) => (typeof f.line === "number" ? f.line : idx)));
  const kept = list.filter((f) => !summary.includes(f));
  kept.splice(Math.min(idx, kept.length), 0, collapsed);
  return kept;
}

/**
 * Group flat education lines into education entries. Each group is one
 * editable entry. Explicit `EDU-G-*` group ids are honoured (they win);
 * otherwise a line that contains a degree token, or the first line when no
 * group is open, starts a new group and everything after it attaches until
 * the next degree-like line. When `persistGroupIds` is true the derived ids
 * are written back onto the facts so removals can find whole groups.
 */
function groupEducationFacts(facts, persistGroupIds) {
  const groups = [];
  let cur = null;
  let curId = "";
  let n = 0;
  const isDegree = (f) => DEGREE_RE.test(f.original_text || "");
  for (const f of facts || []) {
    const existing = f.group_id;
    if (existing && String(existing).startsWith("EDU-G-")) {
      if (existing === curId) {
        cur.push(f);
        continue;
      }
      if (cur && cur.length) groups.push(cur);
      curId = existing;
      cur = [f];
      continue;
    }
    const opens = isDegree(f) || !cur;
    if (opens) {
      if (cur && cur.length) groups.push(cur);
      curId = `EDU-G-${Date.now().toString(36)}-${++n}`;
      cur = [f];
    } else {
      cur.push(f);
    }
    if (persistGroupIds) f.group_id = curId;
  }
  if (cur && cur.length) groups.push(cur);
  return groups;
}

function cleanLabel(s) {
  return String(s || "").replace(/\s{2,}/g, " ").trim();
}

function extractDegree(text) {
  const t = String(text || "").toUpperCase();
  const hit = DEGREES.find((d) => t.includes(d.toUpperCase()));
  return hit || "";
}

function classifyEducationType(degree) {
  const d = String(degree || "");
  if (/\b(?:\bph\.?\s?d|doctorate)\b/i.test(d) || /PH\.?D/.test(d)) return "Doctorate";
  if (/\b(?:mba|m\.?\s?com|m\.?\s?a|m\.?\s?sc|m\.?\s?tech|m\.?\s?e)\b/i.test(d)) return "Master's/Postgraduate";
  if (/\b(?:b\.?\s?tech|b\.?\s?e|b\.?\s?sc|b\.?\s?a|b\.?\s?com|bba|bca|ba\s?llb|b\.?\s?pharm|b\.?\s?arch|b\.?\s?des)\b/i.test(d)) return "Bachelor's/Undergraduate";
  if (/\bdiploma\b/i.test(d)) return "Diploma";
  if (/\b(?:sslc|hsc|certificate)\b/i.test(d)) return "High School";
  return "";
}

function extractCourse(text) {
  const m = String(text || "").match(/\bin\s+([A-Za-z][A-Za-z &/.-]{2,60}?)(?=\s*[,;(]|$)/i);
  return m ? cleanLabel(m[1]) : "";
}

function extractSpecialization(text) {
  const m = String(text || "").match(/(?:speciali[sz]ation|specializ?e[ds]?)\s*(?:in|:)?\s*([A-Za-z][A-Za-z &/.,-]{2,60})(?:$|[,;])/i);
  return m ? cleanLabel(m[1].replace(/[.,;]+$/, "")) : "";
}

function extractInstitution(text) {
  if (!INSTITUTION_RE.test(String(text || ""))) return "";
  return cleanLabel(String(text).replace(/\b(?:from|at|passed|pursuing)\b/i, ""));
}

/**
 * Turn education facts into one editable item per entry, deriving the
 * structured education fields (type / degree / course / specialization /
 * institution / duration) from the group's lines.
 */
function educationItemsFromFacts(facts, idFor) {
  return groupEducationFacts(facts, true).map((g) => {
    const primary = g[0];
    const texts = g.map((f) => f.original_text || "").filter(Boolean);
    const joined = texts.join("\n");
    const degree = primary.degree || extractDegree(joined);
    const institutionLine = g.map((f) => extractInstitution(f.original_text || "")).find(Boolean) || "";
    const durationLine = g.map((f) => (RANGE_ONLY_RE.test((f.original_text || "").trim()) ? f.original_text.trim() : "")).find(Boolean) || "";
    return {
      fact_id: idFor(primary),
      linked_ids: g.map((f) => idFor(f)).filter((id) => id !== idFor(primary)),
      kind: "education",
      text: texts[0] || "",
      claim: primary.normalized_claim || texts[0] || "",
      source_location: primary.source_location || primary.section || "",
      entity: primary.institution || institutionLine,
      duration: primary.duration || durationLine,
      education_type: primary.education_type || classifyEducationType(degree),
      education_status: primary.education_status || "",
      degree,
      course: primary.course || extractCourse(joined),
      specialization: primary.specialization || extractSpecialization(joined),
      institution: primary.institution || institutionLine,
    };
  });
}

/**
 * Collapse summary section facts into a single editor item (multiline text).
 */
function summaryItemsFromFacts(facts, idFor) {
  const flat = facts.map((f) => structuredItemsFor(f, idFor(f))).flat();
  if (flat.length <= 1) return flat;
  return [
    {
      fact_id: flat[0].fact_id,
      summary_fact_ids: flat.map((i) => i.fact_id),
      entity: flat[0].entity || "",
      source_location: flat[0].source_location,
      text: flat.map((i) => i.text).filter(Boolean).join("\n"),
      claim: undefined,
      skills: [],
      kind: "line",
    },
  ];
}

/**
 * Split a natural-language skill line (e.g. "Python, SQL · Excel") into
 * individual skills. Used when a skill fact was stored without structured
 * `technologies`, so the editor can still show one entry per skill.
 */
function splitSkillText(text) {
  return String(text || "")
    .split(/[,\n;\/|•·–—-]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Expand one fact into structured editor items.
 *
 * Deterministically parsed facts carry `item_type`:
 *   - "entry_header" becomes one editable entry (company/name, duration,
 *     location, and for projects the hyperlink text + URL);
 *   - "bullet" becomes one individually editable bullet;
 *   - "skill" stays one item per technology (each editable individually);
 *   - anything else stays a plain editable line.
 *
 * Bullets are emitted right after their (preceding) entry fact in document
 * order, so the UI group header appears above its bullets. Skill facts that
 * were stored without structured `technologies` (older memories) are split
 * with the same care as the parser so each entry stays individually editable.
 */
function structuredItemsFor(fact, baseId) {
  if (fact.category === "skill") {
    const techs = (fact.technologies || []).filter(Boolean).length
      ? fact.technologies.map((t) => String(t).trim()).filter(Boolean)
      : splitSkillText(fact.original_text || fact.normalized_claim || "");
    if (techs.length > 1) {
      return techs.map((t, i) => ({
        fact_id: `${baseId}~${i}`,
        entity: "",
        source_location: fact.source_location || fact.section || "",
        text: t,
        claim: "",
        skills: [t],
        kind: "skill",
        subcategory: fact.subcategory || "",
      }));
    }
  }

  const base = {
    fact_id: baseId,
    entity: fact.entity || "",
    source_location: fact.source_location || fact.section || "",
    text: fact.original_text || "",
    claim: fact.normalized_claim || "",
    skills: fact.technologies || [],
    kind: fact.item_type === "bullet" ? "bullet" : fact.item_type === "entry_header" ? "entry" : "line",
  };
  if (base.kind === "bullet") base.bullet = true;
  if (fact.category === "skill") base.subcategory = fact.subcategory || "";
  if (base.kind === "entry") {
    if (fact.category !== "skill") base.duration = fact.duration || "";
    base.location = fact.location || "";
    base.location_type = fact.location_type || "";
    base.role = fact.role || "";
    base.company = fact.company || "";
    let sm = fact.start_month || "", sy = fact.start_year || "", em = fact.end_month || "", ey = fact.end_year || "";
    let pres = Boolean(fact.is_present);
    // Legacy facts only carry the free-text duration; decompose it so the
    // editor's month/year controls are prefilled consistently.
    if (!sy && fact.duration && /^\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(fact.duration)) {
      const d = splitDateRange(fact.duration);
      sm = sm || d.start_month; sy = sy || d.start_year;
      em = em || d.end_month; ey = ey || d.end_year;
      pres = pres || d.is_present;
    }
    base.start_month = sm;
    base.start_year = sy;
    base.end_month = em;
    base.end_year = ey;
    base.is_present = pres;
    if (fact.category === "project") {
      base.link = { text: fact.link_text || "", url: fact.link_url || "" };
      base.tools = (fact.technologies || []).slice();
    }
  }
  if (base.kind === "bullet" || base.kind === "entry") base.group_id = fact.group_id || "";
  return [base];
}

/**
 * Build the editable structured view from any list of flat resume facts
 * (either freshly extracted lines, which carry no evidence_id yet, or the
 * records stored in Resume Memory). Items are kept in document order using the
 * line provenance recorded by the deterministic parser, so entries, bullets,
 * skills and hyperlinks appear exactly as written in the original file.
 */
export function buildStructuredFromFacts(facts, extraction = null) {
  const factsList = (facts || []).filter((f) => f?.category);
  const indexOf = new Map(factsList.map((f, i) => [f, i]));
  const ordered = factsList
    .map((f, i) => [f, i])
    .sort(([a, ai], [b, bi]) => {
      const la = typeof a.line === "number" ? a.line : ai;
      const lb = typeof b.line === "number" ? b.line : bi;
      if (la !== lb) return la - lb;
      return ai - bi;
    })
    .map(([f]) => f);
  const technologies = Array.from(
    new Set(factsList.flatMap((f) => f.technologies || []).filter(Boolean))
  );
  const sections = STRUCTURED_SECTIONS.map((s) => {
    const secFacts = ordered.filter((f) => s.categories.includes(f.category));
    const idFor = (f) => factIdFor(f, indexOf.get(f));
    let items;
    if (s.key === "education") {
      items = educationItemsFromFacts(secFacts, idFor);
    } else if (s.key === "summary") {
      items = summaryItemsFromFacts(secFacts, idFor);
    } else {
      items = secFacts.flatMap((f) => structuredItemsFor(f, idFor(f)));
    }
    return { key: s.key, title: s.title, items };
  });
  return {
    name: extraction?.name || "",
    contact: {
      email: extraction?.contact?.email || "",
      phone: extraction?.contact?.phone || "",
      location: extraction?.contact?.location || "",
      links: (extraction?.contact?.links || [])?.filter(Boolean) || [],
    },
    technologies,
    sections,
  };
}

export function buildStructured(memory) {
  const facts = ((memory && memory.truth_db) || []).filter((r) => r.source_type === "resume");
  return buildStructuredFromFacts(facts, (memory && memory.extraction) || null);
}

/**
 * Write user edits made in the structured view back onto the evidence facts.
 * Editing the structured text edits the fact, so the source of truth stays in
 * sync with what the user sees.
 */
export function applyStructuredEdits(memory, structured) {
  if (!structured) return memory;
  const byId = new Map((memory.truth_db || []).map((f) => [f.evidence_id, f]));
  for (const sec of structured.sections || []) {
    const items = sec.items || [];
    if (sec.key === "summary") {
      // Summary is a single collapsed field: write back to the first summary
      // fact and drop the others that used to carry the separate lines.
      const item = items[0];
      if (item) {
        const fact = byId.get(item.fact_id);
        if (fact) {
          const text = String(item.text ?? "");
          fact.original_text = text;
          fact.normalized_claim = String(item.claim ?? text);
          const linked = item.summary_fact_ids || [];
          memory.truth_db = (memory.truth_db || []).filter(
            (f) =>
              !(f.category === "summary" && f.evidence_id !== item.fact_id) &&
              !(linked.includes(f.evidence_id) && f.evidence_id !== item.fact_id)
          );
        }
      }
      continue;
    }
    if (sec.key === "skills") {
      // Skill items use `{fact_id}~{i}` sub ids. Group them back by record and
      // rebuild the technologies list from the edited per-skill entries.
      const byBase = new Map();
      for (const item of items) {
        const base = String(item.fact_id || "").split("~")[0];
        if (!base) continue;
        if (!byBase.has(base)) byBase.set(base, []);
        byBase.get(base).push(item);
      }
      for (const [base, group] of byBase) {
        const fact = byId.get(base);
        if (!fact) continue;
        const texts = group.map((g) => String(g.text || "").trim()).filter(Boolean);
        fact.technologies = texts;
        fact.original_text = texts.join(", ");
        fact.normalized_claim = texts.length ? texts.join(", ") : "";
        const sub = group.find((g) => g.subcategory)?.subcategory;
        if (sub !== undefined) fact.subcategory = String(sub);
      }
      continue;
    }
    if (sec.key === "education") {
      // One editable item per education entry; write structured fields back
      // onto the entry's primary fact.
      for (const item of items) {
        const fact = byId.get(item.fact_id);
        if (!fact) continue;
        if (item.text !== undefined) {
          fact.original_text = String(item.text);
          fact.normalized_claim = String(item.text);
        }
        if (item.claim !== undefined) fact.normalized_claim = String(item.claim || "");
        if (item.duration !== undefined) fact.duration = String(item.duration || "");
        if (item.education_type !== undefined) fact.education_type = String(item.education_type || "");
        if (item.degree !== undefined) fact.degree = String(item.degree || "");
        if (item.course !== undefined) fact.course = String(item.course || "");
        if (item.specialization !== undefined) fact.specialization = String(item.specialization || "");
        if (item.institution !== undefined) {
          fact.institution = String(item.institution || "");
          if (fact.institution) fact.entity = fact.institution;
        }
        if (item.education_status !== undefined) {
          const st = String(item.education_status || "");
          fact.education_status =
            st === "COMPLETED" || st === "IN_PROGRESS" ? st : "";
        }
      }
      continue;
    }
    for (const item of items) {
      const fact = byId.get(item.fact_id);
      if (!fact) continue;
      if (item.text !== undefined) {
        fact.original_text = String(item.text);
        // the claim mirrors the editor text so claims validation keeps
        // matching against what the user actually sees
        if (item.kind !== "entry") fact.normalized_claim = String(item.text);
      }
      if (item.claim !== undefined) fact.normalized_claim = String(item.claim || "");
      if (item.entity !== undefined) fact.entity = String(item.entity || "");
      if (item.kind === "entry") {
        if (item.duration !== undefined) fact.duration = String(item.duration || "");
        if (item.location !== undefined) fact.location = String(item.location || "");
        if (item.role !== undefined) fact.role = String(item.role || "");
        if (item.company !== undefined) fact.company = String(item.company || "");
        if (item.location_type !== undefined) fact.location_type = String(item.location_type || "");
        if (item.start_month !== undefined) fact.start_month = String(item.start_month || "");
        if (item.start_year !== undefined) fact.start_year = String(item.start_year || "");
        if (item.end_month !== undefined) fact.end_month = String(item.end_month || "");
        if (item.end_year !== undefined) fact.end_year = String(item.end_year || "");
        if (item.is_present !== undefined) fact.is_present = Boolean(item.is_present);
        if (fact.role || fact.company) {
          fact.entity = fact.role && fact.company ? `${fact.role} at ${fact.company}` : fact.role || fact.company;
        }
        if (fact.category === "project") {
          if (item.link) {
            fact.link_text = String(item.link.text || "");
            fact.link_url = String(item.link.url || "");
          }
          if (item.tools !== undefined) {
            fact.technologies = (item.tools || [])
              .map((t) => String(t).trim())
              .filter(Boolean);
          }
        }
      }
    }
  }
  if (structured.name !== undefined && memory.extraction) memory.extraction.name = structured.name;
  if (structured.contact && memory.extraction) {
    memory.extraction.contact = {
      email: (structured.contact.email ?? existingContact(memory).email) || "",
      phone: (structured.contact.phone ?? existingContact(memory).phone) || "",
      location: (structured.contact.location ?? existingContact(memory).location) || "",
      links: (structured.contact.links ?? (existingContact(memory).links || [])).filter(Boolean),
    };
  }
  memory.structured = buildStructured(memory);
  return memory;
}

function existingContact(memory) {
  return (memory && memory.extraction?.contact) || {};
}

/**
 * Apply add/remove edits made in the structured editor.
 *
 * The editor can add entries (with their bullets), bullets inside an existing
 * entry group, or plain lines/skills, and can remove any resume fact. Removed
 * user answers are never touched. Two id shapes are understood:
 *   - an evidence_id ("E-###") removes/resembles one stored resume fact
 *   - `{base}~{i}` sub ids (skills) drop the i-th technology from `base`'s
 *     technologies list instead of deleting the record.
 */
export function applyStructuredDelta(memory, payload) {
  if (payload?.structured) applyStructuredEdits(memory, payload.structured);
  const removed = new Set(payload?.removed || []);
  const subtitle = [];
  const dropIds = [];
  for (const id of removed) {
    if (String(id).includes("~")) subtitle.push(String(id));
    else dropIds.push(String(id));
  }

  if (subtitle.length) {
    const bySub = new Map();
    for (const sid of subtitle) {
      const [base, idx] = sid.split("~");
      if (!bySub.has(base)) bySub.set(base, []);
      bySub.get(base).push(Number(idx));
    }
    const emptied = new Set();
    for (const [base, idxs] of bySub) {
      const fact = (memory.truth_db || []).find((f) => f.evidence_id === base);
      if (!fact || fact.category !== "skill") continue;
      fact.technologies = (fact.technologies || []).filter((_, i) => !idxs.includes(i));
      if (fact.technologies.length) {
        fact.original_text = fact.technologies.join(", ");
        fact.normalized_claim = fact.technologies.join(", ");
      } else {
        emptied.add(base); // drop only the skill record that lost every technology
      }
    }
    if (emptied.size) {
      memory.truth_db = (memory.truth_db || []).filter((f) => !emptied.has(f.evidence_id));
    }
  }

  if (dropIds.length) {
    const expanded = new Set(dropIds);
    const eduMembers = (memory.truth_db || []).filter((f) => f.category === "education");
    if (eduMembers.length) {
      for (const g of groupEducationFacts(eduMembers, false)) {
        if (g.some((f) => dropIds.includes(f.evidence_id))) {
          for (const f of g) expanded.add(f.evidence_id);
        }
      }
    }
    memory.truth_db = (memory.truth_db || []).filter(
      (f) => !(f.source_type === "resume" && expanded.has(f.evidence_id))
    );
  }

  for (const def of payload?.added || []) addStructuredItem(memory, def);

  memory.structured = buildStructured(memory);
  return memory;
}

let addedGroup = 0;
function nextAddedGroup() {
  addedGroup += 1;
  return `A-${Date.now().toString(36)}-${addedGroup}`;
}

/**
 * Create new resume facts from editor additions. `def` shapes:
 *   { section, kind: "line"|"skill", text }
 *   { section, kind: "entry", entity, duration, location, link, bullets: [{text}, ...] }
 *   { section, kind: "bullet", entity, group_id, text }   (bullet in existing group)
 */
function addStructuredItem(memory, def) {
  const itemText = String(def?.text || "").trim();
  const kind = def?.kind || "line";
  const childBullets = (def?.bullets || []).map((b) => String(b?.text || "").trim()).filter(Boolean);
  if (itemText === "" && childBullets.length === 0 && kind !== "entry") return;

  const secInfo = STRUCTURED_SECTIONS.find((s) => s.key === def?.section);
  const category = def?.category || secInfo?.categories?.[0] || "other";
  const section = def?.section || secInfo ? secInfo.title : "Other";
  const entity = String(def?.entity || "").trim();

  const buildFact = (text, extra = {}) => ({
    section,
    source_location: section,
    original_text: text,
    normalized_claim: text,
    category,
    entity,
    item_type: extra.item_type || "line",
    group_id: extra.group_id || "",
    duration: extra.duration || "",
    location: extra.location || "",
    location_type: extra.location_type || "",
    role: extra.role || "",
    company: extra.company || "",
    start_month: extra.start_month || "",
    start_year: extra.start_year || "",
    end_month: extra.end_month || "",
    end_year: extra.end_year || "",
    is_present: Boolean(extra.is_present),
    education_type: extra.education_type || "",
    degree: extra.degree || "",
    course: extra.course || "",
    specialization: extra.specialization || "",
    institution: extra.institution || "",
    education_status:
      extra.education_status === "COMPLETED" || extra.education_status === "IN_PROGRESS"
        ? extra.education_status
        : "",
    link_text: extra.link_text || "",
    link_url: extra.link_url || "",
    subcategory: "",
    flags: [],
    technologies:
      extra.tools && extra.tools.length
        ? extra.tools
        : category === "skill"
          ? [text]
          : [],
    responsibilities: [],
    outcomes: [],
    metrics: [],
    team_context: "",
    skill_level: "LISTED",
    confidence: 1,
  });

  const builder = [];
  const group = nextAddedGroup();
  if (kind === "entry") {
    const role = String(def?.role || "").trim();
    const company = String(def?.company || "").trim();
    const entryEntity = entity || (role && company ? `${role} at ${company}` : role || company);
    builder.push(
      buildFact(itemText || entryEntity || "(new entry)", {
        item_type: "entry_header",
        group_id: group,
        duration: String(def?.duration || "").trim(),
        location: String(def?.location || "").trim(),
        location_type: String(def?.location_type || "").trim(),
        role,
        company,
        start_month: String(def?.start_month || "").trim(),
        start_year: String(def?.start_year || "").trim(),
        end_month: String(def?.end_month || "").trim(),
        end_year: String(def?.end_year || "").trim(),
        is_present: Boolean(def?.is_present),
        tools: (def?.tools || []).map((t) => String(t).trim()).filter(Boolean),
        link_text: String(def?.link?.text || "").trim(),
        link_url: String(def?.link?.url || "").trim(),
      })
    );
    for (const b of childBullets) {
      builder.push(buildFact(b, { item_type: "bullet", group_id: group, entity: entryEntity, role, company }));
    }
  } else if (kind === "education") {
    builder.push(
      buildFact(itemText || def?.education_text || entity || "(new education)", {
        item_type: "line",
        group_id: group,
        duration: String(def?.duration || "").trim(),
        education_type: String(def?.education_type || "").trim(),
        education_status:
          def?.education_status === "COMPLETED" || def?.education_status === "IN_PROGRESS"
            ? def.education_status
            : "",
        degree: String(def?.degree || "").trim(),
        course: String(def?.course || "").trim(),
        specialization: String(def?.specialization || "").trim(),
        institution: String(def?.institution || "").trim(),
      })
    );
  } else if (kind === "bullet") {
    builder.push(
      buildFact(itemText, { item_type: "bullet", group_id: String(def?.group_id || "").trim(), entity })
    );
  } else {
    builder.push(
      buildFact(itemText, {
        item_type: kind === "skill" ? "skill" : "line",
        subcategory: String(def?.subcategory || "").trim(),
      })
    );
  }

  if (builder.length) {
    // Seed from the memory's existing resume records so new evidence ids
    // continue from the current counters instead of colliding with existing
    // facts (a fresh TruthDatabase would mint RESUME-EXP-001 again).
    const db = new TruthDatabase(
      (memory.truth_db || []).filter((r) => r.source_type === "resume")
    );
    const created = db.addResumeFacts(builder);
    memory.truth_db = [...(memory.truth_db || []), ...created];
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function factKey(f) {
  return `${(f.section || "").toLowerCase()}::${(f.entity || "").toLowerCase()}::${(f.normalized_claim || "").trim().toLowerCase()}`;
}

export function loadMemory() {
  try {
    const raw = fs.readFileSync(MEMORY_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveMemory(memory) {
  ensureDir();
  memory.updated_at = new Date().toISOString();
  memory.structured = buildStructured(memory);
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(memory, null, 2), "utf8");
  return memory;
}

export function getMemory() {
  return loadMemory();
}

export function deleteMemory() {
  try {
    fs.unlinkSync(MEMORY_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the effective evidence base for a session:
 * Resume Memory facts (VERIFIED) + this session's USER_CONFIRMED answers.
 */
export function effectiveTruthDb(session) {
  const memory = loadMemory();
  const db = new TruthDatabase(memory ? memory.truth_db || [] : []);
  const prior = (session && session.answers ? session.answers.filter((a) => !a.declined) : []) || [];
  for (const a of prior) {
    if (!a.evidence_id) continue;
    if (db.get(a.evidence_id)) continue;
    const rec = evidenceRecordSchema.parse({
      evidence_id: a.evidence_id,
      source_type: "user_answer",
      source_location: "User answer",
      original_text: a.answer,
      normalized_claim: a.normalized_claim || "",
      status: "USER_CONFIRMED",
      confidence: 1,
      skill_level: a.skill_level || "USED",
      technologies: [],
      category: a.category || "other",
      question: a.question,
      answer: a.answer,
      requirement_id: a.requirement_id,
      created_at: a.answered_at || new Date().toISOString(),
    });
    db.records.push(rec);
  }
  return db;
}

// ---------------------------------------------------------------------------
// User answers in Resume Memory (reused across applications)
// ---------------------------------------------------------------------------

export function memoryUserAnswers() {
  const memory = loadMemory();
  if (!memory || !memory.truth_db) return [];
  return memory.truth_db.filter((r) => r.source_type === "user_answer");
}

export function findMemoryAnswer(requirementId, question) {
  return memoryUserAnswers().find(
    (a) =>
      (requirementId && a.requirement_id === requirementId) ||
      (question && a.question === question)
  ) || null;
}

/**
 * Persist a confirmed user answer into Resume Memory so future applications
 * reuse it. Dedupes by requirement_id/question; matching answers are updated in
 * place and their evidence_id is reused.
 */
export function persistUserAnswer(record) {
  const memory = loadMemory();
  if (!memory) return record;
  memory.truth_db = memory.truth_db || [];
  const existing = memory.truth_db.find(
    (r) =>
      r.source_type === "user_answer" &&
      ((record.requirement_id && r.requirement_id === record.requirement_id) ||
        (record.question && r.question === record.question))
  );
  if (existing) {
    existing.answer = record.answer;
    existing.original_text = record.answer;
    existing.normalized_claim = record.normalized_claim;
    existing.skill_level = record.skill_level || "USED";
    existing.updated_at = new Date().toISOString();
    saveMemory(memory);
    return existing;
  }
  memory.truth_db.push(evidenceRecordSchema.parse(record));
  saveMemory(memory);
  return record;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/* Wording that implies a degree is NOT finished yet. */
const EDU_ONGOING_RE =
  /(?:in\s+progress|pursuing|ongoing|expected\s+(?:to\s+)?(?:complete\w*|grad\w*|finish\w*)|currently\s+studying|will\s+(?:be\s+)?complet\w*|grad\s+(?:in\s+(?:19|20)\d{2}|\d{4})|studying|enrolled)/i;
/* Wording that implies a degree was finished. */
const EDU_COMPLETED_RE = /\b(?:completed|graduated)\b/i;

function eduRecordsMatch(a, b) {
  const inst = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const deg = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9.]+/g, "");
  const ai = inst(a.institution || a.entity);
  const bi = inst(b.institution || b.entity);
  if (ai && bi && ai === bi) return true;
  const ad = deg(a.degree);
  const bd = deg(b.degree);
  if (ad && bd && ad === bd) return true;
  return false;
}

/**
 * Detect education facts where the stored Resume Memory explicitly names a
 * completed (or in-progress) degree but the newly uploaded resume says the
 * opposite. These surface as "review" conflicts instead of silently replacing
 * the status the user already confirmed.
 */
function buildEducationConflicts(oldFacts, newFacts) {
  const stored = (oldFacts || []).filter(
    (f) =>
      f.category === "education" &&
      (f.education_status === "COMPLETED" || f.education_status === "IN_PROGRESS")
  );
  const fresh = (newFacts || []).filter((f) => f.category === "education");
  const conflicts = [];
  for (const old of stored) {
    const nw = fresh.find((f) => eduRecordsMatch(old, f));
    if (!nw) continue;
    const text = `${nw.normalized_claim || ""} ${nw.original_text || ""}`;
    const conflictsWithStored =
      old.education_status === "COMPLETED" &&
      EDU_ONGOING_RE.test(text) &&
      !EDU_COMPLETED_RE.test(text);
    const conflictsWithStoredAsProgress =
      old.education_status === "IN_PROGRESS" &&
      EDU_COMPLETED_RE.test(text) &&
      !EDU_ONGOING_RE.test(text);
    if (conflictsWithStored || conflictsWithStoredAsProgress) {
      conflicts.push({
        section: old.section || "EDUCATION",
        status: old.education_status,
        entity: old.institution || old.entity || old.degree || "",
        old_fact_id: old.evidence_id,
        new_text: (nw.original_text || nw.normalized_claim || "").trim(),
      });
    }
  }
  return conflicts;
}

/**
 * Compare newly parsed facts against stored Resume Memory.
 */
export function diffResume(newFacts, memory) {
  const oldFacts = (memory && memory.truth_db ? memory.truth_db.filter((r) => r.source_type === "resume") : []) || [];
  const oldBySection = new Map();
  for (const f of oldFacts) {
    const sec = f.section || "Other";
    if (!oldBySection.has(sec)) oldBySection.set(sec, []);
    oldBySection.get(sec).push(f);
  }
  const newBySection = new Map();
  for (const f of newFacts) {
    const sec = f.section || "Other";
    if (!newBySection.has(sec)) newBySection.set(sec, []);
    newBySection.get(sec).push(f);
  }

  const allSections = new Set([...oldBySection.keys(), ...newBySection.keys()]);
  const sections = [];
  let changed = false;

  for (const sec of [...allSections].sort()) {
    const old = oldBySection.get(sec) || [];
    const nw = newBySection.get(sec) || [];
    const oldKeys = new Map(old.map((f) => [factKey(f), f]));
    const newKeys = new Map(nw.map((f) => [factKey(f), f]));

    const added = [];
    const removed = [];
    const modified = [];

    for (const [k, f] of newKeys) {
      if (!oldKeys.has(k)) {
        const existing = [...oldKeys.values()].find((o) => o.entity?.toLowerCase() === f.entity?.toLowerCase());
        if (existing && existing.original_text !== f.original_text) {
          modified.push({ old: existing.original_text, new: f.original_text, claim: f.normalized_claim, section: sec });
        } else {
          added.push(f);
        }
      } else if (oldKeys.get(k).original_text !== f.original_text) {
        modified.push({ old: oldKeys.get(k).original_text, new: f.original_text, claim: f.normalized_claim, section: sec });
      }
    }
    for (const [k, f] of oldKeys) {
      if (!newKeys.has(k)) removed.push(f);
    }

    const status = added.length || removed.length || modified.length ? "changed" : "same";
    if (status === "changed") changed = true;
    sections.push({ section: sec, status, added, removed, modified, oldCount: old.length, newCount: nw.length });
  }

  const summary = changed
    ? sections.filter((s) => s.status === "changed").map((s) => `${s.section}: ${s.added.length} added, ${s.removed.length} removed, ${s.modified.length} changed`).join("; ")
    : "No changes detected.";

  return { changed, summary, sections, education_conflicts: buildEducationConflicts(oldFacts, newFacts) };
}

/**
 * Apply user-selected changes to Resume Memory.
 * accepted is a Set of section names (or contains "ALL").
 */
export function applyAcceptedChanges(memory, newFacts, acceptedSections) {
  const oldFacts = (memory && memory.truth_db ? memory.truth_db.filter((r) => r.source_type === "resume") : []) || [];
  const oldBySection = new Map();
  for (const f of oldFacts) {
    const sec = f.section || "Other";
    if (!oldBySection.has(sec)) oldBySection.set(sec, []);
    oldBySection.get(sec).push(f);
  }
  const newBySection = new Map();
  for (const f of newFacts) {
    const sec = f.section || "Other";
    if (!newBySection.has(sec)) newBySection.set(sec, []);
    newBySection.get(sec).push(f);
  }

  const keep = [];
  const allSections = new Set([...oldBySection.keys(), ...newBySection.keys()]);
  for (const sec of [...allSections].sort()) {
    const isAccepted = acceptedSections.has("ALL") || acceptedSections.has(sec);
    if (isAccepted) {
      const acceptedNew = newBySection.get(sec) || [];
      // Carry the user-confirmed education status onto new facts that don't
      // state one, so applying a newer resume never silently drops it.
      if (acceptedNew.some((f) => f.category === "education")) {
        const storedEdu = oldBySection.get(sec) || [];
        for (const f of acceptedNew) {
          if (f.category === "education" && !f.education_status) {
            const old = storedEdu.find(
              (o) =>
                (o.education_status === "COMPLETED" || o.education_status === "IN_PROGRESS") &&
                eduRecordsMatch(o, f)
            );
            if (old) f.education_status = old.education_status;
          }
        }
      }
      for (const f of acceptedNew) keep.push(f);
    } else {
      for (const f of oldBySection.get(sec) || []) keep.push(f);
    }
  }

  const oldKept = [];
  const newKept = [];
  for (const sec of [...allSections].sort()) {
    if (acceptedSections.has("ALL") || acceptedSections.has(sec)) {
      newKept.push(...(newBySection.get(sec) || []));
    } else {
      oldKept.push(...(oldBySection.get(sec) || []));
    }
  }

  // Old sections keep their existing evidence IDs; accepted new facts get fresh IDs.
  const db = new TruthDatabase(oldKept);
  db.addResumeFacts(newKept);

  // Preserve reused user answers (they are resume-memory-wide, not resume text).
  const userAnswers = (memory.truth_db || []).filter((r) => r.source_type === "user_answer");
  memory.truth_db = collapseSummaryFacts([...db.toJSON(), ...userAnswers]);
  memory.updated_at = new Date().toISOString();
  memory.structured = buildStructured(memory);
  return memory;
}

/**
 * Initialize Resume Memory from a freshly parsed extraction.
 * facts are the enriched fact objects from the extraction pipeline (without evidence_id yet).
 */
export function createMemoryFromExtraction({ facts, extraction, filename, raw_text }) {
  const db = new TruthDatabase([]);
  const records = collapseSummaryFacts(db.addResumeFacts(facts));
  const memory = {
    id: "resume-memory",
    filename,
    raw_text,
    extraction,
    truth_db: records,
    approved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  memory.structured = buildStructured(memory);
  return memory;
}

/**
 * Compact summary for the UI. Includes the editable structured view plus
 * per-section counts and how many personal answers are stored for reuse.
 */
export function memorySummary(memory) {
  if (!memory) return null;
  const facts = memory.truth_db || [];
  const bySection = new Map();
  for (const f of facts) {
    const sec = f.section || "Other";
    if (!bySection.has(sec)) bySection.set(sec, []);
    bySection.get(sec).push(f);
  }
  const resumeFacts = facts.filter((f) => f.source_type === "resume");
  const answerFacts = facts.filter((f) => f.source_type === "user_answer");
  return {
    filename: memory.filename,
    approved_at: memory.approved_at,
    updated_at: memory.updated_at,
    fact_count: facts.length,
    resume_fact_count: resumeFacts.length,
    answer_count: answerFacts.length,
    sections: [...bySection.entries()].map(([sec, items]) => ({ section: sec, count: items.length })),
    structured: buildStructured(memory),
  };
}