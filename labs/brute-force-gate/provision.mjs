import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
briefing({
  Organization: 'Meridian Logistics',
  Target: process.env.CF_TARGET_URL || 'http://127.0.0.1:8080',
  Mission: 'Recover the four-digit admin PIN, read the operations dashboard, then make guessing impractical.',
  Admin: 'labctl (uses ~/.lab/admin.token) sets the lockout policy.',
  Tooling: 'python3, curl and jq are available in the terminal.',
});
adminTokenFile();
evidenceReadme('Meridian PIN audit', 'Record the PIN you recovered, how many attempts it took and the lockout policy you applied.');
write('work/pin-notes.txt', 'The gate has no attempt limit. A four-digit PIN is at most 10,000 guesses.\n* * * *\n');
emit({ 'gate-flag': flagFor(SECRET, 'brute-force-gate', 'gate-flag') });
