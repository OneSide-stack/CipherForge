import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
briefing({
  Organization: 'Solstice HR',
  Target: process.env.CF_TARGET_URL || 'http://127.0.0.1:8080',
  Mission: 'Escalate your role through the profile update, read the payroll ledger, then restrict the endpoint to real profile fields.',
  Admin: 'labctl (uses ~/.lab/admin.token) enables the field allow-list.',
});
adminTokenFile();
evidenceReadme('Solstice mass assignment', 'Record the field you injected, the ledger marker and the allow-list you applied.');
write('work/hr-notes.txt', 'Profile fields in the UI: display name, department, pronouns.\nPayroll ledger requires role=hr-admin.\n');
emit({ 'profile-flag': flagFor(SECRET, 'mass-assignment-profile', 'profile-flag') });
