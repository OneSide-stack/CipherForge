import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { QaCheck, QaResponse } from '../lib/types';
import { Badge, Banner, Button, Card, Empty, SectionTitle, Spinner, Stat, useToast } from '../components/ui';
import { relativeTime } from '../lib/format';
import { useAuth } from '../lib/auth';

export function QaPage() {
  const { user } = useAuth();
  const toast = useToast();
  const [data, setData] = useState<QaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [polling, setPolling] = useState(false);

  async function load() {
    try {
      setData(await api.get<QaResponse>('/api/qa'));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load QA results');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [polling]);

  async function run() {
    setStarting(true);
    try {
      await api.post('/api/admin/qa/run');
      setPolling(true);
      toast.push({ title: 'QA suite queued', body: 'Checks are running against the live stack. Results appear as they complete.', tone: 'ok' });
    } catch (err) {
      toast.push({ title: 'Could not start QA', body: err instanceof ApiError ? err.message : 'Try again', tone: 'bad' });
    } finally {
      setStarting(false);
    }
  }

  if (!data) return error ? <Banner tone="bad">{error}</Banner> : <Spinner label="Loading test history…" />;
  const latest = data.latest;
  const checks: QaCheck[] = latest?.checks ?? [];

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row" style={{ alignItems: 'end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div className="eyebrow">verification wall</div>
          <h1 style={{ fontSize: 32 }}>QA & tests</h1>
          <p className="muted tiny" style={{ marginTop: 6, maxWidth: 720 }}>
            Every run executes against this live deployment. Checks that require an unavailable capability (Docker, a
            privileged kernel feature) report <b>BLOCKED</b> with the reason — never a fabricated pass.
          </p>
        </div>
        {user?.role === 'admin' && (
          <div style={{ marginLeft: 'auto' }}>
            <Button variant="primary" onClick={() => void run()} disabled={starting}>
              {starting ? 'Starting…' : 'Run QA suite'}
            </Button>
          </div>
        )}
      </div>

      {error && <Banner tone="bad">{error}</Banner>}

      {!latest ? (
        <Card>
          <Empty
            title="No QA runs recorded yet"
            body={user?.role === 'admin' ? 'Start a run to verify this deployment. It executes a real sandbox session end to end.' : 'An administrator can trigger a suite from this screen or with npm run qa.'}
            action={user?.role === 'admin' ? <Button variant="primary" size="sm" onClick={() => void run()}>Run the suite</Button> : undefined}
          />
          <div className="banner" style={{ marginTop: 10 }}>{data.howToRun}</div>
        </Card>
      ) : (
        <>
          <div className="grid grid-4">
            <Stat label="Passing" value={latest.summary.pass} tone="teal" />
            <Stat label="Failing" value={latest.summary.fail} tone={latest.summary.fail ? 'ember' : undefined} />
            <Stat label="Blocked" value={latest.summary.blocked} sub="capability unavailable" />
            <Stat label="Mode" value={latest.mode} sub={relativeTime(latest.startedAt)} tone="blue" />
          </div>
          {polling && <Banner tone="warn">Suite running — results refresh automatically. You can leave this page.</Banner>}

          <Card pad={false}>
            <div className="panel-head">
              <h3>Latest run · {new Date(latest.startedAt).toLocaleString()}</h3>
              <Badge tone={latest.summary.fail === 0 ? 'teal' : 'red'} className="nowrap" >{latest.summary.fail === 0 ? 'all executed checks pass' : `${latest.summary.fail} failing`}</Badge>
              <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>run {latest.id.slice(0, 8)}</span>
            </div>
            <div>
              {checks.map((c, i) => (
                <div key={`${c.id}-${i}`} className={`checkrow ${c.status}`}>
                  <span className="status">{c.status}</span>
                  <span className="name">{c.name}</span>
                  <span className="detail">{c.detail || '—'}</span>
                </div>
              ))}
              {!checks.length && <div className="empty">This run has no recorded checks.</div>}
            </div>
          </Card>

          <div className="split">
            <Card pad={false}>
              <div className="panel-head"><h3>Run history</h3></div>
              <table className="table">
                <thead><tr><th>Started</th><th>Mode</th><th>Pass</th><th>Fail</th><th>Blocked</th></tr></thead>
                <tbody>
                  {data.history.map((h) => (
                    <tr key={h.id}>
                      <td className="muted tiny">{new Date(h.startedAt).toLocaleString()}</td>
                      <td className="mono">{h.mode}</td>
                      <td className="mono" style={{ color: 'var(--green)' }}>{h.summary?.pass ?? 0}</td>
                      <td className="mono" style={{ color: (h.summary?.fail ?? 0) > 0 ? 'var(--red)' : 'var(--muted)' }}>{h.summary?.fail ?? 0}</td>
                      <td className="mono" style={{ color: 'var(--amber)' }}>{h.summary?.blocked ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card>
              <h3 style={{ marginBottom: 10 }}>What the suite verifies</h3>
              <ul className="tiny muted" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.9 }}>
                <li>Database connectivity and applied migrations</li>
                <li>Authentication, CSRF and learner/admin authorization</li>
                <li>Session lifecycle through <span className="mono">ready</span> with real health checks</li>
                <li>Flag rejection and acceptance, then double-award prevention</li>
                <li>Live objective validation against the running target</li>
                <li>Cross-learner isolation for status, terminal and target proxy</li>
                <li>Stop cleanup, orphan reaping and residual process checks</li>
                <li>Docker isolation proof — reported <span className="mono">BLOCKED</span> when no engine is present</li>
              </ul>
              <div className="banner" style={{ marginTop: 14, fontSize: 12 }}>{data.howToRun}</div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
