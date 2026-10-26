import { type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider } from './components/ui';
import { Layout } from './components/Layout';
import { Landing } from './pages/Landing';
import { AuthPage } from './pages/Auth';
import { Dashboard } from './pages/Dashboard';
import { Labs } from './pages/Labs';
import { LabDetailPage } from './pages/LabDetail';
import { SessionPage } from './pages/SessionPage';
import { Paths } from './pages/Paths';
import { Leaderboard } from './pages/Leaderboard';
import { Achievements } from './pages/Achievements';
import { QaPage } from './pages/QA';
import { AdminPage } from './pages/Admin';
import { ProfilePage } from './pages/Profile';
import { NotFound } from './pages/NotFound';
import { Spinner } from './components/ui';

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}><Spinner label="Establishing session…" /></div>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return <Layout>{children}</Layout>;
}

function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/app" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/register" element={<AuthPage mode="register" />} />
          <Route path="/app" element={<Protected><Dashboard /></Protected>} />
          <Route path="/app/labs" element={<Protected><Labs /></Protected>} />
          <Route path="/app/labs/:labId" element={<Protected><LabDetailPage /></Protected>} />
          <Route path="/app/sessions/:sessionId" element={<Protected><SessionPage /></Protected>} />
          <Route path="/app/paths" element={<Protected><Paths /></Protected>} />
          <Route path="/app/leaderboard" element={<Protected><Leaderboard /></Protected>} />
          <Route path="/app/achievements" element={<Protected><Achievements /></Protected>} />
          <Route path="/app/qa" element={<Protected><QaPage /></Protected>} />
          <Route path="/app/profile" element={<Protected><ProfilePage /></Protected>} />
          <Route path="/app/admin" element={<Protected><AdminOnly><AdminPage /></AdminOnly></Protected>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ToastProvider>
    </AuthProvider>
  );
}
