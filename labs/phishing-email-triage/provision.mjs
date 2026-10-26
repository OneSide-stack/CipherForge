import crypto from 'node:crypto';
import { flagFor } from '../_shared/appkit.mjs';
import { briefing, emit, evidenceReadme, write } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
const flag = flagFor(SECRET, 'phishing-email-triage', 'malicious-attachment');
const attachment = Buffer.from(
  `Vela Retail settlement notice\n\nReference: VR-88213\nPlease review the attached remittance advice.\n\n${flag}\n\nPortal: https://vela-billing-secure.example/ar/88213\n`,
).toString('base64');

const emails = {
  '2026-10-21-newsletter.eml': `From: Vela Retail <news@velaretail.example>\nTo: ap@northwind.example\nSubject: October product update\nDate: Tue, 21 Oct 2026 09:00:00 +0000\nContent-Type: text/plain; charset=utf-8\n\nNew arrivals and shipping lane updates for October.\n`,
  '2026-10-23-overdue-invoice.eml': `From: "Vela Retail Billing" <billing@vela-billing-secure.example>\nReply-To: ar-desk@vela-billing-secure.example\nTo: ap@northwind.example\nSubject: OVERDUE: invoice VR-88213 (action required)\nDate: Thu, 23 Oct 2026 04:12:00 +0000\nMIME-Version: 1.0\nContent-Type: multipart/mixed; boundary="vr-88213"\nAuthentication-Results: mx.northwind.example; spf=none; dkim=none; dmarc=fail\n\n--vr-88213\nContent-Type: text/plain; charset=utf-8\n\nYour account has an overdue balance. Open the attached remittance advice immediately to avoid service suspension.\n\n--vr-88213\nContent-Type: application/octet-stream; name="remittance-VR-88213.b64"\nContent-Disposition: attachment; filename="remittance-VR-88213.b64"\nContent-Transfer-Encoding: base64\n\n${attachment}\n--vr-88213--\n`,
  '2026-10-23-internal-note.eml': `From: Priya Raman <priya@northwind.example>\nTo: ap@northwind.example\nSubject: Re: remittance process\nDate: Thu, 23 Oct 2026 08:45:00 +0000\nContent-Type: text/plain\n\nReminder: we never accept remittance advice from a lookalike domain. Forward anything suspicious to security.\n`,
};
for (const [name, body] of Object.entries(emails)) write(`artifacts/email/${name}`, body, 0o644);
write(
  'artifacts/email/README.txt',
  'Three messages exported from the accounts-payable mailbox.\nOne is a training phishing lure; the others are benign.\nDecode attachments before trusting them.\n',
);
briefing({
  Organization: 'Northwind Freight',
  Artifacts: '~/artifacts/email/*.eml',
  Mission: 'Triage the mailbox, identify the phishing lure, decode its attachment and capture the marker.',
  Evidence: 'Write ~/evidence/phishing.json with maliciousFile, senderDomain, decodedFlag, portalUrl and notes.',
});
evidenceReadme('Northwind phishing triage', 'Create phishing.json: {"maliciousFile": "...", "senderDomain": "...", "decodedFlag": "CF{...}", "portalUrl": "...", "notes": "..."}');
emit({ 'malicious-attachment': flag });
