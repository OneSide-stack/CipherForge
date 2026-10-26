/** Tiny helpers shared by lab validators (run inside the session). */
import fs from 'node:fs';

export function report(passed, detail, evidence = undefined) {
  console.log('CF_VALIDATOR:' + JSON.stringify({ passed, detail, evidence }));
  process.exit(0);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export async function fetchText(url, options = {}) {
  try {
    const res = await fetch(url, { redirect: 'manual', ...options });
    const text = await res.text();
    return { ok: true, status: res.status, headers: res.headers, text };
  } catch (err) {
    return { ok: false, status: 0, error: String(err.message ?? err), headers: new Headers(), text: '' };
  }
}

export function any(checks) {
  return checks.filter(Boolean);
}
