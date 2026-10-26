/**
 * Solstice HR self-service (training).
 * Deliberate flaw: the profile update endpoint copies every submitted field
 * onto the user record, including privileged ones.
 */
import { createLabServer, escapeHtml } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();

createLabServer({
  labId: 'mass-assignment-profile',
  org: 'Solstice HR',
  subtitle: 'employee self-service',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { fieldWhitelist: false },
  validatePolicy(input) {
    const errors = [];
    if (typeof input.fieldWhitelist !== 'boolean') errors.push('fieldWhitelist must be a boolean');
    return { ok: errors.length === 0, errors, next: { fieldWhitelist: input.fieldWhitelist } };
  },
  seed() {
    return {
      session: 'sess-demo-4412',
      user: { id: 'u-512', name: 'Rowan Mehta', email: 'rowan@solstice.example', role: 'employee', department: 'Support' },
      ledger: { period: '2026-Q3', bonuses: 12, marker: FLAGS['profile-flag'] ?? 'unavailable' },
      baseRole: 'employee',
    };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        ctx.html(200, ctx.page({
          title: 'Employee profile',
          body: `<h1>Solstice self-service</h1><p class="lead">Update your profile.</p>
          <div class="card"><h3>Read</h3><pre>GET /api/profile</pre></div>
          <div class="card"><h3>Update</h3><pre>PATCH /api/profile
{ "name": "Rowan Mehta" }</pre></div>
          <div class="banner">Training replica. Employees and salaries are fictional.</div>`,
        }));
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      handler(ctx) {
        ctx.json(200, { status: 'ok', service: 'solstice-hr', policy: ctx.policy });
      },
    },
    {
      method: 'GET',
      path: '/api/profile',
      handler(ctx) {
        // Once the allow-list is on, the server-authoritative role wins again.
        const user = { ...ctx.data.user, role: ctx.policy.fieldWhitelist ? ctx.data.baseRole : ctx.data.user.role };
        ctx.json(200, { user });
      },
    },
    {
      method: 'PATCH',
      path: '/api/profile',
      handler(ctx) {
        let body = {};
        try { body = JSON.parse(ctx.body || '{}'); } catch { return ctx.json(400, { error: 'invalid_json' }); }
        const allowed = ['name', 'department', 'pronouns'];
        const appliedKeys = ctx.policy.fieldWhitelist ? Object.keys(body).filter((k) => allowed.includes(k)) : Object.keys(body);
        const rejected = Object.keys(body).filter((k) => !appliedKeys.includes(k));
        for (const key of appliedKeys) ctx.data.user[key] = body[key];
        ctx.log({ path: '/api/profile', status: 200, fields: appliedKeys.join(','), rejected: rejected.join(',') });
        const user = { ...ctx.data.user, role: ctx.policy.fieldWhitelist ? ctx.data.baseRole : ctx.data.user.role };
        ctx.json(200, { user, applied: appliedKeys, rejected });
      },
    },
    {
      method: 'GET',
      path: '/api/payroll/ledger',
      handler(ctx) {
        const role = ctx.policy.fieldWhitelist ? ctx.data.baseRole : ctx.data.user.role;
        if (role !== 'hr-admin') {
          ctx.log({ path: '/api/payroll/ledger', status: 403, role });
          return ctx.json(403, { error: 'forbidden', role, message: 'Payroll ledger requires the hr-admin role.' });
        }
        ctx.log({ path: '/api/payroll/ledger', status: 200, role });
        ctx.json(200, { ledger: ctx.data.ledger });
      },
    },
    {
      method: 'GET',
      path: '/profile',
      handler(ctx) {
        const role = ctx.policy.fieldWhitelist ? ctx.data.baseRole : ctx.data.user.role;
        ctx.html(200, ctx.page({ title: 'Profile', body: `<h1>${escapeHtml(ctx.data.user.name)}</h1><p>Role: ${escapeHtml(role)}</p>` }));
      },
    },
  ],
});

console.log('Solstice HR listening');
process.on('SIGTERM', () => process.exit(0));
