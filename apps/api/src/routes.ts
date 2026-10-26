import { Router, type Request, type Response } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { CATEGORIES, rankForXp } from '@cipherforge/shared';
import { all, one, query } from './db/index.js';
import { config } from './config.js';
import { ApiError, badRequest, conflict, forbidden, notFound, tooMany, unauthorized } from './lib/errors.js';
import { asyncHandler, clientIp, parse } from './lib/http.js';
import { hashPassword, verifyPassword, maskEmail } from './lib/crypto.js';
import { log } from './lib/logger.js';
import {
  clearAuthCookies,
  createAuthSession,
  csrfProtection,
  loadAuth,
  requireAdmin,
  requireAuth,
  setAuthCookies,
} from './middleware/auth.js';
import { consumePersistentLimit, memoryLimit } from './services/ratelimit.js';
import { categoriesSummary, getLabDetail, getTemplateRow, listLabs } from './services/catalog.js';
import { listAchievements } from './services/achievements.js';
import {
  buildSessionView,
  startLab,
  resetLab,
  getSessionRow,
  listUserSessions,
  refreshSession,
  requireOwnedSession,
  sessionLogs,
  stopLab,
  extendLab,
} from './services/sessions.js';
import { enrollPath, leaderboard, pathsOverview, progressSummary, revealHint, revealWalkthrough, submitCheck, submitFlag } from './services/objectives.js';
import { proxyTarget, runner } from './services/runner-client.js';

export const router = Router();

const emailSchema = z.string().email().max(200).transform((v) => v.toLowerCase());
const passwordSchema = z.string().min(10, 'Password must be at least 10 characters').max(200);

// --------------------------------------------------------------------- health
router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    let db = false;
    try {
      await query('SELECT 1');
      db = true;
    } catch {}
    let runnerHealth: Awaited<ReturnType<typeof runner.health>> | null = null;
    let runnerError: string | null = null;
    try {
      runnerHealth = await runner.health();
    } catch (err) {
      runnerError = (err as Error).message;
    }
    res.status(db ? 200 : 503).json({
      ok: db,
      app: { version: config.version, env: config.env, uptimeSeconds: Math.round(process.uptime()) },
      database: { ok: db },
      runner: runnerHealth
        ? { ok: runnerHealth.ok, mode: runnerHealth.mode, capacity: runnerHealth.capacity, dockerAvailable: runnerHealth.dockerAvailable, sandboxAvailable: runnerHealth.sandboxAvailable }
        : { ok: false, error: runnerError ?? 'unreachable' },
      time: new Date().toISOString(),
    });
  }),
);

// ----------------------------------------------------------------------- auth
router.post(
  '/auth/register',
  asyncHandler(async (req, res) => {
    memoryLimit(`register:${clientIp(req)}`, config.registerPerHour, 3600_000);
    const body = parse(
      z.object({ email: emailSchema, username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_-]+$/), password: passwordSchema }),
      req.body,
    );
    const existing = await one('SELECT id FROM users WHERE lower(email) = lower($1) OR lower(username) = lower($2)', [body.email, body.username]);
    if (existing) throw conflict('An account with that email or username already exists');
    const { hash, salt } = hashPassword(body.password);
    const user = await one<{ id: string; email: string; username: string; role: string }>(
      'INSERT INTO users (email, username, password_hash, password_salt) VALUES ($1,$2,$3,$4) RETURNING id, email, username, role',
      [body.email, body.username, hash, salt],
    );
    const auth = await createAuthSession(user!.id, clientIp(req), req.headers['user-agent']);
    setAuthCookies(res, auth.token, auth.csrfToken, auth.expiresAt);
    await query('INSERT INTO audit_log (actor_id, actor_role, action, ip) VALUES ($1,$2,$3,$4)', [user!.id, 'learner', 'auth.register', clientIp(req) ?? null]);
    res.status(201).json({ user: { ...user!, rank: rankForXp(0) }, csrfToken: auth.csrfToken });
  }),
);

router.post(
  '/auth/login',
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ email: emailSchema, password: z.string().max(200) }), req.body);
    memoryLimit(`login:${clientIp(req)}`, 30, 300_000);
    const attempts = await one<{ count: string }>(
      "SELECT count(*)::text AS count FROM login_attempts WHERE (email = $1 OR ip = $2) AND success = false AND created_at > now() - interval '15 minutes'",
      [body.email, clientIp(req) ?? '0.0.0.0'],
    );
    if (Number(attempts?.count ?? 0) >= 10) throw tooMany('Too many failed sign-in attempts. Try again in a few minutes.');
    const user = await one<{ id: string; email: string; username: string; role: 'learner' | 'admin'; password_hash: string; password_salt: string; xp: number; disabled: boolean; status: string }>(
      'SELECT id, email, username, role, password_hash, password_salt, xp, disabled, status FROM users WHERE lower(email) = lower($1)',
      [body.email],
    );
    const ok = user ? verifyPassword(body.password, user.password_salt, user.password_hash) : false;
    await query('INSERT INTO login_attempts (email, ip, success) VALUES ($1,$2,$3)', [body.email, clientIp(req) ?? null, ok]);
    if (!ok || !user || user.disabled || user.status !== 'active') {
      await new Promise((r) => setTimeout(r, 250));
      throw unauthorized('Invalid email or password');
    }
    const auth = await createAuthSession(user.id, clientIp(req), req.headers['user-agent']);
    setAuthCookies(res, auth.token, auth.csrfToken, auth.expiresAt);
    await query('INSERT INTO audit_log (actor_id, actor_role, action, ip) VALUES ($1,$2,$3,$4)', [user.id, user.role, 'auth.login', clientIp(req) ?? null]);
    res.json({
      user: { id: user.id, email: user.email, username: user.username, role: user.role, xp: user.xp, rank: rankForXp(user.xp) },
      csrfToken: auth.csrfToken,
    });
  }),
);

router.post(
  '/auth/logout',
  loadAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    if (req.auth) {
      await query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [req.auth.sessionId]);
      await query('INSERT INTO audit_log (actor_id, action, ip) VALUES ($1,$2,$3)', [req.auth.user.id, 'auth.logout', clientIp(req) ?? null]);
    }
    clearAuthCookies(res);
    res.json({ ok: true });
  }),
);

router.get(
  '/auth/me',
  loadAuth,
  asyncHandler(async (req, res) => {
    if (!req.auth) return res.json({ user: null });
    const stats = await one<{ labs: string; objectives: string }>(
      `SELECT (SELECT count(*)::text FROM lab_progress WHERE user_id = $1 AND status = 'completed') AS labs,
              (SELECT count(*)::text FROM objective_completions WHERE user_id = $1) AS objectives`,
      [req.auth.user.id],
    );
    res.json({
      user: {
        id: req.auth.user.id,
        email: req.auth.user.email,
        username: req.auth.user.username,
        role: req.auth.user.role,
        xp: req.auth.user.xp,
        rank: rankForXp(req.auth.user.xp),
        labsCompleted: Number(stats?.labs ?? 0),
        objectives: Number(stats?.objectives ?? 0),
      },
      csrfToken: req.cookies?.cf_csrf ?? null,
    });
  }),
);

router.post(
  '/me/password',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }), req.body);
    const row = await one<{ password_hash: string; password_salt: string }>('SELECT password_hash, password_salt FROM users WHERE id = $1', [req.auth!.user.id]);
    if (!row || !verifyPassword(body.currentPassword, row.password_salt, row.password_hash)) throw unauthorized('Current password is incorrect');
    const { hash, salt } = hashPassword(body.newPassword);
    await query('UPDATE users SET password_hash = $2, password_salt = $3 WHERE id = $1', [req.auth!.user.id, hash, salt]);
    await query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2', [req.auth!.user.id, req.auth!.sessionId]);
    await query('INSERT INTO audit_log (actor_id, action, ip) VALUES ($1,$2,$3)', [req.auth!.user.id, 'auth.password_change', clientIp(req) ?? null]);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------- labs
router.get(
  '/labs',
  loadAuth,
  asyncHandler(async (req, res) => {
    const userId = req.auth?.user.id;
    const [labs, categories] = await Promise.all([listLabs(userId), categoriesSummary(userId)]);
    const search = String(req.query.search ?? '').toLowerCase().trim();
    const category = String(req.query.category ?? '');
    const difficulty = String(req.query.difficulty ?? '');
    const status = String(req.query.status ?? '');
    const skill = String(req.query.skill ?? '').toLowerCase();
    let filtered = labs;
    if (search)
      filtered = filtered.filter((l) =>
        [l.title, l.subtitle, l.summary, l.category, ...l.skills].some((v) => v.toLowerCase().includes(search)),
      );
    if (category) filtered = filtered.filter((l) => l.category === category);
    if (difficulty) filtered = filtered.filter((l) => l.difficulty === difficulty);
    if (status === 'runnable') filtered = filtered.filter((l) => l.runnable);
    if (status === 'coming_soon') filtered = filtered.filter((l) => l.status === 'coming_soon');
    if (status === 'completed') filtered = filtered.filter((l) => l.progress?.status === 'completed');
    if (status === 'in_progress') filtered = filtered.filter((l) => l.progress?.status === 'in_progress');
    if (skill) filtered = filtered.filter((l) => l.skills.some((s) => s.toLowerCase().includes(skill)));
    const skills = [...new Set(labs.flatMap((l) => l.skills))].sort();
    res.json({
      labs: filtered,
      total: filtered.length,
      filters: { categories: [...CATEGORIES], difficulties: ['Beginner', 'Intermediate', 'Advanced', 'Expert'], skills, statuses: ['runnable', 'coming_soon', 'in_progress', 'completed'] },
      categories,
      counts: {
        all: labs.length,
        runnable: labs.filter((l) => l.runnable).length,
        completed: labs.filter((l) => l.progress?.status === 'completed').length,
        comingSoon: labs.filter((l) => l.status === 'coming_soon').length,
      },
    });
  }),
);

router.get(
  '/labs/:id',
  loadAuth,
  asyncHandler(async (req, res) => {
    res.json({ lab: await getLabDetail(req.params.id, req.auth?.user.id) });
  }),
);

router.get(
  '/labs/:id/walkthrough',
  loadAuth,
  requireAuth,
  asyncHandler(async (req, res) => {
    const detail = await getLabDetail(req.params.id, req.auth!.user.id);
    const revealed = await all<{ step_index: number }>('SELECT step_index FROM walkthrough_events WHERE user_id = $1 AND lab_id = $2', [req.auth!.user.id, req.params.id]);
    const indices = revealed.map((r) => r.step_index).sort((a, b) => a - b);
    const template = await getTemplateRow(req.params.id);
    res.json({
      steps: detail.walkthroughSteps,
      revealed: indices,
      revealedSteps: (template?.template.walkthrough ?? [])
        .map((step, index) => ({ index, ...step }))
        .filter((step) => indices.includes(step.index)),
      penalty: 'Completing objectives after using the walkthrough halves their XP.',
    });
  }),
);

const walkthroughBody = z.object({ sessionId: z.string().uuid().optional() });
router.post(
  '/labs/:id/walkthrough/:step',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const step = Number.parseInt(req.params.step, 10);
    const body = parse(walkthroughBody, req.body ?? {});
    const result = await revealWalkthrough(req.auth!.user.id, req.params.id, step, body.sessionId);
    res.json(result);
  }),
);

router.post(
  '/labs/:id/objectives/:objectiveId/hints/:hintId',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ sessionId: z.string().uuid().optional() }), req.body ?? {});
    if (body.sessionId) await requireOwnedSession(req.auth!.user.id, body.sessionId);
    const result = await revealHint(req.auth!.user.id, req.params.id, req.params.objectiveId, req.params.hintId, body.sessionId);
    res.json(result);
  }),
);

// ------------------------------------------------------------------- sessions
router.post(
  '/labs/:id/sessions',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await startLab({ id: req.auth!.user.id, role: req.auth!.user.role }, req.params.id, clientIp(req));
    res.status(result.reused ? 200 : 201).json(result);
  }),
);

router.get(
  '/sessions',
  loadAuth,
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ sessions: await listUserSessions(req.auth!.user.id) });
  }),
);

router.get(
  '/sessions/:id',
  loadAuth,
  requireAuth,
  asyncHandler(async (req, res) => {
    const session = await requireOwnedSession(req.auth!.user.id, req.params.id);
    res.json({ session: await refreshSession(session) });
  }),
);

router.get(
  '/sessions/:id/logs',
  loadAuth,
  requireAuth,
  asyncHandler(async (req, res) => {
    const logs = await sessionLogs(req.auth!.user.id, req.params.id);
    res.json({ logs });
  }),
);

router.get(
  '/sessions/:id/stream',
  loadAuth,
  requireAuth,
  asyncHandler(async (req, res) => {
    const session = await requireOwnedSession(req.auth!.user.id, req.params.id);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    let lastPayload = '';
    req.on('close', () => {
      closed = true;
    });
    const send = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send('open', { sessionId: session.id });
    let view = await buildSessionView(session);
    send('session', view);
    lastPayload = JSON.stringify(view);
    let previousState = view.state;
    let tick = 0;
    const interval = setInterval(async () => {
      if (closed) return;
      tick += 1;
      try {
        const current = await getSessionRow(session.id);
        if (!current) {
          send('error', { message: 'session removed' });
          cleanup();
          return;
        }
        const refreshed = await refreshSession(current);
        const payload = JSON.stringify(refreshed);
        if (payload !== lastPayload) {
          lastPayload = payload;
          send('session', refreshed);
        } else if (tick % 5 === 0) send('heartbeat', { at: new Date().toISOString(), state: refreshed.state, remainingSeconds: refreshed.remainingSeconds });
        if (refreshed.state !== previousState) {
          previousState = refreshed.state;
          send('state', { state: refreshed.state, detail: refreshed.events.at(-1)?.message });
        }
        if (['stopped', 'failed', 'expired'].includes(refreshed.state)) {
          send('end', { state: refreshed.state });
          cleanup();
        }
      } catch (err) {
        send('warning', { message: (err as Error).message });
      }
    }, 1500);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      res.end();
    };
    req.on('close', cleanup);
    setTimeout(cleanup, 60 * 60_000);
  }),
);

router.post(
  '/sessions/:id/stop',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const session = await requireOwnedSession(req.auth!.user.id, req.params.id);
    const view = await stopLab({ id: req.auth!.user.id, role: req.auth!.user.role }, session.id, 'stopped', clientIp(req));
    res.json({ session: view });
  }),
);

router.post(
  '/sessions/:id/reset',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const result = await resetLab({ id: req.auth!.user.id, role: req.auth!.user.role }, req.params.id, clientIp(req));
    res.json(result);
  }),
);

router.post(
  '/sessions/:id/extend',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ minutes: z.number().int().min(1).max(120) }), req.body);
    const view = await extendLab(req.auth!.user.id, req.params.id, body.minutes * 60);
    res.json({ session: view });
  }),
);

router.post(
  '/sessions/:id/objectives/:objectiveId/submit',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ flag: z.string().min(4).max(200) }), req.body);
    const session = await requireOwnedSession(req.auth!.user.id, req.params.id);
    const result = await submitFlag({ id: req.auth!.user.id, xp: req.auth!.user.xp }, session, req.params.objectiveId, body.flag, clientIp(req));
    res.status(result.passed ? 200 : 422).json(result);
  }),
);

const evidenceSchema = z.record(z.unknown()).optional();
router.post(
  '/sessions/:id/objectives/:objectiveId/check',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ evidence: evidenceSchema }), req.body ?? {});
    const session = await requireOwnedSession(req.auth!.user.id, req.params.id);
    const result = await submitCheck({ id: req.auth!.user.id, xp: req.auth!.user.xp }, session, req.params.objectiveId, body.evidence);
    res.status(result.passed ? 200 : 422).json(result);
  }),
);

router.all(
  '/sessions/:id/target/:name/*',
  loadAuth,
  requireAuth,
  asyncHandler(async (req, res) => {
    const session = await requireOwnedSession(req.auth!.user.id, req.params.id);
    if (session.state !== 'ready') throw conflict('The lab is not ready yet');
    const suffix = (req.params as Record<string, string>)[0] ?? '';
    await proxyTarget(req, res, session.id, req.params.name, suffix || '');
  }),
);

// --------------------------------------------------------------- gamification
router.get(
  '/me/summary',
  loadAuth,
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await progressSummary(req.auth!.user.id));
  }),
);

router.get(
  '/achievements',
  loadAuth,
  asyncHandler(async (req, res) => {
    res.json({ achievements: await listAchievements(req.auth?.user.id) });
  }),
);

router.get(
  '/leaderboard',
  loadAuth,
  asyncHandler(async (_req, res) => {
    res.json({ leaderboard: await leaderboard(20) });
  }),
);

router.get(
  '/paths',
  loadAuth,
  asyncHandler(async (req, res) => {
    res.json({ paths: await pathsOverview(req.auth?.user.id) });
  }),
);

router.post(
  '/paths/:id/enroll',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    await enrollPath(req.auth!.user.id, req.params.id);
    res.json({ paths: await pathsOverview(req.auth!.user.id) });
  }),
);

// --------------------------------------------------------------------- admin
router.get(
  '/admin/overview',
  loadAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    let worker: Awaited<ReturnType<typeof runner.health>> | null = null;
    let workerError: string | null = null;
    try {
      worker = await runner.health();
      await query(
        `INSERT INTO worker_heartbeats (id, mode, host, capacity, healthy, checks, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (id) DO UPDATE SET mode = EXCLUDED.mode, capacity = EXCLUDED.capacity, healthy = EXCLUDED.healthy, checks = EXCLUDED.checks, last_seen_at = now()`,
        ['primary', worker.mode, new URL(config.runnerUrl).host, JSON.stringify(worker.capacity), worker.ok, JSON.stringify(worker.checks)],
      );
    } catch (err) {
      workerError = (err as Error).message;
    }
    const counts = await one<{
      users: string;
      active_sessions: string;
      failed_24h: string;
      published: string;
      coming_soon: string;
      completions: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM users) AS users,
        (SELECT count(*)::text FROM lab_sessions WHERE state IN ('queued','provisioning','starting','ready')) AS active_sessions,
        (SELECT count(*)::text FROM lab_sessions WHERE state IN ('failed','expired') AND updated_at > now() - interval '24 hours') AS failed_24h,
        (SELECT count(*)::text FROM lab_templates WHERE status = 'published' AND enabled) AS published,
        (SELECT count(*)::text FROM lab_templates WHERE status = 'coming_soon') AS coming_soon,
        (SELECT count(*)::text FROM objective_completions) AS completions`,
    );
    const [templates, sessions, audit] = await Promise.all([
      all<{ lab_id: string; version: string; checksum: string; status: string; enabled: boolean; published_at: Date | null }>(
        'SELECT lab_id, version, checksum, status, enabled, published_at FROM lab_templates ORDER BY lab_id',
      ),
      all<{ id: string; lab_id: string; state: string; runner_mode: string; created_at: Date; expires_at: Date | null; email: string; failure: unknown }>(
        `SELECT s.id, s.lab_id, s.state, s.runner_mode, s.created_at, s.expires_at, u.email, s.failure
         FROM lab_sessions s JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC LIMIT 25`,
      ),
      all<{ id: string; actor_role: string; action: string; target_type: string; target_id: string; meta: unknown; created_at: Date; email: string | null }>(
        `SELECT a.id, a.actor_role, a.action, a.target_type, a.target_id, a.meta, a.created_at, u.email
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 30`,
      ),
    ]);
    res.json({
      worker: worker
        ? { ok: worker.ok, mode: worker.mode, capacity: worker.capacity, checks: worker.checks, drivers: worker.drivers, isolation: worker.isolation, version: worker.version }
        : { ok: false, error: workerError },
      counts: {
        users: Number(counts?.users ?? 0),
        activeSessions: Number(counts?.active_sessions ?? 0),
        failed24h: Number(counts?.failed_24h ?? 0),
        published: Number(counts?.published ?? 0),
        comingSoon: Number(counts?.coming_soon ?? 0),
        completions: Number(counts?.completions ?? 0),
      },
      templates: templates.map((t) => ({ ...t, checksum: t.checksum.slice(0, 16), published_at: t.published_at?.toISOString() ?? null })),
      sessions: sessions.map((s) => ({
        id: s.id,
        labId: s.lab_id,
        state: s.state,
        mode: s.runner_mode,
        createdAt: new Date(s.created_at).toISOString(),
        expiresAt: s.expires_at?.toISOString() ?? null,
        user: maskEmail(s.email),
        failure: s.failure,
      })),
      audit: audit.map((a) => ({
        id: a.id,
        action: a.action,
        actorRole: a.actor_role,
        actor: a.email ? maskEmail(a.email) : 'system',
        target: `${a.target_type ?? ''}:${a.target_id ?? ''}`,
        meta: a.meta,
        at: new Date(a.created_at).toISOString(),
      })),
    });
  }),
);

router.get(
  '/admin/sessions',
  loadAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const states = String(req.query.state ?? '')
      .split(',')
      .filter(Boolean);
    const rows = await all<Record<string, unknown>>(
      `SELECT s.id, s.lab_id, s.state, s.runner_mode, s.created_at, s.ready_at, s.expires_at, s.ended_at, s.end_reason, s.failure, u.email,
              (SELECT count(*)::text FROM session_events e WHERE e.session_id = s.id) AS event_count
       FROM lab_sessions s JOIN users u ON u.id = s.user_id
       ${states.length ? 'WHERE s.state = ANY($1::text[])' : ''}
       ORDER BY s.created_at DESC LIMIT 100`,
      states.length ? [states] : [],
    );
    res.json({
      sessions: rows.map((r) => ({
        ...r,
        email: maskEmail(String(r.email)),
        created_at: new Date(String(r.created_at)).toISOString(),
        ready_at: r.ready_at ? new Date(String(r.ready_at)).toISOString() : null,
        expires_at: r.expires_at ? new Date(String(r.expires_at)).toISOString() : null,
        ended_at: r.ended_at ? new Date(String(r.ended_at)).toISOString() : null,
      })),
    });
  }),
);

router.get(
  '/admin/sessions/:id/logs',
  loadAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const row = await getSessionRow(req.params.id);
    if (!row) throw notFound('Session not found');
    const logs = await sessionLogs(row.user_id, row.id, true);
    res.json({ logs });
  }),
);

router.post(
  '/admin/sessions/:id/stop',
  loadAuth,
  requireAdmin,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const row = await getSessionRow(req.params.id);
    if (!row) throw notFound('Session not found');
    const view = await stopLab({ id: req.auth!.user.id, role: req.auth!.user.role }, row.id, 'stopped', clientIp(req));
    await query('INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id) VALUES ($1,$2,$3,$4,$5)', [
      req.auth!.user.id,
      'admin',
      'admin.session.stop',
      'lab_session',
      row.id,
    ]);
    res.json({ session: view });
  }),
);

router.post(
  '/admin/labs/:id/enabled',
  loadAuth,
  requireAdmin,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const body = parse(z.object({ enabled: z.boolean() }), req.body);
    const updated = await one('UPDATE lab_templates SET enabled = $2, updated_at = now() WHERE lab_id = $1 RETURNING lab_id, enabled', [
      req.params.id,
      body.enabled,
    ]);
    if (!updated) throw notFound('Lab not found');
    await query('INSERT INTO audit_log (actor_id, actor_role, action, target_type, target_id, meta) VALUES ($1,$2,$3,$4,$5,$6)', [
      req.auth!.user.id,
      'admin',
      body.enabled ? 'admin.lab.enable' : 'admin.lab.disable',
      'lab_template',
      req.params.id,
      JSON.stringify({ enabled: body.enabled }),
    ]);
    res.json({ lab: updated });
  }),
);

router.post(
  '/admin/cleanup',
  loadAuth,
  requireAdmin,
  csrfProtection,
  asyncHandler(async (_req, res) => {
    const expired = await one<{ count: string }>(
      "SELECT count(*)::text AS count FROM lab_sessions WHERE state IN ('queued','provisioning','starting','ready') AND expires_at < now()",
    );
    res.json({ ok: true, expiredSessions: Number(expired?.count ?? 0), message: 'Expiry sweep runs continuously; runner orphan cleanup executes at startup and on session stop.' });
  }),
);

// ------------------------------------------------------------------------ QA
router.get(
  '/qa',
  loadAuth,
  asyncHandler(async (_req, res) => {
    const runs = await all<{ id: string; started_at: Date; finished_at: Date | null; mode: string; summary: unknown; checks: unknown }>(
      'SELECT id, started_at, finished_at, mode, summary, checks FROM qa_runs ORDER BY started_at DESC LIMIT 5',
    );
    res.json({
      latest: runs[0]
        ? {
            id: runs[0].id,
            startedAt: new Date(runs[0].started_at).toISOString(),
            finishedAt: runs[0].finished_at ? new Date(runs[0].finished_at).toISOString() : null,
            mode: runs[0].mode,
            summary: runs[0].summary,
            checks: runs[0].checks,
          }
        : null,
      history: runs.map((r) => ({
        id: r.id,
        startedAt: new Date(r.started_at).toISOString(),
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        mode: r.mode,
        summary: r.summary,
      })),
      howToRun: 'Run `npm run qa` from the project root. Checks that require Docker report BLOCKED when the engine is unavailable.',
    });
  }),
);

router.post(
  '/admin/qa/run',
  loadAuth,
  requireAdmin,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const script = path.join(config.repoRoot, 'scripts/qa/run-qa.mjs');
    if (!existsSync(script)) throw notFound('QA runner script not found');
    const child = spawn(process.execPath, [script, '--persist', '--triggered-by', req.auth!.user.id], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        DATABASE_URL: config.databaseUrl,
        CF_RUNNER_URL: config.runnerUrl,
        CF_RUNNER_SECRET: config.runnerSecret,
        CF_APP_SECRET: config.appSecret,
        CF_API_BASE: `http://127.0.0.1:${config.port}`,
        CF_ADMIN_EMAIL: config.seedAdminEmail,
        CF_ADMIN_PASSWORD: config.seedAdminPassword,
      },
    });
    child.unref();
    await query('INSERT INTO audit_log (actor_id, actor_role, action, meta) VALUES ($1,$2,$3,$4)', [
      req.auth!.user.id,
      'admin',
      'admin.qa.run',
      JSON.stringify({ pid: child.pid }),
    ]);
    res.status(202).json({ ok: true, message: 'QA suite started. Results appear on the QA screen when the run completes.' });
  }),
);

// ------------------------------------------------------------------- accounts
router.get(
  '/me/sessions',
  loadAuth,
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ sessions: await listUserSessions(req.auth!.user.id, 50) });
  }),
);

router.delete(
  '/me/sessions/:id',
  loadAuth,
  requireAuth,
  csrfProtection,
  asyncHandler(async (req, res) => {
    const session = await requireOwnedSession(req.auth!.user.id, req.params.id);
    await stopLab({ id: req.auth!.user.id, role: req.auth!.user.role }, session.id, 'stopped', clientIp(req));
    res.json({ ok: true });
  }),
);

router.get(
  '/sessions/:id/objectives',
  loadAuth,
  requireAuth,
  asyncHandler(async (req, res) => {
    const session = await requireOwnedSession(req.auth!.user.id, req.params.id);
    const template = await one<{ template: { objectives: { id: string; title: string }[] } }>('SELECT template FROM lab_templates WHERE lab_id = $1', [session.lab_id]);
    const completed = await all<{ objective_id: string }>('SELECT objective_id FROM objective_completions WHERE user_id = $1 AND lab_id = $2', [
      req.auth!.user.id,
      session.lab_id,
    ]);
    const hints = await all<{ objective_id: string; hint_id: string; xp_penalty: number }>('SELECT objective_id, hint_id, xp_penalty FROM hint_events WHERE user_id = $1 AND lab_id = $2', [
      req.auth!.user.id,
      session.lab_id,
    ]);
    res.json({
      session: await buildSessionView(session),
      objectives: (template?.template.objectives ?? []).map((o) => ({
        ...o,
        completed: completed.some((c) => c.objective_id === o.id),
      })),
      hints: hints.map((h) => ({ objectiveId: h.objective_id, hintId: h.hint_id, xpPenalty: h.xp_penalty })),
    });
  }),
);

// Small helper for clients that need recent activity on the dashboard.
router.get(
  '/me/activity',
  loadAuth,
  requireAuth,
  asyncHandler(async (req, res) => {
    const rows = await all<{ action: string; target_id: string; created_at: Date }>(
      'SELECT action, target_id, created_at FROM audit_log WHERE actor_id = $1 AND action IN ($2,$3,$4) ORDER BY id DESC LIMIT 12',
      [req.auth!.user.id, 'session.start', 'objective.complete', 'session.stop'],
    );
    res.json({ activity: rows.map((r) => ({ action: r.action, targetId: r.target_id, at: new Date(r.created_at).toISOString() })) });
  }),
);

// Explicit health of the app's own dependencies for the QA screen.
router.get(
  '/admin/config',
  loadAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({
      env: config.env,
      version: config.version,
      features: {
        maxActiveSessionsPerUser: config.maxActiveSessionsPerUser,
        provisionPerHour: config.provisionPerHour,
        flagAttemptsPerMinute: config.flagAttemptsPerMinute,
        runnerUrl: new URL(config.runnerUrl).host,
        cookieSecure: config.cookieSecure,
      },
      security: {
        csrf: 'double-submit cookie + origin guard',
        sessions: 'httpOnly SameSite=Lax cookie, server-side revocation',
        flags: 'HMAC-SHA256 comparison, raw flags never stored',
        runnerAuth: 'HMAC request signing with nonce replay protection',
        dockerSocket: 'runner only — never mounted into api/web',
      },
    });
  }),
);

void crypto;
void readFileSync;
void badRequest;
void forbidden;
void ApiError;
void log;
