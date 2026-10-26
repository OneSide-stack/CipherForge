import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, emit, evidenceReadme } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
briefing({
  Organization: 'Kestrel Identity',
  Target: process.env.CF_TARGET_URL || 'http://127.0.0.1:8080',
  Mission: 'Redirect an authorization code to an unregistered host, capture the marker, then enforce the registered callback.',
  Client: 'client_id=kestrel-web · registered callback https://app.kestrel.example/callback',
  Admin: 'labctl (uses ~/.lab/admin.token) enables redirect validation.',
});
adminTokenFile();
evidenceReadme('Kestrel redirect audit', 'Record the unregistered redirect you used, the leaked code and the policy you applied.');
emit({ 'oauth-flag': flagFor(SECRET, 'open-redirect-oauth', 'oauth-flag') });
