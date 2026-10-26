#!/usr/bin/env node
/**
 * labctl - approved lab administration CLI.
 *
 * Provides the learner with the same style of tooling a cloud engineer would
 * use to inspect and remediate a running service. It talks to the lab target's
 * authenticated admin API using the per-session admin credential placed in
 * ~/.lab/admin.token by the lab provisioner.
 *
 * The tool performs real requests against real lab services; it contains no
 * simulated answers or client-side scoring logic.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME ?? '/home/learner';
const tokenPath = path.join(HOME, '.lab', 'admin.token');
const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : process.env.CF_ADMIN_TOKEN ?? '';
const base = (process.env.CF_TARGET_URL ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

const usage = `labctl - CipherForge lab administration tool

Usage:
  labctl status                    Show target service status and current policy
  labctl audit                     Run a security audit against the target
  labctl policy show               Print the active admin policy (JSON)
  labctl policy apply <file>       Validate and apply a policy JSON file
  labctl call <METHOD> <path> [json-body]
  labctl whoami                    Show the credential in use (never prints the raw token)
  labctl help

Environment:
  CF_TARGET_URL   target base URL (${base})
  ~/.lab/admin.token  per-session admin credential
`;

function authHeaders(extra = {}) {
  if (!token) {
    console.error('No admin credential found at ~/.lab/admin.token. Is this a lab session with an admin API?');
    process.exit(2);
  }
  return { 'x-lab-admin-token': token, ...extra };
}

async function req(method, p, body) {
  const url = p.startsWith('http') ? p : `${base}${p.startsWith('/') ? '' : '/'}${p}`;
  const res = await fetch(url, {
    method,
    headers: authHeaders(body !== undefined ? { 'content-type': 'application/json' } : {}),
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: Object.fromEntries(res.headers), text, json };
}

function print(res) {
  if (res.json) console.log(JSON.stringify(res.json, null, 2));
  else console.log(res.text.slice(0, 8000));
  if (res.status >= 400) process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(usage);
  process.exit(0);
}

try {
  if (cmd === 'whoami') {
    console.log(`target:   ${base}`);
    console.log(`credential: ${token ? 'present (sha256:' + (await import('node:crypto')).createHash('sha256').update(token).digest('hex').slice(0, 12) + '...)' : 'MISSING'}`);
  } else if (cmd === 'status') {
    print(await req('GET', '/admin/status'));
  } else if (cmd === 'audit') {
    print(await req('POST', '/admin/audit'));
  } else if (cmd === 'policy') {
    const [sub, file] = rest;
    if (sub === 'show') print(await req('GET', '/admin/policy'));
    else if (sub === 'apply') {
      if (!file) {
        console.error('usage: labctl policy apply <policy.json>');
        process.exit(2);
      }
      const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(path.resolve(file), 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        console.error(`policy file is not valid JSON: ${err.message}`);
        process.exit(2);
      }
      print(await req('PUT', '/admin/policy', parsed));
    } else {
      console.log(usage);
      process.exit(2);
    }
  } else if (cmd === 'call') {
    const [method, p, body] = rest;
    if (!method || !p) {
      console.error('usage: labctl call <METHOD> <path> [json-body]');
      process.exit(2);
    }
    print(await req(method.toUpperCase(), p, body));
  } else {
    console.error(`unknown command: ${cmd}\n`);
    console.log(usage);
    process.exit(2);
  }
} catch (err) {
  console.error(`labctl: request failed: ${err.message}`);
  process.exit(1);
}
