import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
briefing({
  Organization: 'Torrential ISP',
  Target: process.env.CF_TARGET_URL || 'http://127.0.0.1:8080',
  Mission: 'Turn the hostname lookup into command execution, capture the diagnostic secret, then remove the shell.',
  Admin: 'labctl (uses ~/.lab/admin.token) switches the endpoint to argument-array execution.',
});
adminTokenFile();
evidenceReadme('Torrential command injection', 'Record the payload, the secret you recovered and the execution mode you applied.');
write('work/edge-notes.txt', 'Diagnostics run on the edge node with the support environment attached.\n');
emit({ 'shell-flag': flagFor(SECRET, 'cmdi-netcheck', 'shell-flag') });
