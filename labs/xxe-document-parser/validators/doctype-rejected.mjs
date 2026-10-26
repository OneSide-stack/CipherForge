import { report } from '../../_shared/validator.mjs';

const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const PAYLOAD = '<?xml version="1.0"?><!DOCTYPE invoice [<!ENTITY secret SYSTEM "file:///srv/arclight/secrets/billing.env">]><invoice><line>&secret;</line></invoice>';
const issues = [];
let status = 0;
try {
  const res = await fetch(`${BASE}/api/documents/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: PAYLOAD,
  });
  status = res.status;
  const text = await res.text();
  if (/CF\{/.test(text)) issues.push('entity expansion still returns the billing token');
  if (status !== 400) issues.push(`documents with a DTD should be rejected (status ${status})`);
  const normal = await fetch(`${BASE}/api/documents/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/xml' },
    body: '<invoice><line>consulting</line></invoice>',
  });
  if (normal.status !== 200) issues.push(`ordinary invoices broke (status ${normal.status})`);
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}
report(issues.length === 0, issues.length === 0 ? 'DTDs are rejected and ordinary invoices still parse.' : 'The parser still resolves external entities.', { issues, status });
