# Coran

A webhook relay for Discord on Cloudflare Workers. Receives webhooks from many sources (GitLab, GitHub, your own servers or scripts) and posts them to one or more Discord channels, across any number of Discord servers. One-way notifications only. No bot, no gateway, no always-on process.

## How it works

```
sources (many) -> Worker: authenticate, allowlist, normalize -> route -> Durable Object per destination -> Discord webhook
```

- Every source has its own secret. Unknown sources and bad credentials get the same `401`.
- Each source has an allowlist of repos or project names. Anything else gets `403`.
- Rate limiting and duplicate detection run per source in a Durable Object.
- Delivery runs per destination in a Durable Object: events are queued, batched (up to 10 per message), kept in order, and retried on Discord `429` and `5xx`.
- Mentions in payloads are disabled (`allowed_mentions.parse = []`).

## Setup

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm run typecheck
pnpm test
pnpm run dry-run
# Edit relay.config.json, then set every secret referenced by it:
pnpm exec wrangler secret put SRC_MY_GITLAB
pnpm exec wrangler secret put SRC_MY_GITHUB
pnpm exec wrangler secret put SRC_MY_SERVER
pnpm exec wrangler secret put DEST_DEPLOYS
pnpm exec wrangler secret put DEST_ALERTS
pnpm run deploy
```

Requires Node.js 22 or newer, pnpm 10.33.0, and a Cloudflare account with Workers and SQLite Durable Objects enabled. In Discord, create a webhook under the target channel's **Edit Channel > Integrations > Webhooks**, then store its URL in the destination secret. Use a different source secret for each sender. For GitHub, select JSON content type and the supported events. For GitLab, configure the secret token and supported events.

For local development, copy `.dev.vars.example` to `.dev.vars`, fill in the secrets, and run `pnpm run dev`. Never commit `.dev.vars`.

Point each sender at `https://<your-worker>.workers.dev/hook/<source-id>`.

## relay.config.json

It contains no secrets, only the names of the Worker secrets to read.

- `sources.<id>`: `type` is `gitlab`, `github`, `hmac`, or `bearer`; `secret` is the secret name; `allow` lists repos (`group/repo`, `owner/repo`) or project names, or `["*"]`; optional `ratePerMin` (default 60).
- `destinations.<alias>`: `secret` is the name of the secret holding a Discord webhook URL. Add channels on other servers the same way.
- `routes`: first match is not special, every matching route applies and destinations are de-duplicated. Match by `source`, optional `project`, optional `status` (`start`, `success`, `failed`, `info`), and send `to` one or more aliases.

`pnpm run deploy` and `pnpm run dry-run` validate config before Wrangler bundles it. Invalid config also fails Worker startup.

### Private deployment configuration

Keep the public `relay.config.json` generic. To override it for a deployment, add a Worker secret named `RELAY_CONFIG` containing a complete configuration JSON with the same schema. It replaces the bundled config in both the request handler and destination delivery. Source credentials and Discord webhook URLs still belong in separate secrets referenced by name.

Copy your private configuration into `relay.config.local.json` (ignored by Git), validate it locally, and upload it:

```bash
pnpm run validate:config -- relay.config.local.json
pnpm exec wrangler secret put RELAY_CONFIG < relay.config.local.json
```

Alternatively, paste the JSON into a `RELAY_CONFIG` secret in the Worker dashboard and deploy the secret change. Invalid runtime config returns `503` for hook requests and retains queued deliveries for retry. It never falls back to the public example. Removing the secret restores the bundled config. Validate runtime changes before uploading because CI only verifies the public config.

## Source types

| type | how it authenticates | notes |
| --- | --- | --- |
| `gitlab` | `X-Gitlab-Token` equals the secret | push, merge request, pipeline events |
| `github` | `X-Hub-Signature-256` HMAC of the body, JSON content type | push, pull_request, workflow_run, release events |
| `hmac` | `X-Signature` = hex HMAC-SHA256 of `"<timestamp>.<body>"`, with `X-Timestamp` (unix seconds, 5 minute window) | generic payload, replay protected |
| `bearer` | `Authorization: Bearer <secret>` | generic payload |

Generic payload (`hmac` and `bearer`):

```json
{"project":"web-app-staging","status":"success","title":"Deploy finished","description":"commit abc123","url":"https://example.com","fields":{"duration":"42s"}}
```

Only `project` and `title` are required. `status` defaults to `info`.

Signing example for `hmac`:

```bash
TS=$(date +%s)
BODY='{"project":"web-app-staging","status":"success","title":"Deploy finished"}'
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "https://<your-worker>.workers.dev/hook/my-server" \
  -H "content-type: application/json" -H "x-timestamp: $TS" -H "x-signature: $SIG" -d "$BODY"
```

## Notes

- Use a different secret per source so one leak can be revoked alone.
- GitLab and GitHub deliveries are de-duplicated by their delivery id for 10 minutes, so a manual redelivery inside that window returns `409`.
- Delivery waits about two seconds to collect a batch, with up to 10 embeds and 5500 text characters. A queue retains the latest 200 events; older events are dropped when full.
- Discord `429` respects `retry_after`. Network errors and `5xx` retry after five seconds; other rejected messages are dropped. A destination with no secret drops its queue.
- `202 accepted` means enqueueing is scheduled, not that Discord has delivered the message. Delivery is asynchronous and best effort.
- Payloads are limited to 64 KB. Requests without `content-length` are read before the byte limit is checked.
- Account quotas and Discord rate limits apply. Check the providers' current documentation for your plan.

## Verification

`pnpm test` runs in the Workers runtime with SQLite Durable Objects and mocked outbound HTTP. It covers authentication, normalization, routing, dedupe, rate windows, batching, queue limits, and retries. CI runs typecheck, tests, and a deploy dry-run.

For real delivery verification, run `pnpm run dev` with a temporary Discord webhook in `.dev.vars`, then `pnpm run smoke`. This sends a signed HMAC event, representative GitLab/GitHub payloads, and five quick events. Confirm the messages and the five-embed batch in Discord. These payloads simulate sender deliveries; also use each repository's webhook test/redelivery UI to verify the actual integration. Localhost needs a public development URL for remote sender tests.

## License and credit

Copyright (c) 2026 Almatera Incubator. Coran is distributed under the [Almatera Incubator License](LICENSE), a custom license. Commercial use, modification, and redistribution are permitted subject to its group attribution conditions. Preserve the license and traceable upstream credits when redistributing substantial portions. Names, logos, and endorsement rights are excluded. No OSI approval is claimed.
