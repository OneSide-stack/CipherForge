/**
 * Domain types shared by the API, the lab-runner and tooling.
 * Authoritative data lives in PostgreSQL; lab templates live in version control.
 */

export const SESSION_STATES = [
  'queued',
  'provisioning',
  'starting',
  'ready',
  'stopping',
  'stopped',
  'failed',
  'expired',
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const ACTIVE_SESSION_STATES: SessionState[] = ['queued', 'provisioning', 'starting', 'ready'];

export const TERMINAL_SESSION_STATES: SessionState[] = ['stopping', 'stopped', 'failed', 'expired'];

export type LabDifficulty = 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';
export type LabStatus = 'published' | 'coming_soon' | 'unavailable';
export type RunnerMode = 'docker' | 'sandbox';

export const CATEGORIES = [
  'Web Security',
  'API Security',
  'Network Analysis',
  'Cloud Security',
  'Log Analysis',
  'Secure Coding',
  'Secrets Management',
  'SOC Operations',
  'Linux Security',
  'Identity & Access',
  'Container Security',
  'Digital Forensics',
  'SIEM & Detection',
  'Threat Hunting',
  'Incident Response',
  'Phishing Investigation',
  'Malware Analysis',
  'Cryptography',
  'Red Team Tradecraft',
  'Governance & Risk',
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface ServicePort {
  /** Port inside the service network. Always a fixed, reviewed value. */
  port: number;
  protocol: 'http' | 'https' | 'tcp' | 'udp';
  /** Published through the authenticated target gateway. */
  published: boolean;
  name: string;
}

export interface ServiceHealth {
  kind: 'http' | 'tcp' | 'none';
  path?: string;
  expectStatus?: number;
  expectBody?: string;
  timeoutSeconds?: number;
}

export interface ServiceSpec {
  name: string;
  role: 'target' | 'support' | 'workspace';
  /** Objective flags this service is permitted to know about (least privilege). */
  flagObjectives?: string[];
  /** Which approved application entrypoint runs inside this service. */
  app?: string;
  ports: ServicePort[];
  health?: ServiceHealth;
  /** Environment passed to the approved app. Static values only. */
  env?: Record<string, string>;
}

export interface ResourceSpec {
  cpus: number;
  memoryMb: number;
  pids: number;
  /** Bounded writable storage for /home/learner and /tmp. */
  writableDiskMb: number;
  maxMinutes: number;
  idleTimeoutMinutes: number;
}

export interface NetworkSpec {
  outbound: 'deny' | 'allow';
  /** Ports reachable between services of the same session network. */
  internalPorts: number[];
}

export interface HintSpec {
  id: string;
  /** Progressive hints are stored server-side and revealed one at a time. */
  text: string;
  xpPenalty: number;
}

export interface WalkthroughStep {
  title: string;
  body: string;
  /** Display-only command example (never executed by the platform). */
  snippet?: string;
}

export type ValidationSpec =
  | { type: 'flag'; objectiveKind: 'flag'; xp: number; hint?: string }
  | {
      type: 'check';
      objectiveKind: 'check';
      xp: number;
      /** Approved validator id from this template's validators list. */
      validator: string;
      /** Human readable acceptance criteria (safe to show). */
      criteria: string;
    };

export interface ObjectiveSpec {
  id: string;
  title: string;
  description: string;
  /** Optional proof-of-work prompt shown to the learner. */
  evidencePrompt?: string;
  validation: ValidationSpec;
  hints: HintSpec[];
}

export interface LabTemplate {
  /** Terminal-only labs (no target service) must declare this explicitly. */
  workspaceOnly?: boolean;
  schemaVersion: 1;
  id: string;
  version: string;
  status: LabStatus;
  title: string;
  subtitle: string;
  category: Category;
  difficulty: LabDifficulty;
  estimatedMinutes: number;
  skills: string[];
  summary: string;
  scenario: string;
  prerequisites: string[];
  learningObjectives: string[];
  authorizedScope: string;
  riskSummary: string;
  remediation: string;
  conclusion: string;
  baseXp: number;
  /** Learner-visible note when a lab is not runnable. */
  availabilityNote?: string;
  workspace: {
    image: string;
    tools: string[];
    /** Shell banner displayed in the terminal. */
    motd?: string;
  };
  images: { ref: string; digestPolicy: 'pinned-tag' | 'digest'; services: string[] }[];
  services: ServiceSpec[];
  resources: ResourceSpec;
  network: NetworkSpec;
  objectives: ObjectiveSpec[];
  walkthrough: WalkthroughStep[];
  validators?: string[];
  /** Provisioning artifact (approved script) run once inside the session. */
  provisioner?: { script: string; timeoutSeconds: number };
  /** Declarative contract used by automated lab tests. */
  tests?: { id: string; description: string; type: 'health' | 'validator' | 'teardown' | 'isolation' }[];
}

export interface PublicObjective {
  id: string;
  title: string;
  description: string;
  evidencePrompt?: string;
  xp: number;
  kind: 'flag' | 'check';
  criteria?: string;
  hintCount: number;
  completed: boolean;
  completedAt?: string;
  /** Revealed hint text, in order. */
  hintsRevealed: string[];
  /** Stable hint identifiers with their reveal state (text only when revealed). */
  hints: { id: string; xpPenalty: number; revealed: boolean; text?: string }[];
}

export interface LabSummary {
  id: string;
  version: string;
  status: LabStatus;
  title: string;
  subtitle: string;
  category: Category;
  difficulty: LabDifficulty;
  estimatedMinutes: number;
  skills: string[];
  summary: string;
  baseXp: number;
  availabilityNote?: string;
  objectivesCount: number;
  runnable: boolean;
  progress?: {
    status: 'not_started' | 'in_progress' | 'completed';
    objectivesCompleted: number;
    score: number;
    lastActivityAt?: string;
  };
}

export interface LabDetail extends LabSummary {
  scenario: string;
  prerequisites: string[];
  learningObjectives: string[];
  authorizedScope: string;
  riskSummary: string;
  remediation: string;
  conclusion: string;
  workspace: { tools: string[]; image: string };
  objectives: PublicObjective[];
  walkthroughLocked: boolean;
  walkthroughSteps: number;
  maxMinutes: number;
  resources: { cpus: number; memoryMb: number; writableDiskMb: number };
}

export interface SessionEvent {
  id: number;
  state: SessionState;
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

export interface TargetRoute {
  name: string;
  /** Authenticated path prefix, e.g. /api/sessions/:id/target/web/ */
  path: string;
  port: number;
  protocol: string;
}

export interface LabSession {
  id: string;
  labId: string;
  labVersion: string;
  labTitle?: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  expiresAt?: string;
  maxExpiresAt?: string;
  failure?: { code: string; message: string; detail?: string };
  targets: TargetRoute[];
  terminalPath: string;
  events?: SessionEvent[];
  resources?: ResourceSpec;
  walkthroughUsed: boolean;
  hintsUsed: number;
  durationSeconds: number;
}

export interface RunnerSessionRequest {
  sessionId: string;
  userId: string;
  labId: string;
  labVersion: string;
  /** HMAC used to bind one-time flags to this session. Never persisted in the runner. */
  sessionSecret: string;
  template: LabTemplate;
  /** Maximum wall clock time for this session. */
  ttlSeconds: number;
  requestId: string;
}

export interface RunnerSessionStatus {
  state: SessionState;
  detail?: string;
  targets: { name: string; port: number; url: string }[];
  workspace: { execReady: boolean };
  runtime?: Record<string, unknown>;
  failure?: { code: string; message: string; detail?: string };
  startedAt?: string;
  readyAt?: string;
}

export interface RunnerHealth {
  ok: boolean;
  mode: RunnerMode;
  healthy: boolean;
  dockerAvailable: boolean;
  sandboxAvailable: boolean;
  capacity: { maxSessions: number; activeSessions: number; queued?: number; perUserLimit?: number };
  version: string;
  checks: { id: string; ok: boolean; detail: string }[];
  drivers?: Record<string, { available: boolean; mode: string; checks: { id: string; ok: boolean; detail: string }[]; reason?: string }>;
  isolation?: Record<string, unknown>;
  uptimeSeconds?: number;
}

export interface ValidatorResult {
  passed: boolean;
  detail: string;
  evidence?: Record<string, unknown>;
}

export interface AchievementDefinition {
  slug: string;
  name: string;
  description: string;
  icon: string;
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';
  xp: number;
  criteria: { type: string; target?: number; category?: Category };
}

export interface RankDefinition {
  name: string;
  minXp: number;
  color: string;
}

export const RANKS: RankDefinition[] = [
  { name: 'Initiate', minXp: 0, color: '#7c8798' },
  { name: 'Apprentice', minXp: 250, color: '#5ad1a8' },
  { name: 'Analyst', minXp: 750, color: '#4ea8ff' },
  { name: 'Operator', minXp: 1500, color: '#b38cff' },
  { name: 'Specialist', minXp: 3000, color: '#ffb454' },
  { name: 'Sentinel', minXp: 6000, color: '#ff6b8a' },
  { name: 'Cipherforge Elite', minXp: 10000, color: '#7df9ff' },
];

export function rankForXp(xp: number): RankDefinition {
  let current = RANKS[0]!;
  for (const rank of RANKS) if (xp >= rank.minXp) current = rank;
  return current;
}

export function nextRank(xp: number): RankDefinition | null {
  return RANKS.find((r) => r.minXp > xp) ?? null;
}

export type QaStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIP';

export interface QaCheckResult {
  id: string;
  area: string;
  name: string;
  status: QaStatus;
  detail: string;
  durationMs: number;
}

export interface QaReport {
  id: string;
  startedAt: string;
  finishedAt?: string;
  mode: string;
  summary: { pass: number; fail: number; blocked: number; total: number };
  checks: QaCheckResult[];
}
