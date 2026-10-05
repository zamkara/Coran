import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/** One instance per source: sliding-window rate limit and duplicate/replay detection. */
export class Guard extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS hits (ts INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS seen (nonce TEXT PRIMARY KEY, ts INTEGER NOT NULL)");
  }

  async check(nonce: string | null, limitPerMin: number): Promise<"ok" | "rate" | "duplicate"> {
    const now = Date.now();
    this.sql.exec("DELETE FROM hits WHERE ts < ?", now - 60_000);
    this.sql.exec("DELETE FROM seen WHERE ts < ?", now - 600_000);

    const count = this.sql.exec("SELECT COUNT(*) AS c FROM hits").toArray()[0].c as number;
    if (count >= limitPerMin) return "rate";

    if (nonce) {
      const dup = this.sql.exec("SELECT 1 FROM seen WHERE nonce = ?", nonce).toArray().length > 0;
      if (dup) return "duplicate";
      this.sql.exec("INSERT INTO seen (nonce, ts) VALUES (?, ?)", nonce, now);
    }
    this.sql.exec("INSERT INTO hits (ts) VALUES (?)", now);
    return "ok";
  }
}
