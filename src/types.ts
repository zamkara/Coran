export interface Env extends WorkerBindings {
  [name: string]: unknown;
}

export type Status = "start" | "success" | "failed" | "info";
export type SourceType = "gitlab" | "github" | "hmac" | "bearer";

export interface Source {
  type: SourceType;
  /** Name of the Worker secret holding the token or signing secret. */
  secret: string;
  /** Allowed repos ("group/repo") or project names. Use "*" to allow any. */
  allow: string[];
  ratePerMin?: number;
}

export interface Destination_ {
  /** Name of the Worker secret holding the Discord webhook URL. */
  secret: string;
}

export interface Route {
  source: string;
  project?: string;
  status?: Status[];
  to: string[];
}

export interface Config {
  sources: Record<string, Source>;
  destinations: Record<string, Destination_>;
  routes: Route[];
}

export interface Evt {
  project: string;
  status: Status;
  title: string;
  description?: string;
  url?: string;
  fields: Record<string, string>;
}

export interface Embed {
  title: string;
  description?: string;
  url?: string;
  color: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}
