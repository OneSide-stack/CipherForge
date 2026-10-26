import { flagFor } from '../_shared/appkit.mjs';
import { briefing, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
const flag = flagFor(SECRET, 'log-forensics', 'exfil-marker');
const lines = [
  ['2026-10-24T02:11:03Z', '198.51.100.24', 'GET', '/', 200, 'Mozilla/5.0'],
  ['2026-10-24T02:13:41Z', '203.0.113.77', 'POST', '/login', 401, 'Mozilla/5.0'],
  ['2026-10-24T02:13:44Z', '203.0.113.77', 'POST', '/login', 401, 'Mozilla/5.0'],
  ['2026-10-24T02:13:51Z', '203.0.113.77', 'GET', '/app/invoices', 200, 'sqlmap/1.7.10#stable (https://sqlmap.org)'],
  ['2026-10-24T02:14:02Z', '203.0.113.77', 'GET', "/app/invoices?id=1' OR '1'='1", 500, 'sqlmap/1.7.10#stable'],
  ['2026-10-24T02:14:19Z', '198.51.100.24', 'GET', '/healthz', 200, 'kube-probe/1.28'],
  ['2026-10-24T02:14:31Z', '203.0.113.77', 'GET', '/api/admin/export', 200, 'curl/8.5.0'],
  ['2026-10-24T02:14:32Z', '203.0.113.77', 'GET', `/api/admin/export?token=${flag}`, 200, 'curl/8.5.0'],
  ['2026-10-24T02:15:02Z', '203.0.113.77', 'POST', '/logout', 200, 'curl/8.5.0'],
  ['2026-10-24T02:31:10Z', '198.51.100.90', 'GET', '/app/invoices', 200, 'Mozilla/5.0'],
];
write('artifacts/access.log', lines.map(([ts, ip, method, path, status, ua]) => JSON.stringify({ ts, ip, method, path, status, user_agent: ua })).join('\n') + '\n');
write('artifacts/triage-notes.txt', 'The web application writes JSON access logs to artifacts/access.log.\nA suspicious account accessed the billing portal overnight.\nFind the source address, the abused endpoint and the exfiltration marker.\n');
briefing({ Organization: 'Corvus Insurance', Artifact: '~/artifacts/access.log (JSON lines)', Mission: 'Triage the suspicious session and capture the exfiltrated marker, then record your findings.', Evidence: 'Write ~/evidence/incident.json with attackerIp, endpoint, marker and notes.' });
evidenceReadme('Corvus log triage', 'Create incident.json: {"attackerIp": "...", "endpoint": "...", "marker": "CF{...}", "notes": "..."}');
write('evidence/incident.json', '{\n  "attackerIp": "",\n  "endpoint": "",\n  "marker": "",\n  "notes": ""\n}\n');
emit({ 'exfil-marker': flag });
