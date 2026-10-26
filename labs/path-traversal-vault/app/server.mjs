/**
 * Atlas Logistics document portal (training).
 * Deliberate flaw: the download endpoint concatenates user input onto a base
 * directory and normalises it without checking the final location.
 */
import path from 'node:path';
import { createLabServer, escapeHtml, page } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();

const PUBLIC_DOCS = {
  'readme.txt': 'Atlas Logistics partner document portal.\nAll documents are synthetic training data.\n',
  'onboarding.txt': 'Partner onboarding checklist:\n1. Verify contact details\n2. Sign the data processing addendum\n3. Request portal access\n',
  'pricing-2024.txt': 'Container lane pricing is available from your account manager.\n',
};
const INTERNAL_DOCS = {
  'flag.txt': `Atlas internal marker: ${FLAGS['vault-flag'] ?? 'unavailable'}\n`,
  'staff-contacts.txt': 'ops@atlaslogistics.example\nsecurity@atlaslogistics.example\n',
};

createLabServer({
  labId: 'path-traversal-vault',
  org: 'Atlas Logistics',
  subtitle: 'partner document portal',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { blockTraversal: false },
  validatePolicy(input) {
    const errors = [];
    if (typeof input.blockTraversal !== 'boolean') errors.push('blockTraversal must be a boolean');
    return { ok: errors.length === 0, errors, next: { blockTraversal: input.blockTraversal } };
  },
  seed() {
    return { downloads: 0 };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        ctx.html(200, ctx.page({
          title: 'Partner portal',
          body: `<h1>Partner document library</h1><p class="lead">Download the latest logistics paperwork for your lane.</p>
          <div class="grid">
            <div class="card"><h3>readme.txt</h3><p class="muted">Portal overview</p><p><a href="/docs?file=readme.txt">Download</a></p></div>
            <div class="card"><h3>onboarding.txt</h3><p class="muted">Partner onboarding steps</p><p><a href="/docs?file=onboarding.txt">Download</a></p></div>
            <div class="card"><h3>pricing-2024.txt</h3><p class="muted">Lane pricing notes</p><p><a href="/docs?file=pricing-2024.txt">Download</a></p></div>
          </div>
          <div class="banner">Downloads are resolved on the server. Report anything unusual to security@atlaslogistics.example.</div>`,
          nav: '<a href="/">Documents</a>',
        }));
      },
    },
    {
      method: 'GET',
      path: '/docs',
      handler(ctx) {
        const file = String(ctx.url.searchParams.get('file') ?? '');
        if (!file) return ctx.json(400, { error: 'missing_file', usage: '/docs?file=readme.txt' });
        // Deliberate weakness: normalisation happens after the join, with no
        // containment check. The fix policy rejects traversal segments.
        if (ctx.policy.blockTraversal && (file.includes('..') || path.isAbsolute(file))) {
          ctx.log({ path: '/docs', file, status: 400, note: 'traversal-blocked' });
          return ctx.json(400, { error: 'invalid_path', message: 'File name is not allowed.' });
        }
        const resolved = path.posix.normalize(`public/${file}`);
        const [bucket, ...rest] = resolved.split('/');
        const name = rest.join('/');
        const content = bucket === 'public' ? PUBLIC_DOCS[name] : bucket === 'internal' ? INTERNAL_DOCS[name] : undefined;
        if (content === undefined) {
          ctx.log({ path: '/docs', file, status: 404 });
          return ctx.json(404, { error: 'document_not_found', requested: file });
        }
        ctx.data.downloads += 1;
        ctx.log({ path: '/docs', file, status: 200, resolved });
        ctx.res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-document-path': resolved });
        ctx.res.end(content);
      },
    },
  ],
});

console.log('Atlas Logistics portal listening');
process.on('SIGTERM', () => process.exit(0));
