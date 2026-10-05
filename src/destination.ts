import { DurableObject } from "cloudflare:workers";
import config from "./config";
import type { Embed, Env } from "./types";

const MAX_QUEUE = 200;
const BATCH_MS = 2000;
const MAX_EMBEDS = 10;
const MAX_CHARS = 5500; // Discord caps the total at 6000 per message

function embedSize(e: Embed): number {
  return (
    e.title.length + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) +
    (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

/** One instance per destination: queues, batches, and delivers messages in order, honoring Discord rate limits. */
export class Destination extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS q (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
  }

  async push(alias: string, embed: Embed): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('alias', ?)", alias);
    this.sql.exec("INSERT INTO q (body) VALUES (?)", JSON.stringify(embed));
    this.sql.exec("DELETE FROM q WHERE id <= (SELECT MAX(id) FROM q) - ?", MAX_QUEUE);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + BATCH_MS);
  }

  async alarm(): Promise<void> {
    const rows = this.sql.exec("SELECT id, body FROM q ORDER BY id LIMIT ?", MAX_EMBEDS).toArray();
    if (rows.length === 0) return;

    const alias = this.sql.exec("SELECT v FROM meta WHERE k = 'alias'").toArray()[0]?.v as string | undefined;
    const hook = alias ? (this.env[config.destinations[alias]?.secret ?? ""] as string | undefined) : undefined;
    if (!hook) {
      console.error(`destination "${alias}" has no webhook secret set, dropping queue`);
      this.sql.exec("DELETE FROM q");
      return;
    }

    const embeds: Embed[] = [];
    const ids: number[] = [];
    let size = 0;
    for (const r of rows) {
      const e = JSON.parse(r.body as string) as Embed;
      const s = embedSize(e);
      if (embeds.length > 0 && size + s > MAX_CHARS) break;
      embeds.push(e);
      ids.push(r.id as number);
      size += s;
    }

    let res: Response;
    try {
      res = await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embeds, allowed_mentions: { parse: [] } }),
      });
    } catch {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }

    if (res.status === 429) {
      const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await this.ctx.storage.setAlarm(Date.now() + Math.ceil((j.retry_after ?? 5) * 1000) + 100);
      return;
    }
    if (res.status >= 500) {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }
    if (!res.ok) console.error(`discord rejected message for "${alias}" with status ${res.status}`);

    this.sql.exec(`DELETE FROM q WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
    if (this.sql.exec("SELECT 1 FROM q LIMIT 1").toArray().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
  }
}
