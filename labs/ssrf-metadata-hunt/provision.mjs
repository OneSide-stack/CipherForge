import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
briefing({
  Organization: 'Halcyon Freight',
  Target: process.env.CF_TARGET_URL || 'http://127.0.0.1:8080',
  Mission: 'Use the importer to reach the in-session metadata service, capture the token, then restrict egress to supplier hosts.',
  Admin: 'labctl (uses ~/.lab/admin.token) toggles the egress allow-list.',
  Context: 'The metadata service is bound to loopback inside this session only; it is never published.',
});
adminTokenFile();
evidenceReadme('Halcyon SSRF', 'Record the URL you injected, the credential token you recovered and the allow-list you applied.');
write('work/importer-notes.txt', 'Importer accepts http(s) URLs from suppliers.\nAllow-listed hosts: docs.halcyonfreight.example\n');
emit({ 'metadata-flag': flagFor(SECRET, 'ssrf-metadata-hunt', 'metadata-flag') });
