import fs from 'node:fs';
import { exfilLabels, parseDnsNames } from '../../_shared/pcap.mjs';
import { report } from '../../_shared/validator.mjs';

const PCAP = '/home/learner/artifacts/capture.pcap';
const FILE = '/home/learner/evidence/dns-exfil.json';
const SUFFIX = 'exfil.vela-retail.example';
const issues = [];
let expected = { labels: [], decoded: null };

try {
  const names = parseDnsNames(fs.readFileSync(PCAP));
  const labels = [...new Set(exfilLabels(names, SUFFIX))];
  const decoded = Buffer.from(labels.join(''), 'hex').toString('utf8');
  expected = { labels, decoded: /^CF\{[^}]+\}$/.test(decoded) ? decoded : null };
  if (labels.length < 2) issues.push('no exfiltration labels were found in the capture');
} catch (err) {
  issues.push(`could not read the capture: ${err.message}`);
}

let doc = null;
try {
  doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {
  issues.push('create ~/evidence/dns-exfil.json as valid JSON');
}

if (doc && expected.labels.length) {
  if (doc.exfilDomain !== SUFFIX) issues.push(`exfilDomain should be ${SUFFIX}`);
  if (expected.decoded && doc.decodedFlag !== expected.decoded) {
    issues.push('decodedFlag does not match the DNS labels (hex-decode them in capture order)');
  }
  const listed = Array.isArray(doc.encodedLabels) ? doc.encodedLabels.map(String) : [];
  const covered = expected.labels.filter((l) => listed.includes(l)).length;
  if (covered < expected.labels.length) issues.push(`list all ${expected.labels.length} encoded DNS labels you extracted`);
  if (typeof doc.notes !== 'string' || doc.notes.trim().length < 25) {
    issues.push('notes must explain how the data left the network');
  }
}

report(
  issues.length === 0,
  issues.length === 0 ? 'DNS exfiltration report matches the capture.' : 'DNS exfiltration report is incomplete.',
  { issues, expectedLabels: expected.labels.length },
);
