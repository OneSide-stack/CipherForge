import { report } from '../../_shared/validator.mjs';

const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const issues = [];
let observed = [];
let locked = false;
try {
  for (let i = 0; i < 12; i += 1) {
    const res = await fetch(`${BASE}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pin: '0000' }),
    });
    observed.push(res.status);
    if (res.status === 429) {
      locked = true;
      break;
    }
  }
  if (!locked) issues.push('failed PIN attempts are still unlimited (no 429 after 12 tries)');
  const admin = await fetch(`${BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: '7413' }),
  });
  if (admin.status !== 429) issues.push(`the correct PIN should also be blocked while locked (status ${admin.status})`);
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}
report(issues.length === 0, issues.length === 0 ? 'Failed attempts now trigger a lockout that covers every PIN, including the correct one.' : 'The login gate is still brute-forceable.', {
  issues,
  statuses: [...new Set(observed)].join(','),
});
