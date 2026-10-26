/**
 * Docker-backed lab driver.
 *
 * This is the production execution backend. It is the only component in the
 * platform that talks to the Docker Engine socket; the API and web tiers never
 * see it. Every invocation is derived from a published lab template inside the
 * version-controlled registry, never from learner input.
 *
 * Hardening applied to every container:
 *   - no privileged mode, no host network/pid/ipc, no host binds, no devices
 *   - all capabilities dropped, no-new-privileges, default seccomp/AppArmor
 *   - read-only root filesystem with size-bounded tmpfs scratch space
 *   - non-root user, explicit CPU / memory / PID limits
 *   - one private internal Docker network per session (no outbound internet)
 *   - target ports are never published; access is only via the API gateway
 */
import crypto from 'node:crypto';
import http from 'node:http';
import Docker from 'dockerode';
import type { Container, ContainerCreateOptions, Network } from 'dockerode';
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

interface DockerSession {
  spec: StartSpec;
  networkName: string;
  workspaceName: string;
  serviceNames: Map<string, string>;
  state: PollResult['state'];
  detail: string;
  startedAt: number;
  readyAt?: number;
  lastActivity: number;
  failure?: SessionFailure;
  provision?: ProvisionPayload;
  provisionConsumed: boolean;
  targets: SessionTarget[];
  targetIps: Map<string, { host: string; port: number }>;
  expectedStop: boolean;
}

const sessions = new Map<string, DockerSession>();
let availabilityCache: { at: number; value: Availability } | null = null;

const LABEL_MANAGED = 'cf.managed';
const LABEL_SESSION = 'cf.session';
const LABEL_USER = 'cf.user';
const LABEL_LAB = 'cf.lab';

function sid(id: string): string {
  return id.replace(/-/g, '').slice(0, 12);
}

function containerName(sessionId: string, suffix: string): string {
  return `cf-${suffix}-${sid(sessionId)}`;
}

function networkName(sessionId: string): string {
  return `cfnet-${sid(sessionId)}`;
}

function httpGet(host: string, port: number, urlPath: string, timeoutMs = 3000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: urlPath, method: 'GET', timeout: timeoutMs, headers: { connection: 'close' } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function inContainer(container: Container, cmd: string[], opts: { env?: string[]; user?: string; timeoutMs?: number } = {}) {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Env: opts.env,
    User: opts.user ?? '1000:1000',
    WorkingDir: '/home/learner',
  });
  const stream = await exec.start({});
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => stream.destroy(new Error('exec timeout')), opts.timeoutMs ?? 30_000);
  await new Promise<void>((resolve) => {
    (stream as unknown as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
      let offset = 0;
      while (offset + 8 <= chunk.length) {
        const type = chunk[offset];
        const len = chunk.readUInt32BE(offset + 4);
        const payload = chunk.subarray(offset + 8, offset + 8 + len);
        if (type === 1) stdout += payload.toString();
        else if (type === 2) stderr += payload.toString();
        offset += 8 + len;
      }
      if (offset === 0) stdout += chunk.toString();
    });
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', resolve);
  });
  clearTimeout(timer);
  const inspect = await exec.inspect();
  return { code: inspect.ExitCode ?? -1, stdout, stderr, running: inspect.Running };
}

async function removeQuietly(container: Container): Promise<void> {
  try {
    await container.remove({ force: true, v: true });
  } catch {}
}

export class DockerDriver implements Driver {
  readonly mode = 'docker' as const;
  private docker: Docker;

  constructor() {
    this.docker = config.dockerHost ? new Docker({ host: config.dockerHost }) : new Docker({ socketPath: config.dockerSocket });
  }

  async availability(): Promise<Availability> {
    if (availabilityCache && Date.now() - availabilityCache.at < 15_000) return availabilityCache.value;
    const checks: Availability['checks'] = [];
    try {
      const info = await this.docker.info();
      checks.push({ id: 'engine', ok: true, detail: `Docker ${info.ServerVersion} on ${info.OperatingSystem}` });
      const securityOptions: string[] = info.SecurityOptions ?? [];
      const rootless = securityOptions.some((o) => o.toLowerCase().includes('rootless'));
      checks.push({
        id: 'rootless',
        ok: rootless,
        detail: rootless ? 'Docker Engine is running rootless' : 'Docker Engine is rootful — restrict the runner host (see docs/SECURITY.md)',
      });
      checks.push({
        id: 'cgroup',
        ok: Boolean(info.ServerVersion),
        detail: `Cgroup driver: ${(info as unknown as { CgroupDriver?: string }).CgroupDriver ?? 'unknown'}`,
      });
      const value: Availability = {
        available: true,
        mode: 'docker',
        checks,
        reason: rootless ? undefined : 'Docker reachable (rootful); production guidance requires a dedicated disposable worker host',
      };
      availabilityCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      const value: Availability = {
        available: false,
        mode: 'docker',
        checks: [{ id: 'engine', ok: false, detail: sanitize((err as Error).message, 300) }],
        reason: `Docker Engine is not reachable at ${config.dockerHost || config.dockerSocket}. Start Docker or use the sandbox driver (CF_RUNNER_DRIVER=sandbox).`,
      };
      availabilityCache = { at: Date.now(), value };
      return value;
    }
  }

  private async assertImagesPresent(spec: StartSpec): Promise<void> {
    const required = new Set(spec.template.images.map((i) => i.ref));
    const missing: string[] = [];
    for (const ref of required) {
      try {
        await this.docker.getImage(ref).inspect();
      } catch {
        missing.push(ref);
      }
    }
    if (missing.length) {
      throw Object.assign(new Error(`Approved lab images are missing locally: ${missing.join(', ')}. Build them with scripts/ci/build-images.sh`), {
        code: 'image-missing',
        status: 503,
      });
    }
  }

  private baseHostConfig(spec: StartSpec): ContainerCreateOptions['HostConfig'] {
    const r = spec.template.resources;
    return {
      // No privileged mode, no host namespaces, no devices, no bind mounts.
      Privileged: false,
      NetworkMode: networkName(spec.sessionId),
      ReadonlyRootfs: true,
      Tmpfs: {
        '/tmp': `rw,noexec,nosuid,nodev,size=${r.writableDiskMb}m`,
        '/run': 'rw,noexec,nosuid,nodev,size=8m',
      },
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      Devices: [],
      Binds: [],
      Memory: r.memoryMb * 1024 * 1024,
      MemorySwap: r.memoryMb * 1024 * 1024,
      MemorySwappiness: 0,
      PidsLimit: r.pids,
      NanoCpus: Math.round(r.cpus * 1_000_000_000),
      OomKillDisable: false,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      AutoRemove: false,
    };
  }

  private labels(spec: StartSpec): Record<string, string> {
    return {
      [LABEL_MANAGED]: 'true',
      [LABEL_SESSION]: spec.sessionId,
      [LABEL_USER]: spec.userId,
      [LABEL_LAB]: spec.labId,
      'cf.template.version': spec.template.version,
    };
  }

  private envFor(spec: StartSpec, appSeed: string, adminToken: string) {
    return [
      `CF_SESSION_ID=${spec.sessionId}`,
      `CF_LAB_ID=${spec.labId}`,
      `CF_APP_SEED=${appSeed}`,
      `CF_ADMIN_TOKEN=${adminToken}`,
      'TZ=UTC',
    ];
  }

  async start(spec: StartSpec): Promise<PollResult> {
    const existing = sessions.get(spec.sessionId);
    if (existing) return this.poll(spec.sessionId);
    const availability = await this.availability();
    if (!availability.available) throw Object.assign(new Error(availability.reason ?? 'docker unavailable'), { code: 'driver-unavailable', status: 503 });
    await this.assertImagesPresent(spec);

    const appSeed = crypto.createHmac('sha256', spec.sessionSecret).update(`app-seed:${spec.labId}`).digest('hex').slice(0, 64);
    const adminToken = crypto.createHmac('sha256', spec.sessionSecret).update('admin-token').digest('hex').slice(0, 48);

    const session: DockerSession = {
      spec,
      networkName: networkName(spec.sessionId),
      workspaceName: containerName(spec.sessionId, 'ws'),
      serviceNames: new Map(),
      state: 'provisioning',
      detail: 'Allocating private Docker network',
      startedAt: Date.now(),
      lastActivity: Date.now(),
      provisionConsumed: false,
      targets: spec.template.services
        .flatMap((s) => s.ports.filter((p) => p.published).map((p) => ({ name: p.name, port: p.port, protocol: p.protocol }))),
      targetIps: new Map(),
      expectedStop: false,
    };
    sessions.set(spec.sessionId, session);

    const workspaceService = spec.template.services.find((s) => s.role === 'workspace');
    const workspaceImage = spec.template.workspace.image;

    try {
      // 1. Private, internal per-session network: no route off the network.
      const network: Network = await this.docker.createNetwork({
        Name: session.networkName,
        Driver: 'bridge',
        Internal: true,
        Attachable: false,
        EnableIPv6: false,
        Labels: this.labels(spec),
        Options: { 'com.docker.network.bridge.enable_icc': 'true' },
      });

      // 2. Workspace container (learner shell). Starts idle; provisioning runs
      //    through a controlled exec before any target is exposed.
      const targetUrl = spec.template.services
        .flatMap((s) => s.ports.filter((p) => p.published).map((p) => ({ name: s.name, port: p.port })))
        .map((p) => `http://${p.name}:${p.port}`)[0];
      const wsOpts: ContainerCreateOptions = {
        name: session.workspaceName,
        Image: workspaceImage,
        Cmd: ['sleep', 'infinity'],
        User: '1000:1000',
        WorkingDir: '/home/learner',
        Labels: this.labels(spec),
        Env: [
          ...this.envFor(spec, appSeed, adminToken),
          `CF_TARGET_URL=${targetUrl ?? ''}`,
          'HOME=/home/learner',
          'TERM=xterm-256color',
        ],
        HostConfig: {
          ...this.baseHostConfig(spec),
          Tmpfs: {
            '/tmp': `rw,noexec,nosuid,nodev,size=${spec.template.resources.writableDiskMb}m`,
            '/run': 'rw,noexec,nosuid,nodev,size=8m',
            '/home/learner': `rw,nosuid,nodev,size=${spec.template.resources.writableDiskMb}m,uid=1000,gid=1000`,
          },
        },
        NetworkingConfig: { EndpointsConfig: { [session.networkName]: { Aliases: ['workspace', session.workspaceName] } } },
      };
      const wsContainer = await this.docker.createContainer(wsOpts);
      await wsContainer.start();
      log.info('docker workspace started', { sessionId: spec.sessionId, name: session.workspaceName });

      // 3. Provision inside the workspace using the approved provisioner script.
      const provisioner = spec.template.provisioner;
      let provision: ProvisionPayload | undefined;
      if (provisioner) {
        await this.waitForContainer(wsContainer, 10_000);
        const res = await inContainer(
          wsContainer,
          ['node', `/lab/${provisioner.script}`],
          {
            env: [
              `CF_SESSION_ID=${spec.sessionId}`,
              `CF_LAB_ID=${spec.labId}`,
              `CF_LAB_VERSION=${spec.template.version}`,
              `CF_SESSION_SECRET=${spec.sessionSecret}`,
              `CF_APP_SEED=${appSeed}`,
              `CF_ADMIN_TOKEN=${adminToken}`,
              `CF_TARGET_URL=${targetUrl ?? ''}`,
              'HOME=/home/learner',
              'CF_WORKSPACE=/home/learner',
              'TZ=UTC',
            ],
            user: '1000:1000',
            timeoutMs: (provisioner.timeoutSeconds ?? 45) * 1000,
          },
        );
        const line = res.stdout
          .split('\n')
          .reverse()
          .find((l) => l.startsWith('CF_RESULT:'));
        if (res.code !== 0 || !line) {
          throw Object.assign(new Error('Lab provisioning failed inside the workspace container'), {
            code: 'provisioning-failed',
            status: 500,
            detail: sanitize(`${res.stdout}\n${res.stderr}`, 2000),
          });
        }
        provision = JSON.parse(line.slice('CF_RESULT:'.length));
      }

      // 4. Target + support containers on the same private network.
      for (const svc of spec.template.services) {
        if (svc.role === 'workspace') continue;
        const image = spec.template.images.find((i) => i.services.includes(svc.name))?.ref;
        if (!image) throw Object.assign(new Error(`No approved image for service ${svc.name}`), { code: 'template-invalid', status: 500 });
        const flags = Object.fromEntries(
          ((svc as unknown as { flagObjectives?: string[] }).flagObjectives ?? [])
            .map((id) => [id, provision?.flags?.[id]] as const)
            .filter(([, v]) => typeof v === 'string'),
        );
        const name = containerName(spec.sessionId, svc.name.slice(0, 12));
        session.serviceNames.set(svc.name, name);
        const container = await this.docker.createContainer({
          name,
          Image: image,
          Cmd: ['node', `/lab/${svc.app}`],
          User: '1000:1000',
          WorkingDir: '/opt/cf',
          Labels: this.labels(spec),
          Env: [
            ...this.envFor(spec, appSeed, adminToken),
            `CF_SERVICE=${svc.name}`,
            `PORT=${svc.ports[0]?.port ?? 8080}`,
            `CF_FLAGS_JSON=${JSON.stringify(flags)}`,
          ],
          HostConfig: {
            ...this.baseHostConfig(spec),
            Tmpfs: {
              '/tmp': 'rw,noexec,nosuid,nodev,size=16m',
              '/run': 'rw,noexec,nosuid,nodev,size=8m',
            },
          },
          NetworkingConfig: {
            EndpointsConfig: { [session.networkName]: { Aliases: [svc.name] } },
          },
          ExposedPorts: Object.fromEntries(svc.ports.map((p) => [`${p.port}/${p.protocol === 'udp' ? 'udp' : 'tcp'}`, {}])),
        });
        await container.start();
        log.info('docker service started', { sessionId: spec.sessionId, service: svc.name, container: name });
      }

      session.state = 'starting';
      session.detail = 'Waiting for target services to pass health checks';

      // 5. Resolve service IPs and verify health through the real network.
      await this.verifyServices(session);

      session.state = 'ready';
      session.readyAt = Date.now();
      session.detail = 'Lab is ready — containers healthy and targets reachable';
      session.provision = provision;
      log.info('docker session ready', { sessionId: spec.sessionId });
      return this.poll(spec.sessionId);
    } catch (err) {
      const e = err as Error & { code?: string; detail?: string; status?: number };
      session.state = 'failed';
      session.detail = e.message;
      session.failure = { code: e.code ?? 'provisioning-failed', message: sanitize(e.message, 300), detail: sanitize(e.detail ?? '', 2500) };
      log.error('docker session failed', { sessionId: spec.sessionId, error: e.message });
      await this.forceCleanup(spec.sessionId);
      return this.poll(spec.sessionId);
    }
  }

  private async waitForContainer(container: Container, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = await container.inspect();
      if (info.State.Running) return;
      if (info.State.Status === 'exited') throw new Error(`container exited during startup (code ${info.State.ExitCode})`);
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('container did not start in time');
  }

  private async verifyServices(session: DockerSession): Promise<void> {
    const netInfo = await this.docker.getNetwork(session.networkName).inspect();
    const deadline = Date.now() + 30_000;
    const pending = session.spec.template.services.filter((s) => s.role !== 'workspace');
    const done = new Set<string>();
    let lastError = '';
    while (pending.length > done.size && Date.now() < deadline) {
      for (const svc of pending) {
        if (done.has(svc.name)) continue;
        const name = session.serviceNames.get(svc.name);
        if (!name) continue;
        const container = this.docker.getContainer(name);
        try {
          const info = await container.inspect();
          if (!info.State.Running) {
            lastError = `${svc.name} container is not running`;
            continue;
          }
          const endpoint = info.NetworkSettings.Networks[session.networkName];
          const ip = endpoint?.IPAddress;
          if (!ip) {
            lastError = `${svc.name} has no address on the private network`;
            continue;
          }
          const port = svc.ports[0]?.port;
          if (!port) continue;
          if (svc.health?.kind === 'http') {
            const res = await httpGet(ip, port, svc.health.path ?? '/');
            const expected = svc.health.expectStatus ?? 200;
            if (res.status !== expected) {
              lastError = `${svc.name} returned HTTP ${res.status} (expected ${expected})`;
              continue;
            }
            if (svc.health.expectBody && !res.body.includes(svc.health.expectBody)) {
              lastError = `${svc.name} response missing health marker`;
              continue;
            }
          }
          session.targetIps.set(svc.name, { host: ip, port });
          done.add(svc.name);
          log.info('docker health check passed', { sessionId: session.spec.sessionId, service: svc.name, ip: `[redacted]`, port });
        } catch (err) {
          lastError = sanitize((err as Error).message, 300);
        }
      }
      if (pending.length > done.size) await new Promise((r) => setTimeout(r, 500));
    }
    if (pending.length > done.size) {
      throw Object.assign(new Error('Target services did not pass health checks'), {
        code: 'healthcheck-failed',
        detail: lastError || 'health probe timed out',
      });
    }
    void netInfo;
  }

  async poll(sessionId: string): Promise<PollResult> {
    const session = sessions.get(sessionId);
    if (!session) return { state: 'stopped', detail: 'No such session on this runner', targets: [] };
    if (session.state !== 'ready' && session.state !== 'failed' && session.state !== 'stopped' && session.state !== 'expired') {
      // Detect unexpected container death after provisioning.
      const wsName = session.workspaceName;
      try {
        const info = await this.docker.getContainer(wsName).inspect();
        if (!info.State.Running && session.state !== 'provisioning') {
          session.state = 'failed';
          session.failure = { code: 'service-crash', message: 'Workspace container exited unexpectedly', detail: `exit code ${info.State.ExitCode}` };
        }
      } catch {
        if (session.state !== 'provisioning') {
          session.state = 'failed';
          session.failure = { code: 'service-crash', message: 'Workspace container was removed unexpectedly' };
        }
      }
    }
    return {
      state: session.state,
      detail: session.detail,
      targets: session.targets,
      startedAt: new Date(session.startedAt).toISOString(),
      readyAt: session.readyAt ? new Date(session.readyAt).toISOString() : undefined,
      failure: session.failure,
    };
  }

  consumeProvision(sessionId: string): ProvisionPayload | undefined {
    const session = sessions.get(sessionId);
    if (!session || session.provisionConsumed) return undefined;
    session.provisionConsumed = true;
    return session.provision;
  }

  noteActivity(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) session.lastActivity = Date.now();
  }

  private async forceCleanup(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    const names: string[] = [];
    if (session) {
      names.push(session.workspaceName, ...session.serviceNames.values());
    } else {
      const containers = await this.docker.listContainers({ all: true, filters: { label: [`${LABEL_SESSION}=${sessionId}`] } }).catch(() => []);
      for (const c of containers) names.push(...c.Names.map((n) => n.replace(/^\//, '')));
    }
    for (const name of names) {
      await removeQuietly(this.docker.getContainer(name));
    }
    try {
      const network = this.docker.getNetwork(networkName(sessionId));
      await network.remove();
    } catch {}
  }

  async stop(sessionId: string, reason: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) {
      await this.forceCleanup(sessionId);
      return;
    }
    if (session.state === 'stopped' || session.state === 'expired') return;
    session.expectedStop = true;
    session.state = 'stopping';
    session.detail = `Stopping session (${reason})`;
    const names = [session.workspaceName, ...session.serviceNames.values()];
    for (const name of names) {
      const container = this.docker.getContainer(name);
      try {
        await container.stop({ t: 3 });
      } catch {}
      await removeQuietly(container);
    }
    try {
      await this.docker.getNetwork(session.networkName).remove();
    } catch {}
    session.state = reason === 'expired' ? 'expired' : reason === 'failed' ? 'failed' : 'stopped';
    session.detail = reason === 'expired' ? 'Session expired' : 'Session stopped';
    log.info('docker session stopped', { sessionId, reason });
  }

  async remove(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (session && session.state !== 'stopped' && session.state !== 'expired' && session.state !== 'failed') {
      await this.stop(sessionId, 'stopped');
    }
    await this.forceCleanup(sessionId);
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
    if (!session || session.state !== 'ready') return { passed: false, detail: 'Lab session is not ready.' };
    const allowed = session.spec.template.validators ?? [];
    if (!allowed.includes(req.validator)) return { passed: false, detail: 'This validator is not approved for the lab template.' };
    const container = this.docker.getContainer(session.workspaceName);
    try {
      const res = await inContainer(container, ['node', `/lab/${session.spec.labId}/validators/${req.validator}.mjs`], {
        env: [
          `CF_META=${JSON.stringify(req.meta ?? {})}`,
          `CF_EVIDENCE=${JSON.stringify(req.evidence ?? {})}`,
          `CF_OBJECTIVE=${req.objectiveId}`,
          `CF_TARGET_URL=${[...session.targetIps.entries()][0] ? `http://${[...session.targetIps.keys()][0]}:${[...session.targetIps.values()][0]?.port}` : ''}`,
          `CF_SESSION_ID=${sessionId}`,
          'TZ=UTC',
        ],
        user: '1000:1000',
        timeoutMs: req.timeoutMs ?? 30_000,
      });
      const line = res.stdout
        .split('\n')
        .reverse()
        .find((l) => l.startsWith('CF_VALIDATOR:'));
      if (!line) {
        return {
          passed: false,
          detail: 'Validator did not produce a structured result.',
          evidence: { stderr: sanitize(res.stderr, 800), exitCode: res.code },
        };
      }
      const parsed = JSON.parse(line.slice('CF_VALIDATOR:'.length));
      return { passed: Boolean(parsed.passed), detail: String(parsed.detail ?? ''), evidence: parsed.evidence };
    } catch (err) {
      return { passed: false, detail: `Validator execution failed: ${sanitize((err as Error).message, 300)}` };
    }
  }

  async terminal(sessionId: string, cols: number, rows: number): Promise<TerminalChannel> {
    const session = sessions.get(sessionId);
    if (!session || session.state !== 'ready') throw Object.assign(new Error('session is not ready'), { code: 'not-ready', status: 409 });
    this.noteActivity(sessionId);
    const container = this.docker.getContainer(session.workspaceName);
    const targetUrl = session.targetIps.size
      ? `http://${session.targetIps.keys().next().value}:${session.targetIps.values().next().value?.port}`
      : '';
    const exec = await container.exec({
      Cmd: ['/bin/bash', '-l'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: '1000:1000',
      WorkingDir: '/home/learner',
      Env: [`CF_TARGET_URL=${targetUrl}`, 'HOME=/home/learner', 'TERM=xterm-256color', 'USER=learner'],
    });
    const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as unknown as NodeJS.ReadWriteStream & {
      setWindow?: (r: number, c: number) => void;
      destroy: () => void;
    };
    const dataHandlers: ((chunk: Buffer) => void)[] = [];
    const exitHandlers: ((code: number) => void)[] = [];
    const errorHandlers: ((err: Error) => void)[] = [];
    let closed = false;
    stream.on('data', (chunk: Buffer) => {
      for (const cb of dataHandlers) cb(chunk);
    });
    stream.on('end', () => {
      for (const cb of exitHandlers) cb(0);
    });
    stream.on('error', (err: Error) => {
      for (const cb of errorHandlers) cb(err);
    });
    try {
      await exec.resize({ h: rows, w: cols });
    } catch {}
    return {
      write: (data: Buffer) => {
        if (!closed) stream.write(data);
      },
      resize: (c: number, r: number) => void exec.resize({ h: r, w: c }).catch(() => {}),
      close: () => {
        closed = true;
        try {
          stream.write('exit\n');
          stream.end();
          stream.destroy();
        } catch {}
      },
      onData: (cb) => dataHandlers.push(cb),
      onExit: (cb) => exitHandlers.push(cb),
      onError: (cb) => errorHandlers.push(cb),
    };
  }

  async targetUpstream(sessionId: string, name: string): Promise<TargetUpstream> {
    const session = sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('unknown session'), { code: 'not-found', status: 404 });
    if (session.state !== 'ready') throw Object.assign(new Error('session is not ready'), { code: 'not-ready', status: 409 });
    const approved = session.spec.template.services.flatMap((s) => s.ports.filter((p) => p.published).map((p) => ({ ...p, service: s.name })));
    const svcPort = approved.find((p) => p.name === name);
    if (!svcPort) throw Object.assign(new Error('target is not published for this lab'), { code: 'target-not-approved', status: 404 });
    const upstream = session.targetIps.get(svcPort.service);
    if (!upstream) throw Object.assign(new Error('target is not reachable'), { code: 'target-unavailable', status: 503 });
    this.noteActivity(sessionId);
    return { kind: 'tcp', host: upstream.host, port: upstream.port };
  }

  async metrics(sessionId: string): Promise<MetricSnapshot | null> {
    const session = sessions.get(sessionId);
    if (!session) return null;
    try {
      const stats = (await this.docker.getContainer(session.workspaceName).stats({ stream: false })) as unknown as {
        memory_stats?: { usage?: number };
        pids_stats?: { current?: number };
        cpu_stats?: { cpu_usage?: { total_usage?: number } };
      };
      return {
        processes: stats.pids_stats?.current ?? 0,
        rssMb: Math.round((stats.memory_stats?.usage ?? 0) / 1024 / 1024),
        cpuTicks: stats.cpu_stats?.cpu_usage?.total_usage ?? 0,
        readAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  listManaged(): string[] {
    return [...sessions.keys()];
  }

  async cleanupOrphans(): Promise<{ removed: string[]; killed: number[] }> {
    const removed: string[] = [];
    const containers = await this.docker.listContainers({ all: true, filters: { label: [`${LABEL_MANAGED}=true`] } }).catch(() => []);
    for (const c of containers) {
      const sessionId = c.Labels?.[LABEL_SESSION];
      if (!sessionId) continue;
      if (sessions.has(sessionId)) continue;
      await removeQuietly(this.docker.getContainer(c.Id));
      removed.push(c.Id.slice(0, 12));
    }
    const networks = await this.docker.listNetworks({ filters: { label: [`${LABEL_MANAGED}=true`] } }).catch(() => []);
    for (const n of networks) {
      const sessionId = n.Labels?.[LABEL_SESSION];
      if (!sessionId || sessions.has(sessionId)) continue;
      try {
        await this.docker.getNetwork(n.Id).remove();
        removed.push(`net:${n.Name}`);
      } catch {}
    }
    return { removed, killed: [] };
  }

  describe(): Record<string, unknown> {
    return {
      mode: 'docker',
      socket: config.dockerHost || config.dockerSocket,
      isolation: {
        runtime: 'one container per service, per-session internal bridge network',
        filesystem: 'read-only rootfs + bounded tmpfs writable layers, non-root user 1000',
        capabilities: 'all dropped, no-new-privileges, default seccomp + AppArmor profiles',
        resources: 'CPU shares/quota, memory, PIDs and tmpfs size explicitly applied',
        network: 'no published ports, no outbound internet (internal network), gateway-only access',
      },
    };
  }
}
