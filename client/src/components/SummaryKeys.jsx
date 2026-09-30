import { useEffect, useState } from "react";
import { api } from "../api.js";

const LABELS = {
  commercial: "Commercial",
  financial: "Financial",
  technical: "Technical",
  legal: "Legal",
  technical_qualification: "Technical Qualification",
};

/**
 * The team's standard executive-summary keys. Every summary carries one row
 * per key ("Not mentioned" when the tender is silent), and each key's
 * question is also given to extraction for its category. Keys are usually
 * added from a tender's summary via "Ask the tender", but can be added here
 * directly too.
 */
export default function SummaryKeys() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [question, setQuestion] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.summaryKeys().then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.createSummaryKey({ label: label.trim(), question: question.trim(), category: category || undefined });
      setLabel("");
      setQuestion("");
      setCategory("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (k) => {
    if (!window.confirm(`Remove "${k.label}"? It will disappear from every executive summary, including existing ones.`)) return;
    setError("");
    try {
      await api.removeSummaryKey(k._id);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      <p className="muted small">
        Every executive summary shows these keys, in this order. If a tender doesn't mention one, its row says
        "Not mentioned", so tenders can be compared row by row. Removing a key takes it off every summary.
      </p>

      {!rows ? (
        <p className="muted small">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted small">
          No keys yet. Open a tender's Executive Summary and ask a question, or add one below.
        </p>
      ) : (
        <table className="table small">
          <thead><tr><th>Key</th><th>Question asked of each tender</th><th>Section</th><th>Added by</th><th></th></tr></thead>
          <tbody>
            {rows.map((k) => (
              <tr key={k._id}>
                <td><strong>{k.label}</strong></td>
                <td>{k.question}</td>
                <td>{LABELS[k.category] || "—"}</td>
                <td className="muted">
                  {k.createdBy?.name || "—"}
                  {k.createdAt && <>, {new Date(k.createdAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</>}
                </td>
                <td><button className="link small danger" onClick={() => remove(k)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={add} className="summary-key-form">
        <h3>Add a key</h3>
        <input id="sk-label" type="text" placeholder="Key name, e.g. Site visit mandatory" value={label} onChange={(e) => setLabel(e.target.value)} required />
        <input id="sk-question" type="text" placeholder="Question for each tender (optional), e.g. Is a pre-bid site visit mandatory?" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <select id="sk-category" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Section">
          <option value="">Section (optional)</option>
          {Object.entries(LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button type="submit" disabled={busy || !label.trim()}>{busy ? "Adding…" : "Add key"}</button>
        <p className="muted small">
          Existing summaries show a "Fill them in" prompt for new keys; newly generated summaries include them automatically.
        </p>
      </form>
      {error && <p className="error small">⚠ {error}</p>}
    </>
  );
}
