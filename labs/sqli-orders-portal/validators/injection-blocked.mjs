import { report } from '../../_shared/validator.mjs';

const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const issues = [];
let injectionStatus = 0;
let normalStatus = 0;
try {
  const injected = await fetch(`${BASE}/api/orders?status=${encodeURIComponent("' OR '1'='1")}`);
  injectionStatus = injected.status;
  const body = await injected.json().catch(() => ({}));
  const restricted = (body.rows ?? []).some((r) => r.id === 'ORD-9001');
  if (restricted) issues.push('the injected filter still returns restricted orders');
  if (injectionStatus !== 400 && injectionStatus !== 200) issues.push(`unexpected status for injected input: ${injectionStatus}`);
  const normal = await fetch(`${BASE}/api/orders?status=shipped`);
  normalStatus = normal.status;
  const list = (await normal.json().catch(() => ({}))).rows ?? [];
  if (normalStatus !== 200) issues.push(`legitimate filter broke (status ${normalStatus})`);
  if (!list.length || list.some((r) => r.status !== 'shipped')) issues.push('shipped filter no longer returns only shipped orders');
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}
report(issues.length === 0, issues.length === 0 ? 'Injected input is treated as data and legitimate filters still work.' : 'The order filter is still injectable.', {
  issues,
  injectionStatus,
  normalStatus,
});
