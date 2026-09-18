import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

const CATEGORY_LABELS = {
  commercial: "Commercial",
  financial: "Financial",
  technical: "Technical",
  legal: "Legal",
  technical_qualification: "Technical Qualification",
};

const SOURCE_LABELS = { clause: "from a clause", chat: "from chat", manual: "typed" };

/**
 * One person's notes on this tender. Private by default; a super admin can
 * switch to any other person's (or everyone's) via the picker.
 */
export default function NotesPanel({ tenderId, users, cite, pageLabel, openPage, refreshKey }) {
  const { user, isAdmin } = useAuth();
  const [viewing, setViewing] = useState("me"); // "me" | "all" | a userId
  const [notes, setNotes] = useState(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  const load = () => {
    const params = viewing === "me" ? {} : viewing === "all" ? { all: "true" } : { userId: viewing };
    api.notes(tenderId, params).then(setNotes).catch((e) => setError(e.message));
  };
  useEffect(() => { setNotes(null); setError(""); load(); }, [tenderId, viewing, refreshKey]);

  const remove = async (n) => {
    if (!window.confirm(`Delete note "${n.title}"?`)) return;
    try {
      await api.removeNote(tenderId, n._id);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const mine = viewing === "me";

  return (
    <div className="notes-panel">
      <div className="notes-toolbar">
        {isAdmin && (
          <label className="inline small">
            <span className="muted">Showing</span>
            <select value={viewing} onChange={(e) => setViewing(e.target.value)}>
              <option value="me">My notes</option>
              <option value="all">Everyone's notes</option>
              {(users || []).filter((u) => String(u.id) !== String(user?.id)).map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </label>
        )}
        {mine && <button onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ New note"}</button>}
      </div>

      {adding && (
        <NoteForm
          tenderId={tenderId}
          onDone={() => { setAdding(false); load(); }}
          onCancel={() => setAdding(false)}
        />
      )}

      {error && <p className="error small">⚠ {error}</p>}
      {!notes && !error && <p className="muted small">Loading…</p>}
      {notes?.length === 0 && (
        <p className="muted small">
          {mine
            ? "You haven't added any notes yet. Save a clause or an assistant answer to your notes, or write one directly — your notes stay private to you and remain available for as long as this tender does."
            : "Nothing here."}
        </p>
      )}

      <div className="notes-list">
        {(notes || []).map((n) => (
          <article key={n._id} className={`note imp-${n.importance}`}>
            <header>
              <strong>{n.title}</strong>
              <span className={`badge imp-${n.importance}`}>{n.importance}</span>
              {n.category && <span className="badge">{CATEGORY_LABELS[n.category] || n.category}</span>}
              <span className="badge flag">{SOURCE_LABELS[n.source] || n.source}</span>
              {n.inExecSummary && <span className="badge verify" title="Also included in the executive summary">In summary</span>}
              {n.author && <span className="badge linked">{n.author}</span>}
            </header>
            <p>{n.text}</p>
            <footer className="small muted">
              {n.sourceFile && n.page ? (
                <button className="link small" title={cite(n.page, null, n.sourceFile)} onClick={() => openPage(n.page, n.sourceFile)}>
                  {pageLabel(n.page, null, n.sourceFile)}
                </button>
              ) : null}
              {n.askedQuestion && <span title={n.askedQuestion}>· asked: “{n.askedQuestion.slice(0, 60)}{n.askedQuestion.length > 60 ? "…" : ""}”</span>}
              <span>· {new Date(n.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
              {(String(n.userId) === String(user?.id) || isAdmin) && (
                <button className="link small danger" onClick={() => remove(n)}>Delete</button>
              )}
            </footer>
          </article>
        ))}
      </div>
    </div>
  );
}

/** Shared by the panel ("+ New note") and the clause/chat capture buttons. */
export function NoteForm({ tenderId, preset = {}, onDone, onCancel, allowExecSummary = true }) {
  const [form, setForm] = useState({
    title: preset.title || "",
    text: preset.text || "",
    category: preset.category || "",
    importance: preset.importance || "high",
    addToExecSummary: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const out = await api.addNote(tenderId, {
        ...form,
        source: preset.source || "manual",
        clauseId: preset.clauseId,
        askedQuestion: preset.askedQuestion,
        sourceFile: preset.sourceFile,
        page: preset.page,
      });
      onDone?.(out);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-form" onSubmit={submit}>
      <label>
        <span>Section</span>
        <select value={form.category} onChange={set("category")}>
          <option value="">(none)</option>
          {Object.entries(CATEGORY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label>
        <span>Importance</span>
        <select value={form.importance} onChange={set("importance")}>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </label>
      <label className="wide">
        <span>Title</span>
        <input value={form.title} onChange={set("title")} placeholder="Short name for this point" required />
      </label>
      <label className="wide">
        <span>Detail</span>
        <textarea rows={4} value={form.text} onChange={set("text")} required />
      </label>
      {allowExecSummary && (
        <label className="inline wide">
          <input type="checkbox" checked={form.addToExecSummary} onChange={set("addToExecSummary")} />
          <span>Also include this in the executive summary (visible to the whole team, attributed to you)</span>
        </label>
      )}
      {error && <p className="error small wide">⚠ {error}</p>}
      <div className="wide add-actions">
        <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save to my notes"}</button>
        {onCancel && <button type="button" className="link" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
