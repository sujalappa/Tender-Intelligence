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
 * What the team keeps asking the chatbot, pooled across every tender. This
 * is fed into future extraction prompts, so it's shown here rather than left
 * as invisible state — if a bad question is in the bank it quietly shapes
 * every later extraction, and you can delete it from here.
 */
export default function QuestionBank() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");

  const load = () => api.questions().then(setRows).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    await api.removeQuestion(id).catch((e) => setError(e.message));
    load();
  };

  if (error) return <p className="error small">⚠ {error}</p>;
  if (!rows) return <p className="muted small">Loading…</p>;
  if (!rows.length) {
    return (
      <p className="muted small">
        Nothing yet. Every question asked in the tender chat is pooled here (rewritten to be tender-agnostic) and fed into the
        extraction prompt for later tenders, so the next one answers it up front instead of being asked again.
      </p>
    );
  }

  return (
    <>
      <p className="muted small">
        Pooled from the tender chat and fed into future extractions — the top 12 per category are added to that category's prompt.
        Delete anything that shouldn't shape future runs.
      </p>
      <table className="table small">
        <thead><tr><th>Question</th><th>Section</th><th>Asked</th><th>Tenders</th><th></th></tr></thead>
        <tbody>
          {rows.map((q) => (
            <tr key={q.id}>
              <td>{q.text}</td>
              <td>{LABELS[q.category] || q.category || "—"}</td>
              <td className="mono">{q.asked}</td>
              <td className="mono">{q.tenders}</td>
              <td><button className="link small danger" onClick={() => remove(q.id)}>remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
