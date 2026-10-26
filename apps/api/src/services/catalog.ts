import type { LabDetail, LabSummary, LabTemplate, PublicObjective } from '@cipherforge/shared';
import { all, one } from '../db/index.js';
import { notFound } from '../lib/errors.js';

const TERMINAL_PROGRESS_QUERY = `
  SELECT lab_id, status, score, objectives_completed, walkthrough_used, last_activity_at
  FROM lab_progress WHERE user_id = $1`;

interface DbTemplate {
  lab_id: string;
  version: string;
  checksum: string;
  status: 'published' | 'coming_soon' | 'unavailable';
  enabled: boolean;
  template: LabTemplate;
}

export async function getTemplateRow(labId: string): Promise<DbTemplate | null> {
  return one<DbTemplate>('SELECT lab_id, version, checksum, status, enabled, template FROM lab_templates WHERE lab_id = $1', [labId]);
}

function effectiveStatus(row: DbTemplate): 'published' | 'coming_soon' | 'unavailable' {
  if (!row.enabled) return 'unavailable';
  return row.status;
}

export async function listLabs(userId?: string): Promise<LabSummary[]> {
  const rows = await all<DbTemplate>('SELECT lab_id, version, checksum, status, enabled, template FROM lab_templates ORDER BY lab_id');
  const progress = userId ? await all<{ lab_id: string; status: string; score: number; objectives_completed: number; last_activity_at: string }>(TERMINAL_PROGRESS_QUERY, [userId]) : [];
  const byLab = new Map(progress.map((p) => [p.lab_id, p]));
  return rows
    .map((row) => {
      const t = row.template;
      const p = byLab.get(row.lab_id);
      const status = effectiveStatus(row);
      return {
        id: t.id,
        version: row.version,
        status,
        title: t.title,
        subtitle: t.subtitle,
        category: t.category,
        difficulty: t.difficulty,
        estimatedMinutes: t.estimatedMinutes,
        skills: t.skills,
        summary: t.summary,
        baseXp: t.baseXp,
        availabilityNote: status === 'published' ? undefined : t.availabilityNote ?? (row.enabled ? undefined : 'Temporarily disabled by an administrator'),
        objectivesCount: t.objectives.length,
        runnable: status === 'published',
        progress: p
          ? {
              status: p.objectives_completed >= t.objectives.length ? 'completed' : 'in_progress',
              objectivesCompleted: p.objectives_completed,
              score: p.score,
              lastActivityAt: new Date(p.last_activity_at).toISOString(),
            }
          : { status: 'not_started', objectivesCompleted: 0, score: 0 },
      } satisfies LabSummary;
    })
    .sort((a, b) => (a.runnable === b.runnable ? a.baseXp - b.baseXp : a.runnable ? -1 : 1));
}

export async function getLabDetail(labId: string, userId?: string): Promise<LabDetail> {
  const row = await getTemplateRow(labId);
  if (!row) throw notFound('Lab not found');
  const t = row.template;
  const status = effectiveStatus(row);
  let progress: LabDetail['progress'];
  let completed = new Set<string>();
  const hints = new Map<string, string[]>();
  let walkthroughUsed = false;

  if (userId) {
    const p = await one<{ status: string; score: number; objectives_completed: number; walkthrough_used: boolean; last_activity_at: string }>(
      'SELECT status, score, objectives_completed, walkthrough_used, last_activity_at FROM lab_progress WHERE user_id = $1 AND lab_id = $2',
      [userId, labId],
    );
    if (p) {
      progress = {
        status: p.objectives_completed >= t.objectives.length ? 'completed' : 'in_progress',
        objectivesCompleted: p.objectives_completed,
        score: p.score,
        lastActivityAt: new Date(p.last_activity_at).toISOString(),
      };
      walkthroughUsed = p.walkthrough_used;
    } else progress = { status: 'not_started', objectivesCompleted: 0, score: 0 };
    const rows = await all<{ objective_id: string }>('SELECT objective_id FROM objective_completions WHERE user_id = $1 AND lab_id = $2', [userId, labId]);
    completed = new Set(rows.map((r) => r.objective_id));
    const hintRows = await all<{ objective_id: string; hint_id: string }>('SELECT objective_id, hint_id FROM hint_events WHERE user_id = $1 AND lab_id = $2 ORDER BY id', [
      userId,
      labId,
    ]);
    for (const h of hintRows) {
      const list = hints.get(h.objective_id) ?? [];
      list.push(h.hint_id);
      hints.set(h.objective_id, list);
    }
  } else {
    progress = { status: 'not_started', objectivesCompleted: 0, score: 0 };
  }

  const objectives: PublicObjective[] = t.objectives.map((o) => ({
    id: o.id,
    title: o.title,
    description: o.description,
    evidencePrompt: o.evidencePrompt,
    xp: o.validation.xp,
    kind: o.validation.objectiveKind,
    criteria: o.validation.type === 'check' ? o.validation.criteria : undefined,
    hintCount: o.hints.length,
    completed: completed.has(o.id),
    hintsRevealed: (hints.get(o.id) ?? []).map((hintId) => {
      const idx = o.hints.findIndex((h) => h.id === hintId);
      return o.hints[idx]?.text ?? '';
    }).filter(Boolean),
    hints: o.hints.map((h) => ({
      id: h.id,
      xpPenalty: h.xpPenalty,
      revealed: (hints.get(o.id) ?? []).includes(h.id),
      text: (hints.get(o.id) ?? []).includes(h.id) ? h.text : undefined,
    })),
  }));

  return {
    id: t.id,
    version: row.version,
    status,
    title: t.title,
    subtitle: t.subtitle,
    category: t.category,
    difficulty: t.difficulty,
    estimatedMinutes: t.estimatedMinutes,
    skills: t.skills,
    summary: t.summary,
    baseXp: t.baseXp,
    availabilityNote: status === 'published' ? undefined : t.availabilityNote ?? (row.enabled ? undefined : 'Temporarily disabled by an administrator'),
    objectivesCount: t.objectives.length,
    runnable: status === 'published',
    progress,
    scenario: t.scenario,
    prerequisites: t.prerequisites,
    learningObjectives: t.learningObjectives,
    authorizedScope: t.authorizedScope,
    riskSummary: t.riskSummary,
    remediation: t.remediation,
    conclusion: t.conclusion,
    workspace: { tools: t.workspace.tools, image: t.workspace.image },
    objectives,
    walkthroughLocked: false,
    walkthroughSteps: t.walkthrough.length,
    maxMinutes: t.resources.maxMinutes,
    resources: { cpus: t.resources.cpus, memoryMb: t.resources.memoryMb, writableDiskMb: t.resources.writableDiskMb },
  };
}

export async function categoriesSummary(userId?: string) {
  const labs = await listLabs(userId);
  const map = new Map<string, { category: string; total: number; runnable: number; completed: number }>();
  for (const lab of labs) {
    const entry = map.get(lab.category) ?? { category: lab.category, total: 0, runnable: 0, completed: 0 };
    entry.total += 1;
    if (lab.runnable) entry.runnable += 1;
    if (lab.progress?.status === 'completed') entry.completed += 1;
    map.set(lab.category, entry);
  }
  return [...map.values()].sort((a, b) => b.completed - a.completed || a.category.localeCompare(b.category));
}
