import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { Summary } from '../lib/types';
import { Badge, Banner, Button, Card, SectionTitle, Spinner, Stat, useToast } from '../components/ui';
import { relativeTime, stateTone } from '../lib/format';
import { useAuth } from '../lib/auth';

export function ProfilePage() {
  const { user, logout } = useAuth();
  const toast = useToast();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Summary>('/api/me/summary').then(setSummary).catch(() => setSummary(null));
  }, []);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/me/password', { currentPassword, newPassword });
      setCurrent('');
      setNew('');
      toast.push({ title: 'Password updated', body: 'Other sessions were revoked. This browser stays signed in.', tone: 'ok' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update password');
    } finally {
      setBusy(false);
    }
  }

  if (!summary) return <Spinner label="Loading profile…" />;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <div className="eyebrow">operator record</div>
        <h1 style={{ fontSize: 32 }}>{user?.username}</h1>
        <p className="muted tiny" style={{ marginTop: 6 }}>{user?.email} · {user?.role}</p>
      </div>

      <div className="grid grid-4">
        <Stat label="Rank" value={summary.rank.name} sub={`${summary.xp} XP`} tone="ember" />
        <Stat label="Labs completed" value={summary.stats.labs} tone="teal" />
        <Stat label="Objectives" value={summary.stats.objectives} tone="blue" />
        <Stat label="Streak" value={summary.streak.current} sub={`best ${summary.streak.longest} days`} />
      </div>

      <div className="split">
        <div className="stack" style={{ gap: 16 }}>
          <Card pad={false}>
            <div className="panel-head"><h3>Session history</h3></div>
            <table className="table">
              <thead><tr><th>Lab</th><th>State</th><th>Started</th><th>Expires</th><th /></tr></thead>
              <tbody>
                {summary.activeSessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.labTitle}</td>
                    <td><Badge tone={stateTone(s.state)}>{s.state}</Badge></td>
                    <td className="tiny muted">{relativeTime(s.createdAt)}</td>
                    <td className="tiny muted">{s.expiresAt ? new Date(s.expiresAt).toLocaleTimeString() : '—'}</td>
                    <td style={{ textAlign: 'right' }}><Link className="btn btn-ghost btn-sm" to={`/app/sessions/${s.id}`}>Open</Link></td>
                  </tr>
                ))}
                {!summary.activeSessions.length && <tr><td colSpan={5} className="empty">No active sessions.</td></tr>}
              </tbody>
            </table>
          </Card>

          <Card>
            <h3 style={{ marginBottom: 10 }}>Recent milestones</h3>
            {summary.recent.length ? summary.recent.map((r, i) => (
              <div key={i} className="kv">
                <span className="k">{r.title}</span>
                <span className="v" style={{ color: 'var(--green)' }}>+{r.xp} XP</span>
                <span className="tiny muted mono">{relativeTime(r.at)}</span>
              </div>
            )) : <p className="tiny muted">No verified objectives yet.</p>}
          </Card>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <Card>
            <h3 style={{ marginBottom: 8 }}>Security</h3>
            <p className="tiny muted" style={{ marginBottom: 12 }}>Changing your password revokes all other sessions immediately.</p>
            {error && <Banner tone="bad">{error}</Banner>}
            <form onSubmit={changePassword} className="stack" style={{ gap: 12 }}>
              <label className="field">
                <span className="label">Current password</span>
                <input className="input" type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrent(e.target.value)} />
              </label>
              <label className="field">
                <span className="label">New password</span>
                <input className="input" type="password" autoComplete="new-password" required minLength={10} value={newPassword} onChange={(e) => setNew(e.target.value)} />
              </label>
              <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</Button>
            </form>
          </Card>
          <Card>
            <h3 style={{ marginBottom: 8 }}>Account</h3>
            <div className="kv"><span className="k">Role</span><span className="v">{user?.role}</span></div>
            <div className="kv"><span className="k">Rank</span><span className="v">{summary.rank.name}</span></div>
            <div className="kv"><span className="k">Streak</span><span className="v">{summary.streak.current} days</span></div>
            <div style={{ marginTop: 14 }}>
              <Button variant="danger" size="sm" onClick={() => void logout()}>Sign out of this browser</Button>
            </div>
          </Card>
        </div>
      </div>

      <SectionTitle title="Paths you are enrolled in" hint="progress across the curriculum" />
      <div className="grid grid-3">
        {summary.paths.map((p) => (
          <Card key={p.id}>
            <div className="row gap-8"><h3 style={{ fontSize: 15 }}>{p.name}</h3><span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{p.completed}/{p.total}</span></div>
            <div className="progress" style={{ marginTop: 10 }}><span style={{ width: `${p.total ? Math.round((p.completed / p.total) * 100) : 0}%` }} /></div>
          </Card>
        ))}
        {!summary.paths.length && <Card><p className="tiny muted">Not enrolled in any path yet. <Link to="/app/paths" style={{ color: 'var(--ember-2)' }}>Browse paths →</Link></p></Card>}
      </div>
    </div>
  );
}
