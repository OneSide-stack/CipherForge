import type { LabTemplate } from '@cipherforge/shared';
import { nextRank, rankForXp } from '@cipherforge/shared';
import { all, one, query, transaction } from '../db/index.js';
import { config } from '../config.js';
import { badRequest, conflict, notFound, tooMany } from '../lib/errors.js';
import { decryptSecret, flagSubmissionHmac, sha256, timingSafeEqualStr } from '../lib/crypto.js';
import { log } from '../lib/logger.js';
import { runner } from './runner-client.js';
import { getTemplateRow } from './catalog.js';
import { consumePersistentLimit } from './ratelimit.js';
import { evaluateAchievements, type EarnedAchievement } from './achievements.js';
import { isActive, type SessionRow } from './sessions.js';

export interface CompletionResult {
  passed: boolean;
  message: string;
  alreadyCompleted: boolean;
  xpAwarded: number;
  labBonus: number;
  totalXp: number;
  rank: { name: string; color: string; minXp: number };
  nextRank: { name: string; minXp: number } | null;
  achievements: EarnedAchievement[];
  labCompleted: boolean;
  objectivesCompleted: number;
  objectivesTotal: number;
  score: number;
  evidence?: Record<string, unknown>;
}

async function updateStreak(userId: string) {
  const user = await one<{ streak_count: number; longest_streak: number; last_streak_date: string | null }>(
    'SELECT streak_count, longest_streak, last_streak_date::text FROM users WHERE id = $1',
    [userId],
  );
  if (!user) return;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  let streak = user.streak_count;
  if (user.last_streak_date === today) return;
  if (user.last_streak_date === yesterday) streak += 1;
  else streak = 1;
  await query('UPDATE users SET streak_count = $2, longest_streak = GREATEST(longest_streak, $2), last_streak_date = $3 WHERE id = $1', [
    userId,
    streak,
    today,
  ]);
}

async function recomputeProgress(userId: string, labId: string, template: LabTemplate, walkthroughUsed: boolean) {
  const counts = await one<{ objectives: string; xp: string }>(
    'SELECT count(*)::text AS objectives, COALESCE(sum(xp),0)::text AS xp FROM objective_completions WHERE user_id = $1 AND lab_id = $2',
    [userId, labId],
  );
  const objectivesCompleted = Number(counts?.objectives ?? 0);
  const score = Number(counts?.xp ?? 0);
  const total = template.objectives.length;
  const complete = objectivesCompleted >= total;
  const progress = await one<{ completed_at: Date | null }>('SELECT completed_at FROM lab_progress WHERE user_id = $1 AND lab_id = $2', [userId, labId]);
  const firstCompletion = complete && !progress?.completed_at;
  await query(
    `UPDATE lab_progress SET status = $3, objectives_completed = $4, score = $5,
       completed_at = CASE WHEN $3 = 'completed' AND completed_at IS NULL THEN now() ELSE completed_at END,
       last_activity_at = now(), walkthrough_used = walkthrough_used OR $6
     WHERE user_id = $1 AND lab_id = $2`,
    [userId, labId, complete ? 'completed' : 'in_progress', objectivesCompleted, score, walkthroughUsed],
  );
  return { objectivesCompleted, total, score, complete, firstCompletion };
}

async function awardObjective(args: {
  userId: string;
  labId: string;
  session: SessionRow;
  template: LabTemplate;
  objectiveId: string;
  method: 'flag' | 'check';
}): Promise<CompletionResult> {
  const { userId, labId, session, template, objectiveId, method } = args;
  const objective = template.objectives.find((o) => o.id === objectiveId);
  if (!objective) throw notFound('Objective not found in this lab template');
  const hintSum = await one<{ penalty: string }>(
    'SELECT COALESCE(sum(xp_penalty),0)::text AS penalty FROM hint_events WHERE user_id = $1 AND lab_id = $2 AND objective_id = $3',
    [userId, labId, objectiveId],
  );
  const baseXp = objective.validation.xp;
  const hintPenalty = Math.min(baseXp, Number(hintSum?.penalty ?? 0));
  const multiplier = session.walkthrough_used ? 0.5 : 1;
  const xpAwarded = Math.max(1, Math.round((baseXp - hintPenalty) * multiplier));

  const inserted = await one<{ xp: number }>(
    `INSERT INTO objective_completions (user_id, lab_id, objective_id, session_id, xp, method, walkthrough_used, hints_used)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (user_id, lab_id, objective_id) DO NOTHING RETURNING xp`,
    [userId, labId, objectiveId, session.id, xpAwarded, method, session.walkthrough_used, hintPenalty > 0 ? 1 : 0],
  );

  let labBonus = 0;
  let achieved: EarnedAchievement[] = [];
  if (inserted) {
    await query('UPDATE users SET xp = xp + $2 WHERE id = $1', [userId, xpAwarded]);
    await updateStreak(userId);
    const progress = await recomputeProgress(userId, labId, template, session.walkthrough_used);
    if (progress.firstCompletion) {
      labBonus = Math.max(1, Math.round(template.baseXp * multiplier));
      await query('UPDATE users SET xp = xp + $2 WHERE id = $1', [userId, labBonus]);
      await query('UPDATE lab_progress SET score = score + $3 WHERE user_id = $1 AND lab_id = $2', [userId, labId, labBonus]);
    }
    achieved = await evaluateAchievements(userId);
    await query(
      'INSERT INTO audit_log (actor_id, action, target_type, target_id, meta) VALUES ($1,$2,$3,$4,$5)',
      [userId, 'objective.complete', 'lab', labId, JSON.stringify({ objectiveId, method, xpAwarded, labBonus })],
    );
    log.info('objective completed', { userId, labId, objectiveId, method, xpAwarded });
  }

  const user = await one<{ xp: number }>('SELECT xp FROM users WHERE id = $1', [userId]);
  const progress = await one<{ objectives_completed: number; score: number; status: string; completed_at: Date | null }>(
    'SELECT objectives_completed, score, status, completed_at FROM lab_progress WHERE user_id = $1 AND lab_id = $2',
    [userId, labId],
  );
  const xp = Number(user?.xp ?? 0);
  return {
    passed: true,
    message: inserted ? 'Objective verified' : 'Objective already completed — no additional XP awarded',
    alreadyCompleted: !inserted,
    xpAwarded: inserted ? xpAwarded : 0,
    labBonus,
    totalXp: xp,
    rank: rankForXp(xp),
    nextRank: nextRank(xp),
    achievements: achieved,
    labCompleted: progress?.status === 'completed',
    objectivesCompleted: Number(progress?.objectives_completed ?? 0),
    objectivesTotal: template.objectives.length,
    score: Number(progress?.score ?? 0),
  };
}

export async function submitFlag(user: { id: string; xp: number }, session: SessionRow, objectiveId: string, flag: string, ip?: string): Promise<CompletionResult & { attemptsRemaining?: number }> {
  const templateRow = await getTemplateRow(session.lab_id);
  if (!templateRow) throw notFound('Lab template not found');
  const template = templateRow.template;
  if (!isActive(session.state) || session.state !== 'ready') throw conflict('The lab session is not ready');
  const objective = template.objectives.find((o) => o.id === objectiveId);
  if (!objective) throw notFound('Objective not found');
  if (objective.validation.type !== 'flag') throw badRequest('This objective is validated by a security check, not a flag');

  await consumePersistentLimit(`flag:user:${user.id}`, config.flagAttemptsPerMinute * 2, 60);
  await consumePersistentLimit(`flag:session:${session.id}`, config.flagAttemptsPerMinute, 60);
  const trimmed = String(flag ?? '').trim();
  if (!/^CF\{[A-Za-z0-9_\-+=\/]{8,120}\}$/.test(trimmed)) throw badRequest('Flags look like CF{...}');

  const expected = await one<{ flag_hmac: string }>('SELECT flag_hmac FROM session_flags WHERE session_id = $1 AND objective_id = $2', [
    session.id,
    objectiveId,
  ]);
  if (!expected) throw conflict('Flags for this session are still being provisioned. Wait for the lab to become ready and try again.');

  const secret = decryptSecret(session.secret_encrypted);
  const candidate = flagSubmissionHmac(secret, session.lab_id, objectiveId, trimmed);
  const ok = timingSafeEqualStr(candidate, expected.flag_hmac);
  await query('INSERT INTO flag_attempts (user_id, session_id, objective_id, submitted_hmac, accepted, ip) VALUES ($1,$2,$3,$4,$5,$6)', [
    user.id,
    session.id,
    objectiveId,
    sha256(candidate).slice(0, 64),
    ok,
    ip ?? null,
  ]);
  if (!ok) {
    log.warn('flag rejected', { userId: user.id, labId: session.lab_id, objectiveId });
    const recent = await one<{ count: string }>(
      "SELECT count(*)::text AS count FROM flag_attempts WHERE user_id = $1 AND accepted = false AND created_at > now() - interval '5 minutes'",
      [user.id],
    );
    if (Number(recent?.count ?? 0) > 25) throw tooMany('Too many incorrect flag submissions. Pause and re-read the objective.');
    return {
      passed: false,
      message: 'Flag not accepted. Keep investigating — the flag must come from this session.',
      alreadyCompleted: false,
      xpAwarded: 0,
      labBonus: 0,
      totalXp: user.xp,
      rank: rankForXp(user.xp),
      nextRank: nextRank(user.xp),
      achievements: [],
      labCompleted: false,
      objectivesCompleted: 0,
      objectivesTotal: template.objectives.length,
      score: 0,
    };
  }
  return awardObjective({ userId: user.id, labId: session.lab_id, session, template, objectiveId, method: 'flag' });
}

export async function submitCheck(
  user: { id: string; xp: number },
  session: SessionRow,
  objectiveId: string,
  evidence: Record<string, unknown> | undefined,
): Promise<CompletionResult> {
  const templateRow = await getTemplateRow(session.lab_id);
  if (!templateRow) throw notFound('Lab template not found');
  const template = templateRow.template;
  if (session.state !== 'ready') throw conflict('Start or resume the lab before running objective checks');
  const objective = template.objectives.find((o) => o.id === objectiveId);
  if (!objective) throw notFound('Objective not found');
  if (objective.validation.type !== 'check') throw badRequest('This objective is validated with a flag');
  await consumePersistentLimit(`check:user:${user.id}`, config.checksPerMinute, 60);
  const validator = objective.validation.validator;
  if (!(template.validators ?? []).includes(validator)) {
    log.error('objective references unapproved validator', { labId: session.lab_id, validator });
    throw conflict('This objective cannot be validated; contact an administrator');
  }
  const result = await runner.validate(session.id, {
    userId: user.id,
    objectiveId,
    validator,
    evidence: { ...(evidence ?? {}) },
  });
  if (!result.passed) {
    return {
      passed: false,
      message: result.detail || 'Validation check did not pass yet.',
      alreadyCompleted: false,
      xpAwarded: 0,
      labBonus: 0,
      totalXp: user.xp,
      rank: rankForXp(user.xp),
      nextRank: nextRank(user.xp),
      achievements: [],
      labCompleted: false,
      objectivesCompleted: 0,
      objectivesTotal: template.objectives.length,
      score: 0,
      evidence: result.evidence,
    };
  }
  const awarded = await awardObjective({ userId: user.id, labId: session.lab_id, session, template, objectiveId, method: 'check' });
  return { ...awarded, evidence: result.evidence };
}

export async function revealHint(userId: string, labId: string, objectiveId: string, hintId: string, sessionId?: string) {
  const row = await getTemplateRow(labId);
  if (!row) throw notFound('Lab not found');
  const objective = row.template.objectives.find((o) => o.id === objectiveId);
  if (!objective) throw notFound('Objective not found');
  const index = objective.hints.findIndex((h) => h.id === hintId);
  if (index < 0) throw notFound('Hint not found');
  const revealed = await all<{ hint_id: string }>(
    'SELECT hint_id FROM hint_events WHERE user_id = $1 AND lab_id = $2 AND objective_id = $3 ORDER BY id',
    [userId, labId, objectiveId],
  );
  const revealedIds = revealed.map((r) => r.hint_id);
  if (revealedIds.includes(hintId)) {
    return { hint: objective.hints[index]!.text, alreadyRevealed: true, revealed: revealedIds.length, total: objective.hints.length, xpPenalty: objective.hints[index]!.xpPenalty };
  }
  for (let i = 0; i < index; i += 1) {
    if (!revealedIds.includes(objective.hints[i]!.id)) throw conflict('Reveal hints in order — start with the previous hint for this objective');
  }
  const hint = objective.hints[index]!;
  await query(
    `INSERT INTO hint_events (user_id, session_id, lab_id, objective_id, hint_id, xp_penalty) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, session_id, objective_id, hint_id) DO NOTHING`,
    [userId, sessionId ?? null, labId, objectiveId, hintId, hint.xpPenalty],
  );
  await query('UPDATE lab_progress SET hints_used = hints_used + 1 WHERE user_id = $1 AND lab_id = $2', [userId, labId]);
  if (sessionId) await query('UPDATE lab_sessions SET hints_used = hints_used + 1 WHERE id = $1 AND user_id = $2', [sessionId, userId]);
  return { hint: hint.text, alreadyRevealed: false, revealed: revealedIds.length + 1, total: objective.hints.length, xpPenalty: hint.xpPenalty };
}

export async function revealWalkthrough(userId: string, labId: string, stepIndex: number, sessionId?: string) {
  const row = await getTemplateRow(labId);
  if (!row) throw notFound('Lab not found');
  const steps = row.template.walkthrough;
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) throw badRequest('Invalid walkthrough step');
  const revealed = await all<{ step_index: number }>(
    'SELECT step_index FROM walkthrough_events WHERE user_id = $1 AND lab_id = $2 ORDER BY step_index',
    [userId, labId],
  );
  const revealedSet = new Set(revealed.map((r) => r.step_index));
  if (!revealedSet.has(stepIndex)) {
    for (let i = 0; i < stepIndex; i += 1) if (!revealedSet.has(i)) throw conflict('Reveal walkthrough steps in order');
    await query(
      `INSERT INTO walkthrough_events (user_id, session_id, lab_id, step_index) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, session_id, step_index) DO NOTHING`,
      [userId, sessionId ?? null, labId, stepIndex],
    );
    await query('UPDATE lab_progress SET walkthrough_used = TRUE WHERE user_id = $1 AND lab_id = $2', [userId, labId]);
    if (sessionId) await query('UPDATE lab_sessions SET walkthrough_used = TRUE WHERE id = $1 AND user_id = $2', [sessionId, userId]);
  }
  return {
    step: steps[stepIndex],
    index: stepIndex,
    total: steps.length,
    revealed: revealedSet.has(stepIndex) ? revealedSet.size : revealedSet.size + 1,
    penaltyNotice: 'Using the walkthrough halves XP for objectives completed in this lab session.',
  };
}

export async function progressSummary(userId: string) {
  const user = await one<{ xp: number; streak_count: number; longest_streak: number; last_streak_date: string | null; username: string; email: string; role: string }>(
    'SELECT xp, streak_count, longest_streak, last_streak_date::text, username, email, role FROM users WHERE id = $1',
    [userId],
  );
  if (!user) throw notFound('User not found');
  const stats = await one<{
    objectives: string;
    labs: string;
    categories: string;
    flags: string;
    hints: string;
    walkthroughs: string;
  }>(
    `SELECT
      (SELECT count(*)::text FROM objective_completions WHERE user_id = $1) AS objectives,
      (SELECT count(*)::text FROM lab_progress WHERE user_id = $1 AND status = 'completed') AS labs,
      (SELECT count(DISTINCT t.template->>'category')::text FROM lab_progress p JOIN lab_templates t ON t.lab_id = p.lab_id WHERE p.user_id = $1 AND p.status = 'completed') AS categories,
      (SELECT count(*)::text FROM flag_attempts WHERE user_id = $1 AND accepted) AS flags,
      (SELECT count(*)::text FROM hint_events WHERE user_id = $1) AS hints,
      (SELECT count(*)::text FROM walkthrough_events WHERE user_id = $1) AS walkthroughs`,
    [userId],
  );
  const recent = await all<{ lab_id: string; objective_id: string; xp: number; created_at: Date; title: string }>(
    `SELECT c.lab_id, c.objective_id, c.xp, c.created_at, t.template->>'title' AS title
     FROM objective_completions c LEFT JOIN lab_templates t ON t.lab_id = c.lab_id
     WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 8`,
    [userId],
  );
  const active = await all<{ id: string; lab_id: string; state: string; expires_at: Date | null; title: string | null; created_at: Date }>(
    `SELECT s.id, s.lab_id, s.state, s.expires_at, s.created_at, t.template->>'title' AS title
     FROM lab_sessions s LEFT JOIN lab_templates t ON t.lab_id = s.lab_id
     WHERE s.user_id = $1 AND s.state IN ('queued','provisioning','starting','ready') ORDER BY s.created_at DESC`,
    [userId],
  );
  const earned = await all<{ slug: string; earned_at: Date; name: string; icon: string; tier: string }>(
    'SELECT ua.slug, ua.earned_at, a.name, a.icon, a.tier FROM user_achievements ua JOIN achievements a ON a.slug = ua.slug WHERE ua.user_id = $1 ORDER BY ua.earned_at DESC',
    [userId],
  );
  const pathRows = await all<{ path_id: string; name: string; total: string; completed: string }>(
    `SELECT lp.id AS path_id, lp.name,
       count(pl.lab_id)::text AS total,
       count(p.lab_id) FILTER (WHERE p.status = 'completed')::text AS completed
     FROM learning_paths lp JOIN path_labs pl ON pl.path_id = lp.id
     LEFT JOIN lab_progress p ON p.lab_id = pl.lab_id AND p.user_id = $1
     GROUP BY lp.id, lp.name ORDER BY lp.sort_order`,
    [userId],
  );
  const rank = rankForXp(Number(user.xp));
  return {
    user: { id: userId, username: user.username, email: user.email, role: user.role },
    xp: Number(user.xp),
    rank,
    nextRank: nextRank(Number(user.xp)),
    streak: { current: user.streak_count, longest: user.longest_streak, lastActiveDate: user.last_streak_date },
    stats: {
      objectives: Number(stats?.objectives ?? 0),
      labs: Number(stats?.labs ?? 0),
      categories: Number(stats?.categories ?? 0),
      flags: Number(stats?.flags ?? 0),
      hints: Number(stats?.hints ?? 0),
      walkthroughs: Number(stats?.walkthroughs ?? 0),
    },
    recent: recent.map((r) => ({ labId: r.lab_id, objectiveId: r.objective_id, xp: r.xp, title: r.title, at: new Date(r.created_at).toISOString() })),
    activeSessions: active.map((a) => ({
      id: a.id,
      labId: a.lab_id,
      labTitle: a.title ?? a.lab_id,
      state: a.state,
      expiresAt: a.expires_at ? new Date(a.expires_at).toISOString() : undefined,
      remainingSeconds: a.expires_at ? Math.max(0, Math.floor((new Date(a.expires_at).getTime() - Date.now()) / 1000)) : 0,
      createdAt: new Date(a.created_at).toISOString(),
    })),
    achievements: earned.map((e) => ({ slug: e.slug, name: e.name, icon: e.icon, tier: e.tier, earnedAt: new Date(e.earned_at).toISOString() })),
    paths: pathRows.map((p) => ({ id: p.path_id, name: p.name, total: Number(p.total), completed: Number(p.completed) })),
  };
}

export async function leaderboard(limit = 20) {
  const rows = await all<{ id: string; username: string; xp: number; role: string; labs: string }>(
    `SELECT u.id, u.username, u.xp, u.role,
       (SELECT count(*)::text FROM lab_progress p WHERE p.user_id = u.id AND p.status = 'completed') AS labs
     FROM users u WHERE u.disabled = FALSE ORDER BY u.xp DESC, u.created_at ASC LIMIT $1`,
    [limit],
  );
  return rows.map((r, i) => ({ position: i + 1, userId: r.id, username: r.username, xp: r.xp, rank: rankForXp(r.xp).name, labsCompleted: Number(r.labs) }));
}

export async function pathsOverview(userId?: string) {
  const rows = await all<{ id: string; name: string; description: string; level: string; icon: string; estimated_hours: string; sort_order: number }>(
    'SELECT * FROM learning_paths ORDER BY sort_order',
  );
  const labs = await all<{ path_id: string; lab_id: string; position: number }>('SELECT path_id, lab_id, position FROM path_labs ORDER BY position');
  const labRows = await all<{ lab_id: string; template: LabTemplate }>('SELECT lab_id, template FROM lab_templates');
  const labMap = new Map(labRows.map((l) => [l.lab_id, l.template]));
  const progress = userId
    ? await all<{ lab_id: string; status: string }>('SELECT lab_id, status FROM lab_progress WHERE user_id = $1', [userId])
    : [];
  const progressMap = new Map(progress.map((p) => [p.lab_id, p.status]));
  const enrolled = userId ? await all<{ path_id: string }>('SELECT path_id FROM path_enrollments WHERE user_id = $1', [userId]) : [];
  const enrolledSet = new Set(enrolled.map((e) => e.path_id));
  return rows.map((r) => {
    const pathLabs = labs.filter((l) => l.path_id === r.id);
    const completed = pathLabs.filter((l) => progressMap.get(l.lab_id) === 'completed').length;
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      level: r.level,
      icon: r.icon,
      estimatedHours: Number(r.estimated_hours),
      enrolled: enrolledSet.has(r.id),
      progress: { completed, total: pathLabs.length },
      labs: pathLabs.map((l) => {
        const t = labMap.get(l.lab_id);
        return {
          id: l.lab_id,
          title: t?.title ?? l.lab_id,
          category: t?.category ?? '',
          difficulty: t?.difficulty ?? 'Beginner',
          status: t?.status ?? 'unavailable',
          position: l.position,
          completed: progressMap.get(l.lab_id) === 'completed',
        };
      }),
    };
  });
}

export async function enrollPath(userId: string, pathId: string) {
  const exists = await one('SELECT id FROM learning_paths WHERE id = $1', [pathId]);
  if (!exists) throw notFound('Learning path not found');
  await query('INSERT INTO path_enrollments (user_id, path_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, pathId]);
  await query('INSERT INTO audit_log (actor_id, action, target_type, target_id) VALUES ($1,$2,$3,$4)', [userId, 'path.enroll', 'learning_path', pathId]);
}

export async function categoryProgress(userId: string) {
  return all<{ category: string; total: string; completed: string }>(
    `SELECT t.template->>'category' AS category, count(*)::text AS total,
       count(*) FILTER (WHERE p.status = 'completed')::text AS completed
     FROM lab_templates t LEFT JOIN lab_progress p ON p.lab_id = t.lab_id AND p.user_id = $1
     GROUP BY 1 ORDER BY 1`,
    [userId],
  );
}

export async function transactionGuard<T>(fn: () => Promise<T>): Promise<T> {
  return transaction(async () => fn());
}
