import path from "node:path";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);
const mammoth = require("mammoth");

/**
 * Line model.
 *
 * Every parser reduces a document to an ordered array of model lines. Each line
 * keeps the raw text runs (`parts`), any hyperlinks recovered from the file,
 * and whether the file itself marked the line as a bullet or heading. Section /
 * entry / bullet classification happens later in structure.js; this layer only
 * preserves what the document visually says.
 *
 * @typedef {Object} ModelLine
 * @property {string} text       joined visible text of the line
 * @property {Array}  parts      runs: { text, x?, link? }
 * @property {Array}  links      { text, url } recovered hyperlinks
 * @property {boolean} bullet    true when the file marked this as a bullet item
 * @property {boolean} heading   true when the file marked this as a heading
 * @property {number}  page
 * @property {number}  line      ordinal line on the file (0-based)
 */

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/**
 * Build visual lines from pdf.js text items. Items are grouped by baseline (y),
 * ordered left-to-right (x), and each run records its x for gap detection and
 * page number. Hyperlinks are attached by intersecting run rects with the
 * page's Link annotations.
 */
function buildPdfLines(items, annotations, page) {
  const rects = (annotations || [])
    .filter((a) => a && a.url && Array.isArray(a.rect))
    .map((a) => ({ url: a.url, rect: a.rect }));

  const pointIn = (x, y) => {
    for (const r of rects) {
      const [x1, y1, x2, y2] = r.rect;
      if (x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) {
        return r.url;
      }
    }
    return null;
  };

  // group by baseline y
  const byY = new Map();
  for (const it of items) {
    if (typeof it.str !== "string" || it.str === "") continue;
    const [a, b] = it.transform || [1, 0, 0, 1, 0, 0];
    const x = it.transform?.[4] ?? 0;
    const rawY = it.transform?.[5] ?? 0;
    const y = Math.round(rawY / 2) * 2;
    const w = it.width || Math.max(1, String(it.str).length * Math.abs(a));
    const h = it.height || Math.abs(a) || 10;
    const link = (() => {
      const urls = pointIn(x + w / 2, rawY - h / 2);
      if (urls) return urls;
      return pointIn(x + w / 2, rawY);
    })();
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y).push({ x, w, text: it.str, url: link });
  }

  return [...byY.keys()]
    .sort((a, b) => b - a) // top of page first
    .map((y, lineIdx) => {
      const parts = byY.get(y).sort((a, b) => a.x - b.x).map((p) => ({ text: p.text, x: p.x, link: p.url ? { text: p.text, url: p.url } : null }));
      return {
        text: parts.map((p) => p.text).join(" ").replace(/\s+/g, " ").trim(),
        parts,
        links: parts.map((p) => p.link).filter(Boolean),
        bullet: false,
        heading: false,
        page,
        line: lineIdx,
      };
    })
    .filter((l) => l.text.length > 0);
}

export async function parsePdf(buffer) {
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise;

  const lines = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let annotations = [];
    try {
      annotations = await page.getAnnotations();
    } catch {
      /* annotations are best-effort; text URL tokens are recovered later */
    }
    lines.push(...buildPdfLines(content.items, annotations, i));
  }
  await doc.destroy();

  const pages = new Set(lines.map((l) => l.page));
  const rawText = [...pages]
    .sort((a, b) => a - b)
    .map((p) => lines.filter((l) => l.page === p).map((l) => l.text).join("\n"))
    .join("\n\n");
  return { rawText, lines, source: "pdf" };
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------

/**
 * Reassemble mammoth's HTML into model lines.
 *
 * mammoth's default output is a small vocabulary: paragraphs, lists, heading
 * levels and anchors (`<a href>`), so a lightweight scan suffices. Hard line
 * breaks (`<br>`) inside a paragraph are kept inside the same line because in a
 * resume they are almost always a wrapped continuation of one bullet, not a new
 * bullet. Returns true for `<li>` blocks (marked by the file) and heading levels.
 */
function htmlToModelLines(html) {
  const lines = [];
  const stack = [];
  let textBuf = "";
  let linkBuf = null; // { url, text }
  let links = [];

  const flushText = () => {
    if (linkBuf) {
      linkBuf.text += textBuf;
      textBuf = "";
    }
  };

  const flushLine = () => {
    flushText();
    if (linkBuf) {
      links.push(linkBuf);
      linkBuf = null;
    }
    const open = stack[stack.length - 1];
    const text = textBuf.replace(/\s+/g, " ").trim();
    textBuf = "";
    if (!text && links.length === 0) return;
    lines.push({
      text,
      parts: [{ text, link: links.length ? links[links.length - 1] : null }],
      links,
      bullet: open?.kind === "li",
      heading: open?.kind?.startsWith("h"),
      page: 1,
      line: lines.length,
    });
    links = [];
  };

  const tags = [];
  const tokenRe = /<[^>]*>|[^<]+/g;
  let m;
  while ((m = tokenRe.exec(html))) {
    const tok = m[0];
    if (tok[0] !== "<") {
      if (linkBuf) linkBuf.text += tok;
      textBuf += tok;
      continue;
    }
    const match = /^<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s+([^>]*))?>/.exec(tok);
    if (!match) continue;
    const tag = match[1].toLowerCase();
    const attrs = match[2] || "";
    const closing = tok[1] === "/";
    if (closing) {
      if (tag === "a" && linkBuf) {
        linkBuf.text = linkBuf.text.replace(/\s+/g, " ").trim();
        links.push(linkBuf);
        linkBuf = null;
      }
      const popped = stack.pop();
      if (popped) {
        if (popped.kind === "p" || popped.kind === "li" || popped.kind?.startsWith("h")) flushLine();
      }
      continue;
    }
    // opening tag
    switch (tag) {
      case "p":
      case "li":
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        stack.push({ kind: tag });
        break;
      case "br":
        textBuf += " "; // wrapped continuation, not a new line
        break;
      case "a": {
        const href = /href="([^"]*)"/.exec(attrs)?.[1] || "";
        linkBuf = { url: href, text: "" };
        break;
      }
      case "strong":
      case "em":
      case "b":
      case "i":
      case "span":
      case "ul":
      case "ol":
      case "td":
      case "tr":
        break; // formatting/list containers: text handled by leaf rules
      default:
        break;
    }
  }
  // trailing unclosed text
  if (textBuf.trim() || links.length) flushLine();
  return lines;
}

export async function parseDocx(buffer) {
  let html = "";
  try {
    const result = await mammoth.convertToHtml({ buffer, includeDefaultStyleMap: true });
    html = result.value || "";
  } catch {
    // Fall back to raw text when the HTML conversion fails for an odd file.
    const result = await mammoth.extractRawText({ buffer });
    return parseText(result.value || "", { source: "docx" });
  }
  const lines = htmlToModelLines(html);
  const rawText = normalizeWhitespace(lines.map((l) => l.text).join("\n"));
  return { rawText, lines, source: "docx" };
}

// ---------------------------------------------------------------------------
// TXT
// ---------------------------------------------------------------------------

function parseText(bufferText, opts = {}) {
  const raw = String(bufferText || "").replace(/\u0000/g, "").trim();
  const rawLines = normalizeWhitespace(raw).split("\n");
  const lines = rawLines.map((text, i) => ({
    text,
    parts: [{ text }],
    links: [],
    bullet: false,
    heading: false,
    page: 1,
    line: i,
  }));
  return { rawText: raw, lines, source: opts.source || "txt" };
}

/**
 * Dispatch on file extension. Parsing is fully local: no bytes are sent
 * anywhere. Returns { rawText, lines, source }.
 */
export async function parseResumeFile({ buffer, filename }) {
  const ext = path.extname(filename || "").toLowerCase();
  if (ext === ".pdf") return parsePdf(buffer);
  if (ext === ".docx") return parseDocx(buffer);
  if (ext === ".doc") {
    throw new Error(
      "Legacy .doc files are not supported locally. Please save as .docx or PDF."
    );
  }
  if (ext === ".txt") return parseText(buffer.toString("utf8"));
  throw new Error(`Unsupported file type "${ext || "unknown"}". Use PDF or DOCX.`);
}

export { parseText };