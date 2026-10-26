/**
 * Torrential ISP diagnostics (training).
 * Deliberate flaw: the host parameter is interpolated into a shell string, so
 * metacharacters run additional commands as the service account.
 */
import { exec, execFile } from 'node:child_process';
import { createLabServer, escapeHtml } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();

// The diagnostic secret lives in this process's environment only; the shell
// running it can be made to print it.
const DIAG_SECRET = FLAGS['shell-flag'] ?? 'unavailable';

createLabServer({
  labId: 'cmdi-netcheck',
  org: 'Torrential ISP',
  subtitle: 'field diagnostics console',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { shellDisabled: false },
  validatePolicy(input) {
    const errors = [];
    if (typeof input.shellDisabled !== 'boolean') errors.push('shellDisabled must be a boolean');
    return { ok: errors.length === 0, errors, next: { shellDisabled: input.shellDisabled } };
  },
  seed() {
    return { queries: [] };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        ctx.html(200, ctx.page({
          title: 'Diagnostics',
          body: `<h1>Field diagnostics</h1><p class="lead">Resolve a customer hostname from the edge node.</p>
          <div class="card"><h3>Resolve</h3><pre>GET /api/netcheck?host=portal.torrential.example</pre></div>
          <div class="card"><h3>Environment</h3><pre>DIAG_SECRET is injected by the control plane for support escalations.</pre></div>
          <div class="banner">Training replica. Hostnames and secrets are synthetic.</div>`,
        }));
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      handler(ctx) {
        ctx.json(200, { status: 'ok', service: 'torrential-netcheck', policy: ctx.policy });
      },
    },
    {
      method: 'GET',
      path: '/api/netcheck',
      handler(ctx) {
        const host = ctx.url.searchParams.get('host') ?? '';
        if (!host) return ctx.json(400, { error: 'host_required' });
        const record = (status, extra = {}) => ctx.log({ path: '/api/netcheck', status, host: host.slice(0, 120), ...extra });
        if (ctx.policy.shellDisabled) {
          execFile('getent', ['hosts', host], { timeout: 3000 }, (err, stdout) => {
            record(err ? 502 : 200, { mode: 'no-shell' });
            if (err) return ctx.json(502, { error: 'lookup_failed', host });
            ctx.json(200, { host, mode: 'execFile', output: stdout.trim() });
          });
          return undefined;
        }
        exec(`getent hosts ${host} 2>&1 || true`, { timeout: 3000, env: { ...process.env, DIAG_SECRET } }, (err, stdout) => {
          record(err ? 502 : 200, { mode: 'shell' });
          ctx.json(200, { host, mode: 'sh -c', output: String(stdout).slice(0, 4000) });
        });
        return undefined;
      },
    },
    {
      method: 'GET',
      path: '/diagnostics',
      handler(ctx) {
        ctx.html(200, ctx.page({ title: 'Diagnostics', body: `<h1>Edge node</h1><p>${escapeHtml('Region: ap-south-1 · node edge-07')}</p>` }));
      },
    },
  ],
});

console.log('Torrential diagnostics listening');
process.on('SIGTERM', () => process.exit(0));
