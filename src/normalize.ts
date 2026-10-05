import type { Embed, Evt, Status } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const COLORS: Record<Status, number> = { success: 0x2ecc71, failed: 0xe74c3c, start: 0xf1c40f, info: 0x3498db };
const STATUSES: Status[] = ["start", "success", "failed", "info"];

export function clip(v: unknown, n: number): string {
  const s = String(v ?? "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fields(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o).slice(0, 10)) {
    if (v !== undefined && v !== null && v !== "" && k) out[clip(k, 256)] = clip(v, 1024);
  }
  return out;
}

const branchName = (v: unknown): string | undefined => {
  if (typeof v !== "string" || !v) return undefined;
  if (v.startsWith("refs/") && !v.startsWith("refs/heads/")) return undefined;
  return v.replace(/^refs\/heads\//, "") || undefined;
};

const httpUrl = (u: unknown) => (typeof u === "string" && /^https?:\/\//.test(u) ? u : undefined);

function commitLines(commits: J[], sha: (c: J) => string, url: (c: J) => string, msg: (c: J) => string): string {
  const lines = commits.slice(0, 5).map((c) => `- [${sha(c).slice(0, 8)}](${url(c)}) ${clip(msg(c).split("\n")[0], 80)}`);
  if (commits.length > 5) lines.push(`+${commits.length - 5} more`);
  return lines.join("\n");
}

export function parseGeneric(p: J): Evt | null {
  if (!p || typeof p.project !== "string" || typeof p.title !== "string") return null;
  return {
    project: p.project,
    branch: branchName(p.branch),
    status: STATUSES.includes(p.status) ? p.status : "info",
    title: clip(p.title, 256),
    description: p.description ? clip(p.description, 2000) : undefined,
    url: httpUrl(p.url),
    fields: p.fields && typeof p.fields === "object" ? fields(p.fields) : {},
  };
}

export function parseGitlab(p: J): Evt | null {
  const project = p?.project?.path_with_namespace;
  if (typeof project !== "string") return null;
  const web = httpUrl(p.project.web_url);
  const a = p.object_attributes ?? {};
  switch (p.object_kind) {
    case "push": {
      const branch = String(p.ref ?? "").replace("refs/heads/", "");
      const commits: J[] = p.commits ?? [];
      return {
        project, branch: branchName(p.ref), status: "info", title: clip(`Push to ${branch}`, 256),
        description: commitLines(commits, (c) => String(c.id), (c) => c.url, (c) => String(c.message ?? "")),
        url: web && `${web}/-/commits/${encodeURIComponent(branch)}`,
        fields: fields({ Author: p.user_name, Branch: branch }),
      };
    }
    case "merge_request": {
      if (!["open", "merge", "close", "reopen"].includes(a.action)) return null;
      return {
        project, branch: branchName(a.target_branch), status: a.action === "merge" ? "success" : "info",
        title: clip(`MR !${a.iid} ${a.action}: ${a.title}`, 256),
        description: `${a.source_branch} -> ${a.target_branch}`,
        url: httpUrl(a.url), fields: fields({ Author: p.user?.name }),
      };
    }
    case "pipeline": {
      const map: Record<string, Status> = { running: "start", success: "success", failed: "failed" };
      const status = map[a.status];
      if (!status) return null;
      return {
        project, branch: branchName(a.ref), status, title: clip(`Pipeline #${a.id} ${a.status}`, 256),
        url: web && `${web}/-/pipelines/${a.id}`,
        fields: fields({ Branch: a.ref, Duration: a.duration ? `${a.duration}s` : undefined }),
      };
    }
    default:
      return null;
  }
}

export function parseGithub(event: string, p: J): Evt | null {
  const project = p?.repository?.full_name;
  if (typeof project !== "string") return null;
  switch (event) {
    case "push": {
      const branch = String(p.ref ?? "").replace("refs/heads/", "");
      return {
        project, branch: branchName(p.ref), status: "info", title: clip(`${p.deleted ? "Deleted" : "Push to"} ${branch}`, 256),
        description: commitLines(p.commits ?? [], (c) => String(c.id), (c) => c.url, (c) => String(c.message ?? "")),
        url: httpUrl(p.compare), fields: fields({ Author: p.pusher?.name, Branch: branch }),
      };
    }
    case "pull_request": {
      const pr = p.pull_request ?? {};
      if (!["opened", "closed", "reopened", "ready_for_review"].includes(p.action)) return null;
      const merged = p.action === "closed" && pr.merged;
      return {
        project, branch: branchName(pr.base?.ref), status: merged ? "success" : "info",
        title: clip(`PR #${pr.number} ${merged ? "merged" : p.action}: ${pr.title}`, 256),
        description: `${pr.head?.ref} -> ${pr.base?.ref}`,
        url: httpUrl(pr.html_url), fields: fields({ Author: pr.user?.login }),
      };
    }
    case "workflow_run": {
      const w = p.workflow_run ?? {};
      let status: Status;
      if (p.action === "requested") status = "start";
      else if (p.action === "completed") status = w.conclusion === "success" ? "success" : ["failure", "timed_out"].includes(w.conclusion) ? "failed" : "info";
      else return null;
      return {
        project, branch: branchName(w.head_branch), status, title: clip(`Workflow ${w.name} ${p.action === "completed" ? w.conclusion : "started"}`, 256),
        url: httpUrl(w.html_url), fields: fields({ Branch: w.head_branch, Actor: w.actor?.login }),
      };
    }
    case "release": {
      if (p.action !== "published") return null;
      return {
        project, status: "success", title: clip(`Release ${p.release?.tag_name}`, 256),
        description: p.release?.name ? clip(p.release.name, 200) : undefined,
        url: httpUrl(p.release?.html_url), fields: {},
      };
    }
    default:
      return null;
  }
}

export function toEmbed(sourceId: string, e: Evt): Embed {
  const title = clip(e.title, 256);
  const description = e.description ? clip(e.description, 4096) : undefined;
  // Keep a single embed within the destination's batching budget.
  const footer = { text: clip(`${sourceId} | ${e.project}`, Math.min(2048, 5500 - title.length - (description?.length ?? 0))) };
  let remaining = 5500 - title.length - (description?.length ?? 0) - footer.text.length;
  const fields: NonNullable<Embed["fields"]> = [];
  for (const [key, value] of Object.entries(e.fields).slice(0, 25)) {
    if (remaining < 2) break;
    const name = clip(key, Math.min(256, remaining - 1)) || " ";
    const text = clip(value, Math.min(1024, remaining - name.length)) || " ";
    fields.push({ name, value: text, inline: true });
    remaining -= name.length + text.length;
  }
  return { title, description, url: e.url, color: COLORS[e.status], fields, footer, timestamp: new Date().toISOString() };
}
