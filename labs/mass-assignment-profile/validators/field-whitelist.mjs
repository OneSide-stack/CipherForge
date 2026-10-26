import { report } from '../../_shared/validator.mjs';

const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const issues = [];
let escalatedStatus = 0;
try {
  const patch = await fetch(`${BASE}/api/profile`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'hr-admin' }),
  });
  const patched = await patch.json().catch(() => ({}));
  if (patched.user?.role === 'hr-admin') issues.push('role can still be escalated through profile fields');
  const ledger = await fetch(`${BASE}/api/payroll/ledger`);
  escalatedStatus = ledger.status;
  if (ledger.status !== 403) issues.push(`payroll ledger should be forbidden after the fix (status ${ledger.status})`);
  const allowed = await fetch(`${BASE}/api/profile`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rowan Mehta', department: 'Support' }),
  });
  const allowedBody = await allowed.json().catch(() => ({}));
  if (allowed.status !== 200) issues.push(`legitimate profile fields broke (status ${allowed.status})`);
  if (allowedBody.user?.department !== 'Support') issues.push('legitimate department update was not applied');
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}
report(issues.length === 0, issues.length === 0 ? 'Privileged fields are ignored and ordinary profile edits still apply.' : 'Mass assignment is still possible.', { issues, escalatedStatus });
