import { report } from '../../_shared/validator.mjs';

const BASE = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';
const REGISTERED = 'https://app.kestrel.example/callback';
const issues = [];
let evilStatus = 0;
try {
  const evil = await fetch(`${BASE}/oauth/authorize?client_id=kestrel-web&redirect_uri=${encodeURIComponent('https://attacker.example/collect')}`, { redirect: 'manual' });
  evilStatus = evil.status;
  const location = evil.headers.get('location') ?? '';
  if (evilStatus === 302) issues.push('unregistered redirect_uri is still honoured with a 302');
  if (/attacker\.example/.test(location)) issues.push('authorization code was sent to an unregistered host');
  const good = await fetch(`${BASE}/oauth/authorize?client_id=kestrel-web&redirect_uri=${encodeURIComponent(REGISTERED)}`, { redirect: 'manual' });
  const goodLocation = good.headers.get('location') ?? '';
  if (good.status !== 302) issues.push(`registered redirect broke (status ${good.status})`);
  if (!/^https:\/\/app\.kestrel\.example\/callback\?code=/.test(goodLocation)) issues.push('registered redirect did not receive a code');
  const prefix = await fetch(`${BASE}/oauth/authorize?client_id=kestrel-web&redirect_uri=${encodeURIComponent(REGISTERED + '.attacker.example')}`, { redirect: 'manual' });
  if (prefix.status === 302) issues.push('prefix-matching bypass still issues codes');
} catch (err) {
  issues.push(`target unreachable: ${err.message}`);
}
report(issues.length === 0, issues.length === 0 ? 'Only the registered redirect receives codes.' : 'Redirect validation is still missing.', { issues, evilStatus });
