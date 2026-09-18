import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../auth.jsx";

/** Super-admin account management: create the team, reset passwords, deactivate. */
export default function Users() {
  const { user } = useAuth();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState(null);

  const load = () => api.users().then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const toggleActive = async (u) => {
    const verb = u.active ? "Deactivate" : "Reactivate";
    if (!window.confirm(`${verb} ${u.name}? Their notes and chat history are kept either way.`)) return;
    try {
      await api.updateUser(u.id, { active: !u.active });
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="page">
      <section className="card">
        <div className="head">
          <div>
            <h2>Users</h2>
            <p className="muted small">
              Regular users can read tenders, ask the chatbot, and keep their own notes. Super admins can additionally upload
              tenders, re-run extraction, generate the executive summary, and read everyone's notes and chat history.
            </p>
          </div>
          <div className="actions">
            <button onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add user"}</button>
          </div>
        </div>

        {adding && <UserForm onDone={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />}
        {error && <p className="error small">⚠ {error}</p>}
        {!users && !error && <p className="muted small">Loading…</p>}

        {users && (
          <div className="table-scroll">
            <table className="table small">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Role</th><th>Notes</th><th>Questions</th><th>Last sign-in</th><th></th></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.active ? "" : "inactive-row"}>
                    <td>
                      {u.name}
                      {String(u.id) === String(user?.id) && <span className="badge linked">you</span>}
                      {!u.active && <span className="badge">deactivated</span>}
                    </td>
                    <td className="mono">{u.email}</td>
                    <td>{u.role === "superadmin" ? <strong>super admin</strong> : "user"}</td>
                    <td className="mono">{u.noteCount}</td>
                    <td className="mono">{u.questionCount}</td>
                    <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "never"}</td>
                    <td>
                      <button className="link small" onClick={() => setResetting(resetting === u.id ? null : u.id)}>reset password</button>
                      <button className="link small danger" onClick={() => toggleActive(u)}>{u.active ? "deactivate" : "reactivate"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {resetting && (
          <PasswordReset
            userId={resetting}
            name={users?.find((u) => u.id === resetting)?.name}
            onDone={() => { setResetting(null); load(); }}
            onCancel={() => setResetting(null)}
          />
        )}
      </section>
    </div>
  );
}

function UserForm({ onDone, onCancel }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.createUser(form);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-form" onSubmit={submit}>
      <label><span>Name</span><input value={form.name} onChange={set("name")} required /></label>
      <label><span>Email</span><input type="email" value={form.email} onChange={set("email")} required /></label>
      <label>
        <span>Password (min 8 characters)</span>
        <input type="text" value={form.password} onChange={set("password")} required minLength={8} />
      </label>
      <label>
        <span>Role</span>
        <select value={form.role} onChange={set("role")}>
          <option value="user">User</option>
          <option value="superadmin">Super admin</option>
        </select>
      </label>
      {error && <p className="error small wide">⚠ {error}</p>}
      <div className="wide add-actions">
        <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
        <button type="button" className="link" onClick={onCancel}>cancel</button>
        <span className="muted small">Tell them this password directly — it is shown here once and stored only as a hash.</span>
      </div>
    </form>
  );
}

function PasswordReset({ userId, name, onDone, onCancel }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.updateUser(userId, { password });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="add-form" onSubmit={submit}>
      <label className="wide">
        <span>New password for {name} (min 8 characters)</span>
        <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />
      </label>
      {error && <p className="error small wide">⚠ {error}</p>}
      <div className="wide add-actions">
        <button type="submit" disabled={busy}>{busy ? "Saving…" : "Set password"}</button>
        <button type="button" className="link" onClick={onCancel}>cancel</button>
      </div>
    </form>
  );
}
