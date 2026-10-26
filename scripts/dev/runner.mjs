#!/usr/bin/env node
/** Start the lab-runner for local development. */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '../..');
loadEnv(path.join(repo, '.env'));
const secret = process.env.CF_RUNNER_SECRET ?? crypto.randomBytes(32).toString('hex');
const env = {
  ...process.env,
  CF_REPO_ROOT: repo,
  CF_RUNNER_SECRET: secret,
};
if (!env.CF_RUNNER_DRIVER) env.CF_RUNNER_DRIVER = 'auto';
console.log(`[runner] mode=${env.CF_RUNNER_DRIVER} port=${env.CF_RUNNER_PORT ?? 7100}`);
const child = spawn(process.execPath, [path.join(repo, 'apps/runner/dist/index.js')], { stdio: 'inherit', env });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code) => process.exit(code ?? 0));

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
