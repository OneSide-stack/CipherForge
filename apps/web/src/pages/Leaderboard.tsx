import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { LeaderRow } from '../lib/types';
import { Badge, Card, SectionTitle, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';

export function Leaderboard() {
  const { user } = useAuth();
  const [rows, setRows] = useState<LeaderRow[] | null>(null);

  useEffect(() => {
    api.get<{ leaderboard: LeaderRow[] }>('/api/leaderboard').then((r) => setRows(r.leaderboard)).catch(() => setRows([]));
  }, []);

  if (!rows) return <Spinner label="Ranking operators…" />;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <div className="eyebrow">the forge board</div>
        <h1 style={{ fontSize: 32 }}>Leaderboard</h1>
        <p className="muted tiny" style={{ marginTop: 6 }}>XP from verified objectives only — hints and walkthroughs reduce the reward before it is counted.</p>
      </div>
      <Card pad={false}>
        <table className="table">
          <thead><tr><th>#</th><th>Operator</th><th>Rank</th><th>Labs</th><th style={{ textAlign: 'right' }}>XP</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} style={r.userId === user?.id ? { background: 'rgba(255,122,69,.06)' } : undefined}>
                <td className="mono" style={{ width: 60 }}>{r.position === 1 ? '🥇' : r.position === 2 ? '🥈' : r.position === 3 ? '🥉' : r.position}</td>
                <td>
                  <span className="row gap-8">
                    {r.username}
                    {r.userId === user?.id && <Badge tone="ember">you</Badge>}
                  </span>
                </td>
                <td className="muted">{r.rank}</td>
                <td className="mono muted">{r.labsCompleted}</td>
                <td className="mono" style={{ textAlign: 'right', color: 'var(--ember-2)' }}>{r.xp}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="empty">No operators ranked yet.</td></tr>}
          </tbody>
        </table>
      </Card>
      <SectionTitle title="How XP is calculated" hint="server-side, per objective" />
      <div className="grid grid-3">
        {[
          ['Flag objectives', 'Base objective XP, minus revealed hint penalties. Flags are session-scoped HMAC comparisons.'],
          ['Live checks', 'Validators execute inside your session against the real service. Passing awards the objective XP.'],
          ['Lab completion', 'Finishing every objective adds the lab bonus. Walkthrough use halves objective XP in that lab.'],
        ].map(([t, b]) => <Card key={t}><h3 style={{ marginBottom: 6 }}>{t}</h3><p className="tiny muted">{b}</p></Card>)}
      </div>
    </div>
  );
}
