import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, credentials, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';

briefing({
  'Organization': 'Lumen Health',
  'Your account': 'analyst@lumenhealth.example / lumen2024',
  'Target': `${process.env.CF_TARGET_URL || 'http://127.0.0.1:8080'}`,
  'Mission': 'Find billing records you are not supposed to see, then fix the authorization flaw.',
  'Admin API': 'labctl (uses ~/.lab/admin.token) can read and update the portal policy.',
});
adminTokenFile();
credentials({ email: 'analyst@lumenhealth.example', password: 'lumen2024', notes: 'Patient billing portal for a synthetic clinic.' });
evidenceReadme('Lumen Health IDOR', 'Record the invoice id you were able to read, the owner, and the policy change you applied.');
write('work/scope.txt', 'In scope: the Lumen Health portal in this session only.\nOut of scope: any other host, real clinic systems, or the public internet.\n');
emit({ 'invoice-flag': flagFor(SECRET, 'idor-invoice-hunt', 'invoice-flag') }, { demoUser: 'analyst@lumenhealth.example', otherUser: 'finance@lumenhealth.example' });
