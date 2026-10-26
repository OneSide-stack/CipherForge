/** Verifies the learner's evidence file against the live service. */
import fs from 'node:fs';
const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const FILE = '/home/learner/evidence/headers-findings.json';
const issues = [];
let doc;
try {
  doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (err) {
  console.log('CF_VALIDATOR:' + JSON.stringify({ passed: false, detail: `Could not read ${FILE} as JSON: ${err.message}` }));
  process.exit(0);
}
const required = [
  'content-security-policy',
  'strict-transport-security',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'x-frame-options',
];
const missing = Array.isArray(doc.missingBefore) ? doc.missingBefore.map((s) => String(s).toLowerCase()) : [];
const recognised = missing.filter((m) => required.includes(m));
if (recognised.length < 4) issues.push('missingBefore must list at least four real browser security headers');
const applied = doc.applied && typeof doc.applied === 'object' ? doc.applied : {};
let live;
try {
  live = (await fetch(`${BASE}/`)).headers;
} catch (err) {
  issues.push(`live service unreachable: ${err.message}`);
}
if (live) {
  let matches = 0;
  for (const [name, value] of Object.entries(applied)) {
    const liveValue = live.get(String(name).toLowerCase());
    if (liveValue !== undefined && String(liveValue) === String(value)) matches += 1;
  }
  if (matches < 3) issues.push('applied header values in the evidence must match the live responses (need at least 3)');
  if (!live.get('content-security-policy')) issues.push('live service still has no Content-Security-Policy');
}
if (typeof doc.notes !== 'string' || doc.notes.trim().length < 10) issues.push('add notes describing the risk and remediation');
const passed = issues.length === 0;
console.log(
  'CF_VALIDATOR:' +
    JSON.stringify({
      passed,
      detail: passed ? 'Evidence matches the live hardened service.' : 'Evidence report needs work.',
      evidence: { issues, recognisedHeaders: recognised.length },
    }),
);
