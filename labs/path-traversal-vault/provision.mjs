import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
briefing({
  Organization: 'Atlas Logistics',
  Target: process.env.CF_TARGET_URL || 'http://127.0.0.1:8080',
  Mission: 'Read a document outside the public library, then block path traversal in the download service.',
  Admin: 'labctl (uses ~/.lab/admin.token) reads and applies the download policy.',
});
adminTokenFile();
evidenceReadme('Atlas Logistics traversal', 'Record the exact request you used, the resolved document path, and the policy change.');
write('work/notes.txt', 'The portal resolves documents with a path join. Ask yourself where an attacker can go with ../ segments.\n');
emit({ 'vault-flag': flagFor(SECRET, 'path-traversal-vault', 'vault-flag') }, { portal: 'Atlas Logistics' });
