import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool, query, transaction } from './index.js';
import { config } from '../config.js';

const MIGRATIONS_DIR = path.join(config.repoRoot, 'apps/api/migrations');

export async function migrate(): Promise<{ applied: string[]; skipped: number }> {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum TEXT NOT NULL
  )`);
  const client = await pool.connect();
  const applied: string[] = [];
  let skipped = 0;
  try {
    await client.query('SELECT pg_advisory_lock(727271)');
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const existing = await client.query('SELECT filename FROM schema_migrations WHERE filename = $1', [file]);
      if (existing.rowCount) {
        skipped += 1;
        continue;
      }
      await transaction(async (tx) => {
        await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, String(sql.length)]);
      });
      applied.push(file);
      console.log(`[migrate] applied ${file}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727271)').catch(() => {});
    client.release();
  }
  return { applied, skipped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(async (result) => {
      console.log(`[migrate] done: ${result.applied.length} applied, ${result.skipped} already present`);
      await pool.end();
    })
    .catch(async (err) => {
      console.error('[migrate] failed:', err.message);
      await pool.end();
      process.exit(1);
    });
}
