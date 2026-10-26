/**
 * Aurora Pay partner API (training).
 * Deliberate flaw: the token verifier accepts the "none" algorithm, so any
 * caller can mint an unsigned admin token.
 */
import crypto from 'node:crypto';
import { createLabServer, escapeHtml } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();
const APP_SEED = process.env.CF_APP_SEED ?? '';
const SECRET = crypto.createHmac('sha256', APP_SEED).update('jwt-signing-key').digest('hex').slice(0, 32);

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unb64url = (str) => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const sign = (payload) => {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
};
function verify(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed_token' };
  let header;
  let payload;
  try {
    header = JSON.parse(unb64url(parts[0]));
    payload = JSON.parse(unb64url(parts[1]));
  } catch {
    return { ok: false, error: 'invalid_encoding' };
  }
  // Deliberate flaw: unsigned tokens are trusted.
  if (String(header.alg).toLowerCase() === 'none' && !server.policy.rejectAlgNone) return { ok: true, payload };
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(`${parts[0]}.${parts[1]}`).digest());
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2].padEnd(expected.length).slice(0, expected.length)))) {
    return { ok: false, error: 'signature_invalid' };
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return { ok: false, error: 'token_expired' };
  return { ok: true, payload };
}

const server = createLabServer({
  labId: 'jwt-none-forge',
  org: 'Aurora Pay',
  subtitle: 'partner payments API',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { rejectAlgNone: false },
  validatePolicy(input) {
    const errors = [];
    if (typeof input.rejectAlgNone !== 'boolean') errors.push('rejectAlgNone must be a boolean');
    return { ok: errors.length === 0, errors, next: { rejectAlgNone: input.rejectAlgNone } };
  },
  seed() {
    return {
      users: [
        { id: 'u-201', email: 'analyst@aurorapay.example', password: 'aurora2024', role: 'partner' },
        { id: 'u-900', email: 'admin@aurorapay.example', password: 'not-in-this-lab', role: 'admin' },
      ],
      exports: [
        { id: 'EXP-77', role: 'partner', rows: 12, note: 'settlement summary' },
        { id: 'EXP-9001', role: 'admin', rows: 4210, note: `Full merchant export · marker ${FLAGS['admin-export'] ?? 'unavailable'}` },
      ],
    };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        ctx.html(200, ctx.page({
          title: 'Partner API',
          body: `<h1>Aurora Pay partner API</h1><p class="lead">Token-based access to settlement data.</p>
          <div class="grid">
            <div class="card"><h3>Login</h3><pre>POST /api/login\n{ "email": "analyst@aurorapay.example", "password": "aurora2024" }</pre></div>
            <div class="card"><h3>Export</h3><pre>GET /api/admin/export\nAuthorization: Bearer &lt;token&gt;</pre></div>
            <div class="card"><h3>Health</h3><pre>GET /api/health</pre></div>
          </div>
          <div class="banner">Training build. Tokens are synthetic and merchant data is fictional.</div>`,
        }));
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      handler(ctx) {
        ctx.json(200, { status: 'ok', service: 'aurorapay-partner-api', policy: ctx.policy });
      },
    },
    {
      method: 'POST',
      path: '/api/login',
      handler(ctx) {
        let body = {};
        try { body = JSON.parse(ctx.body || '{}'); } catch { return ctx.json(400, { error: 'invalid_json' }); }
        const user = ctx.data.users.find((u) => u.email.toLowerCase() === String(body.email ?? '').toLowerCase() && u.password === body.password);
        if (!user) {
          ctx.log({ event: 'auth.login', result: 'denied', email: String(body.email ?? '').slice(0, 80) });
          return ctx.json(401, { error: 'invalid_credentials' });
        }
        const token = sign({ sub: user.id, email: user.email, role: user.role, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 });
        ctx.log({ event: 'auth.login', result: 'success', role: user.role });
        ctx.json(200, { token, tokenType: 'Bearer', role: user.role });
      },
    },
    {
      method: 'GET',
      path: '/api/admin/export',
      handler(ctx) {
        const auth = String(ctx.req.headers.authorization ?? '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const result = verify(token);
        if (!result.ok) {
          ctx.log({ path: '/api/admin/export', status: 401, reason: result.error });
          return ctx.json(401, { error: 'invalid_token', reason: result.error });
        }
        if (result.payload.role !== 'admin') {
          ctx.log({ path: '/api/admin/export', status: 403, role: result.payload.role });
          return ctx.json(403, { error: 'admin_required', role: result.payload.role });
        }
        ctx.log({ path: '/api/admin/export', status: 200, role: 'admin', alg: result.payload.alg ?? 'verified' });
        ctx.json(200, { export: ctx.data.exports, generatedAt: new Date().toISOString() });
      },
    },
    {
      method: 'GET',
      path: '/api/exports',
      handler(ctx) {
        const auth = String(ctx.req.headers.authorization ?? '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const result = verify(token);
        if (!result.ok) return ctx.json(401, { error: 'invalid_token', reason: result.error });
        ctx.json(200, { exports: ctx.data.exports.filter((e) => e.role === result.payload.role) });
      },
    },
  ],
});

console.log('Aurora Pay API listening');
process.on('SIGTERM', () => process.exit(0));
