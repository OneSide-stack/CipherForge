import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Summary } from '../lib/types';
import { Badge, Card, Progress, Spinner, Stat } from '../components/ui';
import { relativeTime } from '../lib/format';

interface AchievementRow {
  slug: string; name: string; description: string; icon: string; tier: 'bronze' | 'silver' | 'gold'; xp: number; earned?: boolean; earnedAt?: string;
}

export function Achievements() {
  const [rows, setRows] = useState<AchievementRow[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    Promise.all([api.get<{ achievements: AchievementRow[] }>('/api/achievements'), api.get<Summary>('/api/me/summary')])
      .then(([a, s]) => {
        setRows(a.achievements);
        setSummary(s);
      })
      .catch(() => setRows([]));
  }, []);

  if (!rows) return <Spinner label="Loading achievements…" />;
  const earned = rows.filter((r) => r.earned);
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <div className="eyebrow">milestones</div>
        <h1 style={{ fontSize: 32 }}>Achievements</h1>
        <p className="muted tiny" style={{ marginTop: 6 }}>Awarded automatically when the server observes the underlying progress. Each badge grants bonus XP.</p>
      </div>
      <div className="grid grid-4">
        <Stat label="Unlocked" value={`${earned.length}/${rows.length}`} tone="ember" />
        <Stat label="Badge XP" value={earned.reduce((sum, r) => sum + r.xp, 0)} tone="teal" />
        <Stat label="Current rank" value={summary?.rank.name ?? '—'} sub={summary ? `${summary.xp} XP` : ''} />
        <Stat label="Longest streak" value={summary?.streak.longest ?? 0} sub="days" tone="blue" />
      </div>
      <div className="grid grid-3">
        {rows.map((a) => (
          <Card key={a.slug} style={{ opacity: a.earned ? 1 : 0.72, borderColor: a.earned ? 'rgba(255,122,69,.32)' : undefined }}>
            <div className="row gap-8">
              <Badge tone={a.tier}>{a.tier}</Badge>
              <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{a.earned ? relativeTime(a.earnedAt) : '+? XP'}</span>
            </div>
            <h3 style={{ marginTop: 12 }}>{a.name}</h3>
            <p className="tiny muted" style={{ marginTop: 6 }}>{a.description}</p>
            <div className="row tiny mono" style={{ marginTop: 12, color: a.earned ? 'var(--teal)' : 'var(--muted)' }}>
              {a.earned ? `✓ unlocked · +${a.xp} XP` : `locked · +${a.xp} XP`}
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <h3 style={{ marginBottom: 8 }}>Progress toward the next rank</h3>
        {summary && (
          <>
            <div className="row tiny gap-8"><span>{summary.rank.name}</span><span style={{ marginLeft: 'auto' }} className="muted">{summary.nextRank ? `${summary.nextRank.name} at ${summary.nextRank.minXp} XP` : 'max rank'}</span></div>
            <div style={{ marginTop: 8 }}><Progress value={summary.xp - summary.rank.minXp} total={Math.max(1, (summary.nextRank?.minXp ?? summary.xp) - summary.rank.minXp)} /></div>
          </>
        )}
      </Card>
    </div>
  );
}
