import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, API_BASE } from "../api.js";
import { StatusPill } from "./TenderList.jsx";
import ModelPicker from "./ModelPicker.jsx";
import ChatPanel from "./ChatPanel.jsx";
import ExecutiveSummary from "./ExecutiveSummary.jsx";
import NotesPanel, { NoteForm } from "./NotesPanel.jsx";
import { useAuth } from "../auth.jsx";

const IMPORTANCE_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const EXEC_TAB = "__exec__";
const NOTES_TAB = "__notes__";

const OVERVIEW_FIELDS = [
  ["referenceNumber", "Reference / NIT No."],
  ["issuingAuthority", "Issuing authority"],
  ["location", "Location"],
  ["estimatedValue", "Estimated value"],
  ["tenderFee", "Tender fee"],
  ["emdAmount", "EMD"],
  ["emdExemptions", "EMD exemptions"],
  ["contractPeriod", "Contract period"],
  ["preBidMeeting", "Pre-bid meeting"],
  ["clarificationDeadline", "Clarification deadline"],
  ["bidSubmissionStart", "Bid submission start"],
  ["bidSubmissionEnd", "Bid submission end"],
  ["bidOpeningDate", "Bid opening"],
];

export default function TenderDetail() {
  const { id } = useParams();
  const { user, isAdmin } = useAuth();
  const [tender, setTender] = useState(null);
  const [categories, setCategories] = useState([]);
  const [clauses, setClauses] = useState([]);
  const [active, setActive] = useState("");
  const [q, setQ] = useState("");
  const [importance, setImportance] = useState("");
  const [pageView, setPageView] = useState(null);
  // Citations open the real PDF page by default; "text" falls back to the
  // extracted layer (useful when a page is scanned or the PDF is gone).
  const [pdfView, setPdfView] = useState(true);
  const [rerun, setRerun] = useState(null);
  const [rerunError, setRerunError] = useState("");
  const [overviewBusy, setOverviewBusy] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [actionError, setActionError] = useState("");
  // Bumped whenever a note is created elsewhere on the page (a clause card or
  // the chat widget), so the Notes tab reloads without a full page refresh.
  const [notesKey, setNotesKey] = useState(0);
  const [teamUsers, setTeamUsers] = useState([]);
  useEffect(() => { if (isAdmin) api.users().then(setTeamUsers).catch(() => {}); }, [isAdmin]);

  // File availability is a cheap fs.access() per file server-side, so it's
  // fine to check on every visit rather than only when something looks
  // broken — an ephemeral host (no persistent disk attached) can lose a
  // file on any redeploy with nothing in the UI otherwise telling you.
  const [fileStatus, setFileStatus] = useState(null);
  const loadFileStatus = () => api.fileStatus(id).then(setFileStatus).catch(() => {});
  useEffect(() => { loadFileStatus(); }, [id]);

  const refreshOverview = async () => {
    setOverviewBusy(true);
    setOverviewError("");
    try {
      const { overview } = await api.refreshOverview(id);
      setTender((t) => ({ ...t, overview }));
    } catch (e) {
      setOverviewError(e.message);
    } finally {
      setOverviewBusy(false);
    }
  };

  useEffect(() => { api.categories().then((c) => { setCategories(c); setActive((a) => a || c[0].key); }); }, []);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const t = await api.get(id).catch(() => null);
      if (!alive || !t) return;
      setTender(t);
      // Clauses are saved per category as each one finishes — fetch every
      // poll so finished categories appear while the rest are still running.
      setClauses(await api.clauses(id).catch(() => []));
    };
    tick();
    const timer = setInterval(() => {
      setTender((t) => { if (!t || ["parsing", "segregating", "uploaded"].includes(t.status)) tick(); return t; });
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [id]);

  const visible = useMemo(() => {
    const rx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;
    return clauses
      .filter((c) => c.category === active)
      .filter((c) => !importance || c.importance === importance)
      .filter((c) => !rx || rx.test(`${c.clauseRef} ${c.title} ${c.verbatim} ${c.requirementDescription} ${c.criterion} ${c.sourceFile}`))
      .sort((a, b) => IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance] || a.page - b.page);
  }, [clauses, active, q, importance]);

  const openPage = async (page, file) => {
    setPageView(await api.page(id, page, file));
    // Re-check availability on open, not just on mount: an ephemeral host can
    // drop a file at any time (a redeploy mid-session), and a stale "present"
    // status is what makes the viewer try to embed a PDF that isn't there and
    // render the server's JSON error as if it were a document.
    loadFileStatus();
  };

  const setClauseImportance = async (clause, importance) => {
    const prev = clauses;
    setClauses((cs) => cs.map((c) => (c._id === clause._id ? { ...c, importance } : c))); // optimistic
    try {
      await api.updateClause(id, clause._id, { importance });
    } catch (e) {
      setClauses(prev); // put it back if the server refused
      setActionError(e.message);
    }
  };

  const removeClause = async (clause) => {
    if (!window.confirm(`Remove "${clause.title}" from ${clause.category}?`)) return;
    const prev = clauses;
    setClauses((cs) => cs.filter((c) => c._id !== clause._id));
    try {
      await api.removeClause(id, clause._id);
    } catch (e) {
      setClauses(prev);
      setActionError(e.message);
    }
  };
  // Full citation string for manual verification against the source PDF.
  const cite = (page, pageEnd, file) => `${file || tender?.files?.[0]?.name} — page ${page}${pageEnd && pageEnd !== page ? `–${pageEnd}` : ""}`;
  // Overview citations are stored as "file.pdf#12" strings.
  const parseCitation = (s) => {
    if (!s) return null;
    const i = s.lastIndexOf("#");
    return i < 0 ? { file: tender?.files?.[0]?.name, page: Number(s) } : { file: s.slice(0, i), page: Number(s.slice(i + 1)) };
  };
  // Only show the filename inline once the tender actually bundles more than one.
  const multiFile = (tender?.files?.length || 0) > 1;
  const pageLabel = (page, pageEnd, file) => `${multiFile && file ? `${file} ` : ""}p${page}${pageEnd && pageEnd !== page ? `–${pageEnd}` : ""}`;

  // No PDF library — the browser's own print-to-PDF is more reliable for a
  // long, text-heavy report (selectable text, correct pagination) than
  // rasterizing the DOM. A dedicated print-only block below renders the
  // FULL report (every category, unfiltered by the on-screen search/
  // importance filters) so what gets saved is the complete analysis, not
  // just whatever tab happens to be open.
  const downloadPdf = () => window.print();
  // A second, separate print target for just the executive brief — toggled
  // via a body class rather than React state so it's synchronous with
  // window.print() (no re-render race), with afterprint cleaning it back up.
  const downloadSummaryPdf = () => { document.body.classList.add("print-summary-mode"); window.print(); };

  // A third print target: the signed-in person's OWN notes on this tender.
  // Notes aren't already loaded into this component's state (only NotesPanel
  // fetches them, and only while that tab is open), so this fetches fresh
  // rather than reusing stale/absent data — then the effect below waits for
  // that state to actually land before printing, since window.print() would
  // otherwise fire before React has painted the fetched notes into the DOM.
  const [printNotes, setPrintNotes] = useState(null);
  const downloadNotesPdf = () => { api.notes(id).then(setPrintNotes).catch(() => setPrintNotes([])); };
  useEffect(() => {
    if (printNotes === null) return;
    document.body.classList.add("print-notes-mode");
    window.print();
  }, [printNotes]);

  useEffect(() => {
    const cleanup = () => {
      document.body.classList.remove("print-summary-mode");
      document.body.classList.remove("print-notes-mode");
      setPrintNotes(null); // next click re-fetches, so a note added meanwhile isn't missed
    };
    window.addEventListener("afterprint", cleanup);
    return () => window.removeEventListener("afterprint", cleanup);
  }, []);

  if (!tender) return <div className="page"><p className="muted">Loading…</p></div>;
  const running = ["parsing", "segregating", "uploaded"].includes(tender.status);
  // A "running" tender that hasn't updated in a while COULD be abandoned
  // (server restarted mid-run) or could just be a genuinely slow call — a
  // single LLM call on a big document can legitimately take 15+ minutes, so
  // elapsed time alone can't tell them apart. The button stays clickable
  // either way; the server is the actual authority (isJobActive) and will
  // reject with 409 if a job for this tender is genuinely still running.
  const staleMs = tender.updatedAt ? Date.now() - new Date(tender.updatedAt).getTime() : 0;
  const stale = running && staleMs > 6 * 60 * 1000;
  // Resume is safe and strictly better whenever there's any prior run
  // history: it skips only the categories that already succeeded and
  // redoes everything else, and it reuses already-parsed pages (more
  // reliable than re-fetching linked PDFs fresh, which is network-
  // dependent and can silently return a different set of files each time).
  // A "done" status doesn't mean every category actually succeeded (a
  // category can fail — e.g. a credit/rate-limit error — without the whole
  // run throwing), so basing the default on current status alone was wrong;
  // base it on whether there's data worth trying to preserve instead.
  const hasHistory = (tender.runs?.length || 0) > 0;
  // A category counts as done if it has an error-free extract run — mirrors
  // the server's resume check (verify pass isn't required here since the
  // UI lets you switch verify off).
  const doneCategories = new Set((tender.runs || []).filter((r) => r.pass === "extract" && !r.error).map((r) => r.category));
  // Show the results area as soon as anything has been saved — finished
  // categories are viewable while the rest are still running.
  const hasData = clauses.length > 0 || tender.status === "done";
  // What the executive brief is built from — lets the UI say "regenerate"
  // when the underlying clause set has changed since it was written.
  const criticalCount = clauses.filter((c) => c.importance === "critical" || c.clauseStatus === "CONFLICT").length;
  const ov = tender.overview;
  const ovCite = (field) => ov?.citations?.[field];
  const overviewMissing = ov ? OVERVIEW_FIELDS.filter(([k]) => !ov[k]).length : 0;

  return (
    <div className="page">
      <div className="breadcrumb no-print"><Link to="/">← Tenders</Link></div>
      <section className="card head no-print">
        <div>
          <h2>{tender.title}</h2>
          <ul className="file-list">
            {(tender.files || []).map((f, i) => {
              const st = fileStatus?.[i];
              const missing = st && !st.available;
              return (
                <li key={i} className="mono small">
                  📄 {f.name} {f.pageCount ? `(${f.pageCount}p)` : ""}
                  {f.kind === "linked" && (
                    <span className="badge linked" title={`Automatically retrieved from a link found on ${f.fetchedFrom?.file} p.${f.fetchedFrom?.page}\n${f.sourceUrl}`}>linked</span>
                  )}
                  {missing && (
                    <span className="badge missing-file" title="The original document is currently unavailable. Extracted details remain accurate — only viewing or updating the source file is affected.">
                      ⚠ Unavailable
                    </span>
                  )}
                  {missing && isAdmin && <RestoreFileControl tenderId={id} index={i} kind={f.kind} onRestored={loadFileStatus} />}
                </li>
              );
            })}
          </ul>
          <p className="muted small">
            {tender.pageCount} pages total · ≈{tender.estTokens?.toLocaleString()} tokens · <span className="mono">{tender.provider}/{tender.model}</span>
            {tender.usage && <> · {tender.usage.calls} calls · {tender.usage.inputTokens.toLocaleString()} in / {tender.usage.outputTokens.toLocaleString()} out{tender.usage.errors ? <span className="error"> · {tender.usage.errors} failed calls</span> : null}</>}
          </p>
          <StatusPill status={tender.status} progress={tender.progress} />
          {stale && <p className="error small">⚠ No progress for over 6 minutes. This may be a genuinely slow call, or an abandoned run — try "Resume" below; if a job is truly still active the server will refuse and tell you.</p>}
          {tender.error && <p className="error">{tender.error}</p>}
          {rerunError && <p className="error small">⚠ {rerunError}</p>}
          {actionError && <p className="error small">⚠ {actionError}</p>}
          {tender.events?.length > 0 && (
            <details className="small muted" open={running}>
              <summary>Attempt log ({tender.events.length}) — every LLM call started, retried, aborted or lost</summary>
              <ul className="mono">{tender.events.slice(-30).map((l, i) => <li key={i}>{l.replace("T", " ").replace(/\.\d+Z/, "")}</li>)}</ul>
            </details>
          )}
          {tender.linkLog?.length > 0 && (
            <details className="small muted">
              <summary>Link-following log ({tender.linkLog.length})</summary>
              <ul>{tender.linkLog.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </details>
          )}
        </div>
        <div className="actions">
          {isAdmin && <button onClick={downloadSummaryPdf} disabled={!tender.execSummary} title={tender.execSummary ? "The one-page brief, for handing up the chain" : "Generate it first from the Executive Summary tab"}>Executive Summary PDF</button>}
          <button onClick={downloadPdf} disabled={!hasData} title={running ? "Exports what has finished so far" : ""}>Download Full PDF</button>
          <button onClick={downloadNotesPdf} title="Only your own notes — private to you, like the Notes tab">Download My Notes PDF</button>
          {isAdmin && (
            <button
              title={running ? "If a job is genuinely still active, the server will refuse this and say so" : ""}
              onClick={() => { setRerunError(""); setRerun(rerun ? null : { provider: tender.provider, model: tender.model, verify: true, resume: hasHistory }); }}
            >
              {hasHistory ? "Resume / restart…" : "Re-run…"}
            </button>
          )}
        </div>
      </section>

      {rerun && (
        <section className="card no-print">
          <ModelPicker value={rerun} onChange={setRerun} />
          {hasHistory && (
            <>
              <p className="small muted">
                <label className="inline">
                  <input type="checkbox" checked={rerun.resume} onChange={(e) => setRerun({ ...rerun, resume: e.target.checked })} />
                  Continue where this left off — only re-analyse the sections checked below (uncheck to start over completely, e.g. after switching model)
                </label>
              </p>
              {rerun.resume && (
                <div className="cat-picker small">
                  <span className="muted">Sections to analyse (checking a completed section will redo it):</span>
                  {categories.map((c) => {
                    const done = doneCategories.has(c.key);
                    const checked = rerun.categories ? rerun.categories.includes(c.key) : !done;
                    return (
                      <label key={c.key} className="inline">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const cur = new Set(rerun.categories ?? categories.filter((x) => !doneCategories.has(x.key)).map((x) => x.key));
                            e.target.checked ? cur.add(c.key) : cur.delete(c.key);
                            setRerun({ ...rerun, categories: [...cur] });
                          }}
                        />
                        {c.label} {done ? <span className="muted">(complete, {tender.summary?.[c.key]?.total ?? "?"} items)</span> : <span className="error">(not started)</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </>
          )}
          <button
            onClick={() => {
              const body = { ...rerun };
              // Only send an explicit category list on resume — on a full reset a
              // partial list would wipe everything and rebuild only part of it.
              if (!body.resume) delete body.categories;
              else if (!body.categories) body.categories = categories.filter((x) => !doneCategories.has(x.key)).map((x) => x.key);
              api
                .resegregate(id, body)
                .then(() => { setRerun(null); setRerunError(""); setTender({ ...tender, status: "parsing" }); })
                .catch((err) => setRerunError(err.message));
            }}
          >
            Start
          </button>
        </section>
      )}

      {ov && (
        <section className="card overview no-print">
          <h3>{ov.tenderTitle || tender.title}</h3>
          {ov.scopeSummary && <p>{ov.scopeSummary}</p>}
          <OverviewGrid ov={ov} ovCite={ovCite} parseCitation={parseCitation} cite={cite} openPage={openPage} />
          {ov.notes && <p className="small muted">⚠ {ov.notes}</p>}
          {hasData && !running && isAdmin && (
            <p className="small muted overview-refresh">
              {overviewMissing > 0 && <span>{overviewMissing} of {OVERVIEW_FIELDS.length} key details are missing. </span>}
              <button className="link small" disabled={overviewBusy} onClick={refreshOverview}>
                {overviewBusy ? "Updating…" : "Refresh overview"}
              </button>
              <span> — re-checks these details using what's already been analysed, without affecting anything else.</span>
              {overviewError && <span className="error"> ⚠ {overviewError}</span>}
            </p>
          )}
        </section>
      )}

      {hasData && (
        <ChatPanel
          tenderId={id}
          provider={tender.provider}
          model={tender.model}
          hasExecSummary={Boolean(tender.execSummary)}
          onOpenPage={openPage}
          onNoted={({ execSummary }) => {
            setNotesKey((k) => k + 1);
            if (execSummary) setTender((t) => ({ ...t, execSummary }));
          }}
        />
      )}

      {hasData && (
        <>
          <nav className="tabs no-print">
            <button className={active === EXEC_TAB ? "tab active exec-tab" : "tab exec-tab"} onClick={() => setActive(EXEC_TAB)}>
              📋 Executive Summary
              {tender.execSummary ? <span className="count">ready</span> : <span className="count pending">not generated</span>}
            </button>
            <button className={active === NOTES_TAB ? "tab active exec-tab" : "tab exec-tab"} onClick={() => setActive(NOTES_TAB)}>
              🗒️ My Notes
            </button>
            {categories.map((c) => {
              const s = tender.summary?.[c.key];
              const done = doneCategories.has(c.key);
              const inProgress = running && !done && (tender.progress || "").startsWith(c.key + ":");
              return (
                <button key={c.key} className={active === c.key ? "tab active" : "tab"} onClick={() => setActive(c.key)}>
                  {c.label}{" "}
                  {done || !running ? <span className="count">{s?.total ?? 0}</span> : inProgress ? <span className="count live" title={tender.progress}>running…</span> : <span className="count pending">queued</span>}
                  {s?.critical ? <span className="count crit" title="critical">{s.critical}</span> : null}
                  {s?.conflicts ? <span className="count conflict" title="conflicting clauses">{s.conflicts}⚡</span> : null}
                </button>
              );
            })}
          </nav>

          {active === EXEC_TAB && (
            <section className="card no-print">
              <ExecutiveSummary
                tenderId={id}
                summary={tender.execSummary}
                clauseCount={criticalCount}
                pageLabel={pageLabel}
                cite={cite}
                openPage={openPage}
                onGenerated={(execSummary) => setTender((t) => ({ ...t, execSummary }))}
                onUpdated={(execSummary) => setTender((t) => ({ ...t, execSummary }))}
                canEdit={isAdmin}
              />
            </section>
          )}

          {active === NOTES_TAB && (
            <section className="card no-print">
              <h3>
                My Notes <span className="muted small">— visible only to you</span>
              </h3>
              <NotesPanel
                tenderId={id}
                users={teamUsers}
                cite={cite}
                pageLabel={pageLabel}
                openPage={openPage}
                refreshKey={notesKey}
              />
            </section>
          )}

          {active !== EXEC_TAB && active !== NOTES_TAB && (<>
          <div className="filters no-print">
            <input placeholder="Search in this category…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={importance} onChange={(e) => setImportance(e.target.value)}>
              <option value="">All importance</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <span className="muted small">{visible.length} clauses</span>
          </div>

          <div className="clauses no-print">
            {visible.map((c) => (
              <ClauseCard
                key={c._id}
                c={c}
                tenderId={id}
                cite={cite}
                pageLabel={pageLabel}
                onOpenPage={openPage}
                onImportance={setClauseImportance}
                onRemove={removeClause}
                onNoted={() => setNotesKey((k) => k + 1)}
                canEdit={isAdmin}
              />
            ))}
            {visible.length === 0 && (
              <p className="muted">
                {running && !doneCategories.has(active)
                  ? `${categories.find((c) => c.key === active)?.label || active} hasn't finished extracting yet — it will appear here as soon as it does.`
                  : "Nothing here."}
              </p>
            )}
          </div>
          </>)}
        </>
      )}

      {/* Print/PDF-only: the executive brief alone — shown only when
          "Executive Summary PDF" set body.print-summary-mode (see CSS). */}
      {tender.execSummary && (
        <div className="print-only print-summary">
          <h1>{ov?.tenderTitle || tender.title} — Executive Summary</h1>
          <p className="mono small">{(tender.files || []).map((f) => f.name).join(", ")} · {tender.execSummary.sourceClauseCount} critical clauses</p>
          <ExecutiveSummary tenderId={id} summary={tender.execSummary} clauseCount={criticalCount} pageLabel={pageLabel} cite={cite} printMode />
        </div>
      )}

      {/* Print/PDF-only: the signed-in person's own notes — shown only when
          "Download My Notes PDF" set body.print-notes-mode (see CSS). Never
          another person's notes, even for a super admin, matching the same
          privacy the Notes tab enforces on screen. */}
      {printNotes && (
        <div className="print-only print-notes">
          <h1>{ov?.tenderTitle || tender.title} — {user?.name}'s Notes</h1>
          <p className="mono small">{(tender.files || []).map((f) => f.name).join(", ")} · {printNotes.length} note{printNotes.length === 1 ? "" : "s"}</p>
          {printNotes.length === 0 && <p className="muted small">No notes yet.</p>}
          {printNotes.map((n) => (
            <section key={n._id} className="print-note">
              <h3>
                {n.title}
                <span className="small muted"> — {n.importance}{n.category ? `, ${categories.find((c) => c.key === n.category)?.label || n.category}` : ""}</span>
              </h3>
              <p>{n.text}</p>
              {n.sourceFile && n.page ? <p className="small muted mono">{pageLabel(n.page, null, n.sourceFile)}</p> : null}
            </section>
          ))}
        </div>
      )}

      {/* Print/PDF-only: the complete, unfiltered report — every category,
          every clause, not just the active tab — so "Download Full PDF"
          produces a full record regardless of what's on screen. */}
      {hasData && (
        <div className="print-only print-full">
          <h1>{ov?.tenderTitle || tender.title}</h1>
          <p className="mono small">{(tender.files || []).map((f) => f.name).join(", ")}</p>
          {ov && (
            <>
              {ov.scopeSummary && <p>{ov.scopeSummary}</p>}
              <OverviewGrid ov={ov} ovCite={ovCite} parseCitation={parseCitation} cite={cite} printMode />
              {ov.notes && <p className="small muted">⚠ {ov.notes}</p>}
            </>
          )}
          {categories.map((cat) => (
            <section key={cat.key} className="print-category">
              <h2>{cat.label} ({clauses.filter((c) => c.category === cat.key).length})</h2>
              {clauses
                .filter((c) => c.category === cat.key)
                .sort((a, b) => IMPORTANCE_ORDER[a.importance] - IMPORTANCE_ORDER[b.importance] || a.page - b.page)
                .map((c) => <ClauseCard key={c._id} c={c} cite={cite} pageLabel={pageLabel} printMode />)}
              {clauses.filter((c) => c.category === cat.key).length === 0 && <p className="muted small">Nothing found in this category.</p>}
            </section>
          ))}
        </div>
      )}

      {pageView && (
        <div className="modal no-print" onClick={() => setPageView(null)}>
          <div className="modal-body pdf-modal" onClick={(e) => e.stopPropagation()}>
            <header>
              <strong>📄 {pageView.file} — Page {pageView.page}</strong>
              <span className="modal-tools">
                <button className={pdfView ? "link" : "link active"} onClick={() => setPdfView(false)}>Text</button>
                <button className={pdfView ? "link active" : "link"} onClick={() => setPdfView(true)} disabled={pageView.fileIndex < 0}>Original PDF</button>
                {pageView.fileIndex >= 0 && (
                  <a className="link" href={`${API_BASE}/api/tenders/${id}/file/${pageView.fileIndex}#page=${pageView.page}`} target="_blank" rel="noreferrer">Open in new tab</a>
                )}
                <button className="link" onClick={() => setPageView(null)}>Close</button>
              </span>
            </header>
            {pdfView && pageView.fileIndex >= 0 && fileStatus?.[pageView.fileIndex]?.available === false ? (
              // Without this branch the iframe embeds the endpoint's JSON
              // error body and renders it as the "document" — the viewer
              // showed a raw {"error":"The source PDF is no longer on disk"}
              // where the page should be, with no hint of what to do next.
              <div className="pdf-unavailable">
                <p><strong>This document isn't available to view right now.</strong></p>
                <p className="muted small">
                  The extracted text and every clause from it are unaffected — you can still read this page's text using
                  the <strong>Text</strong> tab above. Only the original PDF is missing, so it can't be displayed.
                </p>
                {isAdmin ? (
                  <p className="small">
                    Restore it from the file list at the top of this page, or re-upload it here:{" "}
                    <RestoreFileControl
                      tenderId={id}
                      index={pageView.fileIndex}
                      kind={tender.files?.[pageView.fileIndex]?.kind}
                      onRestored={loadFileStatus}
                    />
                  </p>
                ) : (
                  <p className="small muted">Ask an administrator to restore the original file.</p>
                )}
              </div>
            ) : pdfView && pageView.fileIndex >= 0 ? (
              // The browser's own PDF viewer, jumped to the cited page —
              // the executive verifies the clause against the real document,
              // not our extracted text.
              <iframe
                className="pdf-frame"
                title={`${pageView.file} page ${pageView.page}`}
                src={`${API_BASE}/api/tenders/${id}/file/${pageView.fileIndex}#page=${pageView.page}&view=FitH`}
              />
            ) : (
              <pre>{pageView.text || "(no extractable text on this page)"}</pre>
            )}
            {pageView.links?.length > 0 && !pdfView && (
              <div className="page-links">
                <strong className="small">Links on this page</strong>
                <ul>
                  {pageView.links.map((l) => (
                    <li key={l}><a href={l} target="_blank" rel="noreferrer">{l}</a></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Recovery control for a super admin, shown next to a file the server
 * reports missing from disk (e.g. an ephemeral host wiped it on redeploy
 * before a persistent disk was attached). Two paths, matching how the file
 * got here in the first place:
 *  - "linked" (auto-fetched from a URL inside the main PDF, e.g. a GCC/SCC
 *    the person never downloaded themselves) → one-click re-fetch from that
 *    same stored URL. No LLM call, so essentially free.
 *  - "uploaded" (or a failed re-fetch) → pick a local file to re-upload.
 * Either way the server independently verifies the result is the same
 * document by page count before accepting it — this is just the trigger.
 */
function RestoreFileControl({ tenderId, index, kind, onRestored }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  const refetch = async () => {
    setBusy(true);
    setError("");
    try {
      await api.refetchFile(tenderId, index);
      onRestored?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // let picking the same filename again re-fire onChange
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      await api.restoreFile(tenderId, index, file);
      onRestored?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="restore-file">
      <input ref={inputRef} type="file" accept="application/pdf" hidden onChange={pick} />
      {kind === "linked" && (
        <button className="link small" disabled={busy} onClick={refetch} title="Attempt to retrieve this document automatically from its original source">
          {busy ? "Retrieving…" : "Retrieve automatically"}
        </button>
      )}
      <button className="link small" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Checking…" : "Upload a copy"}
      </button>
      {error && <span className="error small" title={error}>⚠ {error}</span>}
    </span>
  );
}

/**
 * Overview facts grid. Every field is always shown (not just populated
 * ones) — an empty key detail (EMD, bid opening date, estimated value...)
 * is far more useful flagged as "not found, verify manually" than silently
 * omitted, since these are exactly the facts an executive needs and a gap
 * here usually means the extraction missed something genuinely present in
 * the tender, not that the tender doesn't have it.
 */
function OverviewGrid({ ov, ovCite, parseCitation, cite, openPage, printMode = false }) {
  return (
    <dl className="overview-grid">
      {OVERVIEW_FIELDS.map(([key, label]) => {
        const value = ov[key];
        const c = parseCitation(ovCite(key));
        return (
          <div key={key} className="overview-item">
            <dt>{label}</dt>
            <dd className={value ? "" : "missing"}>
              {value || "⚠ Not found — verify manually"}
              {c && !printMode && <button className="link small" title={cite(c.page, null, c.file)} onClick={() => openPage(c.page, c.file)}>p{c.page}</button>}
              {c && printMode && <span className="small muted"> ({c.file} p{c.page})</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Shared clause card — used both for the live filtered on-screen view and
 *  the print-only full report, so the two never drift out of sync. */
function ClauseCard({ c, cite, pageLabel, onOpenPage, onImportance, onRemove, onNoted, tenderId, canEdit = false, printMode = false }) {
  const [noting, setNoting] = useState(false);
  return (
    <article className={`clause imp-${c.importance}`}>
      <header>
        <span className={`badge imp-${c.importance}`}>{c.importance}</span>
        <strong>{c.clauseRef || "—"}</strong> {c.title}
        {printMode ? (
          <span className="small muted">{pageLabel(c.page, c.pageEnd, c.sourceFile)}</span>
        ) : (
          <button className="link" title={cite(c.page, c.pageEnd, c.sourceFile)} onClick={() => onOpenPage(c.page, c.sourceFile)}>{pageLabel(c.page, c.pageEnd, c.sourceFile)}</button>
        )}
        {c.clauseStatus === "CONFLICT" && <span className="badge conflict" title={c.conflictNote}>⚡ conflict</span>}
        {c.mandatoryStatus && c.mandatoryStatus !== "NOT_SPECIFIED" && <span className="badge status">{c.mandatoryStatus}</span>}
        {c.source === "manual" && <span className="badge manual" title={c.addedFrom ? `Added based on a question asked in the assistant: “${c.addedFrom}”` : "Added manually by a team member"}>Added by team</span>}
        {c.source === "verify" && <span className="badge verify" title="Identified during a secondary review pass">Additional finding</span>}
        {c.correctedByVerify && <span className="badge verify" title="Refined during a secondary review pass">Refined</span>}
        {(c.flags || []).map((f) => <span key={f} className="badge flag">{f}</span>)}
        {!printMode && (
          <span className="clause-tools">
            {!noting && (
              <button className="link small" title="Save this clause to your notes" onClick={() => setNoting(true)}>+ Save to my notes</button>
            )}
            {canEdit && onImportance && (
              <select
                value={c.importance}
                title="Change importance ranking"
                onChange={(e) => onImportance(c, e.target.value)}
              >
                <option value="critical">critical</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            )}
            {canEdit && onRemove && <button className="link small danger" title="Remove this clause" onClick={() => onRemove(c)}>Remove</button>}
          </span>
        )}
      </header>

      {noting && (
        <NoteForm
          tenderId={tenderId}
          preset={{
            title: c.clauseRef ? `${c.clauseRef} — ${c.title}` : c.title,
            text: c.requirementDescription || c.summary || "",
            category: c.category,
            importance: c.importance,
            source: "clause",
            clauseId: c._id,
            sourceFile: c.sourceFile,
            page: c.page,
          }}
          onDone={() => { setNoting(false); onNoted?.(); }}
          onCancel={() => setNoting(false)}
        />
      )}
      <p className="brief">{c.requirementDescription || c.summary}</p>
      {c.clauseStatus === "CONFLICT" && c.conflictNote && <p className="small conflict-note">⚡ {c.conflictNote}</p>}
      <footer className="small muted">
        {c.deadline && <span>⏱ {c.deadline}</span>}
        {c.amount && <span>₹ {c.amount}</span>}
        {c.timePeriod && <span>📅 {c.timePeriod}</span>}
        {c.applicability && <span>👥 {c.applicability}</span>}
        {c.exception && <span>⚠ {c.exception}</span>}
        {c.link && <span>🔗 {printMode ? c.link : <a href={c.link} target="_blank" rel="noreferrer">{c.link}</a>}</span>}
      </footer>
    </article>
  );
}
