import fs from 'node:fs';
import path from 'node:path';
import { report } from '../../_shared/validator.mjs';

const DIR = '/home/learner/artifacts/email';
const FILE = '/home/learner/evidence/phishing.json';
const issues = [];
let expected = null;

function parseEml(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const headers = {};
  const [head] = raw.split(`\n\n`);
  for (const line of head.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const b64 = raw.split(/Content-Transfer-Encoding: base64\s*/)[1];
  let decoded = '';
  if (b64) {
    const payload = b64.split(/\n--/)[0].replace(/\s+/g, '');
    try { decoded = Buffer.from(payload, 'base64').toString('utf8'); } catch {}
  }
  return { raw, headers, decoded };
}

try {
  for (const name of fs.readdirSync(DIR)) {
    if (!name.endsWith('.eml')) continue;
    const eml = parseEml(path.join(DIR, name));
    const marker = eml.decoded.match(/CF\{[^}]+\}/)?.[0];
    if (marker) {
      const url = eml.decoded.match(/https:\/\/[^\s]+/)?.[0] ?? null;
      const domain = String(eml.headers.from ?? '').match(/@([A-Za-z0-9.-]+)/)?.[1] ?? null;
      expected = { maliciousFile: name, senderDomain: domain, decodedFlag: marker, portalUrl: url };
    }
  }
  if (!expected) issues.push('could not locate the malicious message in the mailbox export');
} catch (err) {
  issues.push(`could not read the mailbox export: ${err.message}`);
}

let doc = null;
try { doc = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { issues.push('create ~/evidence/phishing.json as valid JSON'); }
if (doc && expected) {
  if (doc.maliciousFile !== expected.maliciousFile) issues.push(`maliciousFile should be ${expected.maliciousFile}`);
  if (doc.senderDomain !== expected.senderDomain) issues.push(`senderDomain should be ${expected.senderDomain}`);
  if (doc.decodedFlag !== expected.decodedFlag) issues.push('decodedFlag does not match the decoded attachment');
  if (expected.portalUrl && doc.portalUrl !== expected.portalUrl) issues.push(`portalUrl should be ${expected.portalUrl}`);
  if (typeof doc.notes !== 'string' || doc.notes.trim().length < 25) issues.push('notes must explain the indicators in at least 25 characters');
}
report(issues.length === 0, issues.length === 0 ? 'Phishing triage report matches the mailbox evidence.' : 'Phishing report is incomplete.', { issues });
