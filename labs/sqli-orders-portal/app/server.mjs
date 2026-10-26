/**
 * Beacon Outfitters order console (training).
 * Deliberate flaw: the status filter is string-concatenated instead of being
 * treated as data, so a quote closes the intended filter.
 */
import { createLabServer, escapeHtml } from '../../_shared/appkit.mjs';

const FLAGS = (() => {
  try { return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}'); } catch { return {}; }
})();

createLabServer({
  labId: 'sqli-orders-portal',
  org: 'Beacon Outfitters',
  subtitle: 'order operations console',
  port: Number(process.env.PORT ?? 8080),
  defaultPolicy: { parameterizedQueries: false },
  validatePolicy(input) {
    const errors = [];
    if (typeof input.parameterizedQueries !== 'boolean') errors.push('parameterizedQueries must be a boolean');
    return { ok: errors.length === 0, errors, next: { parameterizedQueries: input.parameterizedQueries } };
  },
  seed() {
    return {
      orders: [
        { id: 'ORD-1001', status: 'shipped', customer: 'R. Patel', total: 128.4, note: 'standard dispatch' },
        { id: 'ORD-1002', status: 'processing', customer: 'M. Chen', total: 64.0, note: 'gift wrap' },
        { id: 'ORD-9001', status: 'restricted', customer: 'internal ledger', total: 0, note: `payout marker ${FLAGS['orders-flag'] ?? 'unavailable'}` },
        { id: 'ORD-1003', status: 'shipped', customer: 'A. Silva', total: 212.9, note: 'freight forward' },
      ],
    };
  },
  routes: [
    {
      method: 'GET',
      path: '/',
      handler(ctx) {
        ctx.html(200, ctx.page({
          title: 'Order console',
          body: `<h1>Beacon order console</h1><p class="lead">Filter fulfilment orders by status.</p>
          <div class="card"><h3>Query</h3><pre>GET /api/orders?status=shipped</pre></div>
          <div class="card"><h3>Known statuses</h3><pre>shipped, processing</pre></div>
          <div class="banner">Training replica. Order data is fictional.</div>`,
        }));
      },
    },
    {
      method: 'GET',
      path: '/api/health',
      handler(ctx) {
        ctx.json(200, { status: 'ok', service: 'beacon-orders', policy: ctx.policy });
      },
    },
    {
      method: 'GET',
      path: '/api/orders',
      handler(ctx) {
        const status = ctx.url.searchParams.get('status') ?? '';
        const injected = !ctx.policy.parameterizedQueries && /'/.test(status);
        if (injected && /or\s+'?1'?\s*=\s*'?1/i.test(status)) {
          ctx.log({ path: '/api/orders', status: 200, note: 'filter-bypassed', query: status.slice(0, 120) });
          return ctx.json(200, { query: status, rows: ctx.data.orders, warning: 'unfiltered result set' });
        }
        if (injected) {
          ctx.log({ path: '/api/orders', status: 500, note: 'unterminated-string' });
          return ctx.json(500, { error: 'query_error', message: 'unterminated quoted string in filter' });
        }
        const rows = ctx.data.orders.filter((o) => o.status === status);
        ctx.log({ path: '/api/orders', status: 200, rows: rows.length, query: status.slice(0, 120) });
        ctx.json(200, { query: status, rows });
      },
    },
    {
      method: 'GET',
      path: '/orders',
      handler(ctx) {
        const rows = ctx.data.orders.filter((o) => o.status !== 'restricted');
        ctx.html(200, ctx.page({
          title: 'Orders',
          body: `<h1>Fulfilment queue</h1><table>${rows
            .map((o) => `<tr><td>${escapeHtml(o.id)}</td><td>${escapeHtml(o.status)}</td><td>${escapeHtml(o.customer)}</td><td>${o.total}</td></tr>`)
            .join('')}</table>`,
        }));
      },
    },
  ],
});

console.log('Beacon order console listening');
process.on('SIGTERM', () => process.exit(0));
