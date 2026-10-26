/**
 * CipherForge lab application kit.
 *
 * Every intentionally vulnerable target app is an ordinary Node HTTP service
 * built on this kit. The kit provides:
 *   - deterministic per-session data + secrets derived from the session secret
 *   - real HTTP request handling, logging and an authenticated admin API
 *   - policy storage/validation used by remediation exercises
 *   - consistent fictional branding
 *
 * Nothing here fakes a service: apps run as real processes inside the lab
 * session network and are only reachable through the authenticated gateway
 * (or from the workspace over the per-session private network).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LAB_DIR = process.env.CF_LAB_DIR ?? '/lab';

export function hmac(secret, purpose) {
  return crypto.createHmac('sha256', secret).update(purpose).digest('hex');
}

export function deriveSecret(secret, purpose, length = 32) {
  return hmac(secret, purpose).slice(0, length);
}

/** Per-session admin credential for `labctl` and remediation API calls. */
export function adminToken(secret) {
  return deriveSecret(secret, 'admin-token', 48);
}

/** Deterministic per-session data seeding (same values for provisioner + app). */
export function makeRng(secret, salt) {
  let state = parseInt(hmac(secret, `rng:${salt}`).slice(0, 8), 16) >>> 0;
  return function rng() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

export function intBetween(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

export function flagFor(secret, labId, objectiveId) {
  return `CF{${hmac(secret, `flag:${labId}:${objectiveId}`).slice(0, 32)}}`;
}

export function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

export function html(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers });
  res.end();
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function page({ org, title, subtitle, body, nav = '', accent = '#38e8ff', footer = '' }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(org)}</title>
<style>
  :root{--accent:${accent};--bg:#0a1018;--panel:#0f1824;--text:#dbe7f3;--mut:#8aa0b6;--line:#1c2c3d}
  *{box-sizing:border-box}body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,color-mix(in srgb,var(--accent) 14%,transparent),transparent),var(--bg);color:var(--text);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh}
  header{display:flex;align-items:center;gap:14px;padding:18px 28px;border-bottom:1px solid var(--line);background:rgba(10,16,24,.72);backdrop-filter:blur(8px);position:sticky;top:0;z-index:10}
  .logo{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;font-weight:800;color:#04121a;background:linear-gradient(135deg,var(--accent),#8b5cf6);font-size:15px}
  header b{font-size:15px;letter-spacing:.2px}header span{color:var(--mut);font-size:12px}
  nav{margin-left:auto;display:flex;gap:16px;flex-wrap:wrap}nav a{color:var(--mut);text-decoration:none;font-size:13px}nav a:hover{color:var(--accent)}
  main{max-width:1060px;margin:0 auto;padding:34px 24px 80px}
  h1{font-size:30px;margin:0 0 6px;letter-spacing:-.5px}h2{font-size:19px;margin:30px 0 10px}
  .lead{color:var(--mut);margin:0 0 26px;max-width:70ch}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
  .card{background:linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.01));border:1px solid var(--line);border-radius:14px;padding:18px}
  .card h3{margin:0 0 8px;font-size:15px}.muted{color:var(--mut);font-size:13px}
  code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#07101a;border:1px solid var(--line);border-radius:8px}
  code{padding:1px 6px;font-size:13px}pre{padding:14px;overflow:auto;font-size:13px;line-height:1.5}
  table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line)}
  th{color:var(--mut);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.6px}
  .pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:11px;border:1px solid var(--line);color:var(--mut)}
  .pill.ok{color:#5ad1a8;border-color:#1d5c48;background:#0b2a21}.pill.bad{color:#ff7b8a;border-color:#5c1d27;background:#2a0b10}
  form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  input,select,textarea,button{font:inherit;color:var(--text);background:#07101a;border:1px solid var(--line);border-radius:9px;padding:9px 12px}
  button{background:linear-gradient(135deg,var(--accent),#7c5cff);color:#04121a;font-weight:700;cursor:pointer;border:0}
  button.ghost{background:#0d1a26;color:var(--text);border:1px solid var(--line);font-weight:500}
  a{color:var(--accent)}.banner{margin-top:26px;padding:14px 16px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.02);font-size:13px;color:var(--mut)}
  footer{color:var(--mut);font-size:12px;padding:26px;text-align:center;border-top:1px solid var(--line)}
  .kpis{display:flex;gap:22px;flex-wrap:wrap;margin:10px 0 4px}.kpi b{font-size:23px;display:block}.kpi span{color:var(--mut);font-size:12px}
</style></head><body>
<header><div class="logo">${escapeHtml(org.slice(0, 2).toUpperCase())}</div><div><b>${escapeHtml(org)}</b><br><span>${escapeHtml(subtitle)}</span></div>${nav ? `<nav>${nav}</nav>` : ''}</header>
<main>${body}</main>
<footer>${footer || 'Fictional training environment · CipherForge Academy · All data is synthetic'}</footer>
</body></html>`;
}

/**
 * Create a lab HTTP service.
 *
 * spec:
 *   labId, org, secret, port
 *   defaultPolicy       : object returned by GET /admin/policy
 *   validatePolicy      : (policy, current) => {ok, errors[], next}
 *   audit               : (ctx) => object (real observations)
 *   routes              : [{method, path, handler(ctx)}]  (learner-facing)
 *   seed                : (secret) => data used by handlers
 */
export function createLabServer(spec) {
  // Least privilege: the session HMAC secret is never present in target apps.
  const appSeed = spec.secret ?? process.env.CF_APP_SEED ?? '';
  const port = Number(spec.port ?? process.env.PORT ?? 8080);
  const token = process.env.CF_ADMIN_TOKEN ?? adminToken(appSeed);
  const flags = (() => {
    try {
      return JSON.parse(process.env.CF_FLAGS_JSON ?? '{}');
    } catch {
      return {};
    }
  })();
  const startedAt = new Date();
  const data = spec.seed ? spec.seed(appSeed) : {};
  const policy = spec.defaultPolicy ? structuredClone(spec.defaultPolicy) : {};
  const requestLog = [];
  const logDir = process.env.CF_LOG_DIR;
  if (logDir) fs.mkdirSync(logDir, { recursive: true });
  let seq = 0;

  function countRows(rows) {
    if (Array.isArray(rows)) return rows.map((r) => `${r.method} ${r.path}`);
    return Object.entries(rows ?? {}).map(([k, v]) => `${k} ${Array.isArray(v) ? v.length : '?'}`);
  }

  function record(entry) {
    seq += 1;
    const line = { seq, at: new Date().toISOString(), ...entry };
    requestLog.push(line);
    if (requestLog.length > 500) requestLog.shift();
    if (logDir) {
      try {
        fs.appendFileSync(path.join(logDir, `${spec.labId}.access.log`), `${JSON.stringify(line)}\n`);
      } catch {}
    }
    return line;
  }

  function ctxFor(req, res, url, body) {
    return {
      req,
      res,
      url,
      body,
      data,
      appSeed,
      flags,
      labId: spec.labId,
      log: (entry) => record(entry),
      policy,
      json: (status, obj, headers) => json(res, status, obj, headers),
      html: (status, htmlBody, headers) => html(res, status, htmlBody, headers),
      page: (opts) => page({ org: spec.org, subtitle: spec.subtitle ?? 'training environment', ...opts }),
      cookies: parseCookies(req.headers.cookie ?? ''),
      adminOk: () => timingSafeEqual(req.headers['x-lab-admin-token'] ?? '', token),
      token,
      ctx: data,
    };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'lab.local'}`);
    let body = '';
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) body = await readBody(req);
    } catch {
      return json(res, 413, { error: 'request_too_large' });
    }
    const ctx = ctxFor(req, res, url, body);
    // Edge-style header policy applies to every response, including errors and
    // HEAD probes. Learners verify this with `curl -sI`.
    for (const [name, value] of Object.entries(policy.headers ?? {})) res.setHeader(name, value);
    record({ method: req.method, path: url.pathname, query: url.search, ua: req.headers['user-agent'] ?? '', status: null });

    // Shared administrative plane.
    if (url.pathname.startsWith('/admin/')) {
      if (!ctx.adminOk()) {
        record({ method: req.method, path: url.pathname, status: 401, note: 'admin-auth-required' });
        return json(res, 401, { error: 'admin_credential_required', hint: 'use labctl with ~/.lab/admin.token' });
      }
      if (url.pathname === '/admin/status' && req.method === 'GET') {
        return json(res, 200, {
          lab: spec.labId,
          service: process.env.CF_SERVICE ?? 'target',
          startedAt: startedAt.toISOString(),
          uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
          policy,
          dataSets: countRows(data),
        });
      }
      if (url.pathname === '/admin/policy' && req.method === 'GET') return json(res, 200, { policy });
      if (url.pathname === '/admin/policy' && req.method === 'PUT') {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json(res, 400, { error: 'invalid_json' });
        }
        const result = spec.validatePolicy(parsed, policy);
        if (!result.ok) {
          record({ method: 'PUT', path: '/admin/policy', status: 422, note: 'policy-rejected' });
          return json(res, 422, { error: 'policy_rejected', issues: result.errors });
        }
        for (const key of Object.keys(policy)) delete policy[key];
        Object.assign(policy, result.next ?? parsed);
        record({ method: 'PUT', path: '/admin/policy', status: 200, note: 'policy-applied' });
        return json(res, 200, { applied: true, policy, effectiveAt: new Date().toISOString() });
      }
      if (url.pathname === '/admin/audit' && req.method === 'POST') {
        const findings = await spec.audit({ ctx, policy, data, req });
        return json(res, 200, { auditedAt: new Date().toISOString(), target: spec.org, findings });
      }
      if (url.pathname === '/admin/requests' && req.method === 'GET') return json(res, 200, { requests: requestLog.slice(-50) });
      return json(res, 404, { error: 'not_found' });
    }

    const effectiveMethod = req.method === 'HEAD' ? 'GET' : req.method;
    const route = (spec.routes ?? []).find(
      (r) => r.method === effectiveMethod && (r.path === url.pathname || (r.pattern && new RegExp(r.pattern).test(url.pathname))),
    );
    if (!route) {
      record({ method: req.method, path: url.pathname, status: 404 });
      return json(res, 404, { error: 'not_found', service: spec.labId });
    }
    try {
      for (const [k, v] of Object.entries(route.headers ?? {})) res.setHeader(k, v);
      // Node's http server automatically suppresses response bodies for HEAD.
            await route.handler(ctx, url);
    } catch (err) {
      record({ method: req.method, path: url.pathname, status: 500, note: String(err.message) });
      if (!res.headersSent) json(res, 500, { error: 'internal_error', message: 'The service encountered an error.' });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[${spec.labId}] ${spec.org} listening on ${port}`);
  });
  server.on('clientError', (err, socket) => socket.destroy());
  process.on('SIGTERM', () => server.close());
  return { server, data, policy, token, appSeed, flags };
}

export function requireJson(req) {
  return String(req.headers['content-type'] ?? '').includes('application/json');
}

export function fileExists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readJsonFile(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonFile(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}
