import { report } from '../../_shared/validator.mjs';
const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const issues = [];
let traversal = 0;
let safe = 0;
try {
  const attack = await fetch(`${BASE}/docs?file=${encodeURIComponent('../internal/flag.txt')}`);
  traversal = attack.status;
  if (traversal !== 400) issues.push(`traversal request was not rejected (status ${traversal})`);
  const doc = await fetch(`${BASE}/docs?file=readme.txt`);
  safe = doc.status;
  if (safe !== 200) issues.push(`legitimate document download broke (status ${safe})`);
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}
report(issues.length === 0, issues.length === 0 ? 'Traversal payloads are rejected while public documents still download.' : 'Path traversal is still possible or downloads broke.', { issues, traversalStatus: traversal, safeStatus: safe });
