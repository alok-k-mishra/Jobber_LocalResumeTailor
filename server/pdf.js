// Minimal dependency-free PDF writer used to download the cover letter as a
// .pdf file. It renders the letter as wrapped Helvetica text on one or more
// A4 pages. No layout engine, no external fonts — deliberately small and
// deterministic so the generated file is verifiable byte-for-byte.

const PAGE_WIDTH = 595; // A4, in points
const PAGE_HEIGHT = 842;
const MARGIN = 72; // 1 inch
const FONT_SIZE = 11;
const LINE_HEIGHT = 16;
const PARAGRAPH_GAP = 6;
const MAX_LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LINE_HEIGHT);

// Helvetica's average glyph width is close to half its point size, which is a
// good enough measure for word-wrapping plain text.
const CHAR_WIDTH = FONT_SIZE * 0.5;
const MAX_CHARS_PER_LINE = Math.max(20, Math.floor((PAGE_WIDTH - 2 * MARGIN) / CHAR_WIDTH));

function pdfEscape(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// Transcode JS text into the PDF Text-encoding byte range (WinAnsi subset).
// Anything that cannot be represented becomes "?" rather than corrupting the
// file offsets.
function toLatin1Bytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 8211) {
      out.push(150); // – en dash
    } else if (code === 8212) {
      out.push(151); // — em dash
    } else if (code === 8216 || code === 8217) {
      out.push(39); // curly single quotes -> '
    } else if (code === 8220 || code === 8221) {
      out.push(34); // curly double quotes -> "
    } else if (code === 8226) {
      out.push(149); // • bullet
    } else if (code === 8230) {
      out.push(46, 46, 46); // … ellipsis -> ...
    } else if (code <= 255) {
      out.push(code); // ASCII + WinAnsi range (includes \n, \r)
    } else {
      out.push(63); // ?
    }
  }
  return Uint8Array.from(out);
}

function forContentLines(text) {
  const textLines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const lines = [];
  for (const raw of textLines) {
    const para = raw.replace(/\t/g, "  ").trim();
    if (!para) {
      lines.push(null); // paragraph break
      continue;
    }
    const words = para.split(/\s+/).filter(Boolean);
    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length <= MAX_CHARS_PER_LINE) {
        current = next;
      } else {
        if (current) lines.push(current);
        // A word wider than a full line still lands on its own (possibly
        // truncated-to-page) line rather than dropping the letters.
        current = word;
        while (current.length > MAX_CHARS_PER_LINE) {
          lines.push(current.slice(0, MAX_CHARS_PER_LINE));
          current = current.slice(MAX_CHARS_PER_LINE);
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function paginate(lines) {
  const pages = [];
  let page = [];
  for (const ln of lines) {
    if (ln === null) {
      if (page.length && page[page.length - 1] !== null) page.push(null);
      continue;
    }
    if (page.length >= MAX_LINES_PER_PAGE) {
      pages.push(page);
      page = [];
    }
    page.push(ln);
  }
  while (page.length && page[page.length - 1] === null) page.pop();
  if (page.length) pages.push(page);
  if (pages.length === 0) pages.push([]);
  return pages;
}

function pageContentStream(lines) {
  let out = `BT\n/F1 ${FONT_SIZE} Tf\n`;
  let y = PAGE_HEIGHT - MARGIN;
  for (const ln of lines) {
    if (ln === null) {
      y -= PARAGRAPH_GAP;
      continue;
    }
    out += `1 0 0 1 ${MARGIN} ${y} Tm\n`;
    out += `(${pdfEscape(ln)}) Tj\n`;
    y -= LINE_HEIGHT;
  }
  return out + "ET";
}

/**
 * Render plain text as a single-font (Helvetica) A4 PDF.
 * Returns a Uint8Array of the complete PDF file.
 */
export function coverLetterPdf(text, { title = "" } = {}) {
  const body = [title ? `${title}` : "", text || ""].filter(Boolean).join("\n");
  const lines = paginate(forContentLines(body));
  const pageCount = lines.length;

  // Object numbering: 1 catalog, 2 pages; each page gets a page object and a
  // content-stream object; one font object at the end.
  let nextId = 3;
  const pageObjects = [];
  for (let i = 0; i < pageCount; i++) {
    const pageId = nextId++;
    const streamId = nextId++;
    pageObjects.push({ pageId, streamId });
  }
  const fontId = nextId++;
  const allIds = [1, 2, ...pageObjects.flatMap((p) => [p.pageId, p.streamId]), fontId];
  const size = Math.max(...allIds) + 1;

  const bodies = new Array(size);
  const kids = pageObjects.map((p) => `${p.pageId} 0 R`).join(" ");
  bodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  bodies[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  for (const p of pageObjects) {
    bodies[p.pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${p.streamId} 0 R >>`;
  }
  for (let i = 0; i < pageCount; i++) {
    const content = pageContentStream(lines[i]);
    const bytes = toLatin1Bytes(content);
    bodies[pageObjects[i].streamId] =
      `<< /Length ${bytes.length} >>\nstream\n${content}\nendstream`;
  }
  bodies[fontId] =
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;

  let file = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = new Array(size).fill(0);
  for (let i = 1; i < size; i++) {
    offsets[i] = toLatin1Bytes(file).length;
    file += `${i} 0 obj\n${bodies[i]}\nendobj\n`;
  }
  const xrefStart = toLatin1Bytes(file).length;
  file += `xref\n0 ${size}\n`;
  file += `0000000000 65535 f \n`;
  for (let i = 1; i < size; i++) {
    file += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  file += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return toLatin1Bytes(file);
}