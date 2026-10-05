import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext, runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it } from 'vitest';
import { validateConfig } from '../src/config';
import { parseGeneric, parseGitlab, parseGithub } from '../src/normalize';
import worker from '../src/index';
import type { Env } from '../src/types';
const bindings = env as Env;
const project = { path_with_namespace: 'example/project' };
const repository = { full_name: 'example/project' };
afterEach(async () => { await reset(); });
it.each(['main', 'develop', 'feature/one'])('extracts branch %s using target branch for requests', branch => {
  expect(parseGitlab({ project, object_kind: 'push', ref: `refs/heads/${branch}`, commits: [] })!.branch).toBe(branch);
  expect(parseGitlab({ project, object_kind: 'merge_request', object_attributes: { action: 'merge', source_branch: 'feature/source', target_branch: branch } })!.branch).toBe(branch);
  expect(parseGitlab({ project, object_kind: 'pipeline', object_attributes: { status: 'success', ref: branch } })!.branch).toBe(branch);
  expect(parseGithub('push', { repository, ref: `refs/heads/${branch}`, commits: [] })!.branch).toBe(branch);
  expect(parseGithub('pull_request', { repository, action: 'closed', pull_request: { merged: true, head: { ref: 'feature/source' }, base: { ref: branch } } })!.branch).toBe(branch);
  expect(parseGithub('workflow_run', { repository, action: 'completed', workflow_run: { conclusion: 'success', head_branch: branch } })!.branch).toBe(branch);
  expect(parseGeneric({ project: 'example/project', title: 'event', branch })!.branch).toBe(branch);
});
it('does not treat tags or missing metadata as a branch', () => {
  expect(parseGithub('push', { repository, ref: 'refs/tags/main' })!.branch).toBeUndefined();
  expect(parseGithub('release', { repository, action: 'published', release: { tag_name: 'v1', target_commitish: 'main' } })!.branch).toBeUndefined();
  expect(parseGitlab({ project, object_kind: 'merge_request', object_attributes: { action: 'merge', source_branch: 'main' } })!.branch).toBeUndefined();
  expect(parseGeneric({ project: 'example/project', title: 'event', branch: 123 })!.branch).toBeUndefined();
});
const config = {
  sources: {
    'release-stream': { type: 'gitlab', secret: 'RELEASE_INGRESS', allow: ['example/project'], branches: ['main'] },
    'review-stream': { type: 'gitlab', secret: 'RELEASE_INGRESS', allow: ['example/project'], branches: ['develop'] },
  },
  destinations: { shared: { secret: 'RELEASE_EGRESS' } },
  routes: [{ source: 'release-stream', to: ['shared'] }, { source: 'review-stream', to: ['shared'] }],
};
async function send(source: string, payload: unknown, custom = config) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://example.com/hook/${source}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gitlab-token': 'test-secret' }, body: JSON.stringify(payload),
  }), { ...bindings, RELAY_CONFIG: JSON.stringify(custom) }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
it.each([
  ['push', 'main'], ['push', 'develop'],
  ['merge_request', 'main'], ['merge_request', 'develop'],
  ['pipeline', 'main'], ['pipeline', 'develop'],
])('%s on %s reaches exactly one stream in the shared destination', async (kind, branch) => {
  const payload = { project, object_kind: kind, ref: `refs/heads/${branch}`, commits: [], object_attributes: { action: 'merge', source_branch: branch === 'main' ? 'develop' : 'feature/new', target_branch: branch, status: 'success', ref: branch } };
  const production = await send('release-stream', payload);
  const staging = await send('review-stream', payload);
  expect(production.status).toBe(202);
  expect(staging.status).toBe(202);
  expect(await production.text()).toBe(branch === 'main' ? 'accepted' : 'ignored branch');
  expect(await staging.text()).toBe(branch === 'develop' ? 'accepted' : 'ignored branch');
  await runInDurableObject(bindings.DESTINATION.get(bindings.DESTINATION.idFromName('shared')), (_, state) => {
    const rows = state.storage.sql.exec('SELECT body FROM q').toArray();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].body as string).footer.text).toContain(branch === 'main' ? 'release-stream' : 'review-stream');
  });
});
it.each(['feature/one', 'Main', 'refs/tags/main', ''])('ignores unmatched or missing branch %s without enqueueing', async branch => {
  const response = await send('release-stream', { project, object_kind: 'push', ref: branch, commits: [] });
  expect(await response.text()).toBe('ignored branch');
  await runInDurableObject(bindings.DESTINATION.get(bindings.DESTINATION.idFromName('shared')), (_, state) => {
    expect(state.storage.sql.exec('SELECT body FROM q').toArray()).toHaveLength(0);
  });
});
it('preserves project allowlist before filtering branch', async () => {
  const response = await send('release-stream', { project: { path_with_namespace: 'example/other' }, object_kind: 'push', ref: 'refs/heads/develop' });
  expect(response.status).toBe(403);
});
it('supports several exact branches in one source', async () => {
  const custom = structuredClone(config);
  custom.sources['release-stream'].branches = ['main', 'develop'];
  expect(await (await send('release-stream', { project, object_kind: 'push', ref: 'refs/heads/develop' }, custom)).text()).toBe('accepted');
});
it.each([[], '', [''], ['   '], [null], [123]])('rejects malformed branches settings', branches => {
  const custom = { ...config, sources: { ...config.sources, 'release-stream': { ...config.sources['release-stream'], branches } } };
  expect(() => validateConfig(custom)).toThrow('branches');
});
