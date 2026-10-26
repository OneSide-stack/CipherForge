import type { LabSession, LabTemplate, SessionState } from '@cipherforge/shared';
import { loadRegistry, type LabRegistry } from '@cipherforge/shared';
import { config } from './config.js';
import { log, sanitize } from './logger.js';
import { DockerDriver } from './drivers/docker-driver.js';
import { SandboxDriver } from './drivers/sandbox-driver.js';
import type {
  Driver,
  ExecutionRequest,
  ProvisionPayload,
  SessionFailure,
  SessionTarget,
  StartSpec,
  TargetUpstream,
  TerminalChannel,
} from './drivers/types.js';

export interface RunnerEvent {
  at: string;
  state: SessionState;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface PublicRunnerSession extends Omit<LabSession, 'events'> {
  events: RunnerEvent[];
  provision?: ProvisionPayload;
  metrics?: Record<string, number>;
  mode?: 'docker' | 'sandbox';
}

interface ManagedSession {
  spec: StartSpec;
  template: LabTemplate;
  driver: Driver;
  state: SessionState;
  detail: string;
  createdAt: number;
  readyAt?: number;
  lastActivity: number;
  expiresAt: number;
  maxExpiresAt: number;
  idleTimeoutMs: number;
  targets: SessionTarget[];
  failure?: SessionFailure;
  events: RunnerEvent[];
  meta: Record<string, unknown>;
  finalLogs?: string;
  queued: boolean;
}

/**
 * Raw flag material exists in memory only between the provisioner finishing and
 * the API consuming it exactly once (the API immediately stores HMACs). It is
 * never persisted by the runner and never exposed in session polling responses
 * more than once.
 */
const provisionStore = new Map<string, ProvisionPayload>();

export class LabManager {
  private registry!: LabRegistry;
  private sessions = new Map<string, ManagedSession>();
  private queue: string[] = [];
  private docker = new DockerDriver();
  private sandbox = new SandboxDriver();
  private activeDriver!: Driver;
  private reaper: NodeJS.Timeout | null = null;

  async init(): Promise<void> {
    this.registry = await loadRegistry(config.labsDir);
    log.info('lab registry loaded', { labs: this.registry.entries.size, published: this.registry.published().length });
    const dockerAvail = await this.docker.availability();
    const sandboxAvail = await this.sandbox.availability();
    if (config.driver === 'docker') {
      if (!dockerAvail.available) throw new Error(`Docker driver requested but unavailable: ${dockerAvail.reason}`);
      this.activeDriver = this.docker;
    } else if (config.driver === 'sandbox') {
      if (!sandboxAvail.available) throw new Error(`Sandbox driver requested but unavailable: ${sandboxAvail.reason}`);
      this.activeDriver = this.sandbox;
    } else {
      this.activeDriver = dockerAvail.available ? this.docker : this.sandbox;
    }
    log.info('runner driver selected', { mode: this.activeDriver.mode, docker: dockerAvail.available, sandbox: sandboxAvail.available });
    const cleanup = await this.activeDriver.cleanupOrphans();
    if (cleanup.removed.length || cleanup.killed.length) log.warn('cleaned up orphaned lab resources', cleanup);
    this.reaper = setInterval(() => void this.reap(), 5000);
    this.reaper.unref();
  }

  async health() {
    const [dockerAvail, sandboxAvail] = await Promise.all([this.docker.availability(), this.sandbox.availability()]);
    const active = [...this.sessions.values()].filter((s) => ['queued', 'provisioning', 'starting', 'ready'].includes(s.state)).length;
    const activeChecks = this.activeDriver.mode === 'docker' ? dockerAvail.checks : sandboxAvail.checks;
    const checks = [
      { id: 'registry', ok: this.registry.entries.size > 0, detail: `${this.registry.published().length} published labs in ${config.labsDir}` },
      { id: 'driver', ok: this.activeDriver.mode === 'docker' ? dockerAvail.available : sandboxAvail.available, detail: this.activeDriver.mode },
      ...activeChecks,
    ];
    return {
      ok: checks.every((c) => c.ok),
      mode: this.activeDriver.mode,
      healthy: checks.every((c) => c.ok),
      dockerAvailable: dockerAvail.available,
      sandboxAvailable: sandboxAvail.available,
      capacity: {
        maxSessions: config.maxSessions,
        activeSessions: active,
        queued: this.queue.length,
        perUserLimit: config.maxSessionsPerUser,
      },
      version: config.version,
      checks,
      drivers: { docker: dockerAvail, sandbox: sandboxAvail },
      isolation: this.activeDriver.describe(),
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  registryInfo(): LabRegistry {
    return this.registry;
  }

  getTemplate(labId: string): LabTemplate | undefined {
    return this.registry.get(labId)?.template;
  }

  private activeCount(): number {
    return [...this.sessions.values()].filter((s) => ['provisioning', 'starting', 'ready'].includes(s.state)).length;
  }

  private userActiveCount(userId: string): number {
    return [...this.sessions.values()].filter(
      (s) => s.spec.userId === userId && ['queued', 'provisioning', 'starting', 'ready'].includes(s.state),
    ).length;
  }

  private emit(session: ManagedSession, state: SessionState, level: RunnerEvent['level'], message: string) {
    session.events.push({ at: new Date().toISOString(), state, level, message: sanitize(message, 500) });
    if (session.events.length > 200) session.events.shift();
  }

  async start(input: {
    sessionId: string;
    userId: string;
    labId: string;
    labVersion: string;
    templateChecksum: string;
    sessionSecret: string;
    ttlSeconds: number;
    requestId: string;
  }): Promise<PublicRunnerSession> {
    const existing = this.sessions.get(input.sessionId);
    if (existing) return this.publicSession(existing, false);
    if (!/^[0-9a-f-]{20,40}$/i.test(input.sessionId)) throw Object.assign(new Error('invalid session id'), { status: 400, code: 'validation' });
    if (!/^[0-9a-f-]{20,40}$/i.test(input.userId)) throw Object.assign(new Error('invalid user id'), { status: 400, code: 'validation' });
    const entry = this.registry.get(input.labId);
    if (!entry) throw Object.assign(new Error('lab template not found'), { status: 404, code: 'unknown-lab' });
    if (entry.template.status !== 'published')
      throw Object.assign(new Error('this lab is not published and cannot be provisioned'), { status: 409, code: 'lab-not-published' });
    if (entry.template.version !== input.labVersion)
      throw Object.assign(new Error('lab template version mismatch'), { status: 409, code: 'version-mismatch' });
    if (entry.checksum !== input.templateChecksum)
      throw Object.assign(new Error('lab template checksum mismatch — the template changed since it was published'), {
        status: 409,
        code: 'checksum-mismatch',
      });
    if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > entry.template.resources.maxMinutes * 60 + 30)
      throw Object.assign(new Error('invalid session TTL'), { status: 400, code: 'validation' });
    if (this.userActiveCount(input.userId) >= config.maxSessionsPerUser)
      throw Object.assign(new Error(`This account already has ${config.maxSessionsPerUser} active lab sessions.`), {
        status: 429,
        code: 'user-quota',
      });

    const ttl = Math.min(input.ttlSeconds, entry.template.resources.maxMinutes * 60);
    const spec: StartSpec = {
      sessionId: input.sessionId,
      userId: input.userId,
      labId: input.labId,
      labVersion: entry.template.version,
      templateChecksum: entry.checksum,
      template: entry.template,
      sessionSecret: input.sessionSecret,
      ttlSeconds: ttl,
    };
    const now = Date.now();
    const session: ManagedSession = {
      spec,
      template: entry.template,
      driver: this.activeDriver,
      state: 'queued',
      detail: 'Waiting for lab worker capacity',
      createdAt: now,
      lastActivity: now,
      expiresAt: now + ttl * 1000,
      maxExpiresAt: now + entry.template.resources.maxMinutes * 60_000,
      idleTimeoutMs: entry.template.resources.idleTimeoutMinutes * 60_000,
      targets: [],
      events: [],
      meta: {},
      queued: false,
    };
    this.sessions.set(input.sessionId, session);
    this.emit(session, 'queued', 'info', 'Session queued for provisioning');
    log.info('session requested', { sessionId: input.sessionId, lab: input.labId, user: input.userId.slice(0, 8) });

    if (this.activeCount() >= config.maxSessions) {
      session.queued = true;
      this.queue.push(input.sessionId);
      this.emit(session, 'queued', 'warn', 'Worker at capacity; session queued');
      return this.publicSession(session, false);
    }
    await this.provision(session);
    return this.publicSession(session, false);
  }

  private consumeDriverProvision(session: ManagedSession): ProvisionPayload | undefined {
    const driver = session.driver as unknown as { consumeProvision?: (id: string) => ProvisionPayload | undefined };
    const payload = driver.consumeProvision?.(session.spec.sessionId);
    log.info('consume driver provision', { sessionId: session.spec.sessionId, hasPayload: Boolean(payload), keys: payload ? Object.keys(payload.flags) : [] });
    if (payload) {
      session.meta = payload.meta ?? {};
      provisionStore.set(session.spec.sessionId, payload);
      log.info('provision payload captured', { sessionId: session.spec.sessionId, flags: Object.keys(payload.flags).length });
    }
    return payload;
  }

  private async provision(session: ManagedSession): Promise<void> {
    session.queued = false;
    session.state = 'provisioning';
    session.detail = 'Provisioning isolated lab runtime';
    this.emit(session, 'provisioning', 'info', `Provisioning lab ${session.spec.labId} v${session.spec.labVersion}`);
    try {
      const result = await session.driver.start(session.spec);
      session.state = result.state;
      session.detail = result.detail;
      session.targets = result.targets;
      session.failure = result.failure;
      this.consumeDriverProvision(session);
      if (result.state === 'ready') {
        session.readyAt = Date.now();
        session.expiresAt = Math.min(session.readyAt + session.spec.ttlSeconds * 1000, session.maxExpiresAt);
        this.emit(session, 'ready', 'info', 'All services passed health checks; session is ready');
      } else if (result.state === 'failed') {
        this.emit(session, 'failed', 'error', result.failure?.message ?? 'Provisioning failed');
      }
    } catch (err) {
      const e = err as Error & { code?: string; detail?: string };
      session.state = 'failed';
      session.detail = e.message;
      session.failure = { code: e.code ?? 'provisioning-failed', message: sanitize(e.message, 300), detail: sanitize(e.detail ?? '', 2500) };
      this.emit(session, 'failed', 'error', e.message);
      log.error('session provisioning failed', { sessionId: session.spec.sessionId, error: e.message });
      try {
        await session.driver.stop(session.spec.sessionId, 'failed');
        await session.driver.remove(session.spec.sessionId);
      } catch (cleanupErr) {
        log.warn('failure cleanup did not complete', { error: (cleanupErr as Error).message });
      }
      void this.drainQueue();
      return;
    }
    if (session.state === 'failed') {
      this.emit(session, 'failed', 'error', 'Provisioning failed; partial resources were cleaned up');
      await session.driver.remove(session.spec.sessionId).catch(() => {});
      void this.drainQueue();
    }
  }

  async poll(sessionId: string, consumeProvision = false): Promise<PublicRunnerSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('session not found'), { status: 404, code: 'not-found' });
    if (['queued', 'provisioning', 'starting', 'ready'].includes(session.state)) {
      const result = await session.driver.poll(sessionId);
      const previous = session.state;
      session.state = result.state;
      session.detail = result.detail;
      if (result.targets?.length) session.targets = result.targets;
      if (result.failure) session.failure = result.failure;
      this.consumeDriverProvision(session);
      if (result.state === 'ready' && previous !== 'ready') {
        session.readyAt = Date.now();
        session.expiresAt = Math.min(session.readyAt + session.spec.ttlSeconds * 1000, session.maxExpiresAt);
        this.emit(session, 'ready', 'info', 'All services passed health checks; session is ready');
      }
      if (result.state !== previous) {
        const level = result.state === 'failed' ? 'error' : result.state === 'expired' ? 'warn' : 'info';
        this.emit(session, result.state, level, result.detail || result.state);
        if (result.state === 'failed' || result.state === 'expired') {
          session.finalLogs = await this.collectLogs(sessionId).catch(() => '');
          await session.driver.remove(sessionId).catch(() => {});
          void this.drainQueue();
        }
      }
    }
    return this.publicSession(session, consumeProvision);
  }

  async stop(sessionId: string, reason: 'stopped' | 'expired' | 'failed' = 'stopped'): Promise<PublicRunnerSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('session not found'), { status: 404, code: 'not-found' });
    if (['stopped', 'expired', 'failed'].includes(session.state) && !session.finalLogs) return this.publicSession(session, false);
    this.emit(session, 'stopping', 'info', `Stopping session (${reason})`);
    try {
      await session.driver.stop(sessionId, reason);
    } catch (err) {
      log.warn('driver stop failed', { sessionId, error: (err as Error).message });
    }
    session.finalLogs = await this.collectLogs(sessionId).catch(() => '');
    try {
      await session.driver.remove(sessionId);
    } catch (err) {
      log.warn('driver remove failed; cleanup will be retried', { sessionId, error: (err as Error).message });
      setTimeout(() => void session.driver.remove(sessionId).catch(() => {}), 5000).unref();
    }
    provisionStore.delete(sessionId);
    session.state = reason === 'expired' ? 'expired' : reason === 'failed' ? 'failed' : 'stopped';
    session.detail = reason === 'expired' ? 'Session expired' : 'Session stopped and resources released';
    this.emit(session, session.state, reason === 'expired' ? 'warn' : 'info', session.detail);
    void this.drainQueue();
    return this.publicSession(session, false);
  }

  async reset(sessionId: string): Promise<PublicRunnerSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('session not found'), { status: 404, code: 'not-found' });
    if (!['ready', 'failed', 'stopped', 'expired'].includes(session.state))
      throw Object.assign(new Error('session is busy; wait for the current operation to finish'), { status: 409, code: 'busy' });
    this.emit(session, 'provisioning', 'info', 'Resetting lab session with a clean runtime and new flags');
    await session.driver.remove(sessionId).catch(() => {});
    provisionStore.delete(sessionId);
    session.state = 'provisioning';
    session.failure = undefined;
    session.readyAt = undefined;
    session.finalLogs = undefined;
    session.readyAt = undefined;
    session.lastActivity = Date.now();
    session.expiresAt = Date.now() + session.spec.ttlSeconds * 1000;
    session.maxExpiresAt = Date.now() + session.template.resources.maxMinutes * 60_000;
    await this.provision(session);
    return this.publicSession(session, false);
  }

  async extend(sessionId: string, ttlSeconds: number): Promise<PublicRunnerSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('session not found'), { status: 404, code: 'not-found' });
    if (session.state !== 'ready') throw Object.assign(new Error('only ready sessions can be extended'), { status: 409, code: 'not-ready' });
    const requested = Number(ttlSeconds);
    if (!Number.isFinite(requested) || requested < 60)
      throw Object.assign(new Error('invalid extension duration'), { status: 400, code: 'validation' });
    // Extensions add time to the current expiry (bounded by the hard cap), they
    // are not an absolute "expires in N minutes from now" request.
    const newExpiry = Math.min(session.expiresAt + requested * 1000, session.maxExpiresAt);
    if (newExpiry <= session.expiresAt) throw Object.assign(new Error('maximum session lifetime reached'), { status: 409, code: 'max-lifetime' });
    session.expiresAt = newExpiry;
    session.lastActivity = Date.now();
    this.emit(session, 'ready', 'info', `Session extended to ${new Date(newExpiry).toISOString()}`);
    return this.publicSession(session, false);
  }

  async validate(sessionId: string, ownerUserId: string, req: ExecutionRequest) {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('session not found'), { status: 404, code: 'not-found' });
    if (session.spec.userId !== ownerUserId) throw Object.assign(new Error('forbidden'), { status: 403, code: 'forbidden' });
    if (session.state !== 'ready') throw Object.assign(new Error('session is not ready'), { status: 409, code: 'not-ready' });
    session.lastActivity = Date.now();
    const result = await session.driver.validate(sessionId, { ...req, meta: session.meta, evidence: req.evidence ?? {} });
    return { result, session };
  }

  async terminal(sessionId: string, ownerUserId: string, cols: number, rows: number): Promise<TerminalChannel> {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('session not found'), { status: 404, code: 'not-found' });
    if (session.spec.userId !== ownerUserId) throw Object.assign(new Error('forbidden'), { status: 403, code: 'forbidden' });
    if (session.state !== 'ready') throw Object.assign(new Error('session is not ready'), { status: 409, code: 'not-ready' });
    session.lastActivity = Date.now();
    return session.driver.terminal(sessionId, cols, rows);
  }

  async targetUpstream(sessionId: string, name: string): Promise<TargetUpstream & { template: LabTemplate }> {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error('session not found'), { status: 404, code: 'not-found' });
    if (session.state !== 'ready') throw Object.assign(new Error('session is not ready'), { status: 409, code: 'not-ready' });
    session.lastActivity = Date.now();
    const upstream = await session.driver.targetUpstream(sessionId, name);
    return { ...upstream, template: session.template };
  }

  noteActivity(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastActivity = Date.now();
    session.driver.noteActivity(sessionId);
  }

  listManaged(): { id: string; userId: string; labId: string; state: string; mode: string; expiresAt: string }[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.spec.sessionId,
      userId: s.spec.userId,
      labId: s.spec.labId,
      state: s.state,
      mode: s.driver.mode,
      expiresAt: new Date(s.expiresAt).toISOString(),
    }));
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  async collectLogs(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) return '';
    if (session.finalLogs) return session.finalLogs;
    try {
      const { readFile, readdir } = await import('node:fs/promises');
      const dir = `${config.runtimeDir}/sessions/${sessionId}/logs`;
      const files = await readdir(dir).catch(() => []);
      const chunks: string[] = [];
      for (const f of files.slice(0, 8)) {
        const content = await readFile(`${dir}/${f}`, 'utf8').catch(() => '');
        if (content) chunks.push(`--- ${f} ---\n${content.split('\n').slice(-80).join('\n')}`);
      }
      return sanitize(chunks.join('\n'), 12000);
    } catch {
      return '';
    }
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.state === 'queued') {
        if (now - session.createdAt > 10 * 60_000) {
          session.state = 'expired';
          session.detail = 'Session expired while queued';
          session.failure = { code: 'queue-timeout', message: 'Worker did not become available in time' };
          this.emit(session, 'expired', 'warn', session.detail);
          this.queue = this.queue.filter((id) => id !== session.spec.sessionId);
        }
        continue;
      }
      if (!['ready', 'starting', 'provisioning'].includes(session.state)) continue;
      if (now > session.expiresAt) {
        log.info('session expired', { sessionId: session.spec.sessionId });
        await this.stop(session.spec.sessionId, 'expired').catch(() => {});
        continue;
      }
      if (session.state === 'ready' && now - session.lastActivity > session.idleTimeoutMs) {
        log.info('session idle timeout', { sessionId: session.spec.sessionId });
        await this.stop(session.spec.sessionId, 'expired').catch(() => {});
        continue;
      }
      if (session.state === 'ready') {
        const poll = await session.driver.poll(session.spec.sessionId).catch(() => null);
        if (poll && ['failed', 'expired', 'stopped'].includes(poll.state)) {
          session.state = poll.state;
          session.detail = poll.detail;
          session.failure = poll.failure;
          session.finalLogs = await this.collectLogs(session.spec.sessionId).catch(() => '');
          this.emit(session, session.state, 'error', poll.failure?.message ?? poll.detail);
          await session.driver.remove(session.spec.sessionId).catch(() => {});
          void this.drainQueue();
        }
      }
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length && this.activeCount() < config.maxSessions) {
      const nextId = this.queue.shift();
      if (!nextId) break;
      const session = this.sessions.get(nextId);
      if (!session || session.state !== 'queued') continue;
      this.emit(session, 'provisioning', 'info', 'Worker capacity available; provisioning started');
      await this.provision(session);
    }
  }

  private publicSession(session: ManagedSession, consumeProvision: boolean): PublicRunnerSession {
    let provision: ProvisionPayload | undefined;
    if (consumeProvision) {
      provision = provisionStore.get(session.spec.sessionId);
      log.info('public provision', { sessionId: session.spec.sessionId, hasPayload: Boolean(provision) });
      if (provision) provisionStore.delete(session.spec.sessionId);
    }
    return {
      id: session.spec.sessionId,
      labId: session.spec.labId,
      labVersion: session.spec.labVersion,
      labTitle: session.template.title,
      state: session.state,
      createdAt: new Date(session.createdAt).toISOString(),
      updatedAt: new Date().toISOString(),
      readyAt: session.readyAt ? new Date(session.readyAt).toISOString() : undefined,
      expiresAt: new Date(session.expiresAt).toISOString(),
      maxExpiresAt: new Date(session.maxExpiresAt).toISOString(),
      failure: session.failure,
      targets: session.targets.map((t) => ({
        name: t.name,
        path: `/api/sessions/${session.spec.sessionId}/target/${t.name}/`,
        port: t.port,
        protocol: t.protocol,
      })),
      terminalPath: `/ws/terminal/${session.spec.sessionId}`,
      resources: session.template.resources,
      walkthroughUsed: false,
      hintsUsed: 0,
      durationSeconds: Math.round((Date.now() - session.createdAt) / 1000),
      events: session.events,
      provision,
      mode: session.driver.mode,
    };
  }
}
