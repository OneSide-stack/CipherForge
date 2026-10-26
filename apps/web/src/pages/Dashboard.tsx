import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import type { LabListResponse, Summary } from '../lib/types';
import { Badge, Card, Empty, Progress, SectionTitle, Spinner, Stat } from '../components/ui';
import { difficultyTone, minutesLabel, percent, relativeTime, stateLabel } from '../lib/format';
import { useAuth } from '../lib/auth';

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [labs, setLabs] = useState<LabListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get<Summary>('/api/me/summary'), api.get<LabListResponse>('/api/labs')])
      .then(([s, l]) => {
        setSummary(s);
        setLabs(l);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <Card><div className="banner bad">{error}</div></Card>;
  if (!summary || !labs) return <Spinner label="Loading your training state…" />;

  const nextRankXp = summary.nextRank?.minXp ?? summary.xp;
  const currentRankXp = summary.rank.minXp;
  const toNext = Math.max(0, nextRankXp - summary.xp);
  const rankSpan = Math.max(1, nextRankXp - currentRankXp);
  const rankProgress = Math.min(100, Math.round(((summary.xp - currentRankXp) / rankSpan) * 100));
  const recommendations = labs.labs.filter((l) => l.runnable && l.progress.status !== 'completed').slice(0, 3);
  const active = summary.activeSessions;

  return (
    <div className="stack" style={{ gap: 26 }}>
      <div className="hero" style={{ padding: '28px 30px' }}>
        <div className="row" style={{ gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="grow" style={{ minWidth: 280 }}>
            <div className="eyebrow">operator dashboard</div>
            <h1 style={{ fontSize: 34 }}>Welcome back, {user?.username}.</h1>
            <p className="dim" style={{ marginTop: 8, maxWidth: 560 }}>
              {active.length > 0
                ? `You have ${active.length} live lab session${active.length === 1 ? '' : 's'}. Jump back in before the timer runs out.`
                : 'No active sessions. Pick a lab and the worker will build you a fresh isolated target in seconds.'}
            </p>
          </div>
          <div style={{ minWidth: 240 }}>
            <div className="row gap-8 tiny mono muted">
              <span>{summary.rank.name}</span>
              <span style={{ marginLeft: 'auto' }}>{summary.nextRank ? `${toNext} XP → ${summary.nextRank.name}` : 'max rank'}</span>
            </div>
            <div className="progress" style={{ marginTop: 7 }}><span style={{ width: `${rankProgress}%` }} /></div>
            <div className="row gap-8 tiny mono muted" style={{ marginTop: 10 }}>
              <span>streak</span>
              <span className="row gap-6" style={{ marginLeft: 'auto', color: 'var(--amber)' }}>🔥 {summary.streak.current} days</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-4">
        <Stat label="Total XP" value={summary.xp} sub={`${summary.rank.name} · ${summary.nextRank ? summary.nextRank.name : 'top rank'}`} tone="ember" />
        <Stat label="Labs completed" value={summary.stats.labs} sub={`${summary.stats.objectives} objectives verified`} tone="teal" />
        <Stat label="Verified flags" value={summary.stats.flags} sub={`${summary.stats.hints} hints · ${summary.stats.walkthroughs} walkthrough steps`} tone="blue" />
        <Stat label="Categories" value={summary.stats.categories} sub={`${summary.streak.longest} day best streak`} />
      </div>

      {active.length > 0 && (
        <section>
          <SectionTitle title="Active sessions" hint="live environments expire automatically" />
          <div className="grid grid-2">
            {active.map((s) => (
              <Card key={s.id} className="card-hover" pad>
                <div className="row gap-10">
                  <span className="dot live" />
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{s.labTitle}</div>
                    <div className="tiny muted mono">{stateLabel(s.state)} · {s.id.slice(0, 8)}</div>
                  </div>
                  <Badge tone="amber">{Math.max(0, Math.floor(s.remainingSeconds / 60))} min left</Badge>
                </div>
                <div className="row gap-8" style={{ marginTop: 14 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => navigate(`/app/sessions/${s.id}`)}>Resume workspace</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/app/labs/${s.labId}`)}>Lab brief</button>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle title="Recommended next" hint="ordered by your progress" action={<Link className="btn btn-sm" to="/app/labs">All labs →</Link>} />
        <div className="grid grid-3">
          {recommendations.map((lab) => (
            <Link key={lab.id} to={`/app/labs/${lab.id}`} className="card card-pad card-hover labcard">
              <div className="labcard-top">
                <Badge tone={difficultyTone(lab.difficulty)}>{lab.difficulty}</Badge>
                <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{lab.baseXp} XP</span>
              </div>
              <div>
                <h3>{lab.title}</h3>
                <div className="sub">{lab.category} · {minutesLabel(lab.estimatedMinutes)}</div>
              </div>
              <p className="summary">{lab.summary}</p>
              <div className="labcard-foot">
                <span>{lab.objectivesCount} objectives</span>
                {lab.progress.status === 'in_progress' && <Badge tone="amber" className="nowrap">{percent(lab.progress.objectivesCompleted, lab.objectivesCount)}%</Badge>}
              </div>
            </Link>
          ))}
          {!recommendations.length && <Card><Empty title="Every interactive lab is complete" body="New labs are being forged. Check the catalog for upcoming titles." action={<Link className="btn btn-sm" to="/app/labs">Open catalog</Link>} /></Card>}
        </div>
      </section>

      <div className="split">
        <section>
          <SectionTitle title="Recent verified work" hint="objective completions" />
          <Card pad={false}>
            {summary.recent.length ? (
              <table className="table">
                <thead><tr><th>Objective</th><th>Lab</th><th>XP</th><th>When</th></tr></thead>
                <tbody>
                  {summary.recent.map((r, i) => (
                    <tr key={`${r.labId}-${i}`}>
                      <td className="mono">{r.title ?? r.labId}</td>
                      <td className="muted">{r.labId}</td>
                      <td className="mono" style={{ color: 'var(--green)' }}>+{r.xp}</td>
                      <td className="muted tiny">{relativeTime(r.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty title="No verified objectives yet" body="Launch your first lab and complete an objective to start your record." action={<Link className="btn btn-primary btn-sm" to="/app/labs">Start training</Link>} />
            )}
          </Card>
        </section>

        <div className="stack" style={{ gap: 16 }}>
          <Card>
            <div className="row gap-8" style={{ marginBottom: 10 }}>
              <h3>Learning paths</h3>
              <Link to="/app/paths" className="tiny mono muted" style={{ marginLeft: 'auto' }}>view all →</Link>
            </div>
            <div className="stack" style={{ gap: 12 }}>
              {summary.paths.slice(0, 4).map((p) => (
                <div key={p.id}>
                  <div className="row tiny gap-8">
                    <span>{p.name}</span>
                    <span className="muted mono" style={{ marginLeft: 'auto' }}>{p.completed}/{p.total}</span>
                  </div>
                  <div style={{ marginTop: 5 }}><Progress value={p.completed} total={Math.max(p.total, 1)} /></div>
                </div>
              ))}
              {!summary.paths.length && <p className="tiny muted">No paths enrolled yet.</p>}
            </div>
          </Card>
          <Card>
            <div className="row gap-8" style={{ marginBottom: 10 }}>
              <h3>Achievements</h3>
              <Link to="/app/achievements" className="tiny mono muted" style={{ marginLeft: 'auto' }}>all →</Link>
            </div>
            {summary.achievements.length ? (
              <div className="stack" style={{ gap: 8 }}>
                {summary.achievements.slice(0, 4).map((a) => (
                  <div key={a.slug} className="row gap-10 tiny">
                    <Badge tone={a.tier}>{a.tier}</Badge>
                    <span>{a.name}</span>
                    <span className="muted mono" style={{ marginLeft: 'auto' }}>{relativeTime(a.earnedAt)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="tiny muted">Complete objectives to unlock your first badge.</p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
