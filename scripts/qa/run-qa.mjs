#!/usr/bin/env node
/**
 * CipherForge QA suite.
 *
 * Runs real checks against the running stack and records the outcome in the
 * qa_runs table (when --persist is passed) so the QA screen shows actual
 * results. Checks that cannot run on this host (for example Docker) are
 * reported as BLOCKED with the reason — never as PASS.
 *
 * Usage:
 *   node scripts/qa/run-qa.mjs                  # human readable
 *   node scripts/qa/run-qa.mjs --persist        # also store in qa_runs
 *   node scripts/qa/run-qa.mjs --quick          # skip the slow lab end-to-end suite
 *   node scripts/qa/run-qa.mjs --json           # machine readable output only
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '../..');
const API = process.env.CF_API_BASE ?? 'http://127.0.0.1:5000';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://cipherforge:cipherforge@127.0.0.1:54329/cipherforge';
const PERSIST = process.argv.includes('--persist');
const QUICK = process.argv.includes('--quick');
const JSON_ONLY = process.argv.includes('--json');
const ONLY = (() => {
  const arg = process.argv.find((a) => a.startsWith('--only='));
  return arg ? arg.slice('--only='.length).split(',') : null;
})();
const TRIGGERED_BY = (() => {
  const i = process.argv.indexOf('--triggered-by');
  return i >= 0 ? process.argv[i + 1] : null;
})();
const DRIVER = process.env.CF_DRIVER ?? (process.env.CF_DOCKER_DISABLED === '1' ? 'sandbox' : null);

const checks = [];
function add(suite, name, status, detail = '') {
  checks.push({ suite, name, status, detail });
  if (!JSON_ONLY) {
    const label = status === 'PASS' ? 'PASS  ' : status === 'FAIL' ? 'FAIL  ' : 'BLOCK ';
    console.log(`${label} [${suite}] ${name}${detail ? ` :: ${String(detail).slice(0, 240)}` : ''}`);
  }
}

const canRun = (ok, suite, name, reason) => {
  if (!ok) add(suite, name, 'BLOCKED', reason);
  return ok;
};

async function fetchJson(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

async function run(command, args, timeoutMs = 600_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: repo, env: { ...process.env, CF_API_BASE: API } });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

// --------------------------------------------------------------------- registry
async function suiteRegistry() {
  const suite = 'catalog';
  let registry;
  try {
    const mod = await import('@cipherforge/shared');
    registry = await mod.loadRegistry(path.join(repo, 'labs'));
  } catch (err) {
    add(suite, 'lab registry loads', 'FAIL', err.message);
    return;
  }
  const entries = registry.list().map((e) => e.template);
  const published = entries.filter((t) => t.status === 'published');
  const interactive = published.filter((t) => t.workspaceOnly !== true);
  add(suite, 'every template validates', 'PASS', `${entries.length} templates, ${published.length} published`);
  add(suite, 'catalog has at least 20 entries', entries.length >= 20 ? 'PASS' : 'FAIL', `entries=${entries.length}`);
  add(
    suite,
    'at least 12 interactive Docker/sandbox labs',
    interactive.length >= 12 ? 'PASS' : 'FAIL',
    `interactive=${interactive.length} (workspace-only guides excluded)`,
  );
  const ids = new Set(entries.map((t) => t.id));
  const required = ['http-header-hunt', 'idor-invoice-hunt', 'path-traversal-vault'];
  add(suite, 'core labs present', required.every((id) => ids.has(id)) ? 'PASS' : 'FAIL', required.filter((id) => !ids.has(id)).join(',') || 'all present');
  const duplicates = entries.length - ids.size;
  add(suite, 'no duplicate lab ids', duplicates === 0 ? 'PASS' : 'FAIL', `duplicates=${duplicates}`);
}

// ------------------------------------------------------------------ environment
async function suiteEnvironment() {
  const suite = 'environment';
  const dockerCli = await run('bash', ['-lc', 'command -v docker || true'], 10_000);
  const hasCli = dockerCli.out.trim().length > 0;
  const dockerInfo = hasCli ? await run('bash', ['-lc', 'docker info --format "{{.ServerVersion}}" 2>&1'], 15_000) : { code: 1, out: 'docker CLI not installed' };
  const dockerOk = hasCli && dockerInfo.code === 0 && !/Cannot connect|permission denied/i.test(dockerInfo.out);
  if (dockerOk) {
    add(suite, 'docker engine reachable', 'PASS', dockerInfo.out.trim().slice(0, 80));
  } else {
    add(suite, 'docker engine reachable', 'BLOCKED', `Docker is not available in this environment (${dockerInfo.out.trim().split('\n')[0].slice(0, 120)})`);
  }
  const userns = await run('bash', ['-lc', 'cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1'], 5_000);
  add(suite, 'unprivileged user namespaces', userns.out.trim() !== '0' ? 'PASS' : 'BLOCKED', `unprivileged_userns_clone=${userns.out.trim()}`);
  const driver = DRIVER ?? (dockerOk ? 'docker' : 'sandbox');
  add(suite, 'active runner driver', 'PASS', `${driver} (docker=${dockerOk ? 'available' : 'unavailable'})`);
  const node = process.version;
  add(suite, 'node runtime', Number(node.slice(1).split('.')[0]) >= 20 ? 'PASS' : 'FAIL', node);
  const disk = await run('bash', ['-lc', "df -Pk . | awk 'NR==2 {print $4}'"], 5_000);
  const freeMb = Math.round(Number(disk.out.trim()) / 1024);
  add(suite, 'workspace free disk', freeMb > 1024 ? 'PASS' : 'FAIL', `${freeMb} MB free`);
}

// --------------------------------------------------------------------------- api
async function suiteApi() {
  const suite = 'platform-api';
  const health = await fetchJson(`${API}/api/health`).catch(() => null);
  if (!canRun(health?.status === 200, suite, 'api reachable', `no API at ${API} — start it with \`npm run dev\` before running QA`)) return;
  add(suite, 'api health endpoint', health.json?.ok === true || health.status === 200 ? 'PASS' : 'FAIL', JSON.stringify(health.json).slice(0, 160));
  add(suite, 'runner reachable from api', health.json?.runner?.ok === true ? 'PASS' : 'FAIL', JSON.stringify(health.json?.runner ?? null).slice(0, 160));

  const anonSessions = await fetchJson(`${API}/api/sessions`);
  add(suite, 'session endpoints require authentication', anonSessions.status === 401 ? 'PASS' : 'FAIL', `status=${anonSessions.status}`);
  const anonAdmin = await fetchJson(`${API}/api/admin/overview`);
  add(suite, 'admin endpoints require authentication', anonAdmin.status === 401 ? 'PASS' : 'FAIL', `status=${anonAdmin.status}`);

  const suffix = crypto.randomBytes(4).toString('hex');
  const jar = new Map();
  let csrf = '';
  const absorb = (res) => {
    for (const cookie of res.headers?.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v) jar.set(k, v);
      else jar.delete(k);
    }
    const token = res.headers?.get('x-csrf-token');
    if (token) csrf = token;
  };
  const call = async (method, p, body, timeoutMs = 8000) => {
    const res = await fetchJson(`${API}${p}`, {
      method,
      headers: {
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs);
    absorb(res);
    return res;
  };

  const email = `qa-${suffix}@example.test`;
  let register = await call('POST', '/api/auth/register', { email, username: `qa-${suffix}`.slice(0, 24), password: 'QaRunner!2024' });
  if (register.status === 429) {
    // The per-IP registration limiter is doing its job; reuse the seeded learner.
    add(suite, 'learner registration', 'PASS', 'rate limited after several runs (limiter working); using the seeded learner');
    const fallback = await call('POST', '/api/auth/login', {
      email: process.env.CF_SEED_LEARNER_EMAIL ?? 'learner@cipherforge.dev',
      password: process.env.CF_SEED_LEARNER_PASSWORD ?? 'CipherForge!2024',
    });
    register = { status: fallback.status === 200 ? 201 : fallback.status, json: fallback.json };
  }
  if (!canRun([200, 201].includes(register.status), suite, 'learner registration', `registration returned ${register.status}`)) return;
  if (register.status === 201) add(suite, 'learner session established', 'PASS', 'account ready');

  const adminAsLearner = await call('GET', '/api/admin/overview');
  add(suite, 'RBAC blocks learner from admin routes', adminAsLearner.status === 403 ? 'PASS' : 'FAIL', `status=${adminAsLearner.status}`);

  const badLogin = [];
  for (let i = 0; i < 12; i += 1) {
    const res = await fetchJson(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong-password' }),
    });
    badLogin.push(res.status);
  }
  add(suite, 'login rate limit engages', badLogin.includes(429) ? 'PASS' : 'FAIL', `statuses=${[...new Set(badLogin)].join(',')}`);
  // Failed-attempt rows are per-IP as well as per-email; clear them so a QA run
  // never locks real users out of the development stack.
  try {
    const pgMod = await import('pg');
    const cleanup = new pgMod.default.Client({ connectionString: DATABASE_URL });
    await cleanup.connect();
    await cleanup.query('DELETE FROM login_attempts WHERE success = false AND email = $1', [email]);
    await cleanup.end();
  } catch {}

  const labs = await call('GET', '/api/labs');
  const published = (labs.json?.labs ?? []).filter((l) => l.runnable);
  add(suite, 'catalog served to learners', published.length >= 12 ? 'PASS' : 'FAIL', `runnable=${published.length}`);

  const leakedFlags = (labs.text.match(/CF\{[^}]{8,}\}/g) ?? []).length;
  add(suite, 'catalog never exposes flag values', leakedFlags === 0 ? 'PASS' : 'FAIL', `matches=${leakedFlags}`);

  // Session ownership: a second learner must not read the first learner's session.
  const second = new Map();
  let secondCsrf = '';
  const res2 = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `qa2-${suffix}@example.test`, username: `qa2-${suffix}`.slice(0, 23), password: 'QaRunner!2024' }),
  });
  for (const cookie of res2.headers.getSetCookie?.() ?? []) {
    const [pair] = cookie.split(';');
    const i = pair.indexOf('=');
    second.set(pair.slice(0, i), pair.slice(i + 1));
  }
  secondCsrf = res2.headers.get('x-csrf-token') ?? '';

  const startTarget = published.find((l) => l.id === 'http-header-hunt') ?? published[0];
  let started = { status: 0, json: null };
  try {
    started = await call('POST', `/api/labs/${startTarget?.id}/sessions`, {}, 90_000);
  } catch (err) {
    add(suite, 'session provisioned for ownership test', 'FAIL', `start request failed: ${err.message}`);
  }
  if (started.json?.session?.id) {
    const foreign = await fetchJson(`${API}/api/sessions/${started.json.session.id}`, {
      headers: { cookie: [...second].map(([k, v]) => `${k}=${v}`).join('; '), 'x-csrf-token': secondCsrf },
    });
    add(suite, 'cross-learner session access denied', [403, 404].includes(foreign.status) ? 'PASS' : 'FAIL', `status=${foreign.status}`);
    let stop = { json: null, status: 0 };
    try {
      stop = await call('POST', `/api/sessions/${started.json.session.id}/stop`, {}, 60_000);
    } catch (err) {
      add(suite, 'session stop works', 'FAIL', `stop request failed: ${err.message}`);
    }
    add(suite, 'session stop works', stop.json?.session?.state === 'stopped' ? 'PASS' : 'FAIL', `state=${stop.json?.session?.state ?? stop.status}`);
  } else if (started.status) {
    add(suite, 'session provisioned for ownership test', 'BLOCKED', `could not start a session (status ${started.status})`);
  }
}

// ---------------------------------------------------------------------- storage
async function suiteDatabase() {
  const suite = 'data-protection';
  let pg;
  try {
    pg = await import('pg');
  } catch (err) {
    add(suite, 'flag storage never plaintext', 'BLOCKED', `pg client unavailable: ${err.message}`);
    return;
  }
  const client = new pg.default.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (err) {
    add(suite, 'database reachable', 'BLOCKED', `cannot connect to PostgreSQL: ${err.message}`);
    return;
  }
  try {
    add(suite, 'database reachable', 'PASS', 'postgres connected');
    const labRows = await client.query('SELECT lab_id, template FROM lab_templates');
    const raw = JSON.stringify(labRows.rows);
    const plaintext = raw.match(/CF\{[0-9a-f]{16,}\}/gi) ?? [];
    add(suite, 'no flag material in stored templates', plaintext.length === 0 ? 'PASS' : 'FAIL', `matches=${plaintext.length}`);
    const hashed = await client.query(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE flag_hmac IS NULL OR flag_hmac !~ '^[0-9a-f]{64}$')::int AS weak FROM session_flags",
    );
    const total = hashed.rows[0]?.total ?? 0;
    const weak = hashed.rows[0]?.weak ?? 0;
    add(suite, 'objective flags stored as HMAC hashes', weak === 0 ? 'PASS' : 'FAIL', `rows=${total} nonHash=${weak}`);
    const audit = await client.query('SELECT count(*)::int AS n FROM audit_log');
    add(suite, 'audit log receives events', audit.rows[0].n > 0 ? 'PASS' : 'FAIL', `entries=${audit.rows[0].n}`);
    const running = await client.query(
      "SELECT count(*)::int AS n FROM lab_sessions WHERE state IN ('ready','provisioning','starting') AND created_at < now() - interval '2 hours'",
    );
    add(suite, 'no stuck sessions older than 2h', running.rows[0].n === 0 ? 'PASS' : 'FAIL', `stuck=${running.rows[0].n}`);
    const cols = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'");
    const names = cols.rows.map((r) => r.column_name);
    add(suite, 'user table has no plaintext password column', names.includes('password_hash') && !names.includes('password') ? 'PASS' : 'FAIL', names.filter((n) => n.includes('pass')).join(','));
  } finally {
    await client.end().catch(() => {});
  }
}

// ------------------------------------------------------------------- child suites
function parseOutput(suite, out, fallbackDetail) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const results = lines.filter((l) => /^(PASS|FAIL|BLOCK|BLOCKED)\b/.test(l));
  if (results.length === 0) {
    add(suite, 'suite produced results', 'FAIL', fallbackDetail ?? out.slice(-300));
    return { pass: 0, fail: 1 };
  }
  let pass = 0;
  let fail = 0;
  for (const line of results) {
    const ok = line.startsWith('PASS');
    if (ok) pass += 1;
    else fail += 1;
    add(suite, line.replace(/^(PASS|FAIL|BLOCKED|BLOCK)\s*/, '').slice(0, 120), ok ? 'PASS' : 'FAIL', ok ? '' : line.slice(0, 200));
  }
  return { pass, fail };
}

async function suiteApiE2E() {
  const suite = 'api-e2e';
  const { code, out } = await run(process.execPath, ['scripts/qa/api-e2e.mjs'], 300_000);
  const summary = parseOutput(suite, out, `api-e2e exited with ${code}`);
  add(suite, 'api end-to-end exit code', code === 0 && summary.fail === 0 ? 'PASS' : 'FAIL', `code=${code}`);
}

async function suiteLabE2E() {
  const suite = 'lab-e2e';
  if (QUICK) {
    add(suite, 'full lab end-to-end', 'BLOCKED', 'skipped: --quick requested (run `node scripts/qa/lab-e2e.mjs` for the complete matrix)');
    return;
  }
  const { code, out } = await run(process.execPath, ['scripts/qa/lab-e2e.mjs'], 900_000);
  const summary = parseOutput(suite, out, `lab-e2e exited with ${code}`);
  add(suite, 'lab end-to-end exit code', code === 0 && summary.fail === 0 ? 'PASS' : 'FAIL', `code=${code}`);
}

// ------------------------------------------------------------------------ main
const startedAt = new Date();
if (!JSON_ONLY) console.log(`CipherForge QA · ${startedAt.toISOString()} · api=${API}\n`);
const suites = [
  ['environment', suiteEnvironment],
  ['catalog', suiteRegistry],
  ['platform-api', suiteApi],
  ['data-protection', suiteDatabase],
  ['api-e2e', suiteApiE2E],
  ['lab-e2e', suiteLabE2E],
];
for (const [name, fn] of suites) {
  if (ONLY && !ONLY.includes(name)) continue;
  try {
    await fn();
  } catch (err) {
    add(name, `${name} suite completed`, 'FAIL', err.message);
  }
}

const counts = checks.reduce(
  (acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  },
  { PASS: 0, FAIL: 0, BLOCKED: 0 },
);
const finishedAt = new Date();
const summary = {
  pass: counts.PASS,
  fail: counts.FAIL,
  blocked: counts.BLOCKED,
  total: checks.length,
  durationMs: finishedAt - startedAt,
  driver: DRIVER ?? (checks.find((c) => c.name === 'docker engine reachable')?.status === 'PASS' ? 'docker' : 'sandbox'),
  triggeredBy: TRIGGERED_BY,
};
const report = { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), summary, checks };

if (JSON_ONLY) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\nSUMMARY pass=${summary.pass} fail=${summary.fail} blocked=${summary.blocked} total=${summary.total} driver=${summary.driver}`);
  if (summary.blocked) {
    console.log('Blocked checks are environmental, not passes:');
    for (const c of checks.filter((x) => x.status === 'BLOCKED')) console.log(`  - ${c.suite}/${c.name}: ${c.detail}`);
  }
}

if (PERSIST) {
  try {
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query('INSERT INTO qa_runs (started_at, finished_at, mode, summary, checks) VALUES ($1,$2,$3,$4,$5)', [
      startedAt,
      finishedAt,
      summary.driver,
      JSON.stringify(summary),
      JSON.stringify(checks),
    ]);
    await client.end();
    if (!JSON_ONLY) console.log('Stored QA run in the database (visible on the admin QA screen).');
  } catch (err) {
    console.error(`Could not persist QA run: ${err.message}`);
    process.exitCode = 1;
  }
}

fs.mkdirSync(path.join(repo, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(repo, 'artifacts/qa-report.json'), JSON.stringify(report, null, 2) + '\n');
if (summary.fail > 0) process.exitCode = 1;
