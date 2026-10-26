/**
 * Lumen Health patient billing portal (training).
 * Deliberate flaw: /api/invoices/:id authenticates the caller but never checks
 * that the invoice belongs to them (IDOR). Remediation is a real policy switch
 * applied through the authenticated admin API.
 */
import { createLabServer, escapeHtml, parseCookies, redirect, page } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();
const ORG = 'Lumen Health';

const server = createLabServer({
  labId: 'idor-invoice-hunt',
  org: ORG,
  subtitle: 'patient billing portal',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { enforceOwnership: false },
  validatePolicy(input) {
    const errors = [];
    if (typeof input.enforceOwnership !== 'boolean') errors.push('enforceOwnership must be a boolean');
    return { ok: errors.length === 0, errors, next: { enforceOwnership: input.enforceOwnership } };
  },
  seed() {
    const users = new Map([
      ['analyst@lumenhealth.example', { id: 'u-104', name: 'Priya Raman', password: 'lumen2024' }],
      ['finance@lumenhealth.example', { id: 'u-777', name: 'Marcus Vale', password: 'lumen2024' }],
    ]);
    const invoices = [
      { id: 'INV-1041', owner: 'u-104', patient: 'Priya Raman', amount: 240, service: 'Cardiology follow-up', memo: 'Insurance claim approved.' },
      { id: 'INV-1042', owner: 'u-104', patient: 'Priya Raman', amount: 90, service: 'Pathology panel', memo: 'Routine screening.' },
      { id: 'INV-1099', owner: 'u-777', patient: 'Marcus Vale', amount: 18900, service: 'Executive health assessment', memo: `Internal billing export token: ${FLAGS['invoice-flag'] ?? 'unavailable'}` },
      { id: 'INV-1100', owner: 'u-777', patient: 'Marcus Vale', amount: 320, service: 'Physiotherapy', memo: 'Session package.' },
    ];
    return { users, invoices, sessions: new Map() };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        ctx.html(200, ctx.page({ title: 'Patient portal', body: `<h1>Care, without the paperwork.</h1><p class="lead">Billing and records for Lumen Health patients.</p><div class="grid"><div class="card"><h3>Patient sign in</h3><p class="muted">Review invoices and insurance claims.</p><p><a href="/login">Sign in →</a></p></div><div class="card"><h3>Billing support</h3><p class="muted">Questions about a claim? Our team replies within one business day.</p></div></div><div class="banner">Training instance. Demo account is in <code>~/credentials.txt</code>.</div>` }));
      },
    },
    {
      method: 'GET',
      path: '/login',
      handler(ctx) {
        ctx.html(200, ctx.page({
          title: 'Sign in',
          body: `<h1>Patient sign in</h1><p class="lead">Use the training account from your workspace.</p>${ctx.url.searchParams.get('error') ? '<p class="pill bad">Invalid credentials</p>' : ''}
          <form method="POST" action="/login"><input name="email" placeholder="email" autocomplete="username" required><input name="password" type="password" placeholder="password" required><button>Sign in</button></form>`,
        }));
      },
    },
    {
      method: 'POST',
      path: '/login',
      handler(ctx) {
        const form = new URLSearchParams(ctx.body);
        const email = String(form.get('email') ?? '').toLowerCase();
        const password = String(form.get('password') ?? '');
        const user = ctx.data.users.get(email);
        if (!user || user.password !== password) return redirect(ctx.res, '/login?error=1');
        const sid = `lh_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
        ctx.data.sessions.set(sid, user.id);
        ctx.log({ event: 'auth.login', account: email, result: 'success' });
        return redirect(ctx.res, '/app/invoices', { 'set-cookie': `lh_session=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      },
    },
    {
      method: 'GET',
      path: '/app/invoices',
      handler(ctx) {
        const sid = parseCookies(ctx.req.headers.cookie ?? '').lh_session;
        const uid = ctx.data.sessions.get(sid);
        if (!uid) return redirect(ctx.res, '/login');
        const rows = ctx.data.invoices.filter((i) => i.owner === uid);
        ctx.html(200, ctx.page({
          title: 'Your invoices',
          body: `<h1>Hello, ${escapeHtml(ctx.data.users.get('analyst@lumenhealth.example').name.split(' ')[0])}</h1><p class="lead">Invoices billed to your account.</p>
          <table><tr><th>Invoice</th><th>Service</th><th>Amount</th><th /></tr>${rows.map((i) => `<tr><td>${i.id}</td><td>${escapeHtml(i.service)}</td><td>$${i.amount}</td><td><a href="/api/invoices/${i.id}">view</a></td></tr>`).join('')}</table>
          <div class="banner">Audit note: invoice API calls are logged with the authenticated account id.</div>`,
          nav: '<a href="/app/invoices">Invoices</a><a href="/">Home</a>',
        }));
      },
    },
    {
      method: 'GET',
      pattern: '^/api/invoices/[A-Za-z0-9-]+$',
      handler(ctx) {
        const sid = parseCookies(ctx.req.headers.cookie ?? '').lh_session;
        const uid = ctx.data.sessions.get(sid);
        if (!uid) return ctx.json(401, { error: 'authentication_required' });
        const id = ctx.url.pathname.split('/').pop();
        const invoice = ctx.data.invoices.find((i) => i.id === id);
        if (!invoice) return ctx.json(404, { error: 'invoice_not_found' });
        if (ctx.policy.enforceOwnership && invoice.owner !== uid) {
          ctx.log({ method: 'GET', path: ctx.url.pathname, status: 403, note: 'ownership-enforced' });
          return ctx.json(403, { error: 'forbidden', message: 'This invoice belongs to another patient.' });
        }
        ctx.log({ method: 'GET', path: ctx.url.pathname, status: 200, note: `owner=${invoice.owner} caller=${uid}` });
        ctx.json(200, { invoice });
      },
    },
    {
      method: 'GET',
      pattern: '^/app/invoices/[A-Za-z0-9-]+$',
      handler(ctx) {
        const sid = parseCookies(ctx.req.headers.cookie ?? '').lh_session;
        const uid = ctx.data.sessions.get(sid);
        if (!uid) return redirect(ctx.res, '/login');
        const invoice = ctx.data.invoices.find((i) => i.id === ctx.url.pathname.split('/').pop());
        if (!invoice) return ctx.html(404, ctx.page({ title: 'Not found', body: '<h1>Invoice not found</h1>' }));
        ctx.html(200, ctx.page({
          title: `Invoice ${invoice.id}`,
          body: `<h1>Invoice ${invoice.id}</h1><p class="lead">${escapeHtml(invoice.service)} · ${escapeHtml(invoice.patient)}</p>
          <div class="card"><p class="muted">Amount</p><p style="font-size:28px">$${invoice.amount}</p><p class="muted">${escapeHtml(invoice.memo)}</p></div>`,
          nav: '<a href="/app/invoices">Back</a>',
        }));
      },
    },
  ],
});

console.log(`${ORG} portal started on ${server.server.address()?.port ?? 8080}`);
process.on('SIGTERM', () => process.exit(0));
