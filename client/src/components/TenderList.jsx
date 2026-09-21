import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import ModelPicker from "./ModelPicker.jsx";
import { useAuth } from "../auth.jsx";

export default function TenderList() {
  const { isAdmin } = useAuth();
  const [tenders, setTenders] = useState([]);
  const [files, setFiles] = useState([]);
  const [title, setTitle] = useState("");
  const [followLinks, setFollowLinks] = useState(true);
  const [llm, setLlm] = useState({ provider: "", model: "", verify: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The tender currently in the delete-confirmation modal, or null. Deletion
  // is permanent (clauses, notes, chat history, files — everything), so a
  // one-click Delete next to a possibly-hours-of-work tender is too easy to
  // hit by accident; this requires typing the exact title before it's live.
  const [deleting, setDeleting] = useState(null);

  const load = () => api.list().then(setTenders).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!files.length) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      for (const f of files) form.append("files", f);
      if (title) form.append("title", title);
      if (llm.provider) form.append("provider", llm.provider);
      if (llm.model) form.append("model", llm.model);
      form.append("verify", String(llm.verify));
      form.append("followLinks", String(followLinks));
      await api.upload(form);
      setFiles([]);
      setTitle("");
      e.target.reset();
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      {isAdmin && (
        <section className="card">
          <h2>Upload tender</h2>
          <form onSubmit={submit} className="upload-form">
            <input type="file" accept="application/pdf" multiple onChange={(e) => setFiles([...e.target.files])} required />
            {files.length > 1 && <p className="muted small">{files.length} files selected: {files.map((f) => f.name).join(", ")}</p>}
            <input type="text" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
            <ModelPicker value={llm} onChange={setLlm} />
            <label className="inline">
              <input type="checkbox" checked={followLinks} onChange={(e) => setFollowLinks(e.target.checked)} />
              Automatically retrieve and include any linked documents referenced inside the uploaded file(s)
            </label>
            <button type="submit" disabled={busy || !files.length}>{busy ? "Uploading…" : "Upload & Analyse"}</button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      )}

      <section className="card">
        <h2>Tenders</h2>
        {tenders.length === 0 && <p className="muted">No tenders yet.</p>}
        <table className="table">
          <thead>
            <tr><th>Title</th><th>Files</th><th>Pages</th><th>Status</th><th>Model</th><th>Clauses</th>{isAdmin && <th></th>}</tr>
          </thead>
          <tbody>
            {tenders.map((t) => (
              <tr key={t._id}>
                <td><Link to={`/tenders/${t._id}`}>{t.title}</Link></td>
                <td className="small muted">{t.files?.length ?? "–"}</td>
                <td>{t.pageCount ?? "–"}</td>
                <td><StatusPill status={t.status} progress={t.progress} /></td>
                <td className="mono small">{t.model || "–"}</td>
                <td>{t.summary ? Object.values(t.summary).reduce((a, c) => a + c.total, 0) : "–"}</td>
                {isAdmin && (
                  <td>
                    <button className="link danger" onClick={() => setDeleting(t)}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {deleting && (
        <DeleteTenderModal
          tender={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setDeleting(null); load(); }}
        />
      )}
    </div>
  );
}

function DeleteTenderModal({ tender, onClose, onDeleted }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clauseCount = tender.summary ? Object.values(tender.summary).reduce((a, c) => a + c.total, 0) : 0;
  const matches = typed.trim() === tender.title;

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await api.remove(tender._id);
      onDeleted();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal no-print" onClick={onClose}>
      <div className="modal-body delete-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <strong>⚠ Delete this tender?</strong>
          <button className="link" onClick={onClose}>Close</button>
        </header>
        <div className="delete-modal-body">
          <p>
            You're about to permanently delete <strong>"{tender.title}"</strong>
            {tender.pageCount ? <> — {tender.pageCount} pages</> : null}
            {clauseCount ? <>, {clauseCount} extracted clauses</> : null}.
          </p>
          <p className="error">
            This cannot be undone. All extracted clauses, the executive summary, everyone's notes, and chat history for
            this tender will be permanently deleted.
          </p>
          <label>
            <span className="small muted">Type the tender title to confirm: <strong>{tender.title}</strong></span>
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
          </label>
          {error && <p className="error small">⚠ {error}</p>}
          <div className="delete-modal-actions">
            <button className="danger" disabled={!matches || busy} onClick={confirm}>
              {busy ? "Deleting…" : "Delete permanently"}
            </button>
            <button className="link" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const STATUS_LABELS = {
  uploaded: "Queued",
  parsing: "Reading document",
  segregating: "Analysing",
  done: "Complete",
  failed: "Failed",
};

export function StatusPill({ status, progress }) {
  return (
    <span className={`pill pill-${status}`} title={progress}>
      {STATUS_LABELS[status] || status}
    </span>
  );
}
