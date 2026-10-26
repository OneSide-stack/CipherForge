/**
 * Halcyon Freight import service (training).
 * Deliberate flaw: the importer fetches any URL a caller supplies, including
 * the cloud metadata service bound to the loopback interface.
 */
import http from 'node:http';
import { createLabServer, escapeHtml } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();

// Internal metadata service. It is never published on the gateway: only code
// running inside this session can reach it.
const META_PORT = Number(process.env.CF_META_PORT ?? 9090);
const metadata = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://metadata.local');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/latest/meta-data/instance-id') return res.end(JSON.stringify({ instanceId: 'i-0f2c8a91' }));
  if (url.pathname === '/latest/meta-data/iam/security-credentials/freight-importer') {
    return res.end(JSON.stringify({ accessKeyId: 'ASIA-HALCYON-DEMO', secretAccessKey: 'synthetic', token: FLAGS['metadata-flag'] ?? 'unavailable' }));
  }
  if (url.pathname === '/latest/meta-data/') return res.end(JSON.stringify({ paths: ['instance-id', 'iam/security-credentials/freight-importer'] }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found' }));
});
metadata.listen(META_PORT, '127.0.0.1');

createLabServer({
  labId: 'ssrf-metadata-hunt',
  org: 'Halcyon Freight',
  subtitle: 'document import service',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { allowlistUrls: false },
  validatePolicy(input) {
    const errors = [];
    if (typeof input.allowlistUrls !== 'boolean') errors.push('allowlistUrls must be a boolean');
    return { ok: errors.length === 0, errors, next: { allowlistUrls: input.allowlistUrls } };
  },
  seed() {
    return { allowedHosts: ['docs.halcyonfreight.example'], imported: [] };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        ctx.html(200, ctx.page({
          title: 'Import service',
          body: `<h1>Halcyon document importer</h1><p class="lead">Fetch a supplier document and store it locally.</p>
          <div class="card"><h3>Import</h3><pre>POST /api/import
{ "url": "https://docs.halcyonfreight.example/rates.pdf" }</pre></div>
          <div class="card"><h3>Imported</h3><pre>GET /api/imports</pre></div>
          <div class="banner">Training replica. Cloud metadata and credentials are synthetic.</div>`,
        }));
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      handler(ctx) {
        ctx.json(200, { status: 'ok', service: 'halcyon-importer', policy: ctx.policy });
      },
    },
    {
      method: 'POST',
      path: '/api/import',
      handler(ctx) {
        let body = {};
        try { body = JSON.parse(ctx.body || '{}'); } catch { return ctx.json(400, { error: 'invalid_json' }); }
        let target;
        try {
          target = new URL(String(body.url ?? ''));
        } catch {
          return ctx.json(400, { error: 'invalid_url' });
        }
        if (!['http:', 'https:'].includes(target.protocol)) return ctx.json(400, { error: 'unsupported_scheme' });
        const allowed = ctx.data.allowedHosts.includes(target.hostname);
        if (ctx.policy.allowlistUrls && !allowed) {
          ctx.log({ path: '/api/import', status: 403, host: target.hostname, note: 'allowlist-enforced' });
          return ctx.json(403, { error: 'host_not_allowed', allowedHosts: ctx.data.allowedHosts });
        }
        const detail = fetch(target.toString(), { signal: AbortSignal.timeout(4000) })
          .then(async (res) => ({ status: res.status, body: (await res.text()).slice(0, 4000) }))
          .catch((err) => ({ status: 0, body: `fetch failed: ${err.message}` }));
        return detail.then((result) => {
          ctx.data.imported.unshift({ url: target.toString(), status: result.status, at: new Date().toISOString() });
          ctx.log({ path: '/api/import', status: result.status || 502, host: target.hostname, note: allowed ? 'allowlisted' : 'unlisted-host' });
          if (!result.status) return ctx.json(502, { error: 'fetch_failed', detail: result.body });
          ctx.json(200, { url: target.toString(), upstreamStatus: result.status, body: result.body });
        });
      },
    },
    {
      method: 'GET',
      path: '/api/imports',
      handler(ctx) {
        ctx.json(200, { allowedHosts: ctx.data.allowedHosts, imported: ctx.data.imported.slice(0, 10) });
      },
    },
    {
      method: 'GET',
      path: '/supplier-rates',
      handler(ctx) {
        ctx.html(200, ctx.page({ title: 'Supplier rates', body: `<h1>Supplier rates</h1><p>${escapeHtml('Sample lane rates are filed in the shared drive.')}</p>` }));
      },
    },
  ],
});

console.log('Halcyon importer listening');
process.on('SIGTERM', () => { metadata.close(); process.exit(0); });
