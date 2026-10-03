import { Pool, PoolClient, types } from 'pg';
import fs from 'node:fs';
import path from 'node:path';

// NUMERIC → number (nilai Rupiah/kuantitas dalam rentang aman JS)
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8
types.setTypeParser(1082, (v) => v); // DATE → 'YYYY-MM-DD' apa adanya (tanpa geser zona waktu)

export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/supplier_id';

const SSL = /sslmode=require|PGSSL/.test(DATABASE_URL + (process.env.PGSSL ?? '')) ? { rejectUnauthorized: false } : undefined;
export const pool = new Pool({ connectionString: DATABASE_URL, max: 10, ssl: SSL });

export type Db = Pick<PoolClient, 'query'>;

export async function q<T = any>(db: Db, text: string, params: any[] = []): Promise<T[]> {
  const r = await db.query(text, params);
  return r.rows as T[];
}
export async function one<T = any>(db: Db, text: string, params: any[] = []): Promise<T> {
  const rows = await q<T>(db, text, params);
  if (!rows[0]) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
  return rows[0];
}
export async function maybe<T = any>(db: Db, text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(db, text, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Nomor urut manusiawi: SO-2026-000001 dsb. */
export async function nextNo(db: Db, name: string, prefix: string): Promise<string> {
  const r = await one<{ value: number }>(
    db,
    `INSERT INTO sequences(name, value) VALUES ($1, 1)
     ON CONFLICT (name) DO UPDATE SET value = sequences.value + 1 RETURNING value`,
    [name],
  );
  return `${prefix}-${new Date().getFullYear()}-${String(r.value).padStart(6, '0')}`;
}

export async function migrate(dbUrl = DATABASE_URL) {
  const p = new Pool({ connectionString: dbUrl, ssl: SSL });
  const c = await p.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
    const candidates = [process.env.MIGRATIONS_DIR, path.join(__dirname, '..', 'migrations'), path.join(process.cwd(), 'migrations'), path.join(process.cwd(), 'server', 'migrations')].filter(Boolean) as string[];
    const dir = candidates.find((d) => fs.existsSync(d));
    if (!dir) throw new Error('MIGRATIONS_DIR_NOT_FOUND: ' + candidates.join(', '));
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const done = await c.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
      if (done.rowCount) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await c.query('COMMIT');
        console.log('migrated', f);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    c.release();
    await p.end();
  }
}

export async function resetDatabase(dbUrl = DATABASE_URL) {
  const p = new Pool({ connectionString: dbUrl, ssl: SSL });
  await p.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await p.end();
}
