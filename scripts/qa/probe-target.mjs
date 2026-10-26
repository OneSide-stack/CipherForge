#!/usr/bin/env node
/** Scratch: probe a lab's target routes through the authenticated gateway. */
const BASE = 'http://127.0.0.1:5000';
const LAB = process.argv[2] ?? 'cloud-bucket-exposure';
const PATHS = process.argv.slice(3);
let cookie = '';
let csrf = '';
async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const t = res.headers.get('x-csrf-token');
  if (t) csrf = t;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const suf = Date.now().toString(36);
await api('POST', '/api/auth/register', { email: `probe-${suf}@example.test`, username: `probe-${suf}`.slice(0, 24), password: 'QaRunner!2024' });
const start = await api('POST', `/api/labs/${LAB}/sessions`);
if (!start.json?.session) { console.log('start failed', start.status, start.text.slice(0, 300)); process.exit(1); }
const id = start.json.session.id;
const target = start.json.session.targets?.[0]?.name ?? 'web';
let state = '';
for (let i = 0; i < 120; i += 1) {
  const st = await api('GET', `/api/sessions/${id}`);
  state = st.json?.session?.state;
  if (['ready', 'failed', 'stopped', 'expired'].includes(state)) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log('state', state, 'targets', JSON.stringify(start.json.session.targets ?? []));
if (state !== 'ready') {
  const st = await api('GET', `/api/sessions/${id}`);
  console.log('failure', JSON.stringify(st.json?.session?.failure ?? null, null, 2).slice(0, 3000));
  const logs = await api('GET', `/api/sessions/${id}/logs`);
  console.log('logs', logs.status, String(logs.json?.logs ?? logs.text).slice(-2500));
}
for (const p of PATHS.length ? PATHS : ['/']) {
  const url = `${BASE}/api/sessions/${id}/target/${target}${p}`;
  const res = await fetch(url, { headers: { cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) }, redirect: 'manual' });
  const body = await res.text();
  console.log(`\n== ${p} -> ${res.status}\n${body.slice(0, 400)}`);
}
await api('POST', `/api/sessions/${id}/stop`, {});
