import { extractPages, fetchLinkedPdf } from "./pdf.js";

/**
 * Given already-extracted uploaded files (each with pages[].links), find
 * links that resolve to real PDFs, fetch and parse them, and return them as
 * ready-to-merge "file" entries. One level deep only — links found inside a
 * linked PDF are NOT auto-followed, so cost/time stay bounded regardless of
 * how deep a chain of cross-references goes.
 *
 * Never throws: a bad/slow/huge link is skipped and logged, not fatal to the
 * run. Caps (maxLinked, maxAttempts, per-file size/time) keep an unlucky
 * tender from silently blowing up the token bill.
 */
export async function fetchLinkedFiles(uploadedFiles, destDir, { maxLinked = 8, maxAttempts = 15, onLog } = {}) {
  const seen = new Set();
  const candidates = [];
  for (const f of uploadedFiles) {
    for (const p of f.pages) {
      for (const url of p.links || []) {
        if (seen.has(url)) continue;
        seen.add(url);
        candidates.push({ url, fromFile: f.name, fromPage: p.page });
      }
    }
  }

  const linked = [];
  let attempts = 0;
  for (const c of candidates) {
    if (linked.length >= maxLinked || attempts >= maxAttempts) break;
    attempts++;
    const res = await fetchLinkedPdf(c.url, destDir);
    if (!res.ok) {
      onLog?.(`skip linked doc (${c.url}): ${res.reason}`);
      continue;
    }
    try {
      const { pageCount, pages } = await extractPages(res.filePath);
      linked.push({
        name: res.name,
        filePath: res.filePath,
        kind: "linked",
        sourceUrl: c.url,
        fetchedFrom: { file: c.fromFile, page: c.fromPage },
        pageCount,
        pages,
      });
      onLog?.(`fetched linked doc: ${res.name} (${pageCount} pages) — found on ${c.fromFile} p.${c.fromPage}`);
    } catch (err) {
      onLog?.(`skip linked doc (${c.url}): downloaded but failed to parse — ${err.message}`);
    }
  }
  return { linked, candidateCount: candidates.length };
}
