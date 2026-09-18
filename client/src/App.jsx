import { Routes, Route, Link, Navigate } from "react-router-dom";
import TenderList from "./components/TenderList.jsx";
import TenderDetail from "./components/TenderDetail.jsx";
import QuestionBank from "./components/QuestionBank.jsx";
import Users from "./components/Users.jsx";
import Activity from "./components/Activity.jsx";
import Login from "./components/Login.jsx";
import { AuthProvider, useAuth } from "./auth.jsx";

function AdminOnly({ children }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <Navigate to="/" replace />;
}

function Shell() {
  const { user, loading, logout, isAdmin } = useAuth();

  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!user) return <Login />;

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">Bhushilp <span>Tender Intelligence</span></Link>
        <nav className="topnav">
          <Link to="/questions">What we keep asking</Link>
          {isAdmin && <Link to="/activity">Team activity</Link>}
          {isAdmin && <Link to="/users">Users</Link>}
          <span className="who-am-i" title={user.email}>
            {user.name}{isAdmin && <span className="badge linked">admin</span>}
          </span>
          <button className="link logout" onClick={logout}>sign out</button>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<TenderList />} />
          <Route path="/tenders/:id" element={<TenderDetail />} />
          <Route
            path="/questions"
            element={
              <div className="page">
                <section className="card">
                  <h2>What we keep asking</h2>
                  <QuestionBank />
                </section>
              </div>
            }
          />
          <Route path="/users" element={<AdminOnly><Users /></AdminOnly>} />
          <Route path="/activity" element={<AdminOnly><Activity /></AdminOnly>} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
