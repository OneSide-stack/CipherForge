import { report } from '../../_shared/validator.mjs';
const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const KEY = 'vela-demo-key-2024';
const issues = [];
let anon = 0;
let authed = 0;
try {
  const a = await fetch(`${BASE}/storage/vela-backups`);
  anon = a.status;
  if (anon !== 403) issues.push(`anonymous bucket listing still allowed (status ${anon})`);
  const o = await fetch(`${BASE}/storage/vela-backups/db-snapshot-2026-10-24.txt`);
  if (o.status !== 403) issues.push(`anonymous object read still allowed (status ${o.status})`);
  const ok = await fetch(`${BASE}/storage/vela-backups`, { headers: { 'x-vela-key': KEY } });
  authed = ok.status;
  if (authed !== 200) issues.push(`authorised access with the demo key broke (status ${authed})`);
  const pub = await fetch(`${BASE}/storage/vela-public`);
  if (pub.status !== 200) issues.push(`public CDN bucket broke (status ${pub.status})`);
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}
report(issues.length === 0, issues.length === 0 ? 'Backup objects require an access key while the public bucket stays public.' : 'Backup exposure is not fully remediated.', { issues, anonymousStatus: anon, authorisedStatus: authed });
