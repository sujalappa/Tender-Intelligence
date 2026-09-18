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
        No questions yet. As your team uses the assistant, the questions they ask most often will appear here — helping every
        new tender start with clearer, more complete answers already in place.
      </p>
    );
  }

  return (
    <>
      <p className="muted small">
        These are the questions your team asks most often, used to make future tenders more complete from the start.
        Remove anything that shouldn't be considered going forward.
      </p>
      <table className="table small">
        <thead><tr><th>Question</th><th>Section</th><th>Times asked</th><th>Tenders</th><th></th></tr></thead>
        <tbody>
          {rows.map((q) => (
            <tr key={q.id}>
              <td>{q.text}</td>
              <td>{LABELS[q.category] || q.category || "—"}</td>
              <td className="mono">{q.asked}</td>
              <td className="mono">{q.tenders}</td>
              <td><button className="link small danger" onClick={() => remove(q.id)}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
