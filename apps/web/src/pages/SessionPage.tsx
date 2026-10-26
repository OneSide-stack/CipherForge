import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { CompletionResult, LabDetail, SessionView } from '../lib/types';
import { Badge, Banner, Button, Card, Empty, Modal, Spinner, useToast } from '../components/ui';
import { TerminalPane } from '../components/TerminalPane';
import { cx, stateLabel, stateTone, timeLeft } from '../lib/format';

const FLOW = ['queued', 'provisioning', 'starting', 'ready', 'stopping', 'stopped'] as const;
type Tab = 'target' | 'terminal' | 'logs' | 'details';

export function SessionPage() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [session, setSession] = useState<SessionView | null>(null);
  const [lab, setLab] = useState<LabDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('terminal');
  const [targetName, setTargetName] = useState<string | null>(null);
  const [logs, setLogs] = useState('');
  const [flagInputs, setFlagInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<CompletionResult | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [hintOpen, setHintOpen] = useState<Record<string, boolean>>({});
  const [now, setNow] = useState(Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ session: SessionView }>(`/api/sessions/${sessionId}`);
      setSession(data.session);
      if (!lab) {
        const detail = await api.get<{ lab: LabDetail }>(`/api/labs/${data.session.labId}`);
        setLab(detail.lab);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load session');
    }
  }, [sessionId, lab]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Poll while the session is in a transitional state (the SSE stream carries the rest).
  useEffect(() => {
    const transitional = session && ['queued', 'provisioning', 'starting', 'stopping'].includes(session.state);
    if (!transitional) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    if (!pollRef.current) pollRef.current = setInterval(() => void load(), 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [session, load]);

  useEffect(() => {
    if (!sessionId) return;
    const source = new EventSource(`/api/sessions/${sessionId}/stream`);
    source.addEventListener('session', (event) => {
      try {
        const view = JSON.parse((event as MessageEvent).data) as SessionView;
        setSession(view);
      } catch {
        /* ignore */
      }
    });
    source.onerror = () => {
      /* EventSource reconnects automatically */
    };
    return () => source.close();
  }, [sessionId]);

  useEffect(() => {
    if (tab !== 'logs' || !session) return;
    let active = true;
    const fetchLogs = () =>
      api
        .get<{ logs: string }>(`/api/sessions/${sessionId}/logs`)
        .then((r) => {
          if (active) setLogs(r.logs || '(no logs yet)');
        })
        .catch(() => {
          if (active) setLogs('(logs unavailable)');
        });
    void fetchLogs();
    const timer = setInterval(fetchLogs, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [tab, sessionId, session]);

  const remaining = useMemo(() => {
    if (!session?.expiresAt) return 0;
    return Math.max(0, Math.floor((new Date(session.expiresAt).getTime() - now) / 1000));
  }, [session, now]);

  if (error) return <Card><Banner tone="bad">{error}</Banner><div style={{ marginTop: 12 }}><Link className="btn" to="/app/labs">Back to catalog</Link></div></Card>;
  if (!session || !lab) return <Spinner label="Attaching to your environment…" />;

  const ready = session.state === 'ready';
  const terminalReady = ready;
  const activeTarget = targetName ?? session.targets[0]?.name ?? null;
  const objectiveStates = new Map(session.objectives.map((o) => [o.id, o.completed]));
  const completed = session.objectives.filter((o) => o.completed).length;

  async function submitFlag(objectiveId: string) {
    const flag = (flagInputs[objectiveId] ?? '').trim();
    if (!flag) return;
    setBusy(objectiveId);
    try {
      const res = await api.post<CompletionResult>(`/api/sessions/${sessionId}/objectives/${objectiveId}/submit`, { flag });
      setResult(res);
      setFlagInputs((p) => ({ ...p, [objectiveId]: '' }));
      if (res.passed) toast.push({ title: `Objective verified · +${res.xpAwarded} XP`, body: res.labCompleted ? `Lab complete · +${res.labBonus} XP bonus` : res.message, tone: 'ok' });
      void load();
    } catch (err) {
      toast.push({ title: 'Flag rejected', body: err instanceof ApiError ? err.message : 'Try again', tone: 'bad' });
    } finally {
      setBusy(null);
    }
  }

  async function runCheck(objectiveId: string) {
    setBusy(objectiveId);
    try {
      const res = await api.post<CompletionResult>(`/api/sessions/${sessionId}/objectives/${objectiveId}/check`, {});
      setResult(res);
      if (res.passed) toast.push({ title: `Check passed · +${res.xpAwarded} XP`, body: res.message, tone: 'ok' });
      else toast.push({ title: 'Check did not pass yet', body: res.message, tone: 'bad' });
      void load();
    } catch (err) {
      toast.push({ title: 'Check failed', body: err instanceof ApiError ? err.message : 'Try again', tone: 'bad' });
    } finally {
      setBusy(null);
    }
  }

  async function revealHint(objectiveId: string, hintId: string) {
    try {
      await api.post(`/api/labs/${lab!.id}/objectives/${objectiveId}/hints/${hintId}`, { sessionId });
      void load();
    } catch (err) {
      toast.push({ title: 'Hint unavailable', body: err instanceof ApiError ? err.message : 'Try again', tone: 'bad' });
    }
  }

  async function control(action: 'stop' | 'reset' | 'extend') {
    setBusy(action);
    try {
      if (action === 'stop') {
        const res = await api.post<{ session: SessionView }>(`/api/sessions/${sessionId}/stop`);
        setSession(res.session);
        toast.push({ title: 'Session stopped', body: 'The isolated environment was destroyed.', tone: 'ok' });
      } else if (action === 'reset') {
        const res = await api.post<{ session: SessionView; reused: boolean }>(`/api/sessions/${sessionId}/reset`);
        toast.push({ title: 'Rebuilding environment', body: 'A fresh session with new flag material is provisioning.', tone: 'ok' });
        navigate(`/app/sessions/${res.session.id}`, { replace: true });
      } else {
        const res = await api.post<{ session: SessionView }>(`/api/sessions/${sessionId}/extend`, { minutes: 10 });
        setSession(res.session);
        toast.push({ title: 'Session extended by 10 minutes', tone: 'ok' });
      }
    } catch (err) {
      toast.push({ title: 'Action failed', body: err instanceof ApiError ? err.message : 'Try again', tone: 'bad' });
    } finally {
      setBusy(null);
      setConfirmReset(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Card pad>
        <div className="session-head">
          <div className="grow" style={{ minWidth: 240 }}>
            <div className="row gap-8 tiny mono muted">
              <Link to={`/app/labs/${lab.id}`}>← {lab.title}</Link>
              <span>·</span>
              <span>{session.id.slice(0, 8)}</span>
              {session.mode && <Badge tone="blue">{session.mode}</Badge>}
            </div>
            <h2 style={{ marginTop: 4 }}>Lab workspace</h2>
          </div>
          <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
            <Badge tone={stateTone(session.state)}>
              <span className={cx('dot', ready ? 'ok live' : session.state === 'failed' ? 'bad' : 'warn')} style={{ marginRight: 4 }} />
              {stateLabel(session.state)}
            </Badge>
            {ready && <Badge tone="amber">expires in {timeLeft(remaining)}</Badge>}
            <Button size="sm" onClick={() => void control('extend')} disabled={!ready || busy === 'extend'}>+10 min</Button>
            <Button size="sm" onClick={() => setConfirmReset(true)} disabled={!ready && session.state !== 'failed'}>Reset</Button>
            <Button size="sm" variant="danger" onClick={() => void control('stop')} disabled={!ready && !['starting', 'provisioning', 'queued'].includes(session.state)}>Stop</Button>
          </div>
        </div>
        <div className="row gap-10" style={{ marginTop: 14, flexWrap: 'wrap' }}>
          <div className="status-flow">
            {FLOW.map((step, i) => {
              const idx = FLOW.indexOf(session.state as (typeof FLOW)[number]);
              const done = idx >= 0 && i < idx;
              const active = step === session.state;
              return (
                <span key={step} className="row" style={{ gap: 4 }}>
                  {i > 0 && <span className="flow-arrow">→</span>}
                  <span className={cx('flow-step', done && 'done', active && 'active')}>{step}</span>
                </span>
              );
            })}
            {session.state === 'failed' && <span className="flow-step failed">failed</span>}
            {session.state === 'expired' && <span className="flow-step failed">expired</span>}
          </div>
          <div className="row gap-8 tiny mono muted" style={{ marginLeft: 'auto' }}>
            <span>{completed}/{session.objectives.length} objectives</span>
            <span>·</span>
            <span>{session.hintsUsed} hints</span>
            {session.walkthroughUsed && <><span>·</span><span>walkthrough</span></>}
          </div>
        </div>
        {session.state === 'starting' || session.state === 'provisioning' || session.state === 'queued' ? (
          <Banner tone="warn" style={{ marginTop: 12 }}>
            Building your private environment… The status only becomes <b>ready</b> after the target answers real health
            checks. This usually takes a few seconds.
          </Banner>
        ) : null}
        {session.failure && (
          <Banner tone="bad" style={{ marginTop: 12 }}>
            <div>
              <b>Session failed:</b> {session.failure.message}
              {session.failure.code && <span className="mono tiny muted"> ({session.failure.code})</span>}
            </div>
          </Banner>
        )}
      </Card>

      <div className="workspace">
        <Card pad={false}>
          <div className="panel-head">
            <h3>Objectives</h3>
            <Badge tone="teal" className="nowrap">{completed}/{session.objectives.length}</Badge>
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => void load()}>↻</button>
          </div>
          <div className="panel-body" style={{ maxHeight: '68vh', overflow: 'auto' }}>
            {lab.objectives.map((obj, i) => {
              const isDone = objectiveStates.get(obj.id) ?? false;
              return (
                <div key={obj.id} className={cx('objective', isDone && 'done')} style={{ marginBottom: 10 }}>
                  <div className="objective-head">
                    <div className="obj-num">{isDone ? '✓' : i + 1}</div>
                    <div className="grow">
                      <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
                        <h3 style={{ fontSize: 14.5 }}>{obj.title}</h3>
                        <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{obj.xp} XP</span>
                      </div>
                      <p className="tiny muted" style={{ marginTop: 4 }}>{obj.description}</p>
                      {!isDone && obj.kind === 'flag' && (
                        <div className="row gap-6" style={{ marginTop: 9 }}>
                          <input
                            className="input"
                            style={{ padding: '7px 10px', fontSize: 12.5, fontFamily: 'var(--mono)' }}
                            placeholder="CF{…}"
                            value={flagInputs[obj.id] ?? ''}
                            onChange={(e) => setFlagInputs((p) => ({ ...p, [obj.id]: e.target.value }))}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void submitFlag(obj.id);
                            }}
                          />
                          <Button size="sm" variant="primary" onClick={() => void submitFlag(obj.id)} disabled={busy === obj.id}>
                            {busy === obj.id ? '…' : 'Submit'}
                          </Button>
                        </div>
                      )}
                      {!isDone && obj.kind === 'check' && (
                        <Button size="sm" variant="primary" style={{ marginTop: 9 }} onClick={() => void runCheck(obj.id)} disabled={busy === obj.id || !ready}>
                          {busy === obj.id ? 'Running live check…' : 'Run live check'}
                        </Button>
                      )}
                      {isDone && <Badge tone="teal" style={{ marginTop: 8 }}>verified</Badge>}
                      {!isDone && obj.hintCount > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => setHintOpen((p) => ({ ...p, [obj.id]: !p[obj.id] }))}>
                            {hintOpen[obj.id] ? 'Hide hints' : `Hints (${obj.hints.filter((h) => h.revealed).length}/${obj.hintCount})`}
                          </button>
                          {hintOpen[obj.id] && (
                            <div style={{ marginTop: 6 }}>
                              {obj.hints.filter((h) => h.revealed).map((h) => <div key={h.id} className="hint">{h.text}</div>)}
                              {(() => {
                                const next = obj.hints.find((h) => !h.revealed);
                                if (!next) return null;
                                return (
                                  <div className="row gap-6" style={{ marginTop: 6 }}>
                                    <Button size="sm" onClick={() => void revealHint(obj.id, next.id)}>Reveal hint (−{next.xpPenalty} XP)</Button>
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {result && (
              <Banner tone={result.passed ? 'ok' : 'bad'} >
                <div>
                  <b>{result.passed ? 'Objective verified' : 'Not yet'}</b> — {result.message}
                  {result.passed && (
                    <div className="tiny mono" style={{ marginTop: 4 }}>
                      +{result.xpAwarded} XP{result.labBonus ? ` · lab bonus +${result.labBonus} XP` : ''} · total {result.totalXp} XP · {result.rank.name}
                      {result.achievements.length > 0 && ` · unlocked: ${result.achievements.map((a) => a.name).join(', ')}`}
                    </div>
                  )}
                </div>
              </Banner>
            )}
          </div>
        </Card>

        <Card pad={false}>
          <div className="panel-head">
            <div className="tabs">
              {(['terminal', 'target', 'logs', 'details'] as Tab[]).map((t) => (
                <button key={t} className={cx('tab', tab === t && 'active')} onClick={() => setTab(t)}>
                  {t === 'target' ? 'Target service' : t === 'terminal' ? 'Terminal' : t === 'logs' ? 'Logs' : 'Session details'}
                </button>
              ))}
            </div>
            {tab === 'target' && session.targets.length > 0 && (
              <div className="row gap-6" style={{ marginLeft: 'auto', flexWrap: 'wrap' }}>
                {session.targets.map((t) => (
                  <button
                    key={t.name}
                    className={cx('tab', activeTarget === t.name && 'active')}
                    onClick={() => setTargetName(t.name)}
                  >
                    {t.name}:{t.port}
                  </button>
                ))}
              </div>
            )}
            {tab === 'target' && activeTarget && ready && (
              <a className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} href={`/api/sessions/${session.id}/target/${activeTarget}/`} target="_blank" rel="noreferrer">Open ↗</a>
            )}
          </div>

          <div className="stage">
            {tab === 'terminal' && (
              <TerminalPane sessionId={session.id} enabled={terminalReady} />
            )}
            {tab === 'target' && (
              ready && activeTarget ? (
                <iframe
                  title={`Lab target ${activeTarget}`}
                  src={`/api/sessions/${session.id}/target/${activeTarget}/`}
                  sandbox="allow-same-origin allow-forms allow-scripts allow-popups"
                />
              ) : (
                <Empty title="Target not ready" body="The service is reachable only after the session passes health checks." />
              )
            )}
            {tab === 'logs' && <div className="logs">{logs || 'Loading logs…'}</div>}
            {tab === 'details' && (
              <div style={{ padding: 18, overflow: 'auto', height: '100%' }}>
                <div className="kv"><span className="k">Session</span><span className="v">{session.id}</span></div>
                <div className="kv"><span className="k">Lab</span><span className="v">{session.labTitle} v{session.labVersion}</span></div>
                <div className="kv"><span className="k">Worker mode</span><span className="v">{session.mode ?? 'unknown'}</span></div>
                <div className="kv"><span className="k">Created</span><span className="v">{new Date(session.createdAt).toLocaleString()}</span></div>
                <div className="kv"><span className="k">Ready</span><span className="v">{session.readyAt ? new Date(session.readyAt).toLocaleString() : '—'}</span></div>
                <div className="kv"><span className="k">Expires</span><span className="v">{session.expiresAt ? new Date(session.expiresAt).toLocaleString() : '—'}</span></div>
                <div className="kv"><span className="k">Hard cap</span><span className="v">{session.maxExpiresAt ? new Date(session.maxExpiresAt).toLocaleString() : '—'}</span></div>
                <div className="kv"><span className="k">Extensions</span><span className="v">{session.extensionCount}/4</span></div>
                <div className="kv"><span className="k">Gateway</span><span className="v">{session.targets.map((t) => t.gatewayPath).join(', ') || '—'}</span></div>
                {session.resources && (
                  <>
                    <div className="kv"><span className="k">CPU</span><span className="v">{String(session.resources.cpus ?? '—')}</span></div>
                    <div className="kv"><span className="k">Memory</span><span className="v">{String(session.resources.memoryMb ?? '—')} MB</span></div>
                    <div className="kv"><span className="k">PIDs</span><span className="v">{String(session.resources.pids ?? '—')}</span></div>
                  </>
                )}
                <h3 style={{ margin: '18px 0 8px', fontSize: 14 }}>Event timeline</h3>
                {session.events.map((e, i) => (
                  <div key={i} className="kv">
                    <span className="k mono">{e.state}</span>
                    <span className="v" style={{ fontFamily: 'var(--sans)', textAlign: 'left' }}>{e.message}</span>
                    <span className="tiny muted mono">{new Date(e.createdAt).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      <Modal open={confirmReset} onClose={() => setConfirmReset(false)} title="Reset lab environment">
        <p className="tiny dim">
          Reset stops this session and provisions a fresh one with new flag material. Verified objective progress is
          preserved, but anything you saved inside the workspace is destroyed.
        </p>
        <div className="row gap-8" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => setConfirmReset(false)}>Cancel</Button>
          <Button variant="primary" onClick={() => void control('reset')} disabled={busy === 'reset'}>{busy === 'reset' ? 'Rebuilding…' : 'Reset environment'}</Button>
        </div>
      </Modal>
    </div>
  );
}
