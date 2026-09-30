import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
  // The team-wide list of standard keys, to spot keys added after this
  // summary was generated (they have no row here yet).
  const [keys, setKeys] = useState(null);
  const [filling, setFilling] = useState(false);
  useEffect(() => {
    if (!printMode) api.summaryKeys().then(setKeys).catch(() => setKeys(null));
  }, [printMode, summary?.standing?.length]);

  const fill = async () => {
    setFilling(true);
    setError("");
    try {
      const { execSummary } = await api.fillExecKeys(tenderId);
      onUpdated?.(execSummary);
    } catch (e) {
      setError(e.message);
    } finally {
      setFilling(false);
    }
  };

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
          A concise, one-page summary of this tender's most critical terms — figures, dates and conditions at a glance,
          with risks and conflicts clearly flagged. Ideal for sharing with leadership or comparing against other tenders.
        </p>
        <p className="muted small">Usually ready within a minute.</p>
        {canEdit
          ? <button onClick={generate} disabled={busy}>{busy ? "Preparing summary…" : "Generate executive summary"}</button>
          : <p className="muted small">An administrator needs to generate this summary first.</p>}
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
            Last generated {when}
            {clauseCount !== summary.sourceClauseCount && <span className="error"> · This tender has been updated since — regenerate for the latest summary</span>}
          </span>
          {canEdit && <button className="link small" onClick={generate} disabled={busy}>{busy ? "Regenerating…" : "Regenerate"}</button>}
          {error && <span className="error small">⚠ {error}</span>}
        </div>
      )}

      {summary.headline && <p className="exec-headline">{summary.headline}</p>}

      <StandardKeys
        summary={summary}
        keys={keys}
        Page={Page}
        printMode={printMode}
        filling={filling}
        onFill={fill}
      />

      {!printMode && <AskKey tenderId={tenderId} Page={Page} onAdded={(execSummary) => { onUpdated?.(execSummary); api.summaryKeys().then(setKeys).catch(() => {}); }} />}

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
                      <button className="link small danger" onClick={() => removePoint("__glance__", i, p.label)} title="Remove from brief">Remove</button>
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
                      <button className="link small danger" onClick={() => removePoint(sec.category, i, p.label)} title="Remove from brief">Remove</button>
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

/**
 * The team's standard keys: one row per key on every summary, "Not
 * mentioned" included, so tenders compare row for row. Rows follow the
 * order of the team-wide list.
 */
function StandardKeys({ summary, keys, Page, printMode, filling, onFill }) {
  const rows = summary.standing || [];
  const order = new Map((keys || []).map((k, i) => [String(k._id), i]));
  const sorted = keys ? [...rows].sort((a, b) => (order.get(a.keyId) ?? 1e9) - (order.get(b.keyId) ?? 1e9)) : rows;
  const have = new Set(rows.map((r) => r.keyId));
  const missing = (keys || []).filter((k) => !have.has(String(k._id)));
  if (!rows.length && !missing.length) return null;

  return (
    <section className="exec-cat exec-keys">
      <h4>
        Standard keys <span className="muted small">({rows.length})</span>
        {!printMode && <Link className="link small exec-keys-manage" to="/summary-keys">Manage keys</Link>}
      </h4>
      {!printMode && missing.length > 0 && (
        <p className="exec-keys-missing small">
          {missing.length} key{missing.length > 1 ? "s were" : " was"} added after this summary was generated ({missing.map((k) => k.label).join(", ")}).{" "}
          <button className="link small" onClick={onFill} disabled={filling}>{filling ? "Filling…" : "Fill them in for this tender"}</button>
        </p>
      )}
      {sorted.length > 0 && (
        <table className="table exec-table glance">
          <tbody>
            {sorted.map((r) => (
              <tr key={r.keyId || r.label} className={isRisk(r.value) ? "risk" : ""}>
                <th>{r.label}</th>
                <td className={r.found ? "" : "muted"}>{r.found ? r.value : "— Not mentioned in this tender"}</td>
                <td className="exec-page"><Page p={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Ask the tender a question and, if the answer is worth having on every
 * summary, add it as a standard key. Asking alone saves nothing.
 */
function AskKey({ tenderId, Page, onAdded }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const ask = async (e) => {
    e.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setError("");
    setAnswer(null);
    try {
      const { answer } = await api.askExecKey(tenderId, question.trim());
      setAnswer(answer);
      setLabel(answer.label);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const { execSummary } = await api.addExecKey(tenderId, {
        label: label.trim(),
        question: answer.question,
        category: answer.category,
        answer,
      });
      onAdded?.(execSummary);
      setAnswer(null);
      setQuestion("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="exec-ask">
      <form onSubmit={ask} className="exec-ask-form">
        <label htmlFor="exec-ask-q" className="small">Need something that isn't here? Ask the tender:</label>
        <div className="exec-ask-row">
          <input
            id="exec-ask-q"
            type="text"
            placeholder="e.g. Is a site visit mandatory?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={busy}
          />
          <button type="submit" disabled={busy || !question.trim()}>{busy && !answer ? "Asking…" : "Ask"}</button>
        </div>
      </form>

      {answer && (
        <div className="exec-ask-result">
          <div className="exec-ask-answer">
            <input
              id="exec-ask-label"
              className="exec-ask-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              aria-label="Key name"
              title="Name of this key on every summary. You can edit it."
            />
            <span className={answer.found ? "" : "muted"}>{answer.found ? answer.value : "— Not mentioned in this tender"}</span>
            <Page p={answer} />
          </div>
          <p className="muted small">
            {answer.found
              ? "Add it and every executive summary will carry this key from now on."
              : "This tender doesn't mention it. You can still add it: other tenders will be checked for it, and it will show as \"Not mentioned\" where it's absent."}
          </p>
          <div className="exec-ask-actions">
            <button onClick={add} disabled={busy || !label.trim()}>{busy ? "Adding…" : "Add to every summary"}</button>
            <button className="link small" onClick={() => setAnswer(null)} disabled={busy}>Discard</button>
          </div>
        </div>
      )}
      {error && <p className="error small">⚠ {error}</p>}
    </section>
  );
}
