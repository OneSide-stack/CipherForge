/**
 * Vela Retail object storage (training).
 * Deliberate flaw: the backup bucket inherited the public-read ACL of a CDN
 * bucket, exposing database snapshots anonymously.
 */
import { createLabServer } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();

createLabServer({
  labId: 'cloud-bucket-exposure',
  org: 'Vela Retail',
  subtitle: 'object storage console',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { requireAuthForBackups: false },
  validatePolicy(input) {
    const errors = [];
    if (typeof input.requireAuthForBackups !== 'boolean') errors.push('requireAuthForBackups must be a boolean');
    return { ok: errors.length === 0, errors, next: { requireAuthForBackups: input.requireAuthForBackups } };
  },
  seed() {
    return {
      aclKey: 'vela-demo-key-2024',
      buckets: {
        'vela-public': { visibility: 'public', objects: { 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'shipping-policy.txt': 'Standard shipping across the Indian Ocean corridor.\n' } },
        'vela-backups': { visibility: 'public', objects: {
          'README.txt': 'Nightly database snapshots. Access is intended for the platform team only.\n',
          'db-snapshot-2026-10-24.txt': `snapshot=ok\nrows=184223\ninternal_marker=${FLAGS['backup-flag'] ?? 'unavailable'}\n`,
          'billing-export.csv': 'invoice,total\nINV-1,240\n',
        } },
      },
    };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        const buckets = Object.entries(ctx.data.buckets).map(([name, b]) => `<div class="card"><h3>${name}</h3><p class="muted">visibility: ${b.visibility}</p><p><a href="/storage/${name}">browse →</a></p></div>`).join('');
        ctx.html(200, ctx.page({
          title: 'Storage console',
          body: `<h1>Vela object storage</h1><p class="lead">Buckets backing the storefront, exports and backups.</p><div class="grid">${buckets}</div><div class="banner">The storage console is a training replica. Do not store real data here.</div>`,
        }));
      },
    },
    {
      method: 'GET',
      pattern: '^/storage/[a-z0-9-]+/?$',
      handler(ctx) {
        const bucketName = ctx.url.pathname.split('/')[2];
        const bucket = ctx.data.buckets[bucketName];
        if (!bucket) return ctx.json(404, { error: 'no_such_bucket' });
        if (bucketName === 'vela-backups' && ctx.policy.requireAuthForBackups && ctx.req.headers['x-vela-key'] !== ctx.data.aclKey) {
          ctx.log({ path: ctx.url.pathname, status: 403, note: 'backup-acl-enforced' });
          return ctx.json(403, { error: 'access_denied', message: 'This bucket requires an access key.' });
        }
        ctx.log({ path: ctx.url.pathname, status: 200, bucket: bucketName });
        ctx.json(200, { bucket: bucketName, visibility: bucket.visibility, objects: Object.keys(bucket.objects) });
      },
    },
    {
      method: 'GET',
      pattern: '^/storage/[a-z0-9-]+/[A-Za-z0-9._-]+$',
      handler(ctx) {
        const [, , bucketName, objectName] = ctx.url.pathname.split('/');
        const bucket = ctx.data.buckets[bucketName];
        const body = bucket?.objects[objectName];
        if (body === undefined) return ctx.json(404, { error: 'no_such_object' });
        if (bucketName === 'vela-backups' && ctx.policy.requireAuthForBackups && ctx.req.headers['x-vela-key'] !== ctx.data.aclKey) {
          ctx.log({ path: ctx.url.pathname, status: 403, note: 'backup-object-denied' });
          return ctx.json(403, { error: 'access_denied', message: 'This bucket requires an access key.' });
        }
        ctx.log({ path: ctx.url.pathname, status: 200, object: objectName });
        ctx.res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-vela-bucket': bucketName });
        ctx.res.end(body);
      },
    },
  ],
});

console.log('Vela storage console listening');
process.on('SIGTERM', () => process.exit(0));
