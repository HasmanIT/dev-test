import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "./lib/auth";
import { configError } from "./lib/supabase";
import { Layout, Spinner } from "./components/Layout";
import { Login } from "./pages/Login";
import { Home } from "./pages/Home";
import { PreviewTest, TakeTest } from "./pages/Runner";
import { Results } from "./pages/Results";
import { AdminTests } from "./pages/admin/AdminTests";
import { TestEditor } from "./pages/admin/TestEditor";
import { Attempts } from "./pages/admin/Attempts";
import { AttemptDetail } from "./pages/admin/AttemptDetail";
import { Users } from "./pages/admin/Users";

function RequireAdmin({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  if (!profile) return <Spinner />;
  return profile.role === "admin" ? <>{children}</> : <Navigate to="/" replace />;
}

function Gate() {
  const { loading, session, profile } = useAuth();
  if (loading) return <Spinner />;
  if (!session) return <Login />;
  if (!profile) return <Spinner label="Loading your profile…" />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="test/:testId" element={<TakeTest />} />
        <Route path="results/:attemptId" element={<Results />} />
        <Route path="admin" element={<RequireAdmin><AdminTests /></RequireAdmin>} />
        <Route path="admin/users" element={<RequireAdmin><Users /></RequireAdmin>} />
        <Route path="admin/tests/:testId" element={<RequireAdmin><TestEditor /></RequireAdmin>} />
        <Route path="admin/tests/:testId/preview" element={<RequireAdmin><PreviewTest /></RequireAdmin>} />
        <Route path="admin/tests/:testId/attempts" element={<RequireAdmin><Attempts /></RequireAdmin>} />
        <Route path="admin/attempts/:attemptId" element={<RequireAdmin><AttemptDetail /></RequireAdmin>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  if (configError) {
    return (
      <div className="auth-wrap">
        <div className="card auth-card">
          <h1>Setup needed</h1>
          <p>{configError}</p>
        </div>
      </div>
    );
  }
  return (
    <AuthProvider>
      <HashRouter>
        <Gate />
      </HashRouter>
    </AuthProvider>
  );
}
