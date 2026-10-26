import type { LabTemplate, SessionState, ValidatorResult } from '@cipherforge/shared';

export interface StartSpec {
  sessionId: string;
  userId: string;
  labId: string;
  labVersion: string;
  templateChecksum: string;
  template: LabTemplate;
  /** HMAC material binding flags to this session. Never exposed to the learner. */
  sessionSecret: string;
  ttlSeconds: number;
}

export interface SessionTarget {
  name: string;
  port: number;
  protocol: string;
}

export interface SessionFailure {
  code: string;
  message: string;
  detail?: string;
}

export interface ProvisionPayload {
  flags: Record<string, string>;
  meta: Record<string, unknown>;
}

export interface PollResult {
  state: SessionState;
  detail: string;
  targets: SessionTarget[];
  startedAt?: string;
  readyAt?: string;
  metrics?: Record<string, number>;
  failure?: SessionFailure;
  /** Present exactly once, consumed by the manager. */
  provision?: ProvisionPayload;
}

export interface MetricSnapshot {
  processes: number;
  rssMb: number;
  cpuTicks: number;
  readAt: string;
}

export interface TerminalChannel {
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number) => void): void;
  onError(cb: (err: Error) => void): void;
}

export interface ExecutionRequest {
  objectiveId: string;
  validator: string;
  meta: Record<string, unknown>;
  evidence: Record<string, unknown>;
  timeoutMs?: number;
}

export interface Availability {
  available: boolean;
  mode: 'sandbox' | 'docker';
  checks: { id: string; ok: boolean; detail: string }[];
  reason?: string;
}

export interface TargetUpstream {
  kind: 'unix' | 'tcp';
  socketPath?: string;
  host?: string;
  port?: number;
}

export interface Driver {
  readonly mode: 'sandbox' | 'docker';
  availability(): Promise<Availability>;
  start(spec: StartSpec): Promise<PollResult>;
  poll(sessionId: string): Promise<PollResult>;
  stop(sessionId: string, reason: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  reset(sessionId: string): Promise<void>;
  validate(sessionId: string, req: ExecutionRequest): Promise<ValidatorResult>;
  terminal(sessionId: string, cols: number, rows: number): Promise<TerminalChannel>;
  targetUpstream(sessionId: string, name: string): Promise<TargetUpstream>;
  metrics(sessionId: string): Promise<MetricSnapshot | null>;
  noteActivity(sessionId: string): void;
  listManaged(): string[];
  cleanupOrphans(): Promise<{ removed: string[]; killed: number[] }>;
  describe(): Record<string, unknown>;
}

export interface DriverError extends Error {
  code: string;
  status: number;
  detail?: string;
}
