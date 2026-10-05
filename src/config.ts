import raw from "../relay.config.json";
import type { Config } from "./types";

const ID = /^[a-z0-9_-]+$/;
const ENV = /^[A-Z][A-Z0-9_]*$/;
const TYPES = ["gitlab", "github", "hmac", "bearer"];
const STATUSES = ["start", "success", "failed", "info"];

function fail(msg: string): never {
  throw new Error(`relay.config.json: ${msg}`);
}

export function validateConfig(input: unknown): Config {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("config must be an object");
  const config = input as Config;
  if (!config.sources || typeof config.sources !== "object" || Array.isArray(config.sources)) fail("sources must be an object");
  if (!config.destinations || typeof config.destinations !== "object" || Array.isArray(config.destinations)) fail("destinations must be an object");
  if (!Array.isArray(config.routes)) fail("routes must be an array");

  for (const [id, s] of Object.entries(config.sources ?? {})) {
    if (!s || typeof s !== "object") fail(`source "${id}" must be an object`);
    if (!ID.test(id)) fail(`invalid source id "${id}"`);
    if (!TYPES.includes(s.type)) fail(`source "${id}" has unknown type "${s.type}"`);
    if (!ENV.test(s.secret ?? "")) fail(`source "${id}" needs a secret name like SRC_NAME`);
    if (!Array.isArray(s.allow) || s.allow.length === 0 || s.allow.some((v) => typeof v !== "string" || !v)) fail(`source "${id}" needs a non-empty allow list`);
    if (s.ratePerMin !== undefined && (!Number.isInteger(s.ratePerMin) || s.ratePerMin < 1)) fail(`source "${id}" ratePerMin must be a positive integer`);
  }

  for (const [alias, d] of Object.entries(config.destinations ?? {})) {
    if (!d || typeof d !== "object") fail(`destination "${alias}" must be an object`);
    if (!ID.test(alias)) fail(`invalid destination alias "${alias}"`);
    if (!ENV.test(d.secret ?? "")) fail(`destination "${alias}" needs a secret name like DEST_NAME`);
  }

  for (const [i, r] of (config.routes ?? []).entries()) {
    if (!r || typeof r !== "object") fail(`route ${i} must be an object`);
    if (r.status !== undefined && !Array.isArray(r.status)) fail(`route ${i} status must be an array`);
    if (r.project !== undefined && typeof r.project !== "string") fail(`route ${i} project must be a string`);
    if (!Object.hasOwn(config.sources, r.source)) fail(`route ${i} references unknown source "${r.source}"`);
    if (!Array.isArray(r.to) || r.to.length === 0) fail(`route ${i} has no destinations`);
    for (const a of r.to) if (!Object.hasOwn(config.destinations, a)) fail(`route ${i} references unknown destination "${a}"`);
    for (const s of r.status ?? []) if (!STATUSES.includes(s)) fail(`route ${i} has unknown status "${s}"`);
  }
  return config;
}

export default validateConfig(raw);
