/**
 * Meridian admin gate (training).
 * Deliberate flaw: the admin PIN login has no attempt limit, so a four-digit
 * PIN can be enumerated in a few thousand requests.
 */
import { createLabServer, escapeHtml } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();

createLabServer({
  labId: 'brute-force-gate',
  org: 'Meridian Logistics',
  subtitle: 'operations admin gate',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { lockoutAfter: 0 },
  validatePolicy(input) {
    const errors = [];
    if (!Number.isInteger(input.lockoutAfter) || input.lockoutAfter < 3 || input.lockoutAfter > 50) {
      errors.push('lockoutAfter must be an integer between 3 and 50');
    }
    return { ok: errors.length === 0, errors, next: { lockoutAfter: input.lockoutAfter } };
  },
  seed() {
    return {
      adminPin: '7413',
      failures: 0,
      locked: false,
      dashboard: { shipments: 128, exceptions: 4, marker: FLAGS['gate-flag'] ?? 'unavailable' },
    };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        ctx.html(200, ctx.page({
          title: 'Admin gate',
          body: `<h1>Meridian admin gate</h1><p class="lead">Operations dashboard, PIN protected.</p>
          <div class="card"><h3>Login</h3><pre>POST /api/admin/login
{ "pin": "0000" }</pre></div>
          <div class="card"><h3>Dashboard</h3><pre>GET /api/admin/dashboard
X-Admin-Session: &lt;token&gt;</pre></div>
          <div class="banner">Training replica. PINs and shipments are synthetic.</div>`,
        }));
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      handler(ctx) {
        ctx.json(200, { status: 'ok', service: 'meridian-gate', policy: ctx.policy });
      },
    },
    {
      method: 'POST',
      path: '/api/admin/login',
      handler(ctx) {
        let body = {};
        try { body = JSON.parse(ctx.body || '{}'); } catch { return ctx.json(400, { error: 'invalid_json' }); }
        const pin = String(body.pin ?? '');
        if (ctx.data.locked) {
          ctx.log({ path: '/api/admin/login', status: 429, note: 'locked' });
          return ctx.json(429, { error: 'locked_out', message: 'Too many failed attempts. Try again later.' });
        }
        if (!/^\d{1,8}$/.test(pin)) return ctx.json(400, { error: 'pin_format', message: 'PIN must be numeric' });
        if (pin !== ctx.data.adminPin) {
          ctx.data.failures += 1;
          if (ctx.policy.lockoutAfter > 0 && ctx.data.failures >= ctx.policy.lockoutAfter) {
            ctx.data.locked = true;
            ctx.log({ path: '/api/admin/login', status: 429, note: 'lockout-triggered', failures: ctx.data.failures });
            return ctx.json(429, { error: 'locked_out', message: 'Too many failed attempts. Try again later.' });
          }
          ctx.log({ path: '/api/admin/login', status: 401, failures: ctx.data.failures });
          return ctx.json(401, { error: 'invalid_pin', failures: ctx.data.failures, limit: ctx.policy.lockoutAfter });
        }
        ctx.data.failures = 0;
        const token = Buffer.from(`meridian:${ctx.labId}:${Date.now()}`).toString('base64url');
        ctx.data.tokens = { ...(ctx.data.tokens ?? {}), [token]: true };
        ctx.log({ path: '/api/admin/login', status: 200, note: 'admin-session-issued' });
        ctx.json(200, { token, expiresIn: 900 });
      },
    },
    {
      method: 'GET',
      path: '/api/admin/dashboard',
      handler(ctx) {
        const token = String(ctx.req.headers['x-admin-session'] ?? '');
        if (!ctx.data.tokens?.[token]) {
          ctx.log({ path: '/api/admin/dashboard', status: 401 });
          return ctx.json(401, { error: 'admin_session_required' });
        }
        ctx.json(200, { dashboard: ctx.data.dashboard });
      },
    },
  ],
});

console.log('Meridian admin gate listening');
process.on('SIGTERM', () => process.exit(0));
