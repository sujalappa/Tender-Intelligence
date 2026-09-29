import fs from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { config } from "../config.js";

/**
 * OCR for scanned pages only. pdfjs reads a PDF's text layer; a scanned page
 * has none, so it reaches the model as "[NO EXTRACTABLE TEXT]" and whatever
 * it says (often the whole technical spec) is simply missing from the
 * analysis. Pages that DO have text never come here — that text is exact,
 * free, and better than any OCR.
 *
 * Uses OpenRouter's file-parser plugin with the mistral-ocr engine
 * ($2 / 1000 pages at time of writing). Each scanned page is cut out into its
 * own one-page PDF and sent alone: billing is per page sent, so the text
 * pages of a mixed file are never paid for, and one page per request means
 * the returned text can't be attributed to the wrong page.
 */

/** A page with less text than this is treated as scanned. */
export const SCANNED_MAX_CHARS = 30;
export const isScanned = (p) => (p.text || "").trim().length < SCANNED_MAX_CHARS;

const CONCURRENCY = 4;

/**
 * Fill in `text` for the scanned pages of one parsed file, in place.
 * @param {string} filePath
 * @param {{page:number,text:string,ocr?:boolean}[]} pages
 * @param {{ budget: {left:number}, onLog?: (msg:string)=>void }} opts
 *   `budget.left` is shared across files so one tender can't exceed the cap.
 * @returns {Promise<{attempted:number, recovered:number, failed:number, skipped:number}>}
 */
export async function ocrScannedPages(filePath, pages, { budget, onLog = () => {} }) {
  const todo = pages.filter(isScanned);
  const stats = { attempted: 0, recovered: 0, failed: 0, skipped: 0 };
  if (!todo.length) return stats;

  const allowed = todo.slice(0, Math.max(0, budget.left));
  stats.skipped = todo.length - allowed.length;
  budget.left -= allowed.length;
  if (!allowed.length) return stats;

  let src;
  try {
    src = await PDFDocument.load(await fs.readFile(filePath), { ignoreEncryption: true });
  } catch (e) {
    onLog(`could not open for OCR: ${e.message}`);
    stats.failed = allowed.length;
    return stats;
  }

  let next = 0;
  const worker = async () => {
    while (next < allowed.length) {
      const p = allowed[next++];
      stats.attempted++;
      try {
        const one = await PDFDocument.create();
        const [copied] = await one.copyPages(src, [p.page - 1]);
        one.addPage(copied);
        const text = await ocrOnePagePdf(Buffer.from(await one.save()), `page-${p.page}.pdf`);
        if (text.trim().length >= SCANNED_MAX_CHARS) {
          p.text = text.trim();
          p.ocr = true;
          stats.recovered++;
        } else {
          stats.failed++; // genuinely blank page, or OCR found nothing
        }
      } catch (e) {
        stats.failed++;
        onLog(`OCR failed on p.${p.page}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, allowed.length) }, worker));
  return stats;
}

/**
 * Send a one-page PDF through OpenRouter's mistral-ocr parser and return the
 * page's text. The parser's own output (message.annotations) is preferred —
 * it is Mistral's text verbatim. The model is also asked to copy the page out
 * word for word, which is only used if no annotation comes back.
 */
async function ocrOnePagePdf(buf, filename) {
  if (!config.openrouter.apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.openrouter.siteUrl,
      "X-Title": config.openrouter.appName,
    },
    body: JSON.stringify({
      model: config.ocr.model,
      temperature: 0,
      max_tokens: 6000,
      plugins: [{ id: "file-parser", pdf: { engine: "mistral-ocr" } }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Copy out the full text of the attached page exactly as written — every word, number, table cell and stamp, in reading order. Render tables as plain rows with cells separated by \" | \". No commentary, no summary, nothing added.",
            },
            { type: "file", file: { filename, file_data: `data:application/pdf;base64,${buf.toString("base64")}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(3 * 60 * 1000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${j?.error?.message || "no detail"}`);

  const msg = j.choices?.[0]?.message || {};
  const fromParser = (msg.annotations || [])
    .filter((a) => a?.type === "file")
    .flatMap((a) => a.file?.content || [])
    .filter((c) => c?.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
  return fromParser.trim() ? fromParser : typeof msg.content === "string" ? msg.content : "";
}
