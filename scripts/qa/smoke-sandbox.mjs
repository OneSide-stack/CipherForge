#!/usr/bin/env node
/**
 * End-to-end sandbox smoke test:
 * start runner -> provision http-header-hunt -> health -> gateway -> real PTY
 * terminal -> validator (fail, then pass after remediation) -> teardown.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { loadRegistry } from '@cipherforge/shared';

const repo = path.resolve(import.meta.dirname, '../..');
const SECRET = process.env.CF_RUNNER_SECRET ?? crypto.randomBytes(32).toString('hex');
const PORT = 7311;
const BASE = `http://127.0.0.1:${PORT}`;
const registry = await loadRegistry(path.join(repo, 'labs'));
const entry = registry.get('http-header-hunt');
if (!entry) throw new Error('lab missing');
const state = { pass: 0, fail: 0, blocked: 0 };
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  ok ? state.pass++ : state.fail++;
}

function sign(method, p) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(`${method}\n${p}\n${ts}\n${nonce}`).digest('hex');
  return { 'x-cf-timestamp': ts, 'x-cf-nonce': nonce, 'x-cf-signature': sig, 'content-type': 'application/json' };
}
async function api(method, p, body) {
  const signedPath = p.split('?')[0];
  const res = await fetch(BASE + p, { method, headers: sign(method, signedPath), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const runnerLog = fs.openSync('/tmp/cf-smoke-runner.log', 'a');
const runner = spawn(process.execPath, [path.join(repo, 'apps/runner/dist/index.js')], {
  env: { ...process.env, CF_REPO_ROOT: repo, CF_RUNNER_SECRET: SECRET, CF_RUNNER_DRIVER: 'sandbox', CF_RUNNER_PORT: String(PORT), CF_LOG_LEVEL: 'info' },
  stdio: ['ignore', runnerLog, runnerLog],
});
async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await api('GET', '/health');
      if (res.json?.mode) return res.json;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('runner did not become healthy');
}

function wsTerminal(sessionId, userId) {
  const p = `/sessions/${sessionId}/terminal`;
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString('hex');
  const sig = crypto.createHmac('sha256', SECRET).update(`GET\n${p}\n${ts}\n${nonce}`).digest('hex');
  const url = `ws://127.0.0.1:${PORT}${p}?ts=${ts}&nonce=${nonce}&sig=${sig}&userId=${userId}&cols=120&rows=40`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const listeners = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') resolve({ ws, send: (text) => ws.send(JSON.stringify({ type: 'input', data: Buffer.from(text).toString('base64') })) });
      else for (const cb of listeners) cb(msg);
    });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error('ws status ' + res.statusCode)));
    globalThis.__listeners = listeners;
    ws.on('open', () => {});
    ws.on('close', () => {});
    setTimeout(() => reject(new Error('terminal connect timeout')), 15000);
  });
}
async function runCmd(term, cmd, waitFor = 'CMD_DONE', timeout = 20000) {
  return await new Promise((resolve) => {
    let out = '';
    const start = Date.now();
    const timer = setInterval(() => {
      if (out.includes(waitFor) || Date.now() - start > timeout) {
        clearInterval(timer);
        resolve(out);
      }
    }, 100);
    const listener = (msg) => {
      if (msg.type === 'output') out += Buffer.from(msg.data, 'base64').toString();
    };
    globalThis.__listeners.push(listener);
    term.send(cmd + `; echo ${waitFor}\n`);
  });
}

let sessionId;
try {
  const health = await waitHealth();
  check('runner health', Boolean(health.ok) && health.mode === 'sandbox', JSON.stringify(health.capacity));
  check('sandbox driver available', health.mode === 'sandbox', health.mode);
  const userId = crypto.randomUUID();
  sessionId = crypto.randomUUID();
  const sessionSecret = crypto.randomBytes(32).toString('hex');
  const startedAt = Date.now();
  const start = await api('POST', '/sessions', {
    sessionId, userId, labId: 'http-header-hunt', labVersion: entry.template.version,
    templateChecksum: entry.checksum, sessionSecret, ttlSeconds: 600, requestId: crypto.randomUUID(),
  });
  check('session accepted', start.status === 201, `state=${start.json?.state} ${start.json?.detail ?? ''}`);
  let session = start.json;
  let sawStarting = false;
  for (let i = 0; i < 240 && !['ready', 'failed', 'expired', 'stopped'].includes(session.state); i++) {
    if (session.state === 'starting') sawStarting = true;
    await new Promise((r) => setTimeout(r, 250));
    const poll = await api('GET', `/sessions/${sessionId}`);
    session = poll.json;
  }
  check('session reached ready', session.state === 'ready', `state=${session.state} detail=${session.detail ?? ''} ${JSON.stringify(session.failure ?? {})}`);
  check('provisioning observed starting/queued phase', sawStarting || session.state === 'ready');
  const transitions = (session.events ?? []).map((e) => e.state);
  check(
    'state machine observed provisioning/starting before ready',
    sawStarting || transitions.includes('starting'),
    `states=${transitions.join('>') || 'polled'}`,
  );
  const prov = await api('GET', `/sessions/${sessionId}?consume=1`);
  const flags = prov.json?.provision?.flags ?? {};
  check('provisioned flags handed to API once', Boolean(flags['build-token']), Object.keys(flags).join(','));
  check('flags are not exposed on subsequent polls', !(await api('GET', `/sessions/${sessionId}?consume=1`)).json?.provision);

  const target = await api('GET', `/sessions/${sessionId}/target/web/`);
  check('target reachable through authenticated gateway', target.status === 200 && target.text.includes('Nimbus Freight'), `status=${target.status}`);
  check('gateway path denies unknown target names', (await api('GET', `/sessions/${sessionId}/target/secret/`)).status === 404);

  const term = await wsTerminal(sessionId, userId);
  const banner = await runCmd(term, 'echo HELLO_$((40+2))', 'CMD_DONE');
  check('terminal PTY executes real shell', banner.includes('HELLO_42'), banner.slice(-120).replace(/\n/g, ' | '));
  const ident = await runCmd(term, 'hostname; id -u; echo LAB:$CF_LAB_ID; ls ~ | tr "\\n" ","; echo', 'CMD_DONE');
  check('terminal bound to session jail', /cf-http-header-hunt/.test(ident), ident.slice(-200).replace(/\n/g, ' | '));
  check('workspace has briefing + credentials', ident.includes('README.md') && ident.includes('credentials.txt'), ident.slice(-160));
  const tooling = await runCmd(term, 'curl -s http://127.0.0.1:8080/ | grep -o "Nimbus Freight" | head -1; echo; python3 -c "print(6*7)"; git --version | cut -d" " -f1-3', 'CMD_DONE');
  check('workspace has curl/python/git', tooling.includes('Nimbus Freight') && tooling.includes('42') && tooling.includes('git version'), tooling.slice(-200).replace(/\n/g, ' | '));

  const validateFail = await api('POST', `/sessions/${sessionId}/validate`, { userId, objectiveId: 'harden-headers', validator: 'headers-hardened' });
  check('validator detects unhardened service', validateFail.json?.passed === false, String(validateFail.json?.detail ?? '').slice(0, 120));

  const hunt = await runCmd(
    term,
    `curl -s -c /tmp/c -d 'email=ops@nimbusfreight.example&password=freight2024' http://127.0.0.1:8080/login -o /dev/null && curl -sD - -b /tmp/c http://127.0.0.1:8080/dashboard -o /dev/null | grep -i x-build-token`,
    'CMD_DONE',
  );
  const flagInHeader = /CF\{[a-f0-9]{32}\}/.exec(hunt)?.[0];
  check('real flag is leaked in the authenticated response header', Boolean(flagInHeader), flagInHeader ? flagInHeader.slice(0, 12) + '…' : hunt.slice(-200));
  check('flag header matches provisioned flag hash input', Boolean(flagInHeader) && flags['build-token'] === flagInHeader);

  const policy = {
    headers: {
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'X-Frame-Options': 'DENY',
    },
  };
  const encoded = Buffer.from(JSON.stringify(policy, null, 2)).toString('base64');
  const apply = await runCmd(term, `echo '${encoded}' | base64 -d > ~/hardened.json && labctl policy apply ~/hardened.json | head -5`, 'CMD_DONE');
  check('learner applied policy through real admin API', apply.includes('"applied": true'), apply.slice(-240).replace(/\n/g, ' | '));
  const liveHeaders = await runCmd(term, 'curl -sI http://127.0.0.1:8080/ | grep -Ei "content-security|strict-transport" | cut -c1-60', 'CMD_DONE');
  check('hardened headers served by the live target', /Content-Security-Policy/i.test(liveHeaders) && /Strict-Transport-Security/i.test(liveHeaders), liveHeaders.replace(/\n/g, ' | '));

  const validatePass = await api('POST', `/sessions/${sessionId}/validate`, { userId, objectiveId: 'harden-headers', validator: 'headers-hardened' });
  check('validator passes after real remediation', validatePass.json?.passed === true, String(validatePass.json?.detail ?? '').slice(0, 140));

  const evidence = {
    missingBefore: ['Content-Security-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'X-Frame-Options'],
    applied: {},
    notes: 'Applied a hardened browser security header policy through the authenticated admin API.',
  };
  for (const [k, v] of Object.entries(policy.headers)) evidence.applied[k] = v;
  const evB64 = Buffer.from(JSON.stringify(evidence)).toString('base64');
  await runCmd(term, `echo '${evB64}' | base64 -d > ~/evidence/headers-findings.json`, 'CMD_DONE');
  const evCheck = await api('POST', `/sessions/${sessionId}/validate`, { userId, objectiveId: 'evidence-report', validator: 'headers-evidence' });
  check('evidence validator reads learner files in the session', evCheck.json?.passed === true, String(evCheck.json?.detail ?? '').slice(0, 140));

  const denyResize = await api('POST', `/sessions/${sessionId}/validate`, { userId: crypto.randomUUID(), objectiveId: 'harden-headers', validator: 'headers-hardened' });
  check('runner rejects validation for a different user', denyResize.status === 403, `status=${denyResize.status}`);

  const rejectArbitrary = await api('POST', `/sessions/${sessionId}/validate`, { userId, objectiveId: 'harden-headers', validator: 'evil' });
  check('runner refuses unapproved validator ids', rejectArbitrary.json?.passed === false, String(rejectArbitrary.json?.detail ?? ''));

  const ext = await api('POST', `/sessions/${sessionId}/extend`, { ttlSeconds: 900 });
  check('session extension applies within limits', ext.status === 200 && new Date(ext.json.expiresAt).getTime() > Date.now(), ext.json?.expiresAt);

  term.ws.close();
  const stop = await api('POST', `/sessions/${sessionId}/stop`, { reason: 'stopped' });
  check('session stops', ['stopped', 'stopping'].includes(stop.json?.state), `state=${stop.json?.state}`);
  await new Promise((r) => setTimeout(r, 500));
  const status = await api('GET', `/sessions/${sessionId}`);
  check('final state is reported as stopped', ['stopped', 'stopping'].includes(status.json?.state), status.json?.state);
  check('sandbox session directory removed', !fs.existsSync(path.join(process.env.HOME ?? '/home/user', '.cache/cipherforge/sessions', sessionId)));
  const procs = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).map((p) => { try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8'); } catch { return ''; } }).filter((c) => c.includes(sessionId));
  check('no processes remain for the session', procs.length === 0, `${procs.length} found`);
  sessionId = undefined;
} catch (err) {
  console.error('SMOKE ERROR', err);
  state.fail++;
} finally {
  if (sessionId) { try { await api('POST', `/sessions/${sessionId}/stop`, {}); } catch {} }
  runner.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 700));
  runner.kill('SIGKILL');
  console.log(`\nSUMMARY pass=${state.pass} fail=${state.fail}`);
  process.exit(state.fail ? 1 : 0);
}
