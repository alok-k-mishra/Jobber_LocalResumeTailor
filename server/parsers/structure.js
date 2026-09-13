/**
 * Deterministic résumé structure parser.
 *
 * This module changes the extracted facts from an LLM-first artifact into a
 * faithful line-by-line reading of the document, so that wording, section
 * boundaries, bullets and hyperlinks are preserved in Resume Memory.
 *
 * The parser walks the ordered model lines and maintains a tiny state machine:
 *
 *   - a line that looks like a heading starts a new section
 *   - inside an entry section (experience / internship / projects) lines that
 *     precede the first bullet are the entry header (e.g. "Data Analyst at Acme
 *     (Jun 2023 – Present, Berlin)"); lines after a bullet are treated as a
 *     wrapped continuation of the current bullet instead of a separate bullet,
 *     unless they read like a new entry header
 *   - flat sections (skills, summary, education, achievements, ...) emit one
 *     record per line, with wrapped lines merged back into the same bullet
 *
 * No token is ever fabricated: durations, locations, hyperlinks and companies
 * are only emitted when they can be recovered from the document text.
 */

import {
  BULLET_RE,
  RANGE_RE,
  LOCATION_RE,
  REMOTE_TERMS,
  URL_RE,
  DOMAIN_RE,
  EMAIL_RE,
  PHONE_RE,
  cleanBulletText,
  extractHeader,
  looksLikeHeading,
  splitRoleCompany,
  splitDateRange,
  detectLocationType,
  monthAbbrev,
} from "./segment.js";

// ---------------------------------------------------------------------------
// section classification
// ---------------------------------------------------------------------------

const ENTRY_CATEGORIES = new Set(["experience", "internship", "project"]);

const SECTION_CATEGORY = {
  summary: "summary",
  objective: "summary",
  profile: "summary",
  about: "summary",
  skills: "skill",
  "technical skills": "skill",
  "core competencies": "skill",
  languages: "skill",
  experience: "experience",
  "work experience": "experience",
  "professional experience": "experience",
  employment: "experience",
  internships: "internship",
  internship: "internship",
  projects: "project",
  "personal projects": "project",
  "academic projects": "project",
  education: "education",
  certifications: "certification",
  certificates: "certification",
  achievements: "achievement",
  awards: "achievement",
  leadership: "leadership",
  activities: "activity",
  extracurricular: "activity",
  volunteering: "activity",
  publications: "other",
  interests: "other",
};

const SKILL_SECTIONS = new Set(["skills", "technical skills", "core competencies", "languages"]);

export function sectionCategory(name) {
  return SECTION_CATEGORY[String(name || "").toLowerCase().replace(/[:#]+$/, "").trim()] || "other";
}

function isEntrySection(name) {
  return ENTRY_CATEGORIES.has(sectionCategory(name));
}

// ---------------------------------------------------------------------------
// skill grouping helpers
// ---------------------------------------------------------------------------

const SKILL_GROUP_LABELS = {
  languages: "languages",
  framework: "frameworks",
  frameworks: "frameworks",
  library: "frameworks",
  libraries: "frameworks",
  tool: "tools",
  tools: "tools",
  utility: "tools",
  utilities: "tools",
  database: "other",
  databases: "other",
  platform: "tools",
  platforms: "tools",
  cloud: "tools",
  devops: "tools",
  ide: "tools",
  ides: "tools",
  editor: "tools",
  editors: "tools",
  other: "other",
  others: "other",
};

const GROUP_KEYWORDS = {
  languages: ["python", "javascript", "typescript", "java", "c++", "cpp", "c#", "golang", "go", "rust", "ruby", "php", "kotlin", "swift", "scala", "r ", "sql", "nosql", "html", "css", "perl", "bash", "shell", "matlab", "powershell", "groovy", "dart", "julia", "lua", "haskell", "elixir", "solidity", "js", "ts"],
  frameworks: ["react", "node.js", "node", "express", "django", "flask", "fastapi", "spring", "angular", "vue", "svelte", "next.js", "nuxt", "rails", "laravel", "asp.net", ".net", "tensorflow", "pytorch", "pandas", "numpy", "scikit-learn", "scikit", "matplotlib", "seaborn", "spark", "hadoop", "kafka", "airflow", "redux", "tailwind", "bootstrap", "jquery", "d3", "three.js", "keras", "opencv", "jupyter"],
  tools: ["git", "github", "gitlab", "docker", "kubernetes", "k8s", "jenkins", "ansible", "terraform", "aws", "azure", "gcp", "excel", "tableau", "power bi", "google sheets", "notion", "mlflow", "wandb", "linux", "unix", "postman", "jira", "figma", "nginx", "salesforce", "looker", "snowflake"],
};

export function skillGroupFor(skill) {
  const s = String(skill || "").toLowerCase().trim();
  for (const [group, words] of Object.entries(GROUP_KEYWORDS)) {
    if (words.some((w) => s === w || s.endsWith(" " + w))) return group;
  }
  // bracketed hints, e.g. "R (statistics)"
  if (/\(.*\b(statistics|stats|analysis)\b.*\)/.test(s)) return "languages";
  return "other";
}

const SKILL_LABEL_RE = /^(languages?|technologies?|frameworks?|libraries?|tools?|utilities?|databases?|platforms?|cloud|devops?|ides?|editors?|other(?:s)?)\s*:\s*/i;

export function stripSkillLabel(text) {
  const m = SKILL_LABEL_RE.exec(text);
  if (!m) return { label: null, rest: text.trim() };
  const label = m[1].toLowerCase();
  const rest = text.slice(m[0].length).trim();
  return {
    label,
    rest: rest.replace(/[.;]+$/, "").trim(),
    group: SKILL_GROUP_LABELS[label] || "other",
  };
}

const SKILL_SEP = /[;,•|\n]+/;
const SKILL_KEYWORDS = {
  languages: /python|javascript|type.?script|java|c\+\+|c#|golang|go\b|rust|ruby|php|kotlin|swift|scala|abap|sql|nosql|html|css|perl|bash|shell|matlab|powershell|dart|julia|lua|haskell|elixir|solidity|\br\b/i,
  frameworks: /react|node\.?js|express|django|flask|fastapi|spring|angular|vue|svelte|next\.?js|nuxt|rails|laravel|asp\.?net|\.net|tensorflow|pytorch|pandas|numpy|scikit|matplotlib|seaborn|spark|hadoop|kafka|airflow|redux|tailwind|bootstrap|jquery|d3|three\.?js|keras|opencv|jupyter/i,
  tools: /git|github|gitlab|docker|kubernetes|jenkins|ansible|terraform|aws|azure|gcp|excel|tableau|power\s?bi|notion|mlflow|wandb|linux|unix|postman|jira|figma|nginx|salesforce|looker|snowflake|maven|gradle|npm|yarn|vscode/i,
};

/**
 * Split a skills line into individual tokens. Returns a tagged list so each
 * token can be stored and edited independently. When the line carried a label
 * (e.g. "Databases:"), tokens that match no keyword keep that label's group;
 * otherwise the caller's fallback group is used.
 */
export function splitSkillText(text, fallbackGroup = "other") {
  return String(text || "")
    .split(SKILL_SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) => {
      const group =
        GROUP_KEYWORDS_lookup(value) ||
        (SKILL_KEYWORDS.frameworks.test(value) && "frameworks") ||
        (SKILL_KEYWORDS.tools.test(value) && "tools") ||
        fallbackGroup;
      return { value, group };
    });
}

function GROUP_KEYWORDS_lookup(value) {
  const s = value.toLowerCase();
  for (const [group, words] of Object.entries(GROUP_KEYWORDS)) {
    if (words.some((w) => s === w || s.startsWith(w + " ") || s.endsWith(" " + w))) return group;
  }
  return null;
}

// ---------------------------------------------------------------------------
// record construction
// ---------------------------------------------------------------------------

let groupCounter = 0;
function nextGroupId() {
  groupCounter += 1;
  return `G-${groupCounter}`;
}

export function newGroupCounter() {
  groupCounter = 0;
}

function locationLike(text) {
  const t = (text || "").trim();
  if (!t) return false;
  if (REMOTE_TERMS.includes(t.toLowerCase())) return true;
  if (LOCATION_RE.test(t)) return true;
  return /^\p{Lu}[\p{L} .'’-]*(?:\s+(?:City|State|Province|Region|District|Territory))?$/u.test(t) === false
    ? false
    : /\b(India|USA|UK|UAE|Germany|Australia|Canada|Singapore|London|New York|Berlin|Bengaluru|San Francisco|Remote)\b/i.test(t);
}

/**
 * Pull company / duration / location out of entry header lines.
 */
function extractEntryFields(entry) {
  const lines = entry.headerLines;
  let duration = "";
  let entity = lines.join(" · ") || "";
  for (const line of lines) {
    const m = RANGE_RE.exec(line);
    if (m && m[0].length > duration.length) duration = m[0].replace(/^\s*[-–—]\s*/, "").trim() || m[0].trim();
    if (m) entity = entity.replace(m[0], "");
  }
  const titleLine = lines[0] || entity;
  let location = "";
  for (const line of lines.filter((l) => l !== titleLine)) {
    if (RANGE_RE.test(line) && !/[a-z]{3,}/i.test(line.replace(RANGE_RE, ""))) continue;
    if (locationLike(line)) { location = line; break; }
  }
  entity = String(entity)
    .replace(/[()]/g, "")
    .replace(/[|·•–—:-]+$/, "")
    .replace(/^\s*[-–—·|:]\s*|\s*[-–—·|:]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const { role, company } = splitRoleCompany(entity);
  const location_type = detectLocationType(entity) || detectLocationType(location);
  const date = splitDateRange(duration);
  return {
    entity,
    duration,
    location,
    role,
    company,
    location_type,
    start_month: monthAbbrev(date.start_month),
    start_year: date.start_year,
    end_month: monthAbbrev(date.end_month),
    end_year: date.end_year,
    is_present: date.is_present,
  };
}

/**
 * Pull name / hyperlink out of project header lines.
 */
function extractProjectFields(entry) {
  const headerLines = [...entry.headerLines];
  let headerText = headerLines.join(" · ") || "";

  // Pull an explicit "Tools: ..." line out so it can be stored as the project
  // technology list instead of polluting the project name.
  let tools = [];
  headerText = headerLines
    .map((line) => {
      const m = /^(?:tools?|technologies?|tech stack|stack|built with|using)\s*[:—-]\s*(.+)$/i.exec(line.trim());
      if (!m) return line;
      tools = m[1]
        .split(/[,\/;|•·–—-]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return "";
    })
    .filter(Boolean)
    .join(" · ");

  // Duration (e.g. "Jun 2024 - Aug 2024") also gets pulled out of the name.
  let duration = "";
  headerText = headerText.replace(RANGE_RE, (match) => {
    duration = match.trim();
    return "";
  });

  const typed = entry.links?.[0] || null;
  let url = typed ? typed.url : null;
  let linkText = "";
  if (!url) {
    const m = URL_RE.exec(headerText);
    if (m) url = m[0];
  }
  let name = headerText.replace(/[（(].*?[)）]/, " ").trim();
  if (url) {
    name = headerText
      .replace(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "")
      .replace(/[|·•–—:-]+$/, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    linkText = typed ? (typed.text || name) : url;
  }
  const flags = [];
  if (!url && DOMAIN_RE.test(headerText)) flags.push("link_missing");
  if (url && !/^https?:\/\//.test(url)) url = `http://${url}`;
  const date = splitDateRange(duration);
  return {
    entity: name,
    link_text: linkText,
    link_url: url || "",
    flags,
    tools,
    duration,
    location: detectLocationType(name) || "",
    location_type: detectLocationType(name),
    start_month: monthAbbrev(date.start_month),
    start_year: date.start_year,
    end_month: monthAbbrev(date.end_month),
    end_year: date.end_year,
    is_present: date.is_present,
  };
}

// ---------------------------------------------------------------------------
// main entry point
// ---------------------------------------------------------------------------

export function structureDocument(doc) {
  const header = extractHeader(doc.rawText || "", []);
  return buildStructuredLines(doc.lines || [], header);
}

export function buildStructuredLines(modelLines, header) {
  newGroupCounter();
  const records = [];
  const seenSections = [];
  const skipHeader = new Set(
    [header.name, header.email, header.phone, ...(header.links || [])].filter(Boolean)
  );

  let sectionName = "Header";
  let sectionCat = "other";
  let entry = null;
  let lastWasBullet = false;

  const baseRecord = (text, extra = {}) => ({
    section: sectionName,
    category: sectionCat,
    source_location: sectionName,
    original_text: text,
    normalized_claim: text,
    entity: extra.entity || "",
    item_type: extra.item_type || "line",
    group_id: "",
    duration: "",
    location: "",
    link_text: "",
    link_url: "",
    subcategory: extra.subcategory || "",
    flags: extra.flags || [],
    page: extra.page,
    line: extra.line,
    technologies: extra.technologies || [],
    responsibilities: [],
    outcomes: [],
    metrics: [],
    team_context: "",
    skill_level: "LISTED",
    confidence: 0.7,
  });

  const makeEntry = (ml) => ({
    section: sectionName,
    category: sectionCat,
    group: nextGroupId(),
    headerLines: [],
    bullets: [],
    links: [],
    page: ml.page,
    line: ml.line,
  });

  const emitEntry = () => {
    if (!entry) return;
    let record;
    if (entry.category === "project") {
      const f = extractProjectFields(entry);
      record = baseRecord(entry.headerLines.join(" · ") || "", {
        entity: f.entity,
        item_type: "entry_header",
        link_text: f.link_text,
        link_url: f.link_url,
        flags: f.flags,
        page: entry.page,
        line: entry.line,
      });
    } else {
      const f = extractEntryFields(entry);
      record = baseRecord(entry.headerLines.join(" · ") || "", {
        entity: f.entity,
        item_type: "entry_header",
        flags: f.flags || [],
        page: entry.page,
        line: entry.line,
      });
      record.duration = f.duration;
      record.location = f.location;
    }
    record.group_id = entry.group;
    record.normalized_claim = record.original_text;
    if (record.original_text || entry.bullets.length) records.push(record);
    for (const b of entry.bullets) {
      const br = baseRecord(b, {
        entity: record.entity,
        item_type: "bullet",
        page: entry.page,
        line: entry.line,
      });
      br.group_id = entry.group;
      br.normalized_claim = b;
      records.push(br);
    }
    entry = null;
  };

  const addFlatRecord = (raw, clean, ml) => {
    const text = (clean ? cleanBulletText(raw) : String(raw).trim());
    if (!text) return;
    if (SKILL_SECTIONS.has(sectionName.toLowerCase().replace(/[:#]+$/, "").trim())) {
      const { label, rest, group } = stripSkillLabel(text);
      const tokens = label ? splitSkillText(rest, group) : splitSkillText(text);
      if (label && tokens.length === 0) {
        records.push(baseRecord(text, { item_type: "skill", subcategory: group, technologies: [text], page: ml.page, line: ml.line }));
      } else {
        for (const t of tokens.length ? tokens : [{ value: text, group: group || "other" }]) {
          records.push(
            baseRecord(t.value, {
              item_type: "skill",
              subcategory: t.group || "other",
              entity: t.value,
              technologies: [t.value],
              page: ml.page,
              line: ml.line,
            })
          );
        }
      }
      return;
    }
    records.push(baseRecord(text, { item_type: "line", page: ml.page, line: ml.line }));
  };

  const looksLikeEntryHeader = (raw) => {
    if (!raw || raw.length > 120) return false;
    if (/^[a-z0-9]/.test(raw)) return false;
    if (/[.!?;]$/.test(raw)) return false;
    if (BULLET_RE.test(raw)) return false;
    if (RANGE_RE.test(raw)) return true;
    if (raw === raw.toUpperCase() && /[A-Z]/.test(raw) && !looksLikeHeading(raw)) return true;
    if (/[|:—–]/.test(raw) && !EMAIL_RE.test(raw) && !PHONE_RE.test(raw)) return true;
    if (/,/.test(raw)) return true;
    return false;
  };

  const isContinuation = (raw, last) => {
    if (!last) return false;
    const prev = String(last.original_text || "").trim();
    if (/[.!?;:—–-]$/.test(prev)) return false;
    if (/^[a-z0-9]/.test(raw)) return true;
    return false;
  };

  for (const ml of modelLines) {
    const raw = String(ml.text || "").trim();
    if (!raw) continue;

    // name/contact/location lines in the header block are never headings,
    // never records — and never sections even when written in ALL CAPS.
    if (sectionName === "Header" && (skipHeader.has(raw) || EMAIL_RE.test(raw) || PHONE_RE.test(raw) || /^(https?:\/\/|www\.)/i.test(raw))) {
      lastWasBullet = false;
      continue;
    }

    const isBullet = ml.bullet || BULLET_RE.test(raw);

    // section headers (KNOWN headings, or clean ALL CAPS section titles)
    if (!isBullet && looksLikeHeading(raw)) {
      emitEntry();
      sectionName = raw.replace(/[:#]+$/, "").trim();
      sectionCat = sectionCategory(sectionName);
      if (!seenSections.includes(sectionName)) seenSections.push(sectionName);
      lastWasBullet = false;
      continue;
    }

    // header block (above the first section heading): keep name/contact out
    if (sectionName === "Header") {
      addFlatRecord(raw, false, ml);
      lastWasBullet = false;
      continue;
    }

    if (isEntrySection(sectionName)) {
      if (isBullet) {
        if (!entry) entry = makeEntry(ml);
        entry.bullets.push(cleanBulletText(raw));
        lastWasBullet = true;
        continue;
      }
      if (!entry) entry = makeEntry(ml);
      if (entry.bullets.length > 0) {
        if (looksLikeEntryHeader(raw)) {
          emitEntry();
          entry = makeEntry(ml);
          entry.headerLines.push(raw);
          entry.links = ml.links || [];
          lastWasBullet = false;
        } else {
          // wrapped continuation of the current bullet
          const idx = entry.bullets.length - 1;
          entry.bullets[idx] = `${entry.bullets[idx]} ${raw}`;
        }
      } else {
        entry.headerLines.push(raw);
        entry.links = [...(entry.links || []), ...(ml.links || [])];
        lastWasBullet = false;
      }
      continue;
    }

    // flat sections
    if (isBullet) {
      addFlatRecord(raw, true, ml);
      lastWasBullet = true;
      continue;
    }
    const last = records[records.length - 1];
    if (lastWasBullet && last && isContinuation(raw, last)) {
      last.original_text = `${last.original_text} ${raw}`;
      last.normalized_claim = last.original_text;
    } else {
      addFlatRecord(raw, false, ml);
      lastWasBullet = false;
    }
  }
  emitEntry();

  return { header, records, sections: seenSections };
}

export { looksLikeHeading, cleanBulletText };