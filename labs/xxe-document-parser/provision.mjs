import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
briefing({
  Organization: 'Arclight Billing',
  Target: process.env.CF_TARGET_URL || 'http://127.0.0.1:8080',
  Mission: 'Read the billing secret through XML entity expansion, then disable DTD processing.',
  Store: 'The parser resolves file:// entities against its own document store (/srv/arclight/...).',
  Admin: 'labctl (uses ~/.lab/admin.token) hardening policy.',
});
adminTokenFile();
evidenceReadme('Arclight XXE', 'Record the document you submitted, the resolved secret and the parser policy you applied.');
write('work/parser-notes.txt', 'Intake accepts application/xml and normalises invoices for downstream billing.\n');
emit({ 'xxe-flag': flagFor(SECRET, 'xxe-document-parser', 'xxe-flag') });
