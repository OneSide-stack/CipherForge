import crypto from 'node:crypto';
import { report } from '../../_shared/validator.mjs';

const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const issues = [];
let status = 0;
let userStatus = 0;
try {
  const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'attacker', role: 'admin', exp: Math.floor(Date.now() / 1000) + 600 })}.`;
  const res = await fetch(`${BASE}/api/admin/export`, { headers: { authorization: `Bearer ${forged}` } });
  status = res.status;
  if (status !== 401) issues.push(`unsigned admin token still accepted (status ${status})`);
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'analyst@aurorapay.example', password: 'aurora2024' }),
  });
  const { token } = await login.json();
  const userRes = await fetch(`${BASE}/api/admin/export`, { headers: { authorization: `Bearer ${token}` } });
  userStatus = userRes.status;
  if (userStatus !== 403) issues.push(`signed partner token should authenticate but be forbidden (status ${userStatus})`);
  if (!token || token.split('.').length !== 3) issues.push('normal token issuance broke');
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}
report(issues.length === 0, issues.length === 0 ? 'Unsigned tokens are rejected and signed partner tokens are authorised as partner-only.' : 'Token verification is still too permissive.', { issues, forgedStatus: status, partnerStatus: userStatus });
