import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { LabListResponse, LabSummary } from '../lib/types';
import { Badge, Card, Empty, SectionTitle, Spinner } from '../components/ui';
import { difficultyTone, minutesLabel, percent } from '../lib/format';

type StatusFilter = '' | 'runnable' | 'in_progress' | 'completed' | 'coming_soon';

export function Labs() {
  const [data, setData] = useState<LabListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const qs = new URLSearchParams();
      if (search.trim()) qs.set('search', search.trim());
      if (category) qs.set('category', category);
      if (difficulty) qs.set('difficulty', difficulty);
      if (status) qs.set('status', status);
      api
        .get<LabListResponse>(`/api/labs${qs.toString() ? `?${qs}` : ''}`)
        .then(setData)
        .catch((err: Error) => {
          if (!controller.signal.aborted) setError(err.message);
        });
    }, search ? 220 : 0);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [search, category, difficulty, status]);

  const labs = data?.labs ?? [];
  const grouped = useMemo(() => {
    const runnable = labs.filter((l) => l.runnable);
    const soon = labs.filter((l) => !l.runnable);
    return { runnable, soon };
  }, [labs]);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row" style={{ alignItems: 'end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div className="eyebrow">lab catalog</div>
          <h1 style={{ fontSize: 32 }}>Pick a target.</h1>
          <p className="muted tiny" style={{ marginTop: 6 }}>
            Interactive labs spin up a private environment with a live service and a real shell. Unavailable titles are
            clearly marked — nothing pretends to run.
          </p>
        </div>
        <div className="row gap-8" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
          <Badge tone="teal">{data?.counts.runnable ?? 0} interactive</Badge>
          <Badge tone="amber">{data?.counts.comingSoon ?? 0} coming soon</Badge>
          <Badge tone="blue">{data?.counts.completed ?? 0} completed</Badge>
        </div>
      </div>

      {error && <div className="banner bad">{error}</div>}

      <Card pad>
        <div className="row gap-10" style={{ flexWrap: 'wrap' }}>
          <input className="input" style={{ maxWidth: 300 }} placeholder="Search title, skill or scenario…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="select" style={{ width: 190 }} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {data?.filters.categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="select" style={{ width: 160 }} value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            <option value="">Any difficulty</option>
            {data?.filters.difficulties.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select className="select" style={{ width: 170 }} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
            <option value="">Any status</option>
            <option value="runnable">Interactive</option>
            <option value="in_progress">In progress</option>
            <option value="completed">Completed</option>
            <option value="coming_soon">Coming soon</option>
          </select>
          <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{labs.length} result{labs.length === 1 ? '' : 's'}</span>
        </div>
      </Card>

      {!data ? (
        <Spinner />
      ) : labs.length === 0 ? (
        <Card><Empty title="No labs match those filters" body="Try clearing the search or choosing another category." /></Card>
      ) : (
        <>
          <section>
            <SectionTitle title="Interactive labs" hint="real environment · validated objectives" />
            <div className="grid grid-2">
              {grouped.runnable.map((lab) => <LabCard key={lab.id} lab={lab} />)}
              {!grouped.runnable.length && <Card><Empty title="No interactive labs in this filter" /></Card>}
            </div>
          </section>
          {grouped.soon.length > 0 && (
            <section>
              <SectionTitle title="In the forge" hint="catalog entries that are not runnable yet" />
              <div className="grid grid-2">
                {grouped.soon.map((lab) => <LabCard key={lab.id} lab={lab} />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function LabCard({ lab }: { lab: LabSummary }) {
  const done = lab.progress.status === 'completed';
  return (
    <Link to={`/app/labs/${lab.id}`} className="card card-pad card-hover labcard" style={{ opacity: lab.runnable ? 1 : 0.78 }}>
      <div className="labcard-top">
        <Badge tone={difficultyTone(lab.difficulty)}>{lab.difficulty}</Badge>
        {lab.runnable ? <Badge tone="teal">interactive</Badge> : <Badge tone="amber">coming soon</Badge>}
        {done && <Badge tone="blue">completed</Badge>}
        <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{lab.baseXp} XP</span>
      </div>
      <div>
        <h3>{lab.title}</h3>
        <div className="sub">{lab.category} · {minutesLabel(lab.estimatedMinutes)} · {lab.objectivesCount} objectives</div>
      </div>
      <p className="summary">{lab.summary}</p>
      <div className="chips">{lab.skills.slice(0, 3).map((s) => <span key={s} className="chip">{s}</span>)}</div>
      <div className="labcard-foot">
        {lab.progress.status === 'in_progress' ? (
          <>
            <span className="mono">{lab.progress.objectivesCompleted}/{lab.objectivesCount} objectives</span>
            <span style={{ marginLeft: 'auto' }}>{percent(lab.progress.objectivesCompleted, lab.objectivesCount)}%</span>
          </>
        ) : (
          <span>{lab.availabilityNote ?? (lab.runnable ? 'Ready to launch' : 'Not runnable yet')}</span>
        )}
      </div>
    </Link>
  );
}
