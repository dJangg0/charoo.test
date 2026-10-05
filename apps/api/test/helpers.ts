import { PGlite } from "@electric-sql/pglite";
import type { Database } from "../src/database.js";
import type { Event } from "@charoo/contracts";
import type { Realtime } from "../src/realtime.js";
export class MemoryRealtime implements Realtime {
  values = new Map<string, { v: string; until: number }>();
  rates = new Map<string, number>();
  waiting = new Map<string, number>();
  events: Event[] = [];
  async set(k: string, v: string, t: number) {
    this.values.set(k, { v, until: Date.now() + t * 1000 });
  }
  async get(k: string) {
    const v = this.values.get(k);
    return v && v.until > Date.now() ? v.v : null;
  }
  async del(k: string) {
    this.values.delete(k);
  }
  async limit(k: string, max: number) {
    const n = (this.rates.get(k) || 0) + 1;
    this.rates.set(k, n);
    return n <= max;
  }
  async queue(id: string, score: number) {
    this.waiting.set(id, score);
  }
  async dequeue(id: string) {
    this.waiting.delete(id);
  }
  async candidates() {
    return [...this.waiting].sort((a, b) => a[1] - b[1]).map((v) => v[0]);
  }
  handlers: ((event: Event) => void)[] = [];
  async publish(e: Event) {
    this.events.push(e);
    this.handlers.forEach((fn) => fn(e));
  }
  subscribe(handler: (event: Event) => void) {
    this.handlers.push(handler);
  }
  async roomPresence() {}
  async roomCount() {
    return 0;
  }
}
export function testDatabase(pg: PGlite): Database {
  const wrap = (connection: any): Database => ({
    query: async (sql, params) => {
      const result = await connection.query(sql, params);
      return {
        rows: result.rows,
        rowCount: result.affectedRows ?? result.rows.length,
      };
    },
    transaction: async (fn) =>
      connection.transaction(async (tx: any) => fn(wrap(tx))),
  });
  return wrap(pg);
}
