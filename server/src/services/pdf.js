import fs from "node:fs/promises";
import path from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Extract text page by page from ONE PDF file. Also pulls hyperlink
 * annotations (e-procurement portal links, "refer https://..." references,
 * linked annexures) — pdfjs's getTextContent() only reads the text layer,
 * links live in a separate annotation layer.
 * Returns { pageCount, pages: [{ page, text, links }] } — `page` here is
 * local to this one file (1-indexed, as printed).
 */
export async function extractPages(filePath) {
  const data = new Uint8Array(await fs.readFile(filePath));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Rebuild lines: pdf.js gives items with hasEOL; join with spaces/newlines.
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str;
      text += item.hasEOL ? "\n" : " ";
    }
    const annots = await page.getAnnotations({ intent: "display" });
    const links = [...new Set(
      annots
        .filter((a) => a.subtype === "Link" && (a.url || a.unsafeUrl))
        .map((a) => (a.url || a.unsafeUrl).trim())
    )];
    pages.push({ page: i, text: normalize(text), links });
    page.cleanup();
  }
  await doc.destroy();
  return { pageCount: doc.numPages, pages };
}

function normalize(t) {
  return t
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Rough token estimate (≈4 chars/token for English/legal text). */
export const estimateTokens = (text) => Math.ceil(text.length / 4);

/**
 * Merge multiple files' page arrays into one flat, globally-ordered corpus.
 * The model only ever sees/reports a single running "globalPage" number
 * (so the extraction JSON schema needs no per-item filename field, which
 * would be one more thing the model could get wrong) — the marker also
 * shows a human-readable "(file p.N)" label so the model can still reason
 * about which document a clause came from (needed for the CONFLICT rule
 * across NIT/GCC/SCC). `pageIndex[globalPage] = { file, page }` lets the
 * server translate the model's answer back to a real, file-local citation.
 *
 * @param {{name: string, pages: Array}[]} files
 * @returns {{ taggedPages: Array, pageIndex: Record<number, {file:string,page:number}>, toGlobal: (file:string, page:number) => number|undefined, totalPages: number }}
 */
export function mergeFiles(files) {
  const taggedPages = [];
  const pageIndex = {};
  const reverse = {}; // `${file}\u0000${page}` -> globalPage — for translating a local citation back
  let g = 0;
  for (const f of files) {
    for (const p of f.pages) {
      g++;
      pageIndex[g] = { file: f.name, page: p.page };
      reverse[`${f.name}\u0000${p.page}`] = g;
      taggedPages.push({ ...p, file: f.name, globalPage: g });
    }
  }
  const toGlobal = (file, page) => reverse[`${file}\u0000${page}`];
  return { taggedPages, pageIndex, toGlobal, totalPages: g };
}

/**
 * Rebuild the same {taggedPages, pageIndex, toGlobal, totalPages} shape
 * mergeFiles() produces, but from pages already stored on a Tender document
 * (Tender.pages, each {file, page, text, links}) instead of re-parsing PDFs.
 * Used to resume a run without re-reading files or re-fetching linked PDFs —
 * array order is the global order (unchanged since it was first merged).
 */
export function rehydratePages(storedPages) {
  const taggedPages = [];
  const pageIndex = {};
  const reverse = {};
  storedPages.forEach((p, i) => {
    const g = i + 1;
    pageIndex[g] = { file: p.file, page: p.page };
    reverse[`${p.file}\u0000${p.page}`] = g;
    taggedPages.push({ ...p, globalPage: g });
  });
  const toGlobal = (file, page) => reverse[`${file}\u0000${page}`];
  return { taggedPages, pageIndex, toGlobal, totalPages: storedPages.length };
}

/**
 * Render pages into a single string with explicit page markers so the model
 * can cite page numbers. Scanned pages (no text) are flagged so the executive
 * knows OCR is needed.
 */
export function renderPages(pages) {
  return pages
    .map((p) => {
      const body = p.text.length > 0 ? p.text : "[NO EXTRACTABLE TEXT – possibly scanned image]";
      const linkBlock = p.links?.length ? `\n[LINKS ON THIS PAGE]\n${p.links.map((l) => `- ${l}`).join("\n")}` : "";
      const marker = p.file ? `<<< PAGE ${p.globalPage} (${p.file} p.${p.page}) >>>` : `<<< PAGE ${p.page} >>>`;
      return `${marker}\n${body}${linkBlock}`;
    })
    .join("\n\n");
}

/**
 * Split pages into windows that fit under maxTokens. Overlap a few pages so a
 * clause that straddles a boundary is seen whole in at least one window.
 * `from`/`to` on each window are whatever the pages' own `page` (or
 * `globalPage`, when tagged) value is — just used for progress logging.
 */
export function windowPages(pages, maxTokens, overlapPages = 3) {
  const windows = [];
  const at = (p) => p.globalPage ?? p.page;
  let start = 0;
  while (start < pages.length) {
    let tokens = 0;
    let end = start;
    while (end < pages.length) {
      const t = estimateTokens(pages[end].text) + 8;
      if (tokens + t > maxTokens && end > start) break;
      tokens += t;
      end++;
    }
    windows.push({ from: at(pages[start]), to: at(pages[end - 1]), pages: pages.slice(start, end) });
    if (end >= pages.length) break;
    // Overlap never more than a third of the window, so we always move forward meaningfully
    const overlap = Math.min(overlapPages, Math.floor((end - start) / 3));
    start = Math.max(end - overlap, start + 1);
  }
  return windows;
}

const PDF_MAGIC = "%PDF-";

/**
 * Download a URL and confirm it is actually a PDF (content-type AND magic
 * bytes — some e-procurement portals mislabel content-type) before saving.
 * Returns null (never throws) if the link isn't a fetchable PDF within the
 * caps — a bad/slow link should never abort the whole segregation run.
 */
export async function fetchLinkedPdf(url, destDir, { timeoutMs = 15000, maxBytes = 60 * 1024 * 1024 } = {}) {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) return { ok: false, reason: `HTTP ${res.status}` };

    const contentType = res.headers.get("content-type") || "";
    const looksLikePdfByType = contentType.toLowerCase().includes("pdf");
    const looksLikePdfByExt = /\.pdf(\?|#|$)/i.test(new URL(url).pathname + new URL(url).search);
    if (!looksLikePdfByType && !looksLikePdfByExt) {
      // Cheap pre-filter: don't bother downloading obvious non-PDF pages
      // (general webpages, images) unless the URL at least looks like one.
      if (!contentType.toLowerCase().includes("html") && !looksLikePdfByExt) {
        // ambiguous content-type (e.g. octet-stream) — fall through and sniff bytes
      } else {
        return { ok: false, reason: `not a PDF (content-type: ${contentType || "unknown"})` };
      }
    }

    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength && contentLength > maxBytes) return { ok: false, reason: `too large (${Math.round(contentLength / 1e6)}MB)` };

    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) return { ok: false, reason: `exceeded ${Math.round(maxBytes / 1e6)}MB cap` };
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    if (buf.subarray(0, 5).toString("latin1") !== PDF_MAGIC) return { ok: false, reason: "not a PDF (magic bytes mismatch)" };

    const name = safeName(new URL(url).pathname.split("/").pop() || "linked") + ".pdf";
    const filePath = path.join(destDir, `linked-${Date.now()}-${name}`);
    await fs.writeFile(filePath, buf);
    return { ok: true, filePath, name, bytes: buf.length };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function safeName(s) {
  return s.replace(/\.pdf$/i, "").replace(/[^\w.-]/g, "_").slice(0, 80) || "linked";
}
