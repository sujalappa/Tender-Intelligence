import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import ModelPicker from "./ModelPicker.jsx";

export default function TenderList() {
  const [tenders, setTenders] = useState([]);
  const [files, setFiles] = useState([]);
  const [title, setTitle] = useState("");
  const [followLinks, setFollowLinks] = useState(true);
  const [llm, setLlm] = useState({ provider: "", model: "", verify: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
      <section className="card">
        <h2>Upload tender</h2>
        <form onSubmit={submit} className="upload-form">
          <input type="file" accept="application/pdf" multiple onChange={(e) => setFiles([...e.target.files])} required />
          {files.length > 1 && <p className="muted small">{files.length} files selected: {files.map((f) => f.name).join(", ")}</p>}
          <input type="text" placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <ModelPicker value={llm} onChange={setLlm} />
          <label className="inline">
            <input type="checkbox" checked={followLinks} onChange={(e) => setFollowLinks(e.target.checked)} />
            Auto-fetch PDFs linked from inside the uploaded file(s) and include them as context
          </label>
          <button type="submit" disabled={busy || !files.length}>{busy ? "Uploading…" : "Upload & segregate"}</button>
        </form>
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <h2>Tenders</h2>
        {tenders.length === 0 && <p className="muted">No tenders yet.</p>}
        <table className="table">
          <thead>
            <tr><th>Title</th><th>Files</th><th>Pages</th><th>Status</th><th>Model</th><th>Clauses</th><th></th></tr>
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
                <td>
                  <button className="link danger" onClick={() => api.remove(t._id).then(load)}>delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function StatusPill({ status, progress }) {
  return (
    <span className={`pill pill-${status}`} title={progress}>
      {status}
      {["parsing", "segregating"].includes(status) && progress ? ` · ${progress}` : ""}
    </span>
  );
}
