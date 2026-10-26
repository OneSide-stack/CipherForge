import fs from 'node:fs';
import { briefing, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const HOME = process.env.CF_WORKSPACE ?? '/home/learner';
fs.mkdirSync(`${HOME}/.ssh`, { recursive: true, mode: 0o777 });
fs.writeFileSync(`${HOME}/.ssh/id_ed25519`, '-----BEGIN OPENSSH PRIVATE KEY-----\nSYNTHETIC-TRAINING-KEY-NOT-REAL\n-----END OPENSSH PRIVATE KEY-----\n', { mode: 0o644 });
fs.chmodSync(`${HOME}/.ssh`, 0o777);
fs.chmodSync(`${HOME}/.ssh/id_ed25519`, 0o644);
write('work/report.txt', 'Quarterly access review draft.\n', 0o666);
write('.config/portal/credentials', 'portal_user=svc-reporting\nportal_token=synthetic-token-4d1f\n', 0o644);
briefing({ Organization: 'Northwind Freight', Mission: 'Harden the workspace file permissions and document the risky entries.', Evidence: 'Write ~/evidence/permissions.json listing the issues and the corrected modes.' });
evidenceReadme('Workspace hardening', 'Create permissions.json: {"issues": [{"path": "...", "before": "0777", "after": "0700"}], "notes": "..."}');

// No flags in this lab: completion is proven by the live file-mode validators.
emit({});
