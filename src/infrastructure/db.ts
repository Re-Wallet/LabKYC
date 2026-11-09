import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL no definida");
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

export async function query(sql: string, params?: any[]) {
  const p = getPool();
  const res = await p.query(sql, params);
  return res.rows;
}

export async function queryOne(sql: string, params?: any[]) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

export async function transaction<T>(fn: (conn: any) => Promise<T>): Promise<T> {
  const p = getPool();
  const conn = await p.connect();
  try {
    await conn.query("BEGIN");
    const result = await fn(conn);
    await conn.query("COMMIT");
    return result;
  } catch (e) {
    await conn.query("ROLLBACK");
    throw e;
  } finally {
    conn.release();
  }
}

export async function closePool() {
  if (pool) await pool.end();
  pool = null;
}
