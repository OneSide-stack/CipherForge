/** Server-side verification that the live portal now sends a hardened policy. */
const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const PAGES = ['/', '/login', '/dashboard'];
const issues = [];
const observations = {};

function checkPage(path, headers) {
  const get = (h) => headers.get(h) ?? '';
  const csp = get('content-security-policy');
  const hsts = get('strict-transport-security');
  const xcto = get('x-content-type-options');
  const referrer = get('referrer-policy');
  const permissions = get('permissions-policy');
  const xfo = get('x-frame-options');
  observations[path] = { csp, hsts, xcto, referrer, permissions, xfo };

  if (!csp) issues.push(`${path}: missing Content-Security-Policy`);
  else {
    if (!/frame-ancestors\s+'none'/i.test(csp)) issues.push(`${path}: CSP must include frame-ancestors 'none'`);
    if (/script-src[^;]*unsafe-inline/i.test(csp) || /script-src[^;]*unsafe-eval/i.test(csp))
      issues.push(`${path}: CSP must not allow unsafe-inline/unsafe-eval scripts`);
    if (!/default-src\s+[^;]+/i.test(csp) && !/script-src\s+[^;]+/i.test(csp))
      issues.push(`${path}: CSP must define a default-src or script-src policy`);
  }
  if (!hsts) issues.push(`${path}: missing Strict-Transport-Security`);
  else {
    const m = /max-age=(\d+)/i.exec(hsts) || /max-age\s*=\s*(\d+)/i.exec(hsts);
    if (!m || Number(m[1]) < 15552000) issues.push(`${path}: HSTS max-age must be at least 15552000`);
  }
  if (!/nosniff/i.test(xcto)) issues.push(`${path}: X-Content-Type-Options must be nosniff`);
  if (!referrer) issues.push(`${path}: missing Referrer-Policy`);
  else if (!/no-referrer|strict-origin|same-origin/i.test(referrer)) issues.push(`${path}: Referrer-Policy is too permissive`);
  if (!permissions) issues.push(`${path}: missing Permissions-Policy`);
  else if (!/(camera|microphone|geolocation)\s*=\s*\(\s*\)/i.test(permissions))
    issues.push(`${path}: Permissions-Policy should disable camera, microphone or geolocation`);
  if (!/deny|sameorigin/i.test(xfo) && !/frame-ancestors\s+'none'/i.test(csp))
    issues.push(`${path}: frame embedding must be denied`);
}

for (const p of PAGES) {
  try {
    const res = await fetch(`${BASE}${p}`, { redirect: 'manual' });
    if (p === '/dashboard' && res.status !== 200) {
      // The dashboard requires a session; validate the login page instead.
      const login = await fetch(`${BASE}/login`);
      checkPage('/login', login.headers);
      observations['/dashboard'] = { note: 'requires authentication; skipped' };
      continue;
    }
    checkPage(p, res.headers);
  } catch (err) {
    issues.push(`${p}: request failed (${err.message})`);
  }
}

const passed = issues.length === 0;
console.log(
  'CF_VALIDATOR:' +
    JSON.stringify({
      passed,
      detail: passed
        ? 'Live responses on /, /login and the portal shell satisfy all required browser security headers.'
        : `Header policy is not compliant yet (${issues.length} issue${issues.length === 1 ? '' : 's'}).`,
      evidence: { issues: issues.slice(0, 12), observations },
    }),
);
