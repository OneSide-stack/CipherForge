import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, credentials, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
briefing({
  Organization: 'Vela Retail',
  Target: process.env.CF_TARGET_URL || 'http://127.0.0.1:8080',
  Mission: 'Find the exposed backup bucket, capture the internal marker, then make backups require an access key.',
  Admin: 'labctl (uses ~/.lab/admin.token) updates the storage ACL policy.',
});
adminTokenFile();
credentials({ email: 'platform@velaretail.example', password: 'vela2024', notes: 'Access key for authorized backup reads: vela-demo-key-2024 (send as x-vela-key).' });
evidenceReadme('Vela storage exposure', 'Record the anonymous object URL, the marker, and the ACL policy you applied.');
write('work/notes.txt', 'S3-style buckets default to private. Public-read should be an explicit, reviewable decision.\n');
emit({ 'backup-flag': flagFor(SECRET, 'cloud-bucket-exposure', 'backup-flag') }, { accessKey: 'vela-demo-key-2024' });
