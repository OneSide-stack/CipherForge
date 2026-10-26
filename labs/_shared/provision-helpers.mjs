/**
 * Shared helpers for lab provisioners. Provisioners run once inside the
 * session (after the target app is healthy) and place learner-facing assets.
 * Flags are emitted through CF_RESULT and never written to the workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import { adminToken } from './appkit.mjs';

export const HOME = process.env.CF_WORKSPACE ?? '/home/learner';
export const SECRET = process.env.CF_SESSION_SECRET ?? '';
export const TARGET = process.env.CF_TARGET_URL || 'http://127.0.0.1:8080';

export function adminTokenFile() {
  const dir = path.join(HOME, '.lab');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'admin.token'), process.env.CF_ADMIN_TOKEN ?? adminToken(SECRET), { mode: 0o600 });
  fs.chmodSync(path.join(dir, 'admin.token'), 0o600);
}

export function write(rel, contents, mode = 0o644) {
  const file = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode });
  try {
    fs.chmodSync(file, mode);
  } catch {}
  return file;
}

export function evidenceReadme(title, instructions) {
  write('evidence/README.md', `# Evidence · ${title}\n\n${instructions}\n\nWrite findings as JSON in this directory. Validators read files here with absolute paths (/home/learner/evidence/...).\n`);
}

export function credentials({ url = TARGET, email, password, notes = '' }) {
  write(
    'credentials.txt',
    `Training credentials\n--------------------\nURL:      ${url}\nEmail:    ${email}\nPassword: ${password}\n\n${notes}\nOnly this lab's synthetic service is in scope. Outbound internet is denied.\n`,
  );
}

export function emit(flags, meta = {}) {
  console.log('CF_RESULT:' + JSON.stringify({ flags, meta }));
}

export function briefing(fields) {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k.charAt(0).toUpperCase() + k.slice(1)}: ${v}`);
  write('BRIEFING.txt', `${lines.join('\n')}\n`);
}
