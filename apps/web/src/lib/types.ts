export type Role = 'learner' | 'admin';
export type SessionState = 'queued' | 'provisioning' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed' | 'expired';
export type Difficulty = 'Beginner' | 'Intermediate' | 'Advanced' | 'Expert';

export interface Rank {
  name: string;
  minXp: number;
  color: string;
}

export interface User {
  id: string;
  email: string;
  username: string;
  role: Role;
  xp: number;
  rank: Rank;
  labsCompleted: number;
  objectives: number;
  createdAt?: string;
}

export interface Progress {
  status: 'not_started' | 'in_progress' | 'completed';
  objectivesCompleted: number;
  score: number;
  objectivesTotal?: number;
  completedAt?: string;
}

export interface LabSummary {
  id: string;
  version: string;
  status: 'published' | 'coming_soon' | 'disabled';
  title: string;
  subtitle: string;
  category: string;
  difficulty: Difficulty;
  estimatedMinutes: number;
  skills: string[];
  summary: string;
  baseXp: number;
  objectivesCount: number;
  runnable: boolean;
  progress: Progress & { lastActivityAt?: string };
  availabilityNote?: string;
  platform?: string;
}

export interface Objective {
  id: string;
  title: string;
  description: string;
  evidencePrompt?: string;
  xp: number;
  kind: 'flag' | 'check' | 'evidence';
  criteria?: string[];
  hintCount: number;
  completed: boolean;
  hintsRevealed: string[];
  hints: { id: string; xpPenalty: number; revealed: boolean; text?: string }[];
}

export interface WalkthroughStep {
  title: string;
  body: string;
  command?: string;
}

export interface WalkthroughResponse {
  step: WalkthroughStep;
  index: number;
  total: number;
  revealed: number;
  penaltyNotice: string;
}

export interface HintResponse {
  hint: string;
  alreadyRevealed: boolean;
  revealed: number;
  total: number;
  xpPenalty: number;
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
  objectives: Objective[];
  walkthroughLocked: boolean;
  walkthroughSteps: number;
  maxMinutes: number;
  resources: { cpus: number; memoryMb: number; writableDiskMb: number };
}

export interface StartSessionResponse {
  session: SessionView;
  reused: boolean;
}

export interface WalkthroughState {
  steps: number;
  revealed: number[];
  penalty: string;
}

export interface LabListResponse {
  labs: LabSummary[];
  total: number;
  filters: { categories: string[]; difficulties: string[]; skills: string[]; statuses: string[] };
  categories: { category: string; total: number; runnable: number; completed: number }[];
  counts: { all: number; runnable: number; completed: number; comingSoon: number };
}

export interface SessionTarget {
  name: string;
  port: number;
  protocol: string;
  gatewayPath: string;
}

export interface SessionEvent {
  state: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

export interface SessionView {
  id: string;
  labId: string;
  labTitle: string;
  labVersion: string;
  state: SessionState;
  mode: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  expiresAt?: string;
  maxExpiresAt?: string;
  remainingSeconds: number;
  targets: SessionTarget[];
  terminalPath: string;
  failure?: { code: string; message: string; detail?: string };
  events: SessionEvent[];
  walkthroughUsed: boolean;
  hintsUsed: number;
  extensionCount: number;
  resources?: Record<string, unknown>;
  objectives: { id: string; completed: boolean }[];
  labProgress?: { status: string; objectivesCompleted: number; objectivesTotal: number; score: number; completedAt?: string };
}

export interface CompletionResult {
  passed: boolean;
  message: string;
  alreadyCompleted: boolean;
  xpAwarded: number;
  labBonus: number;
  totalXp: number;
  rank: Rank;
  nextRank: Rank | null;
  achievements: { slug: string; name: string; description: string; icon: string; tier: string }[];
  labCompleted: boolean;
  objectivesCompleted: number;
  objectivesTotal: number;
  score: number;
  attemptsRemaining?: number;
}

export interface Summary {
  user: Pick<User, 'id' | 'username' | 'email' | 'role'>;
  xp: number;
  rank: Rank;
  nextRank: Rank | null;
  streak: { current: number; longest: number; lastActiveDate: string | null };
  stats: { objectives: number; labs: number; categories: number; flags: number; hints: number; walkthroughs: number };
  recent: { labId: string; objectiveId: string; xp: number; title: string; at: string }[];
  activeSessions: { id: string; labId: string; labTitle: string; state: SessionState; expiresAt?: string; remainingSeconds: number; createdAt: string }[];
  achievements: { slug: string; name: string; tier: string; icon: string; earnedAt: string }[];
  paths: { id: string; name: string; total: number; completed: number }[];
}

export interface Achievement {
  slug: string;
  name: string;
  description: string;
  icon: string;
  tier: 'bronze' | 'silver' | 'gold';
  xp: number;
  earned?: boolean;
  earnedAt?: string;
  progress?: { current: number; target: number };
}

export interface LeaderRow {
  position: number;
  userId: string;
  username: string;
  xp: number;
  rank: string;
  labsCompleted: number;
}

export interface Path {
  id: string;
  name: string;
  description: string;
  level: Difficulty;
  icon: string;
  estimatedHours: number;
  enrolled: boolean;
  progress: { completed: number; total: number };
  labs: { id: string; title: string; category: string; difficulty: Difficulty; status: string; position: number; completed: boolean }[];
}

export interface QaCheck {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIP';
  detail?: string;
  durationMs?: number;
  category?: string;
}

export interface QaRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  mode: string;
  summary: { pass: number; fail: number; blocked: number; total: number; mode?: string };
  checks: QaCheck[];
}

export interface QaResponse {
  latest: QaRun | null;
  history: { id: string; startedAt: string; finishedAt: string | null; mode: string; summary: QaRun['summary'] }[];
  howToRun: string;
}

export interface AdminOverview {
  worker: {
    ok: boolean;
    mode: string;
    capacity: { maxSessions: number; activeSessions: number; queued: number; perUserLimit: number };
    checks: { id: string; ok: boolean; detail: string }[];
    drivers?: Record<string, { available: boolean; mode: string; checks: { id: string; ok: boolean; detail: string }[]; reason?: string }>;
    isolation?: Record<string, unknown>;
  };
  counts?: Record<string, number>;
  sessions?: (SessionView & { username?: string })[];
  labs?: number;
}

export interface ApiErrorShape {
  error: string;
  message: string;
  detail?: string;
}
