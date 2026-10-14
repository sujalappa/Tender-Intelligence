import { useEffect, useState } from "react";
import { api } from "../api.js";

// Mirrors verdictFor() on the server (TypeSafe's confidence guidance).
const VERDICT = {
  clear: { label: "Clear meaning", note: "One reading clearly fits the wording." },
  likely: { label: "Probably this reading — worth confirming", note: "One reading is favoured, but not decisively. Confirm before committing money or documents to it." },
  ambiguous: { label: "Genuinely ambiguous — raise a pre-bid query", note: "No reading clearly wins. Only the buyer can settle this; the drafted query below is ready to send." },
  unscored: { label: "Readings not scored", note: "" },
};

const pct = (p) => `${Math.round((p || 0) * 100)}%`;

/**
 * The "Interpret" panel under a clause: the plausible readings DeepSeek wrote
 * out, ranked by Jev's probability for each, with a verdict from Jev's
 * confidence and a drafted pre-bid query for the ambiguous cases.
 */
export default function Interpretation({ tenderId, clause, initial, onClose, onResult }) {
  const [data, setData] = useState(initial || null);
  const [busy, setBusy] = useState(!initial);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const run = async (refresh = false) => {
    setBusy(true);
    setError("");
    try {
      const { interpretation } = await api.interpretClause(tenderId, clause._id, { refresh });
      setData(interpretation);
      onResult?.(interpretation);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  // First open with nothing cached: fetch straight away.
  useEffect(() => {
    if (!initial) run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.preBidQuery);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy — select the text and copy it manually");
    }
  };

  if (busy && !data) return <div className="interp"><p className="muted small">Working out the possible readings of this clause…</p></div>;

  if (!data) {
    return (
      <div className="interp">
        {error && <p className="error small">⚠ {error}</p>}
        <div className="interp-actions">
          <button className="link small" onClick={() => run(false)}>Try again</button>
          <button className="link small" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  const s = data.scoring || {};
  const scored = s.status === "scored";
  const probs = s.probabilities || {};
  const readings = [...(data.readings || [])].sort((a, b) => (scored ? (probs[b.key] || 0) - (probs[a.key] || 0) : 0));
  const verdict = VERDICT[scored ? s.verdict : "unscored"] || VERDICT.unscored;
  const single = readings.length === 1;
  const noneWins = scored && s.choice === "none_of_these";

  return (
    <div className={`interp interp-${scored ? s.verdict : "unscored"}`}>
      <div className="interp-head">
        <strong>{single && !noneWins ? VERDICT.clear.label : verdict.label}</strong>
        {scored && <span className="muted small"> · confidence {pct(s.confidence)}</span>}
        <span className="interp-actions">
          <button className="link small" onClick={() => run(true)} disabled={busy}>{busy ? "Re-running…" : "Re-run"}</button>
          <button className="link small" onClick={onClose}>Close</button>
        </span>
      </div>
      {!single && verdict.note && <p className="small muted interp-note">{verdict.note}</p>}
      {noneWins && <p className="small error">The scoring model thinks none of these readings fits the wording well. Read the clause itself before relying on any of them.</p>}
      {data.whyAmbiguous && <p className="small"><strong>Why it's unclear:</strong> {data.whyAmbiguous}</p>}

      <ol className="interp-readings">
        {readings.map((r) => (
          <li key={r.key} className={scored && s.choice === r.key ? "top" : ""}>
            <div className="interp-reading-head">
              <strong>{r.title}</strong>
              {scored && (
                <span className="interp-prob" title="Likelihood this is what the buyer intends, per Jev">
                  <span className="interp-bar"><span style={{ width: pct(probs[r.key]) }} /></span>
                  {pct(probs[r.key])}
                </span>
              )}
            </div>
            <p>{r.meaning}</p>
            {r.basis && <p className="small muted">Based on: “{r.basis}”</p>}
            {r.ifWrong && !single && <p className="small interp-risk">If this is wrong: {r.ifWrong}</p>}
          </li>
        ))}
      </ol>

      {data.preBidQuery && (
        <div className="interp-query">
          <div className="interp-reading-head">
            <strong className="small">Draft pre-bid query</strong>
            <button className="link small" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <p>{data.preBidQuery}</p>
        </div>
      )}

      <p className="muted small">
        {scored
          ? `Readings by ${data.readingsModel || "DeepSeek"}; likelihoods by ${s.model || "Jev"}. A guide to the wording, not a legal opinion.`
          : `Readings by ${data.readingsModel || "DeepSeek"}. Likelihoods unavailable${s.reason ? `: ${s.reason}` : ""}.`}
        {data.generatedAt && ` · ${new Date(data.generatedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}${data.by ? ` by ${data.by}` : ""}`}
      </p>
      {error && <p className="error small">⚠ {error}</p>}
    </div>
  );
}
