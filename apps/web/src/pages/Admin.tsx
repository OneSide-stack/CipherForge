import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { Badge, Banner, Button, Card, SectionTitle, Spinner, Stat, useToast } from '../components/ui';
import { relativeTime, stateTone } from '../lib/format';

interface AdminSessionRow {
  id: string;
  labId: string;
  state: string;
  mode: string | null;
  createdAt: string;
  expiresAt: string | null;
  user: string;
  failure: unknown;
}

interface AdminOverview {
  worker: {
    ok?: boolean;
    mode?: string;
    capacity?: { maxSessions: number; activeSessions: number; queued: number; perUserLimit: number };
    checks?: { id: string; ok: boolean; detail: string }[];
    drivers?: Record<string, { available: boolean; mode: string; checks: { id: string; ok: boolean; detail: string }[]; reason?: string }>;
    isolation?: Record<string, unknown>;
    error?: string;
  };
  counts: { users: number; activeSessions: number; failed24h: number; published: number; comingSoon: number; completions: number };
  templates: { lab_id: string; version: string; status: string; enabled: boolean }[];
  sessions: AdminSessionRow[];
  audit: { id: number; action: string; actorRole: string; actor: string; target: string; at: string }[];
}

interface AdminConfig {
  env: string;
  version: string;
  features: Record<string, string | number | boolean>;
  security: Record<string, string>;
}

export function AdminPage() {
  const toast = useToast();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    Promise.all([api.get<AdminOverview>('/api/admin/overview'), api.get<AdminConfig>('/api/admin/config')])
      .then(([o, c]) => {
        setData(o);
        setConfig(c);
      })
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    void load();
  }, []);

  async function stopSession(id: string) {
    try {
      await api.post(`/api/admin/sessions/${id}/stop`);
      toast.push({ title: 'Session stopped', tone: 'ok' });
      await load();
    } catch (err) {
      toast.push({ title: 'Stop failed', body: err instanceof ApiError ? err.message : 'Try again', tone: 'bad' });
    }
  }

  async function toggleLab(labId: string, enabled: boolean) {
    try {
      await api.post(`/api/admin/labs/${labId}/enabled`, { enabled });
      toast.push({ title: `${labId} ${enabled ? 'enabled' : 'disabled'}`, tone: 'ok' });
      await load();
    } catch (err) {
      toast.push({ title: 'Update failed', body: err instanceof ApiError ? err.message : 'Try again', tone: 'bad' });
    }
  }

  if (error) return <Banner tone="bad">{error}</Banner>;
  if (!data || !config) return <Spinner label="Loading worker state…" />;
  const worker = data.worker;

  return (
    <div className="stack" style={{ gap: 22 }}>
      <div>
        <div className="eyebrow">operations</div>
        <h1 style={{ fontSize: 32 }}>Administration</h1>
        <p className="muted tiny" style={{ marginTop: 6 }}>Worker capabilities, live sessions, catalog controls and audit trail.</p>
      </div>

      <div className="grid grid-4">
        <Stat label="Active sessions" value={data.counts.activeSessions} sub={`${worker.capacity?.maxSessions ?? '?'} slot capacity`} tone="teal" />
        <Stat label="Users" value={data.counts.users} sub={`${data.counts.completions} objective completions`} />
        <Stat label="Failed (24h)" value={data.counts.failed24h} tone={data.counts.failed24h ? 'ember' : undefined} sub="needs review" />
        <Stat label="Catalog" value={`${data.counts.published}/${data.counts.published + data.counts.comingSoon}`} sub={`${data.counts.comingSoon} coming soon`} tone="blue" />
      </div>

      <div className="grid grid-2">
        <Card>
          <div className="row gap-8" style={{ marginBottom: 10 }}>
            <h3>Lab worker</h3>
            <Badge tone={worker.ok ? 'teal' : 'red'} className="nowrap">{worker.ok ? 'healthy' : 'unavailable'}</Badge>
            <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{worker.mode ?? 'unknown'} mode</span>
          </div>
          {worker.error && <Banner tone="bad">{worker.error}</Banner>}
          <div className="stack" style={{ gap: 6, marginTop: 8 }}>
            {(worker.checks ?? []).map((c) => (
              <div key={c.id} className="row gap-8 tiny">
                <span className={`dot ${c.ok ? 'ok' : 'bad'}`} />
                <span className="mono" style={{ width: 130 }}>{c.id}</span>
                <span className="muted truncate">{c.detail}</span>
              </div>
            ))}
          </div>
          {worker.capacity && (
            <div className="row gap-8 tiny mono muted" style={{ marginTop: 12 }}>
              <span>{worker.capacity.activeSessions}/{worker.capacity.maxSessions} active</span>
              <span>·</span>
              <span>{worker.capacity.queued} queued</span>
              <span>·</span>
              <span>{worker.capacity.perUserLimit}/user</span>
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ marginBottom: 10 }}>Driver matrix</h3>
          <div className="stack" style={{ gap: 12 }}>
            {Object.entries(worker.drivers ?? {}).map(([name, driver]) => (
              <div key={name}>
                <div className="row gap-8">
                  <Badge tone={driver.available ? 'teal' : 'amber'}>{name}</Badge>
                  <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{driver.available ? 'available' : 'BLOCKED'}</span>
                </div>
                <div className="tiny muted" style={{ marginTop: 4 }}>
                  {driver.reason ?? driver.checks.map((c) => `${c.id}: ${c.ok ? 'ok' : 'missing'}`).join(' · ')}
                </div>
              </div>
            ))}
            {!worker.drivers && <p className="tiny muted">Driver details unavailable.</p>}
          </div>
          <div className="banner warn" style={{ marginTop: 12, fontSize: 12 }}>
            Docker is optional: the worker selects the strongest driver it can actually verify. Blocked capabilities are
            reported, not simulated.
          </div>
        </Card>
      </div>

      <section>
        <SectionTitle title="Lab sessions" hint="latest 100 · learner emails are masked" />
        <Card pad={false}>
          <table className="table">
            <thead><tr><th>Session</th><th>Lab</th><th>Learner</th><th>State</th><th>Created</th><th /></tr></thead>
            <tbody>
              {data.sessions.map((s) => (
                <tr key={s.id}>
                  <td className="mono tiny">{s.id.slice(0, 8)}</td>
                  <td>{s.labId}</td>
                  <td className="muted mono tiny">{s.user}</td>
                  <td><Badge tone={stateTone(s.state)}>{s.state}</Badge></td>
                  <td className="tiny muted">{relativeTime(s.createdAt)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {['queued', 'provisioning', 'starting', 'ready'].includes(s.state) && (
                      <Button size="sm" variant="danger" onClick={() => void stopSession(s.id)}>Stop</Button>
                    )}
                  </td>
                </tr>
              ))}
              {!data.sessions.length && <tr><td colSpan={6} className="empty">No sessions yet.</td></tr>}
            </tbody>
          </table>
        </Card>
      </section>

      <div className="split">
        <Card pad={false}>
          <div className="panel-head"><h3>Catalog controls</h3></div>
          <table className="table">
            <thead><tr><th>Lab</th><th>Version</th><th>Status</th><th>Enabled</th><th /></tr></thead>
            <tbody>
              {data.templates.map((t) => (
                <tr key={t.lab_id}>
                  <td className="mono">{t.lab_id}</td>
                  <td className="muted">{t.version}</td>
                  <td><Badge tone={t.status === 'published' ? 'teal' : 'amber'}>{t.status}</Badge></td>
                  <td>{t.enabled ? <Badge tone="teal">on</Badge> : <Badge tone="red">off</Badge>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <Button size="sm" variant={t.enabled ? 'danger' : 'default'} onClick={() => void toggleLab(t.lab_id, !t.enabled)}>
                      {t.enabled ? 'Disable' : 'Enable'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="banner" style={{ margin: 14, fontSize: 12 }}>
            Disabling a lab removes its launch button immediately; running sessions continue until stopped or expired.
          </div>
        </Card>

        <div className="stack" style={{ gap: 16 }}>
          <Card>
            <h3 style={{ marginBottom: 10 }}>Runtime configuration</h3>
            <div className="kv"><span className="k">Environment</span><span className="v">{config.env}</span></div>
            <div className="kv"><span className="k">Version</span><span className="v">{config.version}</span></div>
            {Object.entries(config.features).map(([k, v]) => (
              <div key={k} className="kv"><span className="k">{k}</span><span className="v">{String(v)}</span></div>
            ))}
          </Card>
          <Card>
            <h3 style={{ marginBottom: 10 }}>Security model</h3>
            {Object.entries(config.security).map(([k, v]) => (
              <div key={k} className="kv"><span className="k">{k}</span><span className="v" style={{ maxWidth: 240 }}>{v}</span></div>
            ))}
          </Card>
        </div>
      </div>

      <section>
        <SectionTitle title="Audit trail" hint="last 30 privileged actions" />
        <Card pad={false}>
          <table className="table">
            <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Target</th></tr></thead>
            <tbody>
              {data.audit.map((a) => (
                <tr key={a.id}>
                  <td className="tiny muted">{relativeTime(a.at)}</td>
                  <td className="mono tiny">{a.action}</td>
                  <td className="tiny muted">{a.actor} · {a.actorRole}</td>
                  <td className="mono tiny muted">{a.target}</td>
                </tr>
              ))}
              {!data.audit.length && <tr><td colSpan={4} className="empty">No audit entries.</td></tr>}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  );
}
