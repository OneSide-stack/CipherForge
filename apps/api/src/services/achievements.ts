import { all, one, query } from '../db/index.js';
import { rankForXp } from '@cipherforge/shared';
import { log } from '../lib/logger.js';

export interface EarnedAchievement {
  slug: string;
  name: string;
  description: string;
  icon: string;
  tier: string;
  xp: number;
  earnedAt?: string;
}

interface AchievementRow {
  slug: string;
  name: string;
  description: string;
  icon: string;
  tier: string;
  xp: number;
  criteria: Record<string, unknown>;
  earned_at?: string;
}

export async function listAchievements(userId?: string): Promise<EarnedAchievement[]> {
  const rows = await all<AchievementRow>(
    `SELECT a.slug, a.name, a.description, a.icon, a.tier, a.xp, a.criteria, ua.earned_at
     FROM achievements a LEFT JOIN user_achievements ua ON ua.slug = a.slug AND ua.user_id = $1
     ORDER BY ua.earned_at NULLS LAST, a.xp DESC`,
    [userId ?? null],
  );
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    description: r.description,
    icon: r.icon,
    tier: r.tier,
    xp: r.xp,
    earnedAt: r.earned_at ? new Date(r.earned_at).toISOString() : undefined,
  }));
}

async function userStats(userId: string) {
  const stats = await one<{
    objectives: string;
    labs: string;
    categories: string;
    flags: string;
    streak: number;
    xp: number;
    hints: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM objective_completions WHERE user_id = $1) AS objectives,
       (SELECT count(*)::text FROM lab_progress WHERE user_id = $1 AND status = 'completed') AS labs,
       (SELECT count(DISTINCT t.template->>'category')::text FROM lab_progress p JOIN lab_templates t ON t.lab_id = p.lab_id WHERE p.user_id = $1 AND p.status = 'completed') AS categories,
       (SELECT count(*)::text FROM flag_attempts WHERE user_id = $1 AND accepted) AS flags,
       (SELECT streak_count FROM users WHERE id = $1) AS streak,
       (SELECT xp FROM users WHERE id = $1) AS xp,
       (SELECT count(*)::text FROM hint_events WHERE user_id = $1) AS hints`,
    [userId],
  );
  return {
    objectives: Number(stats?.objectives ?? 0),
    labs: Number(stats?.labs ?? 0),
    categories: Number(stats?.categories ?? 0),
    flags: Number(stats?.flags ?? 0),
    streak: Number(stats?.streak ?? 0),
    xp: Number(stats?.xp ?? 0),
    hints: Number(stats?.hints ?? 0),
  };
}

/** Server-side achievement evaluation; never trusts client claims. */
export async function evaluateAchievements(userId: string): Promise<EarnedAchievement[]> {
  const [defs, stats, categoryRows, fullLabs, noHintLabs] = await Promise.all([
    all<AchievementRow>('SELECT slug, name, description, icon, tier, xp, criteria FROM achievements'),
    userStats(userId),
    all<{ category: string; count: string }>(
      `SELECT t.template->>'category' AS category, count(*)::text AS count FROM lab_progress p JOIN lab_templates t ON t.lab_id = p.lab_id
       WHERE p.user_id = $1 AND p.status = 'completed' GROUP BY 1`,
      [userId],
    ),
    all<{ lab_id: string }>(
      `SELECT p.lab_id FROM lab_progress p JOIN lab_templates t ON t.lab_id = p.lab_id
       WHERE p.user_id = $1 AND p.status = 'completed'
       AND p.objectives_completed >= jsonb_array_length(t.template->'objectives')`,
      [userId],
    ),
    all<{ lab_id: string }>(
      `SELECT p.lab_id FROM lab_progress p WHERE p.user_id = $1 AND p.status = 'completed' AND p.hints_used = 0`,
      [userId],
    ),
  ]);
  const categoryCounts = new Map(categoryRows.map((r) => [r.category, Number(r.count)]));
  const earned = await all<{ slug: string }>('SELECT slug FROM user_achievements WHERE user_id = $1', [userId]);
  const earnedSet = new Set(earned.map((e) => e.slug));
  const newly: EarnedAchievement[] = [];
  const rank = rankForXp(stats.xp);

  for (const def of defs) {
    if (earnedSet.has(def.slug)) continue;
    const c = def.criteria ?? {};
    let qualifies = false;
    switch (c.type) {
      case 'objectives':
        qualifies = stats.objectives >= Number(c.target ?? 1);
        break;
      case 'labs':
        qualifies = stats.labs >= Number(c.target ?? 1);
        break;
      case 'categories':
        qualifies = stats.categories >= Number(c.target ?? 1);
        break;
      case 'category_labs':
        qualifies = (categoryCounts.get(String(c.category)) ?? 0) >= Number(c.target ?? 1);
        break;
      case 'flags':
        qualifies = stats.flags >= Number(c.target ?? 1);
        break;
      case 'streak':
        qualifies = stats.streak >= Number(c.target ?? 1);
        break;
      case 'rank':
        qualifies = stats.xp >= Number(c.target ?? 0) || rank.name === 'Analyst' || rank.minXp >= Number(c.target ?? 0);
        break;
      case 'no_hint_lab':
        qualifies = noHintLabs.length > 0;
        break;
      case 'full_lab':
        qualifies = fullLabs.length > 0;
        break;
      default:
        qualifies = false;
    }
    if (!qualifies) continue;
    const inserted = await one<{ slug: string }>('INSERT INTO user_achievements (user_id, slug) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING slug', [userId, def.slug]);
    if (!inserted) continue;
    if (def.xp > 0) await query('UPDATE users SET xp = xp + $1 WHERE id = $2', [def.xp, userId]);
    newly.push({ slug: def.slug, name: def.name, description: def.description, icon: def.icon, tier: def.tier, xp: def.xp, earnedAt: new Date().toISOString() });
    log.info('achievement earned', { userId, slug: def.slug });
  }
  return newly;
}
