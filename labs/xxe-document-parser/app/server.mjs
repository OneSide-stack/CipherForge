/**
 * Arclight billing document parser (training).
 * Deliberate flaw: the XML parser resolves external entities, so a document can
 * read files from the parser's document store (which holds service secrets).
 */
import { createLabServer, escapeHtml } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();

// The parser's document store. The secrets file is only reachable through
// entity resolution; no HTTP route serves it.
const DOCUMENTS = {
  '/srv/arclight/docs/invoice-template.xml': '<invoice><line>consulting</line></invoice>',
  '/srv/arclight/docs/terms.txt': 'Payment due within 30 days.\n',
  '/srv/arclight/secrets/billing.env': `ARCLIGHT_BILLING_TOKEN=${FLAGS['xxe-flag'] ?? 'unavailable'}\n`,
};

function resolveEntities(xml, policy) {
  const out = [];
  const entityRe = /<!ENTITY\s+(\w+)\s+SYSTEM\s+["']([^"']+)["']\s*>/g;
  let match;
  while ((match = entityRe.exec(xml))) {
    const [, name, uri] = match;
    if (policy.allowDoctype === false) continue;
    const path = uri.replace(/^file:\/\//, '');
    const content = DOCUMENTS[path];
    out.push({ name, uri, path, resolved: content !== undefined, content: content ?? '' });
  }
  return out;
}

createLabServer({
  labId: 'xxe-document-parser',
  org: 'Arclight Billing',
  subtitle: 'invoice document intake',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { allowDoctype: true },
  validatePolicy(input) {
    const errors = [];
    if (typeof input.allowDoctype !== 'boolean') errors.push('allowDoctype must be a boolean');
    return { ok: errors.length === 0, errors, next: { allowDoctype: input.allowDoctype } };
  },
  seed() {
    return { parsed: [] };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        ctx.html(200, ctx.page({
          title: 'Invoice intake',
          body: `<h1>Arclight invoice intake</h1><p class="lead">POST an XML invoice for normalisation.</p>
          <div class="card"><h3>Submit</h3><pre>POST /api/documents/parse
Content-Type: application/xml

&lt;invoice&gt;&lt;line&gt;consulting&lt;/line&gt;&lt;/invoice&gt;</pre></div>
          <div class="banner">Training replica. Tokens and invoices are synthetic.</div>`,
        }));
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      handler(ctx) {
        ctx.json(200, { status: 'ok', service: 'arclight-parser', policy: ctx.policy });
      },
    },
    {
      method: 'POST',
      path: '/api/documents/parse',
      handler(ctx) {
        const xml = String(ctx.body ?? '');
        if (!xml.trim().startsWith('<')) return ctx.json(400, { error: 'expected_xml' });
        const entities = resolveEntities(xml, ctx.policy);
        const doctypeRejected = ctx.policy.allowDoctype === false && /<!DOCTYPE/i.test(xml);
        ctx.data.parsed.unshift({ at: new Date().toISOString(), bytes: xml.length, entities: entities.length });
        ctx.log({ path: '/api/documents/parse', status: doctypeRejected ? 400 : 200, entities: entities.length, doctype: /<!DOCTYPE/i.test(xml) });
        if (doctypeRejected) return ctx.json(400, { error: 'doctype_rejected', message: 'Document type declarations are not accepted.' });
        ctx.json(200, { parsed: true, entities, note: 'entities were resolved against the document store' });
      },
    },
    {
      method: 'GET',
      path: '/docs/template',
      handler(ctx) {
        ctx.html(200, ctx.page({ title: 'Template', body: `<h1>Invoice template</h1><pre>${escapeHtml(DOCUMENTS['/srv/arclight/docs/invoice-template.xml'])}</pre>` }));
      },
    },
  ],
});

console.log('Arclight parser listening');
process.on('SIGTERM', () => process.exit(0));
