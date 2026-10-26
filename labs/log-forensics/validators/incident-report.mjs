import fs from 'node:fs';
import { report } from '../../_shared/validator.mjs';
const LOG = '/home/learner/artifacts/access.log';
const FILE = '/home/learner/evidence/incident.json';
const issues = [];
let expected = null;
try {
  const rows = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const scan = rows.find((r) => String(r.user_agent).toLowerCase().includes('sqlmap'));
  if (!scan) issues.push('log artifact is missing the suspicious session');
  const leak = rows.find((r) => /CF\{[^}]+\}/.test(String(r.path)));
  if (!leak) issues.push('log artifact does not contain the exfiltration entry');
  if (scan && leak) expected = { ip: scan.ip, path: String(leak.path).split('?')[0], marker: leak.path.match(/CF\{[^}]+\}/)?.[0] };
} catch (err) {
  issues.push(`could not parse the access log: ${err.message}`);
}
if (!fs.existsSync(FILE)) issues.push('create /home/learner/evidence/incident.json');
let doc = null;
try { doc = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (err) { issues.push(`incident.json is not valid JSON: ${err.message}`); }
if (doc && expected) {
  if (doc.attackerIp !== expected.ip) issues.push(`attackerIp should be ${expected.ip} (found ${doc.attackerIp || 'empty'})`);
  if (String(doc.endpoint ?? '').split('?')[0] !== expected.path) issues.push(`endpoint should be ${expected.path}`);
  if (doc.marker !== expected.marker) issues.push('marker does not match the exfiltration entry in the log');
  if (typeof doc.notes !== 'string' || doc.notes.trim().length < 25) issues.push('notes must explain the timeline in at least 25 characters');
}
report(issues.length === 0, issues.length === 0 ? 'Incident report matches the log evidence.' : 'Incident report is incomplete.', { issues });
