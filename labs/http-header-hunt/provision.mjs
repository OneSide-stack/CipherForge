/**
 * Provisioning for HTTP Header Hunt.
 * Runs inside the lab session before the target is exposed. Places only
 * learner-facing assets; the flag itself stays inside the target app.
 */
import { adminToken, flagFor } from '../_shared/appkit.mjs';
import fs from 'node:fs';

const HOME = process.env.CF_WORKSPACE ?? '/home/learner';
const secret = process.env.CF_SESSION_SECRET ?? '';
const token = process.env.CF_ADMIN_TOKEN ?? adminToken(secret);

fs.mkdirSync(`${HOME}/.lab`, { recursive: true, mode: 0o700 });
fs.writeFileSync(`${HOME}/.lab/admin.token`, token, { mode: 0o600 });
fs.chmodSync(`${HOME}/.lab/admin.token`, 0o600);
fs.mkdirSync(`${HOME}/evidence`, { recursive: true });

fs.writeFileSync(
  `${HOME}/credentials.txt`,
  `Nimbus Freight training portal\n-------------------------------\nURL:       ${process.env.CF_TARGET_URL || 'http://127.0.0.1:8080'}\nEmail:     ops@nimbusfreight.example\nPassword:  freight2024\n\nAdmin tooling: labctl (uses ~/.lab/admin.token)\nScope: only this portal. Outbound internet is denied.\n`,
  { mode: 0o644 },
);
fs.writeFileSync(
  `${HOME}/evidence/README.md`,
  `# Evidence folder\n\nRecord findings here. For the final objective create headers-findings.json:\n\n{\n  "missingBefore": ["Content-Security-Policy", "..."],\n  "applied": { "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "...": "..." },\n  "notes": "what you changed and why"\n}\n`,
);

const result = {
  flags: { 'build-token': flagFor(secret, 'http-header-hunt', 'build-token') },
  meta: { org: 'Nimbus Freight', demoUser: 'ops@nimbusfreight.example' },
};
console.log('CF_RESULT:' + JSON.stringify(result));
