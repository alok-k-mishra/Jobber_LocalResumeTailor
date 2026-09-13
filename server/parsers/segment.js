/**
 * Resume header + token helpers.
 *
 * This module owns the regexes and the contact-header detector used by the
 * deterministic structure parser. The structure parser (structure.js) owns
 * section/section-entry/bullet detection; the LLM is never the source of truth
 * for wording, section boundaries, bullets or hyperlinks.
 */

export const BULLET_RE = /^\s*(?:[-*•‣▪◦●○–—]|\u2022|\d+[.)])\s+/;
export const CONTACT_RE = /(@|\+?\d[\d\s().-]{6,}\d|https?:\/\/|www\.|linkedin\.com|github\.com)/i;
export const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/;
export const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
export const URL_RE = /((?:https?:\/\/|www\.)[^\s,;)]+|(?:linkedin|github)\.com\/[^\s,;)]+)/gi;
export const DOMAIN_RE = /(?:[a-z0-9-]+\.)+(?:com|io|dev|org|net|ai|app|co|me|in|github\.io)(?:\/[^\s,;)]*)?/i;

export const MONTHS =
  "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";

// A duration/date range, e.g. "Jun 2024 - Aug 2024", "2021 - 2025",
// "May 2021 - Present". Used to pull duration out of an entry header and to
// stop an ALL CAPS date range from being misclassified as a section heading.
export const RANGE_RE = new RegExp(
  `(${MONTHS}\\s*\\d{4}|\\d{4})\\s*(?:–|—|--|to|through|-)\\s*(Present|Current|Now|${MONTHS}\\s*\\d{4}|\\d{4})`,
  "i"
);

export const LOCATION_RE = /^[\p{L} .'’-]{2,60},\s*[\p{L} .'’-]{2,60}$/u;
export const REMOTE_TERMS = ["remote", "hybrid", "on-site", "onsite", "wfh", "relocate"];

const KNOWN_HEADINGS = [
  "summary",
  "objective",
  "profile",
  "about",
  "skills",
  "technical skills",
  "core competencies",
  "experience",
  "work experience",
  "professional experience",
  "employment",
  "internships",
  "internship",
  "projects",
  "personal projects",
  "academic projects",
  "education",
  "certifications",
  "certificates",
  "achievements",
  "awards",
  "leadership",
  "activities",
  "extracurricular",
  "volunteering",
  "publications",
  "interests",
  "languages",
];

export function looksLikeDateRange(line) {
  const raw = String(line || "").trim();
  return RANGE_RE.test(raw) && /^\d{4}|Present/i.test(raw.replace(RANGE_RE, ""));
}

// ALL CAPS lines that are really job titles / company lines, never headings.
const CAPS_ROLE_RE = /(ENGINEER|DEVELOPER|DESIGNER|ANALYST|MANAGER|DIRECTOR|LEAD|SENIOR|JUNIOR|INTERN|DATA|SOFTWARE|WEB|MOBILE|CLOUD|SALES|MARKETING|RESEARCH|SCIENTIST|ASSOCIATE|PRODUCT|CONSULTANT|ARCHITECT|FREELANCER|OWNER)/i;

export function looksLikeHeading(line) {
  const raw = String(line || "").trim();
  if (!raw) return false;
  if (raw.length > 48) return false;
  if (/[.!?;:,]$/.test(raw)) return false;
  if (BULLET_RE.test(raw)) return false;
  if (RANGE_RE.test(raw)) return false; // "JAN 2020 – PRESENT" is a duration, not a heading
  const lower = raw.toLowerCase().replace(/[:#]+$/, "").trim();
  if (KNOWN_HEADINGS.includes(lower)) return true;
  // ALL CAPS heading — but not a caps job title / company line.
  const letters = raw.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 3 && raw === raw.toUpperCase()) {
    if (CAPS_ROLE_RE.test(raw)) return false;
    if (/,|•|\./.test(raw)) return false;
    if (raw.length <= 26) return true;
  }
  return false;
}

export function cleanBulletText(line) {
  return String(line || "").replace(BULLET_RE, "").trim();
}

export function isContactLine(text) {
  return CONTACT_RE.test(text) && text.length < 120;
}

/**
 * Detect name, email, phone, links and an optional location in the header
 * block (the first lines before the first section heading).
 */
export function extractHeader(rawText, items) {
  const lines = String(rawText || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const isNameShape = (l) =>
    l.length <= 48 &&
    !EMAIL_RE.test(l) &&
    !PHONE_RE.test(l) &&
    !BULLET_RE.test(l) &&
    !RANGE_RE.test(l) &&
    /^[A-Za-z][A-Za-z.'-]+(?:\s+[A-Za-z][A-Za-z.'-]+){1,3}$/.test(l);

  // The first line of a resume is almost always the candidate's name, even when
  // it is written in ALL CAPS (which looks like a section heading).
  const first = lines[0];
  const name = (first && isNameShape(first) ? first : "") ||
    lines.find((l) => isNameShape(l) && !looksLikeHeading(l)) ||
    "";

  const joined = lines.join("\n");
  const email = (joined.match(EMAIL_RE) || [""])[0];
  const phone = (joined.match(PHONE_RE) || [""])[0];
  const links = Array.from(new Set(joined.match(URL_RE) || []));

  // Location: a short comma-separated place line (or a remote/hybrid marker)
  // in the header block, clearly distinguishable from the name.
  let location = "";
  for (const l of lines.slice(0, 10)) {
    if (!l || l === name || isContactLine(l) && l.length > 64) continue;
    if (REMOTE_TERMS.includes(l.toLowerCase())) { location = l; break; }
    if (LOCATION_RE.test(l) && !/^[A-Z][a-z]+ [A-Z][a-z]+$/.test(l.replace(/,.*/, ""))) {
      location = l;
      break;
    }
  }

  return { name, email, phone, links, location };
}

export function contactEvidenceTexts(items) {
  return items.filter((i) => i.isContact).map((i) => i.text);
}

// ---------------------------------------------------------------------------
// Entry-field helpers (company/role split, structured date ranges)
// ---------------------------------------------------------------------------

// Words that indicate a job-title-ish fragment.
const ROLE_HINT =
  /\b(?:engineer|developer|analyst|scientist|manager|director|lead|senior|junior|intern|consultant|architect|designer|specialist|officer|programmer|researcher|tester|qa|associate|coordinator|freelancer|owner|executive|head|principal|data|software|web|mobile|cloud|devops|machine|business|product|project|ux|ui|full[- ]stack)\b/i;
// Words that indicate an organisation-ish fragment.
const ORG_HINT =
  /\b(?:ltd|limited|inc|corporation|corp|private|pvt|plc|llc|company|co\.|technologies|technology|tech|software|solutions|solution|services|service|systems|system|consulting|consultancy|labs|lab|banks?|group|ventures|academy|university|college|institute|school|&\b|,|engineering|industries)\b/i;

/**
 * Best-effort split of an entry entity into role and company.
 * Falls back to leaving everything as `company` when nothing hints.
 */
export function splitRoleCompany(entity) {
  const text = String(entity || "").trim();
  if (!text) return { role: "", company: "" };

  const endsWithRole = (side) => ROLE_HINT.test(side);
  const pickRole = (left, right) => {
    if (endsWithRole(left)) return { role: stripEnd(left), company: stripEnd(right) };
    if (endsWithRole(right)) return { role: stripEnd(right), company: stripEnd(left) };
    return { role: "", company: stripEnd(left) };
  };

  const stripEnd = (s) => s.replace(/^[|·•–—:\s]+|[|·•–—:\s]+$/g, "").trim();

  // "Role at Company"
  let m = text.match(/^(.*?)\s+at\s+(.+)$/i);
  if (m && m[1].trim() && m[2].trim()) {
    return { role: stripEnd(m[1]), company: stripEnd(m[2]) };
  }
  // "Company | Role" | "Role | Company"
  const bar = text.split("|").map((s) => s.trim());
  if (bar.length === 2 && bar[0] && bar[1]) {
    const role = barsPickRole(bar);
    if (role) return role;
    return { role: "", company: bar[0] };
  }
  // "Role, Company" — only split when the left side reads like a role.
  const comma = text.split(",").map((s) => s.trim());
  if (comma.length >= 2) {
    const first = comma[0];
    const rest = comma.slice(1).join(", ").trim();
    if (endsWithRole(first)) return { role: stripEnd(first), company: stripEnd(rest) };
  }
  // "Company - Role" | "Role - Company"
  const dash = text.split(/\s+[–—-]\s+/).map((s) => s.trim());
  if (dash.length === 2 && dash[0] && dash[1]) {
    return pickRole(dash[0], dash[1]);
  }
  return { role: "", company: text };
}

function barsPickRole(sides) {
  const [a, b] = sides;
  const aRole = ROLE_HINT.test(a);
  const bRole = ROLE_HINT.test(b);
  if (aRole && !bRole) return { role: a, company: b };
  if (bRole && !aRole) return { role: b, company: a };
  if (ORG_HINT.test(b) && !ORG_HINT.test(a)) return { role: a, company: b };
  if (ORG_HINT.test(a) && !ORG_HINT.test(b)) return { role: b, company: a };
  return null;
}

/**
 * Split a duration string into structured month/year fields.
 * Accepts "Jun 2024 - Aug 2024", "2021 - 2025", "May 2021 - Present" etc.
 */
export function splitDateRange(duration) {
  const text = String(duration || "").trim();
  const out = { start_month: "", start_year: "", end_month: "", end_year: "", is_present: false };
  if (!text) return out;
  const rx = new RegExp(
    `^(${MONTHS}\\s*\\d{4}|\\d{4})\\s*(?:–|—|--|to|through|-)\\s*(Present|Current|Now|${MONTHS}\\s*\\d{4}|\\d{4})?$`,
    "i"
  );
  const m = rx.exec(text);
  if (!m) return out;
  const parse = (part) => {
    const mm = part.match(new RegExp(`(${MONTHS})\\s*(\\d{4})`, "i"));
    if (mm) return { month: cap(mm[1]), year: mm[2] };
    const yy = part.match(/(\d{4})/);
    return { month: "", year: yy ? yy[1] : "" };
  };
  const from = parse(m[1]);
  out.start_month = from.month;
  out.start_year = from.year;
  if (m[2] && /present|current|now/i.test(m[2])) {
    out.is_present = true;
  } else if (m[2]) {
    const to = parse(m[2]);
    out.end_month = to.month;
    out.end_year = to.year;
  }
  return out;
}

function cap(s) {
  const v = String(s || "");
  if (!v) return "";
  return v.charAt(0).toUpperCase() + v.slice(1, 3).toLowerCase();
}

const MONTHS_FULL = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function monthAbbrev(name) {
  const v = String(name || "").trim().toLowerCase();
  if (!v) return "";
  const m = MONTHS_FULL.find((mth) => mth.toLowerCase() === v || mth.toLowerCase().slice(0, 3) === v.slice(0, 3));
  return m || cap(v);
}

export function detectLocationType(text) {
  const t = String(text || "").toLowerCase();
  if (/remote|work from home|wfh/.test(t)) return "Remote";
  if (/hybrid/.test(t)) return "Hybrid";
  if (/on-?site/.test(t)) return "On-site";
  return "";
}