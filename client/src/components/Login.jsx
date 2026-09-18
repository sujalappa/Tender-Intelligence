import { useState } from "react";
import { useAuth } from "../auth.jsx";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <aside className="login-brand">
        <div className="login-brand-inner">
          <div className="login-logo">BI</div>
          <h1>Bhushilp <span>Tender Intelligence</span></h1>
          <p className="login-tagline">
            Clause-by-clause analysis of tender documents — commercial, financial, technical, legal and qualification
            terms, every one cited back to the page it came from.
          </p>
          <ul className="login-points">
            <li>Every clause traced to the source PDF page</li>
            <li>Conflicts flagged across NIT, GCC and SCC</li>
            <li>A one-page brief for the decision-maker</li>
          </ul>
        </div>
      </aside>

      <main className="login-form-side">
        <form className="login-form" onSubmit={submit}>
          <header>
            <h2>Sign in</h2>
            <p className="muted small">Use the account your administrator set up for you.</p>
          </header>

          <label>
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoFocus
              required
              autoComplete="username"
            />
          </label>

          <label>
            <span>Password</span>
            <div className="password-field">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                className="link small"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? "hide" : "show"}
              </button>
            </div>
          </label>

          {error && <p className="login-error">⚠ {error}</p>}

          <button type="submit" className="login-submit" disabled={busy || !email || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>

          <p className="muted small login-foot">
            Accounts are created by an administrator. If you've forgotten your password, please contact your administrator.
          </p>
        </form>
      </main>
    </div>
  );
}
