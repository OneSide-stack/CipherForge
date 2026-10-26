import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, credentials, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
briefing({
  Organization: 'Aurora Pay',
  Target: process.env.CF_TARGET_URL || 'http://127.0.0.1:8080',
  Mission: 'Obtain an admin export from the partner API, then make unsigned tokens unacceptable.',
  Demo: 'analyst@aurorapay.example / aurora2024',
  Admin: 'labctl (uses ~/.lab/admin.token) toggles the token verifier policy.',
});
adminTokenFile();
credentials({ email: 'analyst@aurorapay.example', password: 'aurora2024', notes: 'Partner API account. Admin export requires role=admin.' });
evidenceReadme('Aurora Pay JWT', 'Save the forged token (redact the signature if desired), the export marker, and the policy you applied.');
write('work/jwt-notes.txt', 'JWT structure: base64url(header).base64url(payload).signature\nThe verifier should reject any token whose alg does not match an expected allow-list.\n');
emit({ 'admin-export': flagFor(SECRET, 'jwt-none-forge', 'admin-export') }, { demoUser: 'analyst@aurorapay.example' });
