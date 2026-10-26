import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { Path } from '../lib/types';
import { Badge, Button, Card, Progress, SectionTitle, Spinner, useToast } from '../components/ui';
import { difficultyTone, percent } from '../lib/format';

export function Paths() {
  const [paths, setPaths] = useState<Path[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();

  const load = () => api.get<{ paths: Path[] }>('/api/paths').then((r) => setPaths(r.paths)).catch(() => setPaths([]));
  useEffect(() => { void load(); }, []);

  async function enroll(id: string) {
    setBusy(id);
    try {
      await api.post(`/api/paths/${id}/enroll`);
      toast.push({ title: 'Enrolled', body: 'Path added to your dashboard.', tone: 'ok' });
      await load();
    } catch (err) {
      toast.push({ title: 'Could not enroll', body: err instanceof Error ? err.message : 'Try again', tone: 'bad' });
    } finally {
      setBusy(null);
    }
  }

  if (!paths) return <Spinner label="Loading learning paths…" />;
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div>
        <div className="eyebrow">curriculum</div>
        <h1 style={{ fontSize: 32 }}>Learning paths</h1>
        <p className="muted tiny" style={{ marginTop: 6 }}>Ordered tracks that combine labs into a defensible skill narrative.</p>
      </div>
      <div className="grid grid-2">
        {paths.map((p) => (
          <Card key={p.id} className="card-hover">
            <div className="row gap-10" style={{ flexWrap: 'wrap' }}>
              <Badge tone={difficultyTone(p.level)}>{p.level}</Badge>
              <Badge>{p.estimatedHours}h</Badge>
              {p.enrolled && <Badge tone="teal">enrolled</Badge>}
              <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{p.progress.completed}/{p.progress.total} labs</span>
            </div>
            <h2 style={{ marginTop: 12, fontSize: 21 }}>{p.name}</h2>
            <p className="tiny muted" style={{ marginTop: 6 }}>{p.description}</p>
            <div style={{ marginTop: 14 }}><Progress value={p.progress.completed} total={Math.max(p.progress.total, 1)} tone="teal" /></div>
            <div className="stack" style={{ gap: 8, marginTop: 16 }}>
              {p.labs.length ? p.labs.map((lab) => (
                <Link key={lab.id} to={`/app/labs/${lab.id}`} className="row gap-10 tiny" style={{ padding: '7px 0', borderBottom: '1px dashed rgba(29,42,56,.7)' }}>
                  <span className="mono muted">{String(lab.position).padStart(2, '0')}</span>
                  <span className="grow truncate">{lab.title}</span>
                  {lab.completed ? <Badge tone="teal">done</Badge> : <Badge>{lab.difficulty}</Badge>}
                </Link>
              )) : <p className="tiny muted">No labs mapped to this path yet — entries are published as they become runnable.</p>}
            </div>
            <div className="row gap-8" style={{ marginTop: 16 }}>
              {!p.enrolled ? (
                <Button size="sm" variant="primary" onClick={() => void enroll(p.id)} disabled={busy === p.id}>{busy === p.id ? 'Enrolling…' : 'Enroll in path'}</Button>
              ) : (
                <Button size="sm" onClick={() => void enroll(p.id)} disabled>Enrolled · {percent(p.progress.completed, Math.max(p.progress.total, 1))}%</Button>
              )}
              <Link to="/app/labs" className="btn btn-ghost btn-sm">Browse labs</Link>
            </div>
          </Card>
        ))}
      </div>
      {!paths.length && <Card><SectionTitle title="No paths yet" /><p className="tiny muted">Run the seed script to create the default curriculum.</p></Card>}
    </div>
  );
}
