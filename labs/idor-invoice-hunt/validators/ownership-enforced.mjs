/** Proves the portal now rejects cross-patient invoice access for a real session. */
import { report } from '../../_shared/validator.mjs';

const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const issues = [];
let status = 0;
let ownStatus = 0;

try {
  const login = await fetch(`${BASE}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=analyst%40lumenhealth.example&password=lumen2024',
  });
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie.includes('lh_session')) issues.push('demo account could not sign in — did the login flow break?');
  const other = await fetch(`${BASE}/api/invoices/INV-1099`, { headers: { cookie }, redirect: 'manual' });
  status = other.status;
  if (status !== 403) issues.push(`another patient's invoice is still readable (status ${status})`);
  const own = await fetch(`${BASE}/api/invoices/INV-1041`, { headers: { cookie } });
  ownStatus = own.status;
  if (ownStatus !== 200) issues.push(`own invoice request broke (status ${ownStatus})`);
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}

report(issues.length === 0, issues.length === 0 ? 'Cross-patient invoice access is denied while the owner still has access.' : 'Authorization is still missing.', {
  issues,
  crossPatientStatus: status,
  ownInvoiceStatus: ownStatus,
});
