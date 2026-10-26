import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { HintResponse, LabDetail, SessionView, StartSessionResponse, WalkthroughResponse, WalkthroughState } from '../lib/types';
import { Badge, Banner, Button, Card, SectionTitle, Spinner, useToast } from '../components/ui';
import { difficultyTone, minutesLabel } from '../lib/format';

const ACTIVE = new Set(['queued', 'provisioning', 'starting', 'ready']);

export function LabDetailPage() {
  const { labId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [lab, setLab] = useState<LabDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [session, setSession] = useState<SessionView | null>(null);
  const [walkthrough, setWalkthrough] = useState<WalkthroughState | null>(null);
  const [steps, setSteps] = useState<Record<number, WalkthroughResponse['step']>>({});
  const [revealing, setRevealing] = useState<number | null>(null);
  const [openHint, setOpenHint] = useState<Record<string, boolean>>({});

  async function load() {
    try {
      const [detail, sessions, wt] = await Promise.all([
        api.get<{ lab: LabDetail }>(`/api/labs/${labId}`),
        api.get<{ sessions: SessionView[] }>('/api/sessions').catch(() => ({ sessions: [] })),
        api.get<WalkthroughState & { revealedSteps: (WalkthroughResponse['step'] & { index: number })[] }>(`/api/labs/${labId}/walkthrough`).catch(() => null),
      ]);
      setLab(detail.lab);
      setSession(sessions.sessions.find((s) => s.labId === labId && ACTIVE.has(s.state)) ?? null);
      if (wt) {
        setWalkthrough({ steps: wt.steps, revealed: wt.revealed, penalty: wt.penalty });
        const map: Record<number, WalkthroughResponse['step']> = {};
        for (const step of wt.revealedSteps ?? []) map[step.index] = step;
        setSteps(map);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load lab');
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labId]);

  async function launch() {
    setLaunching(true);
    try {
      const res = await api.post<StartSessionResponse>(`/api/labs/${labId}/sessions`);
      toast.push({ title: res.reused ? 'Resuming your session' : 'Lab is provisioning', body: res.reused ? 'Your environment is still running.' : 'You will get a shell as soon as health checks pass.', tone: 'ok' });
      navigate(`/app/sessions/${res.session.id}`);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not start lab';
      toast.push({ title: 'Launch failed', body: message, tone: 'bad' });
    } finally {
      setLaunching(false);
    }
  }

  async function revealHint(objectiveId: string, hintId: string) {
    try {
      const res = await api.post<HintResponse>(`/api/labs/${labId}/objectives/${objectiveId}/hints/${hintId}`, session ? { sessionId: session.id } : {});
      toast.push({ title: `Hint revealed · −${res.xpPenalty} XP on this objective`, body: 'Hints are progressive; reveal only what you need.', tone: 'ok' });
      await load();
    } catch (err) {
      toast.push({ title: 'Hint unavailable', body: err instanceof ApiError ? err.message : 'Try again', tone: 'bad' });
    }
  }

  async function revealStep(index: number) {
    setRevealing(index);
    try {
      const res = await api.post<WalkthroughResponse>(`/api/labs/${labId}/walkthrough/${index}`, session ? { sessionId: session.id } : {});
      setSteps((prev) => ({ ...prev, [index]: res.step }));
      setWalkthrough((prev) => prev ? { ...prev, revealed: [...new Set([...prev.revealed, index])].sort((a, b) => a - b) } : prev);
    } catch (err) {
      toast.push({ title: 'Cannot reveal step', body: err instanceof ApiError ? err.message : 'Reveal steps in order', tone: 'bad' });
    } finally {
      setRevealing(null);
    }
  }

  const objectives = useMemo(() => lab?.objectives ?? [], [lab]);
  if (error) return <Card><Banner tone="bad">{error}</Banner></Card>;
  if (!lab) return <Spinner label="Loading lab brief…" />;

  const nextStep = walkthrough ? walkthrough.revealed.length : 0;
  const canLaunch = lab.runnable;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <Card pad={false} className="detail-hero">
        <div className="row gap-10" style={{ flexWrap: 'wrap' }}>
          <Badge tone={difficultyTone(lab.difficulty)}>{lab.difficulty}</Badge>
          <Badge>{lab.category}</Badge>
          {lab.runnable ? <Badge tone="teal">interactive</Badge> : <Badge tone="amber">coming soon</Badge>}
          {lab.progress.status === 'completed' && <Badge tone="blue">completed</Badge>}
          <Link to="/app/labs" className="tiny mono muted" style={{ marginLeft: 'auto' }}>← catalog</Link>
        </div>
        <h1 style={{ marginTop: 14, fontSize: 36 }}>{lab.title}</h1>
        <p className="dim" style={{ marginTop: 8, maxWidth: 780 }}>{lab.subtitle}</p>
        <p className="muted tiny" style={{ marginTop: 10, maxWidth: 820 }}>{lab.summary}</p>
        <div className="meta-grid">
          <div className="meta"><div className="k">Estimated</div><div className="v">{minutesLabel(lab.estimatedMinutes)}</div></div>
          <div className="meta"><div className="k">Reward</div><div className="v">{lab.baseXp} XP + objectives</div></div>
          <div className="meta"><div className="k">Objectives</div><div className="v">{lab.progress.objectivesCompleted}/{lab.objectivesCount} done</div></div>
          <div className="meta"><div className="k">Session cap</div><div className="v">{lab.maxMinutes} min · {lab.resources.memoryMb} MB</div></div>
        </div>
        <div className="row gap-10" style={{ marginTop: 20, flexWrap: 'wrap' }}>
          {session ? (
            <Button variant="primary" size="lg" onClick={() => navigate(`/app/sessions/${session.id}`)}>
              Resume live session →
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={launch} disabled={!canLaunch || launching}>
              {launching ? 'Provisioning…' : canLaunch ? 'Start isolated lab' : 'Not available yet'}
            </Button>
          )}
          {session && <Badge tone="teal">session {session.id.slice(0, 8)} · {session.state}</Badge>}
          {!canLaunch && <span className="tiny muted">{lab.availabilityNote ?? 'This entry is catalogued but not runnable yet.'}</span>}
        </div>
        {!canLaunch && (
          <Banner tone="warn">
            This lab is published as a catalog entry only. There is no Docker-backed environment behind it, and the
            platform will not fake one. {lab.availabilityNote ?? ''}
          </Banner>
        )}
      </Card>

      <div className="split">
        <div className="stack" style={{ gap: 16 }}>
          <section>
            <SectionTitle title="Objectives" hint="complete them in any order" />
            {objectives.map((obj, idx) => (
              <div key={obj.id} className={`objective ${obj.completed ? 'done' : ''}`}>
                <div className="objective-head">
                  <div className="obj-num">{obj.completed ? '✓' : idx + 1}</div>
                  <div className="grow">
                    <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
                      <h3>{obj.title}</h3>
                      {obj.completed && <Badge tone="teal">verified</Badge>}
                      <Badge tone={obj.kind === 'flag' ? 'violet' : 'blue'}>{obj.kind === 'flag' ? 'flag' : 'live check'}</Badge>
                      <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{obj.xp} XP</span>
                    </div>
                    <p className="tiny dim" style={{ marginTop: 6 }}>{obj.description}</p>
                    {obj.evidencePrompt && !obj.completed && (
                      <p className="tiny muted" style={{ marginTop: 6, fontStyle: 'italic' }}>{obj.evidencePrompt}</p>
                    )}
                    {obj.kind === 'check' && obj.criteria && obj.criteria.length > 0 && (
                      <div className="chips" style={{ marginTop: 8 }}>
                        {obj.criteria.slice(0, 6).map((c) => <span key={c} className="chip">{c}</span>)}
                      </div>
                    )}

                    <div className="row gap-8" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                      <Button size="sm" variant="ghost" onClick={() => setOpenHint((p) => ({ ...p, [obj.id]: !p[obj.id] }))} disabled={obj.hintCount === 0}>
                        {obj.hintCount ? `${openHint[obj.id] ? 'Hide' : 'Hints'} (${obj.hints.filter((h) => h.revealed).length}/${obj.hintCount})` : 'No hints'}
                      </Button>
                      {session && obj.completed === false && (
                        <Link to={`/app/sessions/${session.id}`} className="btn btn-ghost btn-sm">Validate in workspace →</Link>
                      )}
                    </div>

                    {openHint[obj.id] && (
                      <div style={{ marginTop: 10 }}>
                        {obj.hints.filter((h) => h.revealed).map((h) => (
                          <div key={h.id} className="hint">{h.text}</div>
                        ))}
                        {obj.hints.find((h) => !h.revealed) && (() => {
                          const nextHint = obj.hints.find((h) => !h.revealed)!;
                          return (
                            <div className="row gap-8" style={{ marginTop: 8 }}>
                              <Button size="sm" onClick={() => void revealHint(obj.id, nextHint.id)}>Reveal next hint (−{nextHint.xpPenalty} XP)</Button>
                              <span className="tiny muted">Penalty applies to this objective's XP.</span>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </section>

          <section>
            <SectionTitle title="Walkthrough" hint="step-by-step · halves objective XP" />
            <Card>
              {walkthrough === null ? (
                <p className="tiny muted">Walkthrough data unavailable.</p>
              ) : (
                <>
                  <p className="tiny muted" style={{ marginBottom: 12 }}>
                    {walkthrough.steps} steps. Revealing walkthrough steps halves the XP for objectives you complete
                    afterwards — the penalty is applied server-side.
                  </p>
                  {walkthrough.revealed.map((idx) => {
                    const step = steps[idx];
                    return (
                      <div key={idx} className="step">
                        <div className="obj-num">{idx + 1}</div>
                        <div className="grow">
                          <h3 style={{ fontSize: 14.5 }}>{step?.title ?? `Step ${idx + 1}`}</h3>
                          {step?.body && <p className="tiny dim" style={{ marginTop: 4 }}>{step.body}</p>}
                          {step?.command && <pre className="hint mono" style={{ marginTop: 8, overflow: 'auto' }}>{step.command}</pre>}
                        </div>
                      </div>
                    );
                  })}
                  {nextStep < walkthrough.steps ? (
                    <div className="row gap-10" style={{ marginTop: 12 }}>
                      <Button size="sm" onClick={() => void revealStep(nextStep)} disabled={revealing === nextStep}>
                        {revealing === nextStep ? 'Revealing…' : `Reveal step ${nextStep + 1}`}
                      </Button>
                      <span className="tiny muted">Use this only when you are stuck.</span>
                    </div>
                  ) : (
                    <Banner tone="warn" style={{ marginTop: 10 }}>Walkthrough fully revealed. Objective XP is halved for this lab.</Banner>
                  )}
                </>
              )}
            </Card>
          </section>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <Card>
            <h3 style={{ marginBottom: 8 }}>Scenario</h3>
            <p className="tiny dim">{lab.scenario}</p>
          </Card>
          <Card>
            <h3 style={{ marginBottom: 8 }}>What you will practise</h3>
            <ul className="tiny dim" style={{ paddingLeft: 18, margin: 0 }}>
              {lab.learningObjectives.map((o) => <li key={o} style={{ marginBottom: 5 }}>{o}</li>)}
            </ul>
          </Card>
          <Card>
            <h3 style={{ marginBottom: 8 }}>Authorised scope</h3>
            <p className="tiny" style={{ color: 'var(--amber)' }}>{lab.authorizedScope}</p>
            <div className="kv" style={{ marginTop: 10 }}><span className="k">Workspace image</span><span className="v">{lab.workspace.image}</span></div>
            <div className="kv"><span className="k">Tools</span><span className="v">{lab.workspace.tools.join(', ')}</span></div>
            <div className="kv"><span className="k">Resources</span><span className="v">{lab.resources.cpus} vCPU · {lab.resources.memoryMb} MB</span></div>
          </Card>
          <Card>
            <h3 style={{ marginBottom: 8 }}>Prerequisites</h3>
            <div className="chips">{lab.prerequisites.map((p) => <span key={p} className="chip">{p}</span>)}</div>
          </Card>
          <Card>
            <h3 style={{ marginBottom: 8 }}>Risk & remediation</h3>
            <p className="tiny dim">{lab.riskSummary}</p>
            <p className="tiny muted" style={{ marginTop: 8 }}>{lab.remediation}</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
