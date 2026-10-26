import { flagFor } from '../_shared/appkit.mjs';
import { adminTokenFile, briefing, credentials, emit, evidenceReadme } from '../_shared/provision-helpers.mjs';

const SECRET = process.env.CF_SESSION_SECRET ?? '';
briefing({
  Organization: 'Beacon Outfitters',
  Target: process.env.CF_TARGET_URL || 'http://127.0.0.1:8080',
  Mission: 'Break out of the status filter, read the restricted order, then make the query safe.',
  Demo: 'GET /api/orders?status=shipped (no login required for the console)',
  Admin: 'labctl (uses ~/.lab/admin.token) toggles the query-safety policy.',
});
adminTokenFile();
credentials({ email: 'ops@beaconoutfitters.example', password: 'beacon2024', notes: 'Read-only console account; the API is unauthenticated in this training build.' });
evidenceReadme('Beacon filter injection', 'Record the payload, the restricted row you read and the policy you applied.');
emit({ 'orders-flag': flagFor(SECRET, 'sqli-orders-portal', 'orders-flag') });
