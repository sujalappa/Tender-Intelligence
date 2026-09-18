import { useState } from "react";
import { api } from "../api.js";

const CATEGORY_LABELS = {
  commercial: "Commercial",
  financial: "Financial",
  technical: "Technical",
  legal: "Legal",
  technical_qualification: "Technical Qualification",
};

const isRisk = (v) => /^(risk|conflict)\b/i.test(v || "");

/**
 * Renders the model-written executive brief stored on the tender
 * (tender.execSummary — see server/services/execSummary.js), and offers to
 * generate / regenerate it. `printMode` swaps citation buttons for plain
 * page refs and hides the controls.
 */
export default function ExecutiveSummary({ tenderId, summary, clauseCount, pageLabel, cite, openPage, onGenerated, onUpdated, canEdit = false, printMode = false }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const generate = async () => {
    setBusy(true);
    setError("");
    try {
      const { execSummary } = await api.execSummary(tenderId);
      onGenerated?.(execSummary);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const removePoint = async (category, pointIndex, label) => {
    if (!window.confirm(`Remove "${label}" from the brief?`)) return;
    try {
      const { execSummary } = await api.removeExecPoint(tenderId, category, pointIndex);
      onUpdated?.(execSummary);
    } catch (e) {
      setError(e.message);
    }
  };

  const Page = ({ p }) =>
    !p.file || !p.page ? null : printMode ? (
      <span className="muted">{pageLabel(p.page, null, p.file)}</span>
    ) : (
      <button className="link small" title={cite(p.page, null, p.file)} onClick={() => openPage(p.page, p.file)}>{pageLabel(p.page, null, p.file)}</button>
    );

  if (!summary) {
    if (printMode) return null;
    return (
      <div className="exec-empty">
        <p>
          A one-page brief for the head of the company: the model re-reads every critical clause and compresses each into a single key/value line — figures, dates and conditions only — merging duplicates and flagging risks, so this tender can be compared against others at a glance.
        </p>
        <p className="muted small">One model call over the {clauseCount} critical/conflicting clauses (~1 minute).</p>
        {canEdit
          ? <button onClick={generate} disabled={busy}>{busy ? "Writing brief…" : "Generate executive summary"}</button>
          : <p className="muted small">A super admin needs to generate this first.</p>}
        {error && <p className="error small">⚠ {error}</p>}
      </div>
    );
  }

  const when = summary.generatedAt ? new Date(summary.generatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "";

  return (
    <div className="exec-summary">
      {!printMode && (
        <div className="exec-toolbar">
          <span className="muted small">
            Generated {when} from {summary.sourceClauseCount} critical/conflicting clauses
            {clauseCount !== summary.sourceClauseCount && <span className="error"> · clause data has changed since ({clauseCount} now) — regenerate</span>}
          </span>
          {canEdit && <button className="link small" onClick={generate} disabled={busy}>{busy ? "Regenerating…" : "Regenerate"}</button>}
          {error && <span className="error small">⚠ {error}</span>}
        </div>
      )}

      {summary.headline && <p className="exec-headline">{summary.headline}</p>}

      {summary.atAGlance?.length > 0 && (
        <section className="exec-cat">
          <h4>At a glance</h4>
          <table className="table exec-table glance">
            <tbody>
              {summary.atAGlance.map((p, i) => (
                <tr key={i} className={isRisk(p.value) ? "risk" : ""}>
                  <th>{p.label}</th>
                  <td>{p.value}</td>
                  <td className="exec-page"><Page p={p} /></td>
                  {!printMode && canEdit && (
                    <td className="exec-tools">
                      <button className="link small danger" onClick={() => removePoint("__glance__", i, p.label)} title="Remove from brief">remove</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {summary.watchouts?.length > 0 && (
        <section className="exec-cat exec-watch">
          <h4>⚠ Before approving a bid</h4>
          <ul>{summary.watchouts.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </section>
      )}

      {summary.sections?.map((sec) => (
        <section key={sec.category} className="exec-cat">
          <h4>{CATEGORY_LABELS[sec.category] || sec.category} <span className="muted small">({sec.points.length})</span></h4>
          <table className="table exec-table">
            <tbody>
              {sec.points.map((p, i) => (
                <tr key={i} className={isRisk(p.value) ? "risk" : ""}>
                  <th>{p.label}</th>
                  <td>{p.value}{p.addedBy && <span className="badge linked" title={`Added by ${p.addedBy}`}>{p.addedBy}</span>}</td>
                  <td className="exec-page"><Page p={p} /></td>
                  {!printMode && canEdit && (
                    <td className="exec-tools">
                      <button className="link small danger" onClick={() => removePoint(sec.category, i, p.label)} title="Remove from brief">remove</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
