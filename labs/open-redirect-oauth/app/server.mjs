/**
 * Kestrel Identity provider (training).
 * Deliberate flaw: redirect_uri is not matched against the registered client,
 * so authorization codes can be delivered to any host.
 */
import { createLabServer, escapeHtml } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();

createLabServer({
  labId: 'open-redirect-oauth',
  org: 'Kestrel Identity',
  subtitle: 'OAuth broker',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { validateRedirect: false },
  validatePolicy(input) {
    const errors = [];
    if (typeof input.validateRedirect !== 'boolean') errors.push('validateRedirect must be a boolean');
    return { ok: errors.length === 0, errors, next: { validateRedirect: input.validateRedirect } };
  },
  seed() {
    return {
      client: { clientId: 'kestrel-web', name: 'Kestrel Web', registeredRedirect: 'https://app.kestrel.example/callback' },
      code: `code-${FLAGS['oauth-flag'] ?? 'unavailable'}`,
    };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        ctx.html(200, ctx.page({
          title: 'Kestrel Identity',
          body: `<h1>Kestrel OAuth broker</h1><p class="lead">Authorization codes for first-party clients.</p>
          <div class="card"><h3>Authorize</h3><pre>GET /oauth/authorize?client_id=kestrel-web&amp;redirect_uri=...</pre></div>
          <div class="card"><h3>Registered client</h3><pre>${escapeHtml(ctx.data.client.name)} → ${escapeHtml(ctx.data.client.registeredRedirect)}</pre></div>
          <div class="banner">Training replica. Codes and clients are synthetic.</div>`,
        }));
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      handler(ctx) {
        ctx.json(200, { status: 'ok', service: 'kestrel-oauth', policy: ctx.policy });
      },
    },
    {
      method: 'GET',
      path: '/oauth/authorize',
      handler(ctx) {
        const clientId = ctx.url.searchParams.get('client_id') ?? '';
        const redirect = ctx.url.searchParams.get('redirect_uri') ?? '';
        if (clientId !== ctx.data.client.clientId) return ctx.json(400, { error: 'unknown_client' });
        let target;
        try {
          target = new URL(redirect);
        } catch {
          return ctx.json(400, { error: 'invalid_redirect' });
        }
        const registered = ctx.data.client.registeredRedirect;
        if (ctx.policy.validateRedirect && redirect !== registered) {
          ctx.log({ path: '/oauth/authorize', status: 400, note: 'redirect-rejected', redirect: redirect.slice(0, 160) });
          return ctx.json(400, { error: 'invalid_redirect_uri', registeredRedirect: registered });
        }
        const code = `${ctx.data.code}-${Math.random().toString(36).slice(2, 8)}`;
        ctx.log({ path: '/oauth/authorize', status: 302, note: 'code-issued', to: target.hostname });
        ctx.res.writeHead(302, { location: `${target.toString()}${target.toString().includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}` });
        ctx.res.end();
        return undefined;
      },
    },
  ],
});

console.log('Kestrel OAuth broker listening');
process.on('SIGTERM', () => process.exit(0));
