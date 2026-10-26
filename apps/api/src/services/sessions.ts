import crypto from 'node:crypto';
import type { LabTemplate, SessionState } from '@cipherforge/shared';
import { all, one, query } from '../db/index.js';
import { config } from '../config.js';
import { ApiError, badRequest, conflict, forbidden, notFound, tooMany, unavailable } from '../lib/errors.js';
import { decryptSecret, encryptSecret, flagSubmissionHmac } from '../lib/crypto.js';
import { log } from '../lib/logger.js';
import { runner } from './runner-client.js';
import { getTemplateRow } from './catalog.js';
import { consumePersistentLimit } from './ratelimit.js';

const ACTIVE_STATES: SessionState[] = ['queued', 'provisioning', 'starting', 'ready'];
const TERMINAL_STATES: SessionState[] = ['stopped', 'failed', 'expired'];

export interface SessionRow {
  id: string;
  user_id: string;
  lab_id: string;
  lab_version: string;
  template_checksum: string;
  state: SessionState;
  runner_mode: string | null;
  secret_encrypted: string;
  targets: { name: string; port: number; protocol: string; path?: string }[];
  failure: { code: string; message: string; detail?: string } | null;
  resources: Record<string, unknown> | null;
  walkthrough_used: boolean;
  hints_used: number;
  extension_count: number;
  created_at: Date;
  updated_at: Date;
  ready_at: Date | null;
  expires_at: Date | null;
  max_expires_at: Date | null;
  last_activity_at: Date;
  ended_at: Date | null;
  end_reason: string | null;
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
  targets: { name: string; port: number; protocol: string; gatewayPath: string }[];
  terminalPath: string;
  failure?: { code: string; message: string; detail?: string };
  events: { state: string; level: string; message: string; createdAt: string }[];
  walkthroughUsed: boolean;
  hintsUsed: number;
  extensionCount: number;
  resources?: Record<string, unknown>;
  objectives: { id: string; completed: boolean }[];
  labProgress?: { status: string; objectivesCompleted: number; objectivesTotal: number; score: number; completedAt?: string };
}

export async function getSessionRow(id: string): Promise<SessionRow | null> {
  return one<SessionRow>('SELECT * FROM lab_sessions WHERE id = $1', [id]);
}

export async function requireOwnedSession(userId: string, sessionId: string, allowAdmin = false): Promise<SessionRow> {
  const row = await getSessionRow(sessionId);
  if (!row) throw notFound('Lab session not found');
  if (row.user_id !== userId && !allowAdmin) throw forbidden('This lab session belongs to another learner');
  return row;
}

export function isActive(state: SessionState): boolean {
  return ACTIVE_STATES.includes(state);
}

async function insertEvent(sessionId: string, state: string, level: 'info' | 'warn' | 'error', message: string) {
  await query('INSERT INTO session_events (session_id, state, level, message) VALUES ($1,$2,$3,$4)', [sessionId, state, level, message.slice(0, 1000)]);
}

async function storeFlags(session: SessionRow, template: LabTemplate, provision?: { flags: Record<string, string> }) {
  if (!provision?.flags) return;
  const secret = decryptSecret(session.secret_encrypted);
  const flagObjectives = new Set(template.objectives.filter((o) => o.validation.type === 'flag').map((o) => o.id));
  for (const [objectiveId, rawFlag] of Object.entries(provision.flags)) {
    if (!flagObjectives.has(objectiveId) || typeof rawFlag !== 'string' || !rawFlag.startsWith('CF{')) {
      log.warn('ignoring unexpected provisioned flag', { sessionId: session.id, objectiveId });
      continue;
    }
    const expected = flagSubmissionHmac(secret, session.lab_id, objectiveId, rawFlag);
    await query(
      `INSERT INTO session_flags (session_id, objective_id, flag_hmac) VALUES ($1,$2,$3)
       ON CONFLICT (session_id, objective_id) DO UPDATE SET flag_hmac = EXCLUDED.flag_hmac`,
      [session.id, objectiveId, expected],
    );
  }
}

async function touchProgress(userId: string, labId: string) {
  await query(
    `INSERT INTO lab_progress (user_id, lab_id, status, last_activity_at)
     VALUES ($1,$2,'in_progress',now())
     ON CONFLICT (user_id, lab_id) DO UPDATE SET last_activity_at = now()`,
    [userId, labId],
  );
}

export async function buildSessionView(session: SessionRow, includeEvents = true): Promise<SessionView> {
  const templateRow = await getTemplateRow(session.lab_id);
  const template = templateRow?.template;
  const events = includeEvents
    ? await all<{ state: string; level: string; message: string; created_at: Date }>(
        'SELECT state, level, message, created_at FROM session_events WHERE session_id = $1 ORDER BY id DESC LIMIT 30',
        [session.id],
      )
    : [];
  const completed = await all<{ objective_id: string }>('SELECT objective_id FROM objective_completions WHERE user_id = $1 AND lab_id = $2', [
    session.user_id,
    session.lab_id,
  ]);
  const completedSet = new Set(completed.map((c) => c.objective_id));
  const progress = await one<{ status: string; objectives_completed: number; score: number; completed_at: Date | null }>(
    'SELECT status, objectives_completed, score, completed_at FROM lab_progress WHERE user_id = $1 AND lab_id = $2',
    [session.user_id, session.lab_id],
  );
  const remaining = session.expires_at ? Math.max(0, Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000)) : 0;
  return {
    id: session.id,
    labId: session.lab_id,
    labTitle: template?.title ?? session.lab_id,
    labVersion: session.lab_version,
    state: session.state,
    mode: session.runner_mode,
    createdAt: new Date(session.created_at).toISOString(),
    updatedAt: new Date(session.updated_at).toISOString(),
    readyAt: session.ready_at ? new Date(session.ready_at).toISOString() : undefined,
    expiresAt: session.expires_at ? new Date(session.expires_at).toISOString() : undefined,
    maxExpiresAt: session.max_expires_at ? new Date(session.max_expires_at).toISOString() : undefined,
    remainingSeconds: remaining,
    targets: (session.targets ?? []).map((t) => ({
      name: t.name,
      port: t.port,
      protocol: t.protocol,
      gatewayPath: `/api/sessions/${session.id}/target/${t.name}/`,
    })),
    terminalPath: `/ws/terminal/${session.id}`,
    failure: session.failure ?? undefined,
    events: events.reverse().map((e) => ({ state: e.state, level: e.level, message: e.message, createdAt: new Date(e.created_at).toISOString() })),
    walkthroughUsed: session.walkthrough_used,
    hintsUsed: session.hints_used,
    extensionCount: session.extension_count,
    resources: session.resources ?? undefined,
    objectives: (template?.objectives ?? []).map((o) => ({ id: o.id, completed: completedSet.has(o.id) })),
    labProgress: progress
      ? {
          status: progress.status,
          objectivesCompleted: progress.objectives_completed,
          objectivesTotal: template?.objectives.length ?? 0,
          score: progress.score,
          completedAt: progress.completed_at ? new Date(progress.completed_at).toISOString() : undefined,
        }
      : template
        ? { status: 'in_progress', objectivesCompleted: 0, objectivesTotal: template.objectives.length, score: 0 }
        : undefined,
  };
}

export async function getActiveSession(userId: string, labId?: string): Promise<SessionRow | null> {
  const rows = await all<SessionRow>(
    `SELECT * FROM lab_sessions WHERE user_id = $1 AND state = ANY($2::text[]) ${labId ? 'AND lab_id = $3' : ''} ORDER BY created_at DESC LIMIT 1`,
    labId ? [userId, ACTIVE_STATES, labId] : [userId, ACTIVE_STATES],
  );
  return rows[0] ?? null;
}

export async function listUserSessions(userId: string, limit = 20): Promise<SessionView[]> {
  const rows = await all<SessionRow>('SELECT * FROM lab_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [userId, limit]);
  return Promise.all(rows.map((r) => buildSessionView(r)));
}

export async function startLab(user: { id: string; role: string }, labId: string, ip?: string): Promise<{ session: SessionView; reused: boolean }> {
  const row = await getTemplateRow(labId);
  if (!row) throw notFound('Lab not found');
  if (row.status !== 'published' || !row.enabled) throw conflict('This lab is not currently runnable. See its availability note.');
  const existing = await getActiveSession(user.id, labId);
  if (existing) return { session: await buildSessionView(existing), reused: true };

  const activeCount = await one<{ count: string }>('SELECT count(*)::text AS count FROM lab_sessions WHERE user_id = $1 AND state = ANY($2::text[])', [
    user.id,
    ACTIVE_STATES,
  ]);
  if (Number(activeCount?.count ?? 0) >= config.maxActiveSessionsPerUser)
    throw tooMany(`You already have ${config.maxActiveSessionsPerUser} active lab sessions. Stop or let one expire before starting another.`);
  await consumePersistentLimit(`provision:user:${user.id}`, config.provisionPerHour, 3600);
  if (user.role !== 'admin') await consumePersistentLimit('provision:global', config.provisionPerHour * 20, 3600);

  const template = row.template;
  const sessionId = crypto.randomUUID();
  const secret = crypto.randomBytes(32).toString('hex');
  // maxMinutes is the hard lifetime cap; a session starts with ~2/3 of it so the
  // learner still has room for an extension (limited to maxMinutes).
  const hardCapSeconds = template.resources.maxMinutes * 60;
  const ttlSeconds = Math.min(hardCapSeconds, Math.max(5, Math.round(template.resources.maxMinutes * 0.66)) * 60);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const maxExpiresAt = new Date(Date.now() + hardCapSeconds * 1000);
  await query(
    `INSERT INTO lab_sessions (id, user_id, lab_id, lab_version, template_checksum, state, secret_encrypted, resources, expires_at, max_expires_at)
     VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9)`,
    [sessionId, user.id, labId, row.version, row.checksum, encryptSecret(secret), JSON.stringify(template.resources), expiresAt, maxExpiresAt],
  );
  await insertEvent(sessionId, 'queued', 'info', 'Session requested');
  await touchProgress(user.id, labId);
  await query(
    'INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [user.id, user.role, 'session.start', 'lab_session', sessionId, JSON.stringify({ labId, version: row.version }), ip ?? null],
  );

  try {
    const started = await runner.startSession({
      sessionId,
      userId: user.id,
      labId,
      labVersion: row.version,
      templateChecksum: row.checksum,
      sessionSecret: secret,
      ttlSeconds,
      requestId: crypto.randomUUID(),
    });
    await applyRunnerState(sessionId, template, started);
    if (started.provision) await storeFlags((await getSessionRow(sessionId))!, template, started.provision);
    const fresh = (await getSessionRow(sessionId))!;
    return { session: await buildSessionView(fresh), reused: false };
  } catch (err) {
    const e = err as ApiError;
    const detail = e instanceof ApiError ? `${e.message}${e.detail ? ` — ${e.detail}` : ''}` : 'Lab worker error';
    await query(
      `UPDATE lab_sessions SET state = 'failed', failure = $2, ended_at = now(), end_reason = 'provisioning-failed', updated_at = now() WHERE id = $1`,
      [sessionId, JSON.stringify({ code: e instanceof ApiError ? e.code : 'runner_error', message: e.message ?? 'Provisioning failed', detail: detail.slice(0, 1500) })],
    );
    await insertEvent(sessionId, 'failed', 'error', detail.slice(0, 900));
    await query('INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      user.id,
      user.role,
      'session.start_failed',
      'lab_session',
      sessionId,
      JSON.stringify({ labId, error: e.message }),
      ip ?? null,
    ]);
    throw e instanceof ApiError ? e : unavailable('The lab worker could not provision this session');
  }
}

async function applyRunnerState(sessionId: string, template: LabTemplate, state: {
  state: string;
  detail?: string;
  targets?: { name: string; port: number; protocol: string }[];
  failure?: { code: string; message: string; detail?: string };
  expiresAt?: string;
  readyAt?: string;
  events?: { at: string; state: string; level: 'info' | 'warn' | 'error'; message: string }[];
  mode?: string;
  provision?: { flags: Record<string, string>; meta: Record<string, unknown> };
}) {
  const current = await getSessionRow(sessionId);
  if (!current) return;
  const nextState = state.state as SessionState;
  const active = isActive(nextState);
  const expiresAt = state.expiresAt ? new Date(state.expiresAt) : current.expires_at;
  await query(
    `UPDATE lab_sessions SET state = $2, runner_mode = COALESCE($3, runner_mode),
       targets = $4, failure = $5, expires_at = $6,
       ready_at = CASE WHEN $2 = 'ready' AND ready_at IS NULL THEN now() ELSE ready_at END,
       updated_at = now(),
       ended_at = CASE WHEN $7 THEN now() ELSE ended_at END,
       end_reason = CASE WHEN $7 THEN COALESCE($8, 'ended') ELSE end_reason END
     WHERE id = $1`,
    [
      sessionId,
      nextState,
      state.mode ?? null,
      JSON.stringify(state.targets ?? current.targets ?? []),
      state.failure ? JSON.stringify(state.failure) : null,
      expiresAt,
      !active && !['queued', 'provisioning', 'starting'].includes(nextState),
      nextState === 'expired' ? 'expired' : nextState === 'failed' ? 'failed' : 'stopped',
    ],
  );
  if (current.state !== nextState) {
    const level = nextState === 'failed' ? 'error' : nextState === 'expired' ? 'warn' : 'info';
    await insertEvent(sessionId, nextState, level, (state.detail || nextState).slice(0, 900));
  }
  if (state.events?.length) {
    const last = await one<{ created_at: Date | null }>('SELECT max(created_at) AS created_at FROM session_events WHERE session_id = $1', [sessionId]);
    const lastAt = last?.created_at ? new Date(last.created_at).getTime() : 0;
    for (const ev of state.events) {
      if (new Date(ev.at).getTime() <= lastAt) continue;
      await insertEvent(sessionId, ev.state, ev.level, ev.message);
    }
  }
  if (nextState === 'failed' && state.failure) {
    await query('INSERT INTO audit_log (action, target_type, target_id, meta) VALUES ($1,$2,$3,$4)', [
      'session.failed',
      'lab_session',
      sessionId,
      JSON.stringify({ code: state.failure.code, message: state.failure.message }),
    ]);
  }
  void template;
}

export async function refreshSession(session: SessionRow): Promise<SessionView> {
  if (TERMINAL_STATES.includes(session.state)) return buildSessionView(session);
  try {
    const remote = await runner.getSession(session.id, true);
    const templateRow = await getTemplateRow(session.lab_id);
    if (templateRow) await applyRunnerState(session.id, templateRow.template, remote);
    if (remote.provision && templateRow) {
      await storeFlags(session, templateRow.template, remote.provision);
    }
    const updated = (await getSessionRow(session.id))!;
    if (isActive(updated.state)) await query('UPDATE lab_progress SET last_activity_at = now() WHERE user_id = $1 AND lab_id = $2', [updated.user_id, updated.lab_id]);
    return buildSessionView(updated);
  } catch (err) {
    const e = err as ApiError;
    if (e.status === 404) {
      await query(
        `UPDATE lab_sessions SET state = 'failed', failure = $2, ended_at = now(), end_reason = 'worker-lost', updated_at = now() WHERE id = $1`,
        [session.id, JSON.stringify({ code: 'worker-lost', message: 'The lab worker no longer has this session (it may have restarted). Start the lab again.' })],
      );
      await insertEvent(session.id, 'failed', 'error', 'Lab worker lost this session; resources were reconciled and the lab can be restarted');
      return buildSessionView((await getSessionRow(session.id))!);
    }
    log.warn('session refresh failed', { sessionId: session.id, error: e.message });
    const view = await buildSessionView(session);
    view.events = [...view.events, { state: session.state, level: 'warn', message: 'Lab worker temporarily unreachable; showing last known state', createdAt: new Date().toISOString() }];
    return view;
  }
}

export async function stopLab(user: { id: string; role: string }, sessionId: string, reason: 'stopped' | 'expired' = 'stopped', ip?: string): Promise<SessionView> {
  const session = await requireOwnedSession(user.id, sessionId);
  if (TERMINAL_STATES.includes(session.state)) return buildSessionView(session);
  await query(`UPDATE lab_sessions SET state = 'stopping', updated_at = now() WHERE id = $1`, [sessionId]);
  try {
    await runner.stopSession(sessionId, reason);
  } catch (err) {
    log.warn('runner stop failed', { sessionId, error: (err as Error).message });
  }
  await query(
    `UPDATE lab_sessions SET state = $2, ended_at = now(), end_reason = $3, updated_at = now() WHERE id = $1 AND state NOT IN ('stopped','failed','expired')`,
    [sessionId, reason === 'expired' ? 'expired' : 'stopped', reason],
  );
  await insertEvent(sessionId, reason === 'expired' ? 'expired' : 'stopped', 'info', 'Session resources released');
  await query('INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, ip) VALUES ($1,$2,$3,$4,$5,$6)', [
    user.id,
    user.role,
    'session.stop',
    'lab_session',
    sessionId,
    ip ?? null,
  ]);
  return buildSessionView((await getSessionRow(sessionId))!);
}

export async function extendLab(userId: string, sessionId: string, ttlSeconds: number): Promise<SessionView> {
  const session = await requireOwnedSession(userId, sessionId);
  if (session.state !== 'ready') throw conflict('Only a ready session can be extended');
  if (session.extension_count >= 4) throw conflict('This session has reached the maximum number of extensions');
  const templateRow = await getTemplateRow(session.lab_id);
  if (!templateRow) throw notFound('Template missing');
  const maxSeconds = templateRow.template.resources.maxMinutes * 60;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > maxSeconds) throw badRequest(`Extension must be between 60 and ${maxSeconds} seconds`);
  if (session.max_expires_at && Date.now() + 30_000 >= new Date(session.max_expires_at).getTime())
    throw conflict('This session has reached its maximum lifetime');
  const remote = await runner.extendSession(sessionId, ttlSeconds);
  await query('UPDATE lab_sessions SET expires_at = $2, extension_count = extension_count + 1, updated_at = now() WHERE id = $1', [
    sessionId,
    remote.expiresAt ? new Date(remote.expiresAt) : new Date(Date.now() + ttlSeconds * 1000),
  ]);
  await insertEvent(sessionId, 'ready', 'info', `Session extended by ${Math.round(ttlSeconds / 60)} minutes`);
  return buildSessionView((await getSessionRow(sessionId))!);
}

/**
 * Reset is implemented as stop + fresh provision with a brand new session ID and
 * flag material. Learning progress (objective completions) is preserved.
 */
export async function resetLab(user: { id: string; role: string }, sessionId: string, ip?: string): Promise<{ session: SessionView; reused: boolean }> {
  const session = await requireOwnedSession(user.id, sessionId);
  await stopLab(user, sessionId, 'stopped', ip);
  await consumePersistentLimit(`provision:user:${user.id}`, config.provisionPerHour, 3600);
  await query("UPDATE lab_sessions SET end_reason = 'reset' WHERE id = $1", [sessionId]);
  const started = await startLab(user, session.lab_id, ip);
  return started;
}

export async function sessionLogs(userId: string, sessionId: string, isAdmin = false): Promise<string> {
  const session = await requireOwnedSession(userId, sessionId, isAdmin);
  try {
    const result = await runner.logs(sessionId);
    return result.logs ?? '';
  } catch (err) {
    const events = await all<{ created_at: Date; state: string; message: string }>(
      'SELECT created_at, state, message FROM session_events WHERE session_id = $1 ORDER BY id',
      [sessionId],
    );
    return [
      `worker logs unavailable: ${(err as Error).message}`,
      ...events.map((e) => `${new Date(e.created_at).toISOString()} [${e.state}] ${e.message}`),
    ].join('\n');
  }
}

export async function reapExpiredSessions(): Promise<number> {
  const rows = await all<SessionRow>(
    `SELECT * FROM lab_sessions WHERE state IN ('queued','provisioning','starting','ready') AND (
       expires_at < now() OR (state = 'ready' AND last_activity_at < now() - interval '1 hour' * 6)
     )`,
  );
  let count = 0;
  for (const row of rows) {
    try {
      await stopLab({ id: row.user_id, role: 'system' }, row.id, 'expired');
      count += 1;
    } catch (err) {
      log.warn('expiry sweep failed', { sessionId: row.id, error: (err as Error).message });
    }
  }
  return count;
}
