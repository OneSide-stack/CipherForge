#!/usr/bin/env node
/**
 * CipherForge Academy local development orchestrator.
 *
 * Starts, in order:
 *   1. a real PostgreSQL instance (embedded binaries when DATABASE_URL is unset)
 *   2. schema migrations + seed data
 *   3. the isolated lab-runner (Docker if available, otherwise the sandbox driver)
 *   4. the API + built web client on CF_API_PORT (default 5000)
 *
 * Usage:
 *   npm run dev                 # embedded postgres + sandbox/docker runner + web
 *   npm run dev -- --build-web  # rebuild the frontend first
 *   DATABASE_URL=... npm run dev  # use an external PostgreSQL
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const repo = path.resolve(import.meta.dirname, '../..');
loadEnv(path.join(repo, '.env'));

const args = new Set(process.argv.slice(2));
const runtime = process.env.CF_RUNTIME_DIR ?? path.join(os.homedir(), '.cache', 'cipherforge');
fs.mkdirSync(runtime, { recursive: true });
const stateFile = path.join(runtime, 'dev-state.json');
const devState = readJson(stateFile) ?? {};
const secrets = {
  CF_APP_SECRET: process.env.CF_APP_SECRET ?? devState.CF_APP_SECRET ?? crypto.randomBytes(32).toString('hex'),
  CF_RUNNER_SECRET: process.env.CF_RUNNER_SECRET ?? devState.CF_RUNNER_SECRET ?? crypto.randomBytes(32).toString('hex'),
};
fs.writeFileSync(stateFile, JSON.stringify({ ...devState, ...secrets }, null, 2), { mode: 0o600 });
for (const [k, v] of Object.entries(secrets)) process.env[k] ??= v;

const apiPort = Number(process.env.CF_API_PORT ?? 5000);
const runnerPort = Number(process.env.CF_RUNNER_PORT ?? 7100);
const pgPort = Number(process.env.CF_PG_PORT ?? 54329);
const useEmbeddedPg = !process.env.DATABASE_URL;
const children = [];
let embeddedPg = null;
let shuttingDown = false;

const log = (...a) => console.log('[dev]', ...a);

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
async function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(600);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}
function spawnStep(name, command, env = {}, stdio = 'inherit') {
  const child = spawn(command[0], command.slice(1), { cwd: repo, env: { ...process.env, ...env }, stdio });
  child.on('exit', (code) => {
    if (!shuttingDown && name !== 'web-build') {
      console.error(`[dev] ${name} exited with code ${code}`);
      void shutdown(code ?? 1);
    }
  });
  if (name !== 'web-build') children.push({ name, child });
  return child;
}
function runOnce(name, command, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd: repo, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${name} failed with code ${code}`))));
    child.on('error', reject);
  });
}

async function startEmbeddedPostgres() {
  if (!useEmbeddedPg) {
    log('using external DATABASE_URL');
    return process.env.DATABASE_URL;
  }
  if (process.env.CF_EMBEDDED_PG === '0') throw new Error('No DATABASE_URL and CF_EMBEDDED_PG=0; provide a database connection string');
  const dataDir = path.join(runtime, 'pgdata');
  const password = 'cipherforge';
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'cipherforge', password, port: pgPort, persistent: true });
  const initialized = fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  if (initialized) log('starting existing embedded PostgreSQL', dataDir);
  else {
    log('initialising embedded PostgreSQL', dataDir);
    await pg.initialise();
  }
  try {
    await pg.start();
  } catch (err) {
    if (String(err.message).includes('already running') || (await portOpen(pgPort))) log('embedded PostgreSQL already running');
    else throw err;
  }
  const { Client } = await import('pg');
  const admin = new Client({ host: '127.0.0.1', port: pgPort, user: 'cipherforge', password, database: 'postgres' });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'cipherforge'");
  if (!exists.rowCount) {
    await admin.query('CREATE DATABASE cipherforge');
    log('created database cipherforge');
  }
  await admin.end();
  embeddedPg = pg;
  return `postgres://cipherforge:${password}@127.0.0.1:${pgPort}/cipherforge`;
}

function detectDriver() {
  const configured = process.env.CF_RUNNER_DRIVER;
  if (configured) return configured;
  const dockerSocket = process.env.CF_DOCKER_SOCKET ?? '/var/run/docker.sock';
  return fs.existsSync(dockerSocket) ? 'auto' : 'sandbox';
}

async function main() {
  for (const [name, port] of [
    ['API', apiPort],
    ['runner', runnerPort],
  ]) {
    if (await portOpen(port)) {
      throw new Error(`${name} port ${port} is already in use. Stop the other process or set CF_${name.toUpperCase()}_PORT.`);
    }
  }

  const databaseUrl = await startEmbeddedPostgres();
  process.env.DATABASE_URL = databaseUrl;
  const dbEnv = { DATABASE_URL: databaseUrl, CF_REPO_ROOT: repo, CF_APP_SECRET: process.env.CF_APP_SECRET };

  // A fresh clone has no compiled backend yet; build it so `npm run dev` works
  // directly after `npm install` (the README quick start relies on this).
  const backendArtifacts = [
    path.join(repo, 'apps/api/dist/db/migrate.js'),
    path.join(repo, 'apps/api/dist/index.js'),
    path.join(repo, 'apps/runner/dist/index.js'),
  ];
  if (backendArtifacts.some((file) => !fs.existsSync(file))) {
    if (!fs.existsSync(path.join(repo, 'node_modules/typescript'))) {
      throw new Error('backend is not built and dev dependencies are missing — run npm install first');
    }
    log('backend is not built; compiling shared + api + runner');
    await runOnce('build-backend', ['npm', 'run', 'build:backend']);
  }

  log('running database migrations');
  await runOnce('migrate', ['node', 'apps/api/dist/db/migrate.js'], dbEnv);
  log('seeding catalog, achievements, paths and development accounts');
  await runOnce('seed', ['node', 'apps/api/dist/db/seed.js'], dbEnv);

  const webDist = path.join(repo, 'apps/web/dist');
  if (args.has('--skip-web')) {
    log('skipping web build (--skip-web); API only');
  } else if (args.has('--build-web') || !fs.existsSync(path.join(webDist, 'index.html'))) {
    if (!fs.existsSync(path.join(repo, 'apps/web/node_modules')) && !fs.existsSync(path.join(repo, 'node_modules/vite'))) {
      throw new Error('frontend dependencies are missing — run npm install first');
    }
    log('building web client');
    await runOnce('web-build', ['npm', 'run', 'build', '-w', '@cipherforge/web']);
  }

  const driver = detectDriver();
  log(`starting lab runner (driver: ${driver}) on 127.0.0.1:${runnerPort}`);
  spawnStep('runner', ['node', 'apps/runner/dist/index.js'], {
    CF_REPO_ROOT: repo,
    CF_RUNNER_SECRET: process.env.CF_RUNNER_SECRET,
    CF_RUNNER_DRIVER: driver,
    CF_RUNNER_PORT: String(runnerPort),
    CF_RUNNER_BIND: '127.0.0.1',
    CF_RUNTIME_DIR: runtime,
    CF_LABS_DIR: path.join(repo, 'labs'),
  });

  log(`starting API on 0.0.0.0:${apiPort}`);
  spawnStep('api', ['node', 'apps/api/dist/index.js'], {
    CF_REPO_ROOT: repo,
    DATABASE_URL: databaseUrl,
    CF_APP_SECRET: process.env.CF_APP_SECRET,
    CF_RUNNER_SECRET: process.env.CF_RUNNER_SECRET,
    CF_RUNNER_URL: `http://127.0.0.1:${runnerPort}`,
    CF_API_PORT: String(apiPort),
    CF_API_BIND: '0.0.0.0',
    CF_WEB_DIST: webDist,
    CF_LABS_DIR: path.join(repo, 'labs'),
    CF_RUNTIME_DIR: runtime,
    CF_COOKIE_SECURE: process.env.CF_COOKIE_SECURE ?? 'false',
  });

  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`);
      if (res.ok) break;
    } catch {}
  }
  let health = null;
  try {
    health = await (await fetch(`http://127.0.0.1:${apiPort}/api/health`)).json();
  } catch {}
  console.log('\n┌──────────────────────────────────────────────────────────────┐');
  console.log('│  CipherForge Academy is running                              │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  console.log(`  Local:        http://127.0.0.1:${apiPort}`);
  console.log(`  Preview:      https://<sandbox-port-${apiPort}>.e2b.app  (served on 0.0.0.0:${apiPort})`);
  console.log(`  Lab worker:   ${health?.runner?.mode ?? driver} @ 127.0.0.1:${runnerPort}`);
  console.log(`  Database:     ${useEmbeddedPg ? `embedded PostgreSQL :${pgPort}` : 'external DATABASE_URL'}`);
  console.log(`  Dev accounts: ${process.env.CF_ADMIN_EMAIL ?? 'admin@cipherforge.dev'} (admin), ${process.env.CF_LEARNER_EMAIL ?? 'learner@cipherforge.dev'} (learner)`);
  console.log('  Stop with Ctrl+C\n');
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down');
  for (const { name, child } of children.reverse()) {
    try {
      child.kill('SIGTERM');
      log(`stopped ${name}`);
    } catch {}
  }
  await sleep(500);
  if (embeddedPg) {
    try {
      await embeddedPg.stop();
      log('stopped embedded PostgreSQL');
    } catch {}
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

main().catch(async (err) => {
  console.error('[dev] failed:', err.message);
  console.error('[dev] troubleshooting: see README.md#troubleshooting (ports, Docker access, sandbox setup)');
  await shutdown(1);
});
