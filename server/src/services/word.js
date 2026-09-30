import fs from "node:fs/promises";
import JSZip from "jszip";
import WordExtractor from "word-extractor";

/**
 * Word (.docx / .doc) → the same { pageCount, pages: [{ page, text, links }] }
 * shape extractPages() returns for a PDF, so the rest of the pipeline never
 * needs to know which format a tender document came in.
 *
 * A Word file has no fixed pages — pagination is decided by whoever renders
 * it. But Word writes a <w:lastRenderedPageBreak/> marker wherever a page
 * ended the last time IT laid the document out, so for a file saved by Word
 * those markers give the same page numbers the reader sees on screen, which
 * is what a citation needs. Files written by other tools (and legacy .doc)
 * lack them; those are cut into roughly A4-sized chunks instead and flagged
 * `approxPages` so nobody is told "p.12" means printed page 12.
 */

const CHUNK_CHARS = 3500; // ≈ one dense A4 page of tender text

export async function extractWordPages(filePath) {
  if (/\.doc$/i.test(filePath)) return extractLegacyDoc(filePath);
  return extractDocx(filePath);
}

async function extractDocx(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
  const docXml = await zip.file("word/document.xml")?.async("string");
  if (!docXml) throw new Error("Not a valid .docx file (word/document.xml missing)");
  const relsXml = (await zip.file("word/_rels/document.xml.rels")?.async("string")) || "";

  // rId -> external URL, for <w:hyperlink r:id="…">
  const rels = {};
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], "Id");
    const target = attr(m[1], "Target");
    if (id && target && /TargetMode="External"/.test(m[1])) rels[id] = decode(target);
  }

  const pages = [];
  let pageText = "";
  let pageLinks = new Set();
  let renderedBreaks = 0;
  const newPage = () => {
    // Word can record an explicit page break AND a rendered break at the same
    // spot; don't turn that into an empty page.
    if (!pageText.trim()) return;
    pages.push({ text: pageText, links: [...pageLinks] });
    pageText = "";
    pageLinks = new Set();
  };

  // Table state: a stack so nested tables flatten into their outer cell.
  const tables = []; // [{ row: string[], cell: string|null }]
  const inCell = () => tables.length && tables[tables.length - 1].cell !== null;
  const write = (s) => {
    if (inCell()) tables[tables.length - 1].cell += s;
    else pageText += s;
  };
  let pendingBreak = false; // page break seen inside a table: apply after the row

  let inText = false;
  let inInstr = false;
  let skipDepth = 0; // inside <mc:Fallback> (duplicate of the text box above it)

  for (const m of docXml.matchAll(/<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g)) {
    const [, close, name, attrs, selfClose, text] = m;
    if (text !== undefined) {
      if (skipDepth) continue;
      if (inText) write(decode(text));
      else if (inInstr) {
        const link = decode(text).match(/HYPERLINK\s+"([^"]+)"/);
        if (link) pageLinks.add(link[1]);
      }
      continue;
    }
    if (name === "mc:Fallback") {
      if (selfClose) continue;
      skipDepth += close ? -1 : 1;
      continue;
    }
    if (skipDepth) continue;

    switch (name) {
      case "w:t":
        inText = !close && !selfClose;
        break;
      case "w:instrText":
        inInstr = !close && !selfClose;
        break;
      case "w:tab":
        if (!close) write(" ");
        break;
      case "w:br":
      case "w:cr":
        if (close) break;
        if (/w:type="page"/.test(attrs)) {
          if (tables.length) pendingBreak = true;
          else newPage();
        } else write(inCell() ? " " : "\n");
        break;
      case "w:lastRenderedPageBreak":
        renderedBreaks++;
        if (tables.length) pendingBreak = true;
        else newPage();
        break;
      case "w:hyperlink": {
        const id = !close && attr(attrs, "r:id");
        if (id && rels[id]) pageLinks.add(rels[id]);
        break;
      }
      case "w:p":
        if (close) write(inCell() ? " " : "\n");
        break;
      case "w:tbl":
        if (!close) tables.push({ row: [], cell: null });
        else {
          tables.pop();
          if (!tables.length && pendingBreak) { pendingBreak = false; newPage(); }
        }
        break;
      case "w:tr":
        if (!tables.length) break;
        if (!close) tables[tables.length - 1].row = [];
        else {
          const t = tables[tables.length - 1];
          const line = t.row.map((c) => c.replace(/\s+/g, " ").trim()).join(" | ");
          t.row = [];
          // A row of a nested table lands inside the outer cell, on one line.
          if (tables.length > 1) tables[tables.length - 2].cell += ` ${line} ;`;
          else {
            pageText += line + "\n";
            if (pendingBreak) { pendingBreak = false; newPage(); }
          }
        }
        break;
      case "w:tc":
        if (!tables.length) break;
        if (!close) tables[tables.length - 1].cell = "";
        else {
          const t = tables[tables.length - 1];
          t.row.push(t.cell || "");
          t.cell = null;
        }
        break;
    }
  }
  newPage();

  let out = pages.map((p) => ({ text: normalize(p.text), links: p.links }));
  // No rendered-break markers → the pages we have are only explicit breaks
  // (or one page for the whole file). Chunk them so no "page" is 40 pages long.
  const approxPages = renderedBreaks === 0;
  if (approxPages) out = out.flatMap(chunk);
  return finish(out, approxPages);
}

async function extractLegacyDoc(filePath) {
  const doc = await new WordExtractor().extract(filePath);
  const body = [doc.getBody(), doc.getFootnotes?.(), doc.getEndnotes?.()].filter(Boolean).join("\n\n");
  // .doc tables come through as tab-separated cells
  const text = body.replace(/\t/g, " | ");
  return finish(chunk({ text: normalize(text), links: [] }), true);
}

/** Split one over-long page on paragraph boundaries into ≈CHUNK_CHARS pieces. */
function chunk({ text, links }) {
  if (text.length <= CHUNK_CHARS * 1.3) return [{ text, links }];
  const parts = [];
  let cur = "";
  for (const para of text.split("\n")) {
    if (cur && cur.length + para.length > CHUNK_CHARS) {
      parts.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + para;
  }
  if (cur) parts.push(cur);
  // Links can't be placed more precisely than the page they came from.
  return parts.map((t, i) => ({ text: t, links: i === 0 ? links : [] }));
}

function finish(pages, approxPages) {
  const kept = pages.length ? pages : [{ text: "", links: [] }];
  return {
    pageCount: kept.length,
    approxPages,
    pages: kept.map((p, i) => ({ page: i + 1, text: p.text, links: p.links })),
  };
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function normalize(t) {
  return t
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
