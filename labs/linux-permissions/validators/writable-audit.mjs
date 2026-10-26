import fs from 'node:fs';
import path from 'node:path';
import { report } from '../../_shared/validator.mjs';
const ROOT = '/home/learner';
const issues = [];
const worldWritable = [];
const walk = (dir, depth = 0) => {
  if (depth > 4) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (file.endsWith('/evidence') || file.endsWith('/.lab')) continue;
      if ((fs.statSync(file).mode & 0o002) !== 0) worldWritable.push(file);
      walk(file, depth + 1);
    } else if ((fs.statSync(file).mode & 0o002) !== 0) worldWritable.push(file);
  }
};
try { walk(ROOT); } catch (err) { issues.push(`scan failed: ${err.message}`); }
if (worldWritable.length) issues.push(`world-writable entries remain: ${worldWritable.join(', ')}`);
let doc = null;
try { doc = JSON.parse(fs.readFileSync(`${ROOT}/evidence/permissions.json`, 'utf8')); } catch { issues.push('create ~/evidence/permissions.json as valid JSON'); }
if (doc) {
  if (!Array.isArray(doc.issues) || doc.issues.length < 3) issues.push('list at least three permission issues you found and fixed');
  if (typeof doc.notes !== 'string' || doc.notes.trim().length < 25) issues.push('notes must explain the risk in at least 25 characters');
}
report(issues.length === 0, issues.length === 0 ? 'No world-writable files remain and the audit is documented.' : 'Workspace permissions still need work.', { issues, worldWritable });
