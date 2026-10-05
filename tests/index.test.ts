import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { hmacHex } from '../src/auth';
import type { Env } from '../src/types';
const bindings = env as Env;
afterEach(async () => { vi.restoreAllMocks(); await reset(); });
async function send(body = '{"project":"web-app-staging","title":"hello"}', path = '/hook/my-server', headers: Record<string, string> = {}, method = 'POST') {
  const ts = String(Math.floor(Date.now() / 1000));
  const req = new Request('https://example.com' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-timestamp': ts, 'x-signature': await hmacHex('test-secret', `${ts}.${body}`), ...headers },
    ...(method === 'POST' ? { body } : {}),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}
it.each([['/wrong', 'POST'], ['/hook/my-server/extra', 'POST'], ['/hook/my-server', 'GET']])('returns 404 for %s %s', async (path, method) => {
  expect((await send(undefined, path, {}, method)).status).toBe(404);
});
it('uses identical 401 responses for unknown sources, missing secrets and bad auth', async () => {
  const unknown = await send(undefined, '/hook/unknown');
  const bad = await send(undefined, undefined, { 'x-signature': 'wrong' });
  const ctx = createExecutionContext();
  const missing = await worker.fetch(new Request('https://example.com/hook/my-server', { method: 'POST' }), { ...bindings, SRC_MY_SERVER: undefined }, ctx);
  for (const response of [unknown, bad, missing]) {
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('unauthorized');
  }
});
it('returns 415 for unsupported content', async () => {
  expect((await send(undefined, undefined, { 'content-type': 'text/plain' })).status).toBe(415);
});
it('returns 413 with or without content-length, including UTF-8 bytes', async () => {
  expect((await send('x', undefined, { 'content-length': '65537' })).status).toBe(413);
  expect((await send('x'.repeat(65537))).status).toBe(413);
  expect((await send('é'.repeat(32769))).status).toBe(413);
});
it('returns 400 for signed malformed JSON', async () => {
  expect((await send('{')).status).toBe(400);
});
it('returns 403 for projects outside the allowlist', async () => {
  expect((await send('{"project":"other","title":"hello"}')).status).toBe(403);
});
it('returns 409 for replay', async () => {
  expect((await send()).status).toBe(202);
  expect((await send()).status).toBe(409);
});
it('returns 429 after the configured rate limit', async () => {
  for (let i = 0; i < 30; i++) expect((await send(JSON.stringify({ project: 'web-app-staging', title: `event ${i}` }))).status).toBe(202);
  expect((await send('{"project":"web-app-staging","title":"limited"}')).status).toBe(429);
});
it('returns 202 ignored for unsupported events', async () => {
  const res = await send('{}');
  expect(res.status).toBe(202);
  expect(await res.text()).toBe('ignored');
});
it('accepts and deduplicates destinations across matching routes', async () => {
  const deploys = bindings.DESTINATION.get(bindings.DESTINATION.idFromName('deploys'));
  const alerts = bindings.DESTINATION.get(bindings.DESTINATION.idFromName('alerts'));
  const res = await send('{"project":"web-app-staging","title":"failure","status":"failed"}');
  expect(res.status).toBe(202);
  expect(await res.text()).toBe('accepted');
  const { runInDurableObject } = await import('cloudflare:test');
  for (const stub of [deploys, alerts]) {
    await runInDurableObject(stub, (_, state) => {
      expect(state.storage.sql.exec('SELECT * FROM q').toArray()).toHaveLength(1);
    });
  }
});
it('processes signed GitHub and token-authenticated GitLab deliveries', async () => {
  const gl = JSON.stringify({ project: { path_with_namespace: 'group/project' }, object_kind: 'pipeline', object_attributes: { status: 'success', id: 1 } });
  expect((await send(gl, '/hook/my-gitlab', { 'x-gitlab-token': 'test-secret', 'idempotency-key': 'gitlab-test' })).status).toBe(202);
  const gh = JSON.stringify({ repository: { full_name: 'owner/repo' }, action: 'published', release: { tag_name: 'v1' } });
  expect((await send(gh, '/hook/my-github', { 'x-hub-signature-256': 'sha256=' + await hmacHex('test-secret', gh), 'x-github-event': 'release', 'x-github-delivery': 'github-test' })).status).toBe(202);
});
it('accepts bearer generic payloads and returns 202 when no route matches', async () => {
  const { default: config } = await import('../src/config');
  const source = 'test-bearer';
  config.sources[source] = { type: 'bearer', secret: 'SRC_MY_SERVER', allow: ['*'] };
  try {
    const res = await send('{"project":"example","title":"hello"}', '/hook/' + source, { authorization: 'Bearer test-secret' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('no route');
  } finally {
    delete config.sources[source];
  }
});
