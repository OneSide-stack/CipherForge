import { report } from '../../_shared/validator.mjs';

const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const issues = [];
let injectedStatus = 0;
let normalStatus = 0;
try {
  const injected = await fetch(`${BASE}/api/netcheck?host=${encodeURIComponent('127.0.0.1; env')}`);
  injectedStatus = injected.status;
  const body = await injected.json().catch(() => ({}));
  if (/CF\{/.test(JSON.stringify(body))) issues.push('shell metacharacters still expose the diagnostic secret');
  const normal = await fetch(`${BASE}/api/netcheck?host=localhost`);
  normalStatus = normal.status;
  const normalBody = await normal.json().catch(() => ({}));
  if (normalStatus !== 200) issues.push(`legitimate lookups broke (status ${normalStatus})`);
  if (typeof normalBody.output !== 'string') issues.push('legitimate lookup returned no output');
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}
report(issues.length === 0, issues.length === 0 ? 'Metacharacters no longer spawn a shell and normal lookups still work.' : 'The diagnostic endpoint still executes shell input.', {
  issues,
  injectedStatus,
  normalStatus,
});
