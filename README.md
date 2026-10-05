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

Deploy the same repository or fork without editing source, configuration files, or identity labels. All deployment-specific configuration is supplied through Worker secrets. Requires Node.js 22 or newer, pnpm 10.33.0, and a Cloudflare account with Workers and SQLite Durable Objects enabled.

```bash
pnpm install --frozen-lockfile
pnpm exec wrangler login
pnpm run deploy
```

After the first deployment, open the Worker's **Settings > Variables and Secrets** in Cloudflare. Add these as type **Secret**, then deploy the secret changes:

| Name | Value |
| --- | --- |
| `RELEASE_INGRESS` | Random authentication value also configured on the sender |
| `RELEASE_EGRESS` | Discord channel webhook URL |
| `RELAY_CONFIG` | Complete JSON configuration, such as the example below |

The names below are examples. Choose your own source IDs, destination IDs, and credential names entirely in the environment. Neither prefixes nor suffixes are required. Secret names use uppercase letters, digits, and underscores and start with a letter; endpoint and destination IDs use lowercase letters, digits, hyphens, and underscores.

```json
{
  "sources": {
    "release-stream": {
      "type": "gitlab",
      "secret": "RELEASE_INGRESS",
      "allow": ["example/project"]
    }
  },
  "destinations": {
    "release-room": { "secret": "RELEASE_EGRESS" }
  },
  "routes": [
    { "source": "release-stream", "to": ["release-room"] }
  ]
}
```

Use your actual repository path in the environment allowlist. Point the sender to `https://<worker-domain>/hook/release-stream`, using the source ID from your config. Configure authentication for its protocol. In Discord, create a channel webhook under **Edit Channel > Integrations > Webhooks** and store its URL in the destination secret.

`RELAY_CONFIG` replaces the bundled example in both request handling and destination delivery. Invalid runtime config returns `503` for hook requests and retains queued deliveries for retry. It never falls back to the example when an override is invalid. Without the override, the generic bundled example is used; configure the override before connecting real senders.

Alternatively, store your JSON in `relay.config.local.json` (ignored by Git), validate it, and upload it with Wrangler:

```bash
pnpm run validate:config -- relay.config.local.json
pnpm exec wrangler secret put RELEASE_INGRESS
pnpm exec wrangler secret put RELEASE_EGRESS
pnpm exec wrangler secret put RELAY_CONFIG < relay.config.local.json
```

Changing repositories, servers, channel webhooks, or routes requires only secret updates, not a code change or a new commit. Never commit private configuration or credentials. The public `relay.config.json` remains a generic reference example; CI validates it, not your deployed secrets.

## Configuration schema

- `sources.<id>` defines a sender and its endpoint slug. `type` selects the protocol (`gitlab`, `github`, `hmac`, or `bearer`), `secret` names its authentication secret, and `allow` lists permitted repository paths or project names. Optional `ratePerMin` defaults to 60. Optional `branches` is a non-empty list of exact, case-sensitive branch names. Push and pipeline/workflow events match their branch; merge/pull requests match the target branch; generic events use the optional payload `branch`. With a branch filter, missing branch metadata and events without a reliable branch (including releases) are ignored with `202 ignored branch`. No branch filter means existing behavior is preserved.
- `destinations.<id>.secret` names the secret containing a Discord channel webhook URL. A server with multiple target channels has a destination per channel webhook.
- `routes` connects sources to destinations. All matching routes apply and destinations are deduplicated. Optional `project` and `status` narrow the match.

A source can reach multiple destinations on different Discord servers, and several sources can share a destination. Deployment notifiers can each have their own authenticated source. Protocol names select parsers; they do not prescribe identity labels.

For local development, copy `.dev.vars.example` to `.dev.vars`, optionally include your complete `RELAY_CONFIG` JSON, and run `pnpm run dev`. Local secret files are ignored by Git. `pnpm run dry-run` validates the bundled example and bundles without deploying.

For separate branch streams, add `"branches": ["main"]` to one source and `"branches": ["develop"]` to another in `RELAY_CONFIG`. Both can route to the same destination. Enable merge request delivery for both sender webhooks; the relay checks target branches independently of provider push filters. Test deliveries are filtered too, using their actual payload branch.

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
curl -X POST "https://<your-worker>.workers.dev/hook/deploy-runner" \
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
