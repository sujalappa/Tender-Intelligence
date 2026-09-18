import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

/**
 * Super-admin view across everyone: what the team has been noting and asking.
 * The point is coverage — spotting that nobody has looked at a tender's legal
 * section, or that three people asked the same thing.
 */
export default function Activity() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("notes");

  useEffect(() => { api.activity().then(setData).catch((e) => setError(e.message)); }, []);

  if (error) return <div className="page"><section className="card"><p className="error">⚠ {error}</p></section></div>;
  if (!data) return <div className="page"><p className="muted">Loading…</p></div>;

  const rows = tab === "notes" ? data.notes : data.questions;

  return (
    <div className="page">
      <section className="card">
        <h2>Team Activity</h2>
        <p className="muted small">A record of recent notes and questions from your team across all tenders. Individual notes stay private otherwise — this overview is visible only to administrators.</p>

        <nav className="tabs no-print">
          <button className={tab === "notes" ? "tab active" : "tab"} onClick={() => setTab("notes")}>
            Notes <span className="count">{data.notes.length}</span>
          </button>
          <button className={tab === "questions" ? "tab active" : "tab"} onClick={() => setTab("questions")}>
            Questions asked <span className="count">{data.questions.length}</span>
          </button>
        </nav>

        {rows.length === 0 && <p className="muted small">Nothing yet.</p>}

        <div className="table-scroll">
          <table className="table small">
            <thead>
              <tr>
                <th>Who</th>
                <th>{tab === "notes" ? "Note" : "Question"}</th>
                <th>Tender</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id}>
                  <td>{r.author}</td>
                  <td>
                    {tab === "notes" ? (
                      <>
                        <strong>{r.title}</strong>
                        <div className="muted">{r.text.slice(0, 160)}{r.text.length > 160 ? "…" : ""}</div>
                      </>
                    ) : (
                      r.text
                    )}
                  </td>
                  <td><Link to={`/tenders/${r.tenderId}`}>open</Link></td>
                  <td className="mono">{new Date(r.createdAt).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
