# Verification

Checked locally on 5 October 2026:

- `pnpm run typecheck`: passed, including source and test files.
- `pnpm test`: 97 tests passed across seven files in the Cloudflare Workers runtime with SQLite Durable Objects.
- `pnpm run dry-run`: passed, with Guard and Destination bindings recognized.
- Privacy scan: example configuration and shipped source use generic project names and placeholder credentials. The license attribution is intentionally preserved.
- `LICENSE`: unchanged.

The tests cover all four authentication types, timestamp skew and tampering, supported and ignored provider events, embed limits, endpoint responses, routing deduplication, rate and nonce windows, batch size and text limits, queue overflow, retries, missing destination secrets, and private runtime configuration with fail-closed handling, plus exact branch filters and target-branch routing for merge/pull requests. Outbound Discord HTTP is mocked; these tests do not prove real delivery or visual rendering.

The compatibility date is `2026-08-15`, supported by the runtime bundled with the installed Cloudflare test pool. Runtime dependencies: none.

## Remaining live checks

A provider sample push was delivered to Discord, as shown in supplied delivery details and a destination screenshot. Real branch-filtered delivery, other source protocols, and live batching remain unverified. CI has been configured but has not yet run on GitHub.

1. Create a temporary Discord channel webhook and fill in `.dev.vars` using `.dev.vars.example`.
2. Run `pnpm run dev` and then `pnpm run smoke`. Expect HTTP 202 for all eight events.
3. Confirm the HMAC, GitLab, and GitHub sample embeds render. Confirm the last five events appear together in one message.
4. Configure real repository webhooks against a reachable Worker URL. Verify provider test deliveries and record event type, HTTP status, resulting Discord message link, and batch count here. Never record tokens or webhook URLs.
