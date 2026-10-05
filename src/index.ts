import { configFor } from "./config";
import { authenticate } from "./auth";
import { parseGeneric, parseGithub, parseGitlab, toEmbed } from "./normalize";
import type { Config, Env, Evt, SourceType } from "./types";

export { Guard } from "./guard";
export { Destination } from "./destination";

const MAX_BODY = 64 * 1024;
const reply = (body: string, status: number) => new Response(body, { status });
// Same response for unknown source, missing secret, and bad credentials, so ids cannot be probed.
const deny = () => reply("unauthorized", 401);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(type: SourceType, req: Request, payload: any): Evt | null {
  try {
    if (type === "gitlab") return parseGitlab(payload);
    if (type === "github") return parseGithub(req.headers.get("x-github-event") ?? "", payload);
    return parseGeneric(payload);
  } catch {
    return null;
  }
}

function targets(config: Config, sourceId: string, e: Evt): string[] {
  const out = new Set<string>();
  for (const r of config.routes) {
    if (r.source !== sourceId) continue;
    if (r.project && r.project !== e.project) continue;
    if (r.status && !r.status.includes(e.status)) continue;
    r.to.forEach((a) => out.add(a));
  }
  return [...out];
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const m = new URL(req.url).pathname.match(/^\/hook\/([a-z0-9_-]+)$/);
    if (req.method !== "POST" || !m) return reply("not found", 404);

    let config: Config;
    try {
      config = configFor(env);
    } catch {
      console.error("relay configuration invalid");
      return reply("configuration unavailable", 503);
    }

    const id = m[1];
    const src = config.sources[id];
    const secret = src ? (env[src.secret] as string | undefined) : undefined;
    if (!src || !secret) return deny();

    if (!(req.headers.get("content-type") ?? "").includes("application/json")) return reply("unsupported media type", 415);
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return reply("payload too large", 413);
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY) return reply("payload too large", 413);

    const auth = await authenticate(src.type, req, raw, secret);
    if (!auth.ok) return deny();

    const verdict = await env.GUARD.get(env.GUARD.idFromName(id)).check(auth.nonce, src.ratePerMin ?? 60);
    if (verdict === "rate") return reply("rate limited", 429);
    if (verdict === "duplicate") return reply("duplicate", 409);

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return reply("bad json", 400);
    }

    const evt = parse(src.type, req, payload);
    if (!evt) return reply("ignored", 202);
    if (!src.allow.includes("*") && !src.allow.includes(evt.project)) return reply("forbidden", 403);

    if (src.branches && (!evt.branch || !src.branches.includes(evt.branch))) return reply("ignored branch", 202);

    const aliases = targets(config, id, evt);
    if (aliases.length === 0) return reply("no route", 202);

    const embed = toEmbed(id, evt);
    ctx.waitUntil(
      Promise.all(aliases.map((a) => env.DESTINATION.get(env.DESTINATION.idFromName(a)).push(a, embed))).catch(() =>
        console.error("enqueue failed"),
      ),
    );
    return reply("accepted", 202);
  },
};
