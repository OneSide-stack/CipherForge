import { loadRegistry } from '@cipherforge/shared';
import { all, one, query, pool } from './index.js';
import { config } from '../config.js';
import { hashPassword } from '../lib/crypto.js';

const ACHIEVEMENTS = [
  ['first-objective', 'First Blood', 'Complete your first lab objective.', 'target', 'bronze', 15, { type: 'objectives', target: 1 }],
  ['first-lab', 'Perimeter Breached', 'Complete an entire lab.', 'shield', 'bronze', 25, { type: 'labs', target: 1 }],
  ['five-labs', 'Forge Operator', 'Complete five different labs.', 'flame', 'silver', 75, { type: 'labs', target: 5 }],
  ['ten-objectives', 'Objective Hunter', 'Complete ten objectives across the catalog.', 'crosshair', 'silver', 50, { type: 'objectives', target: 10 }],
  ['three-categories', 'Versatile Analyst', 'Complete labs in three different categories.', 'layers', 'silver', 50, { type: 'categories', target: 3 }],
  ['web-trio', 'Web Warrior', 'Complete three Web Security labs.', 'globe', 'gold', 80, { type: 'category_labs', category: 'Web Security', target: 3 }],
  ['detection-trio', 'Signal Hunter', 'Complete three detection-focused labs.', 'radar', 'gold', 80, { type: 'category_labs', category: 'SOC Operations', target: 1 }],
  ['unassisted', 'Unassisted', 'Complete a lab without revealing any hints.', 'lock', 'silver', 60, { type: 'no_hint_lab' }],
  ['streak-3', 'Consistent Operator', 'Practise on three consecutive days.', 'calendar', 'bronze', 30, { type: 'streak', target: 3 }],
  ['analyst-rank', 'Analyst', 'Reach the Analyst rank.', 'badge', 'silver', 50, { type: 'rank', target: 750 }],
  ['flag-collector', 'Flag Collector', 'Submit ten verified flags.', 'flag', 'silver', 40, { type: 'flags', target: 10 }],
  ['full-sweep', 'Full Sweep', 'Complete every objective in a single lab.', 'check', 'bronze', 20, { type: 'full_lab' }],
] as const;

const PATHS = [
  {
    id: 'web-foundations',
    name: 'Web Application Defence',
    description: 'Audit and harden real browser-facing services: headers, authorization and API policy.',
    level: 'Beginner',
    icon: 'globe',
    hours: 2.5,
    sort: 1,
    labs: ['http-header-hunt', 'access-control-arcade', 'api-gatekeeper'],
  },
  {
    id: 'detection-ops',
    name: 'Detection & Network Forensics',
    description: 'Follow the evidence across packet captures, application logs and alert triage.',
    level: 'Intermediate',
    icon: 'radar',
    hours: 3.5,
    sort: 2,
    labs: ['packet-trail', 'logline-investigator', 'soc-alert-sprint'],
  },
  {
    id: 'cloud-secrets',
    name: 'Cloud & Secrets Security',
    description: 'Reduce exposure in object storage, source control and cloud configuration.',
    level: 'Intermediate',
    icon: 'cloud',
    hours: 2.5,
    sort: 3,
    labs: ['cloud-bucket-detective', 'secrets-in-source', 'container-security-audit'],
  },
  {
    id: 'secure-delivery',
    name: 'Secure Software Delivery',
    description: 'Find and fix vulnerabilities in source code, build configuration and repository history.',
    level: 'Intermediate',
    icon: 'code',
    hours: 3,
    sort: 4,
    labs: ['secrets-in-source', 'secure-coding-review', 'container-security-audit'],
  },
  {
    id: 'linux-hardening',
    name: 'Linux Host Hardening',
    description: 'Audit a live Linux workspace, correct file permissions and validate the hardened state.',
    level: 'Beginner',
    icon: 'terminal',
    hours: 1.5,
    sort: 5,
    labs: ['linux-hardening', 'secrets-in-source'],
  },
  {
    id: 'incident-response',
    name: 'Incident Response Practicum',
    description: 'Reconstruct incidents from real artifacts and validate your conclusions.',
    level: 'Advanced',
    icon: 'siren',
    hours: 4,
    sort: 6,
    labs: ['logline-investigator', 'soc-alert-sprint', 'forensics-artifact-recovery', 'phishing-triage'],
  },
];

export async function seed(): Promise<{ labs: number; paths: number; users: number; skipped: boolean }> {
  const registry = await loadRegistry(config.labsDir);
  let labs = 0;
  for (const entry of registry.list()) {
    const t = entry.template;
    await query(
      `INSERT INTO lab_templates (lab_id, version, checksum, status, template, published_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (lab_id) DO UPDATE SET
         version = EXCLUDED.version,
         checksum = EXCLUDED.checksum,
         status = EXCLUDED.status,
         template = EXCLUDED.template,
         published_at = COALESCE(lab_templates.published_at, EXCLUDED.published_at),
         updated_at = now()`,
      [t.id, t.version, entry.checksum, t.status, JSON.stringify(t), t.status === 'published' ? new Date() : null],
    );
    labs += 1;
  }

  for (const [slug, name, description, icon, tier, xp, criteria] of ACHIEVEMENTS) {
    await query(
      `INSERT INTO achievements (slug, name, description, icon, tier, xp, criteria) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, icon = EXCLUDED.icon,
         tier = EXCLUDED.tier, xp = EXCLUDED.xp, criteria = EXCLUDED.criteria`,
      [slug, name, description, icon, tier, xp, JSON.stringify(criteria)],
    );
  }

  for (const p of PATHS) {
    await query(
      `INSERT INTO learning_paths (id, name, description, level, icon, estimated_hours, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         level = EXCLUDED.level, icon = EXCLUDED.icon, estimated_hours = EXCLUDED.estimated_hours, sort_order = EXCLUDED.sort_order`,
      [p.id, p.name, p.description, p.level, p.icon, p.hours, p.sort],
    );
    await query('DELETE FROM path_labs WHERE path_id = $1', [p.id]);
    for (const [index, labId] of p.labs.entries()) {
      if (!registry.get(labId)) continue;
      await query('INSERT INTO path_labs (path_id, lab_id, position) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [p.id, labId, index + 1]);
    }
  }

  let users = 0;
  const seedUsers = [
    { email: config.seedAdminEmail, password: config.seedAdminPassword, username: 'forge-admin', role: 'admin' },
    { email: config.seedLearnerEmail, password: config.seedLearnerPassword, username: 'nova-learner', role: 'learner' },
  ].filter((u) => u.email && u.password);

  for (const u of seedUsers) {
    const existing = await one('SELECT id FROM users WHERE lower(email) = lower($1)', [u.email]);
    if (existing) continue;
    const { hash, salt } = hashPassword(u.password);
    await query(
      `INSERT INTO users (email, username, password_hash, password_salt, role)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING`,
      [u.email.toLowerCase(), u.username, hash, salt, u.role],
    );
    users += 1;
  }

  const labCount = await one<{ count: string }>('SELECT count(*)::text AS count FROM lab_templates');
  return { labs, paths: PATHS.length, users, skipped: !labCount || labCount.count === '0' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed()
    .then(async (result) => {
      console.log(`[seed] labs=${result.labs} paths=${result.paths} newUsers=${result.users}`);
      if (config.env !== 'production' && config.seedAdminEmail) {
        console.log(`[seed] development accounts: ${config.seedAdminEmail} (admin), ${config.seedLearnerEmail} (learner) — change these in production`);
      }
      await pool.end();
    })
    .catch(async (err) => {
      console.error('[seed] failed:', err.message);
      await pool.end();
      process.exit(1);
    });
}
