import { Link, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function Layout() {
  const { profile, signOut } = useAuth();
  const isAdmin = profile?.role === "admin";
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span aria-hidden>🚩</span> Intern Tests
        </Link>
        <nav className="nav">
          <NavLink to="/" end>
            My tests
          </NavLink>
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
          {isAdmin && <NavLink to="/admin/users">People</NavLink>}
        </nav>
        <div className="who">
          <span title={profile?.email}>{profile?.display_name}</span>
          {isAdmin && <span className="pill pill-admin">admin</span>}
          <button className="btn btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="page">
        <Outlet />
      </main>
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert">
      {error}
    </div>
  );
}
