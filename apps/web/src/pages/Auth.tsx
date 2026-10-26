import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Field } from '../components/ui';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/app';
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await api.post('/api/auth/login', { email, password });
      else await api.post('/api/auth/register', { email, username, password });
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-art">
        <Link to="/" className="brand" style={{ padding: 0 }}>
          <div className="brand-mark">CF</div>
          <div>
            <div className="brand-name">CipherForge</div>
            <div className="brand-sub">Academy</div>
          </div>
        </Link>
        <div style={{ maxWidth: 520 }}>
          <div className="eyebrow">Isolated · verified · yours</div>
          <h1 style={{ fontSize: 'clamp(30px, 3.4vw, 44px)' }}>
            Every session is a fresh lab.<br />
            <span style={{ color: 'var(--ember-2)' }}>Every flag is earned.</span>
          </h1>
          <p className="dim" style={{ marginTop: 16 }}>
            Real shell, real target, real validation. Progress, XP and achievements persist — the environment does not.
          </p>
          <div className="term" style={{ marginTop: 26 }}>
            <div className="term-bar"><i /><i /><i /><span className="tiny muted mono" style={{ marginLeft: 6 }}>session lifecycle</span></div>
            <div className="term-body">
              <span className="cmd">$</span> cf session start http-header-hunt{'\n'}
              `queued → provisioning → starting`{'\n'}
              <span className="ok">ready</span> · health checks passed · ttl 30m{'\n'}
              <span className="cmd">$</span> labctl audit && labctl policy apply ./hardened.json{'\n'}
              <span className="ok">✓ 18 issues resolved</span>{'\n'}
              <span className="flagline">objective verified → progress saved</span>
            </div>
          </div>
        </div>
        <p className="tiny muted mono">Synthetic scenarios · no real customer data · responsible use required</p>
      </div>

      <div className="auth-panel">
        <form className="auth-form" onSubmit={submit}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>{mode === 'login' ? 'Welcome back' : 'Create your operator'}</div>
            <h2>{mode === 'login' ? 'Sign in to CipherForge' : 'Join the academy'}</h2>
            <p className="tiny muted" style={{ marginTop: 6 }}>
              {mode === 'login' ? 'Continue your labs and keep your progress.' : 'Ten seconds to set up. No credit card, no sales call.'}
            </p>
          </div>

          {error && <div className="banner bad">{error}</div>}

          <Field label="Email">
            <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="operator@example.com" />
          </Field>
          {mode === 'register' && (
            <Field label="Username" hint="3–24 characters, letters, numbers, dashes and underscores.">
              <input className="input" required minLength={3} maxLength={24} pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,23}" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="nova" />
            </Field>
          )}
          <Field label="Password" hint={mode === 'register' ? 'At least 10 characters. Use a unique password.' : undefined}>
            <input className="input" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••" />
          </Field>

          <Button type="submit" variant="primary" size="lg" disabled={busy}>
            {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>

          <div className="tiny muted center">
            {mode === 'login' ? (
              <>New here? <Link to="/register" style={{ color: 'var(--ember-2)' }}>Create an account</Link></>
            ) : (
              <>Already have an account? <Link to="/login" style={{ color: 'var(--ember-2)' }}>Sign in</Link></>
            )}
          </div>
          {mode === 'login' && (
            <div className="banner" style={{ fontSize: 12 }}>
              <span>
                Local development accounts: <span className="mono">learner@cipherforge.dev</span> / <span className="mono">CipherForge!2024</span>
              </span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
