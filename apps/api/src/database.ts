import pg from "pg";
import { readFile } from "node:fs/promises";
import { defaultSettings } from "@charoo/contracts";
export interface Database {
  query(
    sql: string,
    params?: any[],
  ): Promise<{ rows: any[]; rowCount: number | null }>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
}
export function database(url: string): Database {
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  const wrap = (client: pg.Pool | pg.PoolClient): Database => ({
    query: async (sql, params) => client.query(sql, params),
    transaction: async (fn) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const result = await fn(wrap(c));
        await c.query("COMMIT");
        return result;
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    },
  });
  return wrap(pool);
}
export async function migrate(db: Database) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(901001)");
    if (
      !(await tx.query("SELECT 1 FROM schema_migrations WHERE version='001'"))
        .rows.length
    ) {
      const sql = await readFile(
        new URL("../../../packages/database/001_initial.sql", import.meta.url),
        "utf8",
      );
      for (const statement of sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations(version) VALUES('001')");
      await tx.query("INSERT INTO settings(value) VALUES($1)", [
        JSON.stringify(defaultSettings),
      ]);
    }
  });
}
