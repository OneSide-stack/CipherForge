import { report } from '../../_shared/validator.mjs';

const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const issues = [];
let blockedStatus = 0;
let allowedStatus = 0;
try {
  const blocked = await fetch(`${BASE}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://127.0.0.1:9090/latest/meta-data/iam/security-credentials/freight-importer' }),
  });
  blockedStatus = blocked.status;
  const text = await blocked.text();
  if (blockedStatus !== 403) issues.push(`metadata URL should be rejected (status ${blockedStatus})`);
  if (/CF\{/.test(text)) issues.push('the metadata token still appears in the response');

  const dotted = await fetch(`${BASE}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://2130706433:9090/latest/meta-data/' }),
  });
  if (dotted.status !== 403) issues.push(`alternate loopback encoding should be rejected (status ${dotted.status})`);

  const allowed = await fetch(`${BASE}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://docs.halcyonfreight.example/rates' }),
  });
  allowedStatus = allowed.status;
  if (allowedStatus === 403) issues.push('the allowlisted supplier host was rejected');
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}
report(issues.length === 0, issues.length === 0 ? 'The importer refuses loopback and encoded metadata targets while supplier hosts still resolve.' : 'The importer still reaches internal services.', {
  issues,
  blockedStatus,
  allowedStatus,
});
