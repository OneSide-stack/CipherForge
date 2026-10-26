import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { LabListResponse } from '../lib/types';
import { difficultyTone, minutesLabel } from '../lib/format';
import { Badge, SectionTitle } from '../components/ui';
import { useAuth } from '../lib/auth';

export function Landing() {
  const { user } = useAuth();
  const [labs, setLabs] = useState<LabListResponse | null>(null);

  useEffect(() => {
    api.get<LabListResponse>('/api/labs').then(setLabs).catch(() => setLabs(null));
  }, []);

  const featured = (labs?.labs ?? []).filter((l) => l.runnable).slice(0, 3);
  const upcoming = (labs?.labs ?? []).filter((l) => !l.runnable).slice(0, 3);

  return (
    <div>
      <header style={{ borderBottom: '1px solid var(--line)', background: 'rgba(7,10,15,.7)', backdropFilter: 'blur(8px)', position: 'sticky', top: 0, zIndex: 20 }}>
        <div className="row" style={{ maxWidth: 1180, margin: '0 auto', padding: '14px 24px', gap: 14 }}>
          <Link to="/" className="brand" style={{ padding: 0 }}>
            <div className="brand-mark">CF</div>
            <div>
              <div className="brand-name">CipherForge</div>
              <div className="brand-sub">Academy</div>
            </div>
          </Link>
          <nav className="row gap-16" style={{ marginLeft: 'auto', fontSize: 13.5 }}>
            <a className="dim" href="#labs">Labs</a>
            <a className="dim" href="#isolation">Isolation</a>
            <a className="dim" href="#verify">Verification</a>
            {user ? (
              <Link to="/app" className="btn btn-primary btn-sm">Open academy</Link>
            ) : (
              <>
                <Link to="/login" className="btn btn-ghost btn-sm">Sign in</Link>
                <Link to="/register" className="btn btn-primary btn-sm">Create account</Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 1180, margin: '0 auto', padding: '56px 24px 80px' }}>
        <section className="hero" style={{ padding: '48px 42px' }}>
          <div className="eyebrow">Hands-on security training · isolated by default</div>
          <h1 style={{ maxWidth: 760, fontSize: 'clamp(34px, 4.6vw, 58px)' }}>
            Break real targets.<br />
            <span style={{ color: 'var(--ember-2)' }}>Prove real skill.</span>
          </h1>
          <p className="dim" style={{ maxWidth: 620, marginTop: 18, fontSize: 16.5 }}>
            CipherForge Academy gives every learner their own disposable lab: a live target service, a real Linux shell
            and objective validation that runs against the actual environment — not a quiz that can be guessed.
          </p>
          <div className="row gap-10" style={{ marginTop: 26, flexWrap: 'wrap' }}>
            <Link to={user ? '/app/labs' : '/register'} className="btn btn-primary btn-lg">
              {user ? 'Browse the lab catalog' : 'Start training free'}
            </Link>
            <Link to="/login" className="btn btn-lg btn-ghost">Sign in to an existing account</Link>
          </div>
          <div className="row gap-20 tiny mono muted" style={{ marginTop: 30, flexWrap: 'wrap' }}>
            <span><span className="dot ok" style={{ display: 'inline-block', marginRight: 7 }} />per-session isolation</span>
            <span><span className="dot ok" style={{ display: 'inline-block', marginRight: 7 }} />HMAC-signed runner RPC</span>
            <span><span className="dot ok" style={{ display: 'inline-block', marginRight: 7 }} />server-side flag hashes</span>
            <span><span className="dot ok" style={{ display: 'inline-block', marginRight: 7 }} />honest QA wall</span>
          </div>
        </section>

        <section style={{ marginTop: 26, display: 'grid', gridTemplateColumns: '1fr 380px', gap: 18 }}>
          <div className="card card-pad" id="isolation">
            <div className="eyebrow">Why it feels different</div>
            <h2 style={{ marginBottom: 14 }}>A lab that actually exists</h2>
            <div className="grid grid-2" style={{ gap: 14 }}>
              {[
                ['Real shell, real files', 'xterm.js talks to a PTY inside the session namespace. You get bash, curl, git, python — not a simulated command list.'],
                ['Validated, not guessed', 'Flags are generated per session and stored only as HMACs. Security checks run live against your target service.'],
                ['Nothing leaks between learners', 'Every session gets its own mount, PID and network namespace plus a private broker socket. Guessing a session id gets a 403.'],
                ['Cleanup you can audit', 'Stop a session and the runtime directory, processes and sockets are removed. Every state change is recorded as an event.'],
              ].map(([title, body]) => (
                <div key={title} className="card" style={{ padding: 16, background: 'rgba(255,255,255,.02)', boxShadow: 'none' }}>
                  <h3 style={{ marginBottom: 6 }}>{title}</h3>
                  <p className="tiny muted">{body}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="term">
            <div className="term-bar"><i /><i /><i /><span className="tiny muted mono" style={{ marginLeft: 6 }}>learner@cf-http-header-hunt</span></div>
            <div className="term-body">
              <span className="cmd">learner@lab:~$</span> curl -sI $CF_TARGET_URL | head -4{'\n'}
              {`HTTP/1.1 200 OK\nserver: NimbusPortal/1.0\nx-build-token: CF{••••••••••••}\n`}
              <span className="cmd">learner@lab:~$</span> labctl audit | jq .score{'\n'}
              {`{
  "status": "non-compliant",
  "issues": 18
}`}
              {'\n'}<span className="ok">✓ objective ready for validation</span>{'\n'}
              <span className="flagline">flag submitted → 30 XP · lab +70 XP</span>
            </div>
          </div>
        </section>

        <section style={{ marginTop: 48 }} id="labs">
          <SectionTitle title="Featured labs" hint={`${labs?.counts.runnable ?? 0} interactive · ${labs?.counts.comingSoon ?? 0} in the forge`} action={<Link to="/app/labs" className="btn btn-sm">Full catalog →</Link>} />
          <div className="grid grid-3">
            {featured.map((lab) => (
              <Link key={lab.id} to={user ? `/app/labs/${lab.id}` : '/register'} className="card card-pad card-hover labcard">
                <div className="labcard-top">
                  <Badge tone={difficultyTone(lab.difficulty)}>{lab.difficulty}</Badge>
                  <Badge tone="teal">interactive</Badge>
                  <span className="tiny mono muted" style={{ marginLeft: 'auto' }}>{lab.baseXp} XP</span>
                </div>
                <div>
                  <h3>{lab.title}</h3>
                  <div className="sub">{lab.category} · {minutesLabel(lab.estimatedMinutes)}</div>
                </div>
                <p className="summary">{lab.summary}</p>
                <div className="chips">{lab.skills.slice(0, 3).map((s) => <span key={s} className="chip">{s}</span>)}</div>
              </Link>
            ))}
            {!featured.length && <div className="card card-pad muted">Catalog loading…</div>}
          </div>
          {upcoming.length > 0 && (
            <div className="grid grid-3" style={{ marginTop: 14 }}>
              {upcoming.map((lab) => (
                <div key={lab.id} className="card card-pad labcard" style={{ opacity: 0.72 }}>
                  <div className="labcard-top">
                    <Badge>{lab.difficulty}</Badge>
                    <Badge tone="amber">coming soon</Badge>
                  </div>
                  <h3>{lab.title}</h3>
                  <div className="sub">{lab.category}</div>
                  <p className="summary">{lab.availabilityNote ?? lab.summary}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={{ marginTop: 48 }} id="verify">
          <SectionTitle title="Verification, not vibes" hint="the QA screen shows PASS / FAIL / BLOCKED" />
          <div className="grid grid-3">
            {[
              ['Runtime checks', 'The QA suite boots a real sandbox session, drives the PTY, validates flags, applies remediation and confirms cleanup. Docker-only checks report BLOCKED with the exact reason.'],
              ['Signed runner RPC', 'The API never touches the container runtime. Every worker call carries an HMAC over method, path, timestamp and nonce with replay protection.'],
              ['Server-side scoring', 'Objective rewards, hint penalties and walkthrough multipliers are computed on the server from template data you never receive.'],
            ].map(([title, body]) => (
              <div key={title} className="card card-pad">
                <h3 style={{ marginBottom: 8 }}>{title}</h3>
                <p className="tiny muted">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="card card-pad" style={{ marginTop: 48, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <div className="grow">
            <h2>Only test what you are authorised to test.</h2>
            <p className="muted tiny" style={{ marginTop: 6, maxWidth: 720 }}>
              Every target in this academy is synthetic and runs inside your own isolated session. Scenarios are
              fictional (<span className="mono">nimbusfreight.example</span>) and flags are harmless generated tokens.
              Keep the skills here — never point them at systems you do not own.
            </p>
          </div>
          <Link to={user ? '/app/labs' : '/register'} className="btn btn-primary">Enter the forge</Link>
        </section>
      </main>

      <footer style={{ borderTop: '1px solid var(--line)', padding: '26px 24px', fontSize: 12.5 }} className="muted">
        <div className="row" style={{ maxWidth: 1180, margin: '0 auto', gap: 16, flexWrap: 'wrap' }}>
          <span className="mono">CipherForge Academy v1.0</span>
          <span style={{ marginLeft: 'auto' }}>Synthetic targets · isolated sessions · responsible use only</span>
        </div>
      </footer>
    </div>
  );
}
