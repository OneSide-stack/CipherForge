import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { ValidatorResult } from '@cipherforge/shared';
import { config } from '../config.js';
import { log, sanitize } from '../logger.js';
import {
  type Availability,
  type Driver,
  type ExecutionRequest,
  type MetricSnapshot,
  type PollResult,
  type ProvisionPayload,
  type SessionFailure,
  type SessionTarget,
  type StartSpec,
  type TargetUpstream,
  type TerminalChannel,
} from './types.js';
import { openTerminal, runValidator } from '../sandbox/broker-client.js';

interface SandboxSession {
  spec: StartSpec;
  sessionDir: string;
  socketDir: string;
  proc: ChildProcess | null;
  pid: number | null;
  state: PollResult['state'];
  detail: string;
  startedAt: number;
  readyAt?: number;
  lastActivity: number;
  failure?: SessionFailure;
  provision?: ProvisionPayload;
  provisionConsumed: boolean;
  targets: SessionTarget[];
  expectedStop: boolean;
  exitCode?: number;
  exitedAt?: number;
  verified: boolean;
}

const sessions = new Map<string, SandboxSession>();
let availabilityCache: { at: number; value: Availability } | null = null;

const SUPERVISOR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../sandbox/init.mjs');

function now(): number {
  return Date.now();
}

function sessionPaths(sessionId: string) {
  const sessionDir = path.join(config.runtimeDir, 'sessions', sessionId);
  return {
    sessionDir,
    socketDir: path.join(sessionDir, 'sock'),
    sharedDir: path.join(sessionDir, 'shared'),
    logDir: path.join(sessionDir, 'logs'),
    homeDir: path.join(sessionDir, 'home'),
    upperDir: path.join(sessionDir, 'upper'),
    workDir: path.join(sessionDir, 'work'),
    mergedDir: path.join(sessionDir, 'merged'),
    configPath: path.join(sessionDir, 'config.json'),
    pidPath: path.join(sessionDir, 'supervisor.pid'),
  };
}

function buildBriefing(spec: StartSpec): string {
  const t = spec.template;
  const published = t.services.flatMap((s) => s.ports.filter((p) => p.published).map((p) => `http://127.0.0.1:${p.port}`));
  return [
    `# ${t.title}`,
    '',
    `**${t.subtitle}**`,
    '',
    `- Category: ${t.category}`,
    `- Difficulty: ${t.difficulty}`,
    `- Session: ${spec.sessionId}`,
    `- Target: ${published[0] ?? '(no published target)'}`,
    `- Maximum session lifetime: ${t.resources.maxMinutes} minutes`,
    '',
    '## Scenario',
    '',
    t.scenario,
    '',
    '## Learning objectives',
    '',
    ...t.learningObjectives.map((o) => `- ${o}`),
    '',
    '## Authorized scope',
    '',
    t.authorizedScope,
    '',
    '## Objectives and flags',
    '',
    ...t.objectives.map((o, i) => `${i + 1}. **${o.title}** — ${o.description}`),
    '',
    '## Workspace tools',
    '',
    t.workspace.tools.map((tool) => `\`${tool}\``).join(' · '),
    '',
    '## Rules of engagement',
    '',
    '- Only the services inside this lab session are in scope.',
    '- Outbound internet access is denied by the session network policy.',
    '- Flags use the format `CF{...}`. Submitting the same objective twice grants no extra XP.',
    '- Progressive hints are available in the platform panel and reduce the XP for that objective.',
    '- A full walkthrough is available if you get stuck; using it applies a score penalty.',
    '',
    `_CipherForge Academy · ${t.id} v${t.version}_`,
    '',
  ].join('\n');
}

function buildMergedConfig(spec: StartSpec, dirs: ReturnType<typeof sessionPaths>) {
  const t = spec.template;
  const hostname = `cf-${t.id.slice(0, 18)}-${spec.sessionId.slice(0, 6)}`.replace(/[^a-z0-9-]/g, '');
  const firstPublished = t.services.flatMap((s) => s.ports.filter((p) => p.published).map((p) => p)).find(Boolean);
  return {
    sessionId: spec.sessionId,
    labId: t.id,
    labVersion: t.version,
    hostname,
    rootfsDir: config.rootfsDir,
    labsDir: config.labsDir,
    assetsDir: config.assetsDir,
    sessionSecret: spec.sessionSecret,
    resources: t.resources,
    network: t.network,
    ttlSeconds: spec.ttlSeconds,
    healthTimeoutMs: 30_000,
    provisionTimeoutMs: (t.provisioner?.timeoutSeconds ?? 45) * 1000,
    services: t.services.map((s) => ({
      name: s.name,
      role: s.role,
      app: s.app,
      ports: s.ports,
      health: s.health,
      env: s.env ?? {},
      flagObjectives: (s as unknown as { flagObjectives?: string[] }).flagObjectives ?? [],
    })),
    provisioner: t.provisioner?.script,
    targetUrl: firstPublished ? `http://127.0.0.1:${firstPublished.port}` : '',
    briefing: buildBriefing(spec),
    motd: [
      `\n  CipherForge Academy · ${t.title}`,
      `  ${t.subtitle}`,
      `  session ${spec.sessionId.slice(0, 8)} · ${t.difficulty} · ${t.category}`,
      `  Target: ${firstPublished ? `http://127.0.0.1:${firstPublished.port}` : 'see briefing'}`,
      `  Briefing: ~/README.md    Help: labctl help\n`,
    ].join('\n'),
    envExports: firstPublished ? `export CF_TARGET_URL=http://127.0.0.1:${firstPublished.port}` : '',
  };
}

async function tcpProbeSocket(socketPath: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function httpProbeSocket(socketPath: string, requestPath: string, timeoutMs = 4000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: requestPath, method: 'GET', timeout: timeoutMs, headers: { host: 'lab.local', connection: 'close' } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('probe timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function logTail(dir: string, lines = 25): Promise<string> {
  try {
    const files = await fsp.readdir(dir);
    const parts: string[] = [];
    for (const f of files.filter((x) => x.endsWith('.log')).slice(0, 6)) {
      const content = (await fsp.readFile(path.join(dir, f), 'utf8')).trim().split('\n').slice(-lines);
      if (content.length) parts.push(`${f}:\n${content.join('\n')}`);
    }
    return sanitize(parts.join('\n'), 3500);
  } catch {
    return '';
  }
}

async function killProcess(pid: number, signal: NodeJS.Signals = 'SIGTERM') {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

export class SandboxDriver implements Driver {
  readonly mode = 'sandbox' as const;

  async availability(): Promise<Availability> {
    if (availabilityCache && now() - availabilityCache.at < 20_000) return availabilityCache.value;
    const checks: Availability['checks'] = [];
    const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

    check('rootfs', fs.existsSync(path.join(config.rootfsDir, 'bin', 'bash')), config.rootfsDir);
    check('assets', fs.existsSync(path.join(config.assetsDir, 'node_modules', 'node-pty', 'lib', 'index.js')), config.assetsDir);
    check('unshare', fs.existsSync('/usr/bin/unshare'), 'unshare(1) present');
    check('pivot_root', fs.existsSync('/usr/sbin/pivot_root'), 'pivot_root present');
    let namespacesOk = false;
    let nsDetail = '';
    try {
      execFileSync('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--pid', '--net', '--fork', '/bin/true'], {
        timeout: 5000,
        stdio: 'ignore',
      });
      namespacesOk = true;
      nsDetail = 'user/mount/pid/net namespaces available';
    } catch (err) {
      nsDetail = sanitize(String((err as Error).message), 200);
    }
    check('namespaces', namespacesOk, nsDetail);
    let overlayOk = false;
    try {
      overlayOk = fs.readFileSync('/proc/filesystems', 'utf8').includes('overlay');
    } catch {}
    check('overlayfs', overlayOk, 'overlay filesystem supported by kernel');
    const setprivOk = fs.existsSync('/usr/bin/setpriv');
    check('no-new-privileges', setprivOk, setprivOk ? 'setpriv --no-new-privs wrapper available' : 'setpriv missing (warning: no_new_privs not applied)');

    const required = checks.filter((c) => c.id !== 'no-new-privileges');
    const available = required.every((c) => c.ok);
    const value: Availability = {
      available,
      mode: 'sandbox',
      checks,
      reason: available ? undefined : 'sandbox prerequisites missing — run `npm run setup:sandbox` and ensure unprivileged namespaces are enabled',
    };
    availabilityCache = { at: now(), value };
    return value;
  }

  async start(spec: StartSpec): Promise<PollResult> {
    const existing = sessions.get(spec.sessionId);
    if (existing) return this.poll(spec.sessionId);

    const availability = await this.availability();
    if (!availability.available) {
      throw Object.assign(new Error(availability.reason ?? 'sandbox driver unavailable'), { code: 'driver-unavailable', status: 503 });
    }

    const dirs = sessionPaths(spec.sessionId);
    await fsp.rm(dirs.sessionDir, { recursive: true, force: true });
    for (const dir of [dirs.sessionDir, dirs.socketDir, dirs.sharedDir, dirs.logDir, dirs.homeDir, dirs.upperDir, dirs.workDir, dirs.mergedDir]) {
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    }
    const mergedConfig = buildMergedConfig(spec, dirs);
    await fsp.writeFile(dirs.configPath, JSON.stringify(mergedConfig, null, 2), { mode: 0o600 });

    const session: SandboxSession = {
      spec,
      sessionDir: dirs.sessionDir,
      socketDir: dirs.socketDir,
      proc: null,
      pid: null,
      state: 'provisioning',
      detail: 'Sandbox session allocated; building isolated filesystem',
      startedAt: now(),
      lastActivity: now(),
      provisionConsumed: false,
      targets: spec.template.services
        .flatMap((s) => s.ports.filter((p) => p.published).map((p) => ({ name: p.name, port: p.port, protocol: p.protocol }))),
      expectedStop: false,
      verified: false,
    };
    sessions.set(spec.sessionId, session);

    const logFd = fs.openSync(path.join(dirs.logDir, 'host-supervisor.log'), 'a');
    const unshareArgs = [
      '--user',
      '--map-root-user',
      '--mount',
      '--pid',
      '--net',
      '--uts',
      '--ipc',
      '--fork',
      '--kill-child',
      process.execPath,
      SUPERVISOR,
      dirs.sessionDir,
      dirs.configPath,
    ];
    const useSetpriv = fs.existsSync('/usr/bin/setpriv');
    const bin = useSetpriv ? '/usr/bin/setpriv' : '/usr/bin/unshare';
    const args = useSetpriv ? ['--no-new-privs', '/usr/bin/unshare', ...unshareArgs] : unshareArgs;

    const proc = spawn(bin, args, {
      stdio: ['ignore', logFd, logFd],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/nonexistent', TZ: 'UTC', CF_SANDBOX: '1' },
    });
    session.proc = proc;
    session.pid = proc.pid ?? null;
    if (session.pid) await fsp.writeFile(dirs.pidPath, String(session.pid));

    proc.on('exit', (code, signal) => {
      session.exitCode = code ?? undefined;
      session.exitedAt = now();
      fs.closeSync(logFd);
      log.info('sandbox supervisor exited', { sessionId: spec.sessionId, code, signal });
      if (session.state === 'stopped' || session.state === 'expired') return;
      const map: Record<number, { state: PollResult['state']; code: string; message: string }> = {
        0: { state: session.expectedStop ? 'stopped' : 'failed', code: 'runtime-exited', message: 'Lab runtime exited unexpectedly' },
        1: { state: 'failed', code: 'provisioning-failed', message: 'Lab runtime could not finish starting' },
        3: { state: 'failed', code: 'resource-limit', message: 'Session exceeded its resource limits' },
        4: { state: 'failed', code: 'service-crash', message: 'A lab service crashed' },
        5: { state: 'expired', code: 'ttl-expired', message: 'Session reached its maximum lifetime' },
        6: { state: 'expired', code: 'idle-timeout', message: 'Session stopped after inactivity' },
      };
      const mapped = map[code ?? -1] ?? { state: 'failed' as const, code: 'runtime-exited', message: `Lab runtime exited (code ${code ?? 'null'})` };
      void this.finalize(session, mapped.state, mapped.code, mapped.message);
    });
    proc.on('error', (err) => {
      void this.finalize(session, 'failed', 'driver-error', `Could not start sandbox supervisor: ${err.message}`);
    });

    log.info('sandbox session provisioning', { sessionId: spec.sessionId, pid: session.pid, lab: spec.labId });
    return this.poll(spec.sessionId);
  }

  private async finalize(session: SandboxSession, state: PollResult['state'], code: string, message: string, detail?: string) {
    if (session.state === state) return;
    session.state = state;
    session.detail = message;
    session.exitCode ??= session.proc?.exitCode ?? undefined;
    if (state === 'failed' || state === 'expired') {
      // Prefer the sandbox's own startup diagnostics: the supervisor writes them
      // to shared/ (readable by the runner) and they explain the real cause.
      const shared = path.join(session.sessionDir, 'shared');
      let diag = '';
      try {
        const startup = JSON.parse(await fsp.readFile(path.join(shared, 'startup-error.json'), 'utf8'));
        diag = `[${startup.code}] ${startup.message}\n${startup.detail ?? ''}`;
      } catch {}
      if (!diag) {
        try {
          diag = (await fsp.readFile(path.join(shared, 'logs/supervisor.log'), 'utf8')).slice(-2500);
        } catch {}
      }
      if (!diag) diag = await logTail(session.sessionDir + '/logs');
      session.failure = { code, message, detail: sanitize(detail ?? diag, 2500) };
    }
  }

  async poll(sessionId: string): Promise<PollResult> {
    const session = sessions.get(sessionId);
    if (!session) {
      return { state: 'stopped', detail: 'No such session on this runner', targets: [] };
    }
    if (session.state === 'ready' || session.state === 'failed' || session.state === 'expired' || session.state === 'stopped') {
      return this.snapshot(session);
    }
    const dirs = sessionPaths(sessionId);
    const startupError = await readJson<{ code: string; message: string; detail: string }>(path.join(dirs.sharedDir, 'startup-error.json'));
    if (startupError) {
      if (session.proc && session.pid) await killProcess(session.pid, 'SIGTERM');
      await this.finalize(session, 'failed', startupError.code ?? 'provisioning-failed', startupError.message, startupError.detail);
      return this.snapshot(session);
    }
    const phase = await readJson<{ phase: string }>(path.join(dirs.sharedDir, 'phase.json'));
    if (phase?.phase === 'ready' && !session.verified) {
      session.state = 'starting';
      session.detail = 'Services started; verifying target health through the session gateway';
      const verification = await this.verifyTargets(session);
      if (!verification.ok) {
        await this.finalize(session, 'failed', 'healthcheck-failed', 'Target services did not become reachable', verification.detail);
        return this.snapshot(session);
      }
      const provision = await readJson<ProvisionPayload>(path.join(dirs.sessionDir, 'provision-result.json'));
      log.info('provision handoff read', { sessionId, found: Boolean(provision) });
      if (provision) {
        session.provision = {
          flags: provision.flags ?? {},
          meta: provision.meta ?? {},
        };
        await fsp.rm(path.join(dirs.sessionDir, 'provision-result.json'), { force: true });
      }
      session.verified = true;
      session.state = 'ready';
      session.readyAt = now();
      session.lastActivity = now();
      session.detail = 'Lab is ready — all services passed health checks';
      log.info('sandbox session ready', { sessionId, targets: session.targets });
      return this.snapshot(session);
    }
    if (phase?.phase === 'starting' || phase?.phase === 'starting-services') {
      session.state = 'starting';
      session.detail = phase.phase === 'starting' ? 'Provisioning lab artifacts' : 'Starting lab services';
    } else {
      session.state = 'provisioning';
      session.detail = session.detail || 'Building isolated filesystem';
    }
    if (session.proc && session.pid) {
      try {
        process.kill(session.pid, 0);
      } catch {
        // process already gone; the exit handler will finalize
      }
    }
    return this.snapshot(session);
  }

  private async verifyTargets(session: SandboxSession): Promise<{ ok: boolean; detail: string }> {
    const details: string[] = [];
    for (const svc of session.spec.template.services) {
      if (svc.role === 'workspace') continue;
      for (const port of svc.ports.filter((p) => p.published)) {
        const socketPath = path.join(session.socketDir, `pub-${port.name}.sock`);
        const reachable = await tcpProbeSocket(socketPath);
        if (!reachable) return { ok: false, detail: `gateway bridge for ${svc.name}/${port.name} is not reachable` };
        if (svc.health?.kind === 'http') {
          try {
            const res = await httpProbeSocket(socketPath, svc.health.path ?? '/');
            const expected = svc.health.expectStatus ?? 200;
            if (res.status !== expected) {
              return { ok: false, detail: `${svc.name} gateway returned HTTP ${res.status}, expected ${expected}` };
            }
            if (svc.health.expectBody && !res.body.includes(svc.health.expectBody)) {
              return { ok: false, detail: `${svc.name} gateway response did not include the expected health marker` };
            }
            details.push(`${svc.name}:${port.name} HTTP ${res.status} verified through gateway`);
          } catch (err) {
            return { ok: false, detail: `${svc.name} gateway probe failed: ${sanitize((err as Error).message, 200)}` };
          }
        } else {
          details.push(`${svc.name}:${port.name} TCP bridge verified`);
        }
      }
    }
    return { ok: true, detail: details.join('; ') };
  }

  private snapshot(session: SandboxSession): PollResult {
    const dirs = sessionPaths(session.spec.sessionId);
    const result: PollResult = {
      state: session.state,
      detail: session.detail,
      targets: session.targets,
      startedAt: new Date(session.startedAt).toISOString(),
      readyAt: session.readyAt ? new Date(session.readyAt).toISOString() : undefined,
      failure: session.failure,
    };
    try {
      const metrics = JSON.parse(fs.readFileSync(path.join(dirs.sharedDir, 'metrics.json'), 'utf8'));
      result.metrics = {
        processes: Number(metrics.processes ?? 0),
        rssMb: Number(metrics.rssMb ?? 0),
      };
    } catch {}
    return result;
  }

  /** One-shot handoff of raw flags to the API, which hashes them immediately. */
  takeProvision(sessionId: string): ProvisionPayload | undefined {
    const session = sessions.get(sessionId);
    if (!session || session.provisionConsumed || !session.provision) return undefined;
    session.provisionConsumed = true;
    const payload = session.provision;
    // Raw flags leave the runner's memory as soon as the API has them.
    session.provision = undefined;
    return payload;
  }

  consumeProvision(sessionId: string): ProvisionPayload | undefined {
    return this.takeProvision(sessionId);
  }

  noteActivity(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) session.lastActivity = now();
  }

  async stop(sessionId: string, reason: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.state === 'stopped' || session.state === 'expired') return;
    session.expectedStop = true;
    session.detail = `Session stopping (${reason})`;
    session.state = 'stopping';
    if (session.pid) await killProcess(session.pid, 'SIGTERM');
    const deadline = now() + 9000;
    while (session.proc && session.proc.exitCode === null && now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (session.proc && session.proc.exitCode === null && session.pid) {
      await killProcess(session.pid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 250));
    }
    const finalState = reason === 'expired' ? 'expired' : reason === 'failed' ? 'failed' : 'stopped';
    session.state = finalState;
    session.exitedAt = session.exitedAt ?? now();
    session.detail = reason === 'expired' ? 'Session expired' : 'Session stopped';
    log.info('sandbox session stopped', { sessionId, reason });
  }

  async remove(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    // Debugging aid: CF_KEEP_FAILED_SESSIONS=1 preserves runtime dirs so the
    // supervisor log can be inspected after a failed start.
    if (process.env.CF_KEEP_FAILED_SESSIONS === '1' && session && session.state === 'failed') {
      log.warn('keeping failed session dirs for inspection', { sessionId, dir: sessionPaths(sessionId).sessionDir });
      sessions.delete(sessionId);
      return;
    }
    if (session) {
      if (session.state !== 'stopped' && session.state !== 'expired' && session.state !== 'failed') {
        await this.stop(sessionId, 'stopped');
      }
    }
    const dirs = sessionPaths(sessionId);
    if (session?.pid) await killProcess(session.pid, 'SIGKILL');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await fsp.rm(dirs.sessionDir, { recursive: true, force: true });
        break;
      } catch (err) {
        if (attempt === 2) log.warn('failed to remove sandbox dirs', { sessionId, error: (err as Error).message });
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    sessions.delete(sessionId);
  }

  async reset(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('session not found on runner'), { code: 'not-found', status: 404 });
    const spec = session.spec;
    await this.remove(sessionId);
    await this.start(spec);
  }

  async validate(sessionId: string, req: ExecutionRequest): Promise<ValidatorResult> {
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'ready') {
      return { passed: false, detail: 'Lab session is not ready; start or resume the lab before validating objectives.' };
    }
    const allowed = session.spec.template.validators ?? [];
    if (!allowed.includes(req.validator)) {
      return { passed: false, detail: 'This validator is not approved for the lab template.' };
    }
    this.noteActivity(sessionId);
    try {
      const result = await runValidator(path.join(session.socketDir, 'broker.sock'), session.spec.labId, {
        objectiveId: req.objectiveId,
        validator: req.validator,
        meta: req.meta,
        evidence: req.evidence,
        timeoutMs: req.timeoutMs,
      });
      return result;
    } catch (err) {
      return { passed: false, detail: `Validator could not run inside the lab session: ${sanitize((err as Error).message, 300)}` };
    }
  }

  async terminal(sessionId: string, cols: number, rows: number): Promise<TerminalChannel> {
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'ready') throw Object.assign(new Error('session is not ready'), { code: 'not-ready', status: 409 });
    this.noteActivity(sessionId);
    return openTerminal(path.join(session.socketDir, 'broker.sock'), cols, rows);
  }

  async targetUpstream(sessionId: string, name: string): Promise<TargetUpstream> {
    const session = sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('unknown session'), { code: 'not-found', status: 404 });
    if (session.state !== 'ready') throw Object.assign(new Error('session is not ready'), { code: 'not-ready', status: 409 });
    const approved = session.spec.template.services.flatMap((s) => s.ports.filter((p) => p.published));
    if (!approved.some((p) => p.name === name)) {
      throw Object.assign(new Error('target is not published for this lab'), { code: 'target-not-approved', status: 404 });
    }
    this.noteActivity(sessionId);
    return { kind: 'unix', socketPath: path.join(session.socketDir, `pub-${name}.sock`) };
  }

  async metrics(sessionId: string): Promise<MetricSnapshot | null> {
    const session = sessions.get(sessionId);
    if (!session) return null;
    const dirs = sessionPaths(sessionId);
    const metrics = await readJson<{ processes?: number; rssMb?: number; cpuTicks?: number; at?: string }>(path.join(dirs.sharedDir, 'metrics.json'));
    if (!metrics) return null;
    return { processes: metrics.processes ?? 0, rssMb: metrics.rssMb ?? 0, cpuTicks: metrics.cpuTicks ?? 0, readAt: metrics.at ?? new Date().toISOString() };
  }

  listManaged(): string[] {
    return [...sessions.keys()];
  }

  async cleanupOrphans(): Promise<{ removed: string[]; killed: number[] }> {
    const removed: string[] = [];
    const killed: number[] = [];
    const root = path.join(config.runtimeDir, 'sessions');
    let entries: string[] = [];
    try {
      entries = await fsp.readdir(root);
    } catch {
      return { removed, killed };
    }
    for (const entry of entries) {
      if (!/^[0-9a-f-]{20,40}$/i.test(entry)) continue;
      const sessionDir = path.join(root, entry);
      const pidPath = path.join(sessionDir, 'supervisor.pid');
      try {
        const pid = Number((await fsp.readFile(pidPath, 'utf8')).trim());
        const cmdline = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
        if (pid > 1 && cmdline.includes('sandbox/init.mjs') && cmdline.includes(entry)) {
          await killProcess(pid, 'SIGKILL');
          killed.push(pid);
          removed.push(entry);
        }
      } catch {}
      try {
        await fsp.rm(sessionDir, { recursive: true, force: true });
        if (!removed.includes(entry)) removed.push(entry);
      } catch {}
    }
    return { removed, killed };
  }

  describe(): Record<string, unknown> {
    return {
      mode: 'sandbox',
      rootfsDir: config.rootfsDir,
      assetsDir: config.assetsDir,
      isolation: {
        runtime: 'user+pid+mount+net+uts+ipc namespaces',
        rootFilesystem: 'overlayfs with pivot_root, approved assets mounted read-only',
        writableStorage: 'size-bounded tmpfs for /tmp, /var/tmp and /home/learner',
        network: 'private netns: loopback only, no outbound route, no host ports',
        kernel: 'shared with host (no seccomp/AppArmor in sandbox mode) - see docs/SECURITY.md',
      },
    };
  }
}

export function sandboxInitPath(): string {
  return SUPERVISOR;
}

export function hashSessionId(id: string): string {
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
}
