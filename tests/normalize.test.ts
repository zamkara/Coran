import { expect, it } from 'vitest';
import { parseGeneric, parseGithub, parseGitlab, toEmbed } from '../src/normalize';
const gitlab = { project: { path_with_namespace: 'group/project', web_url: 'https://example.com/project' } };
const github = { repository: { full_name: 'owner/repo' } };
it.each([
  ['push', { ref: 'refs/heads/main', commits: [{ id: 'abc123456789', url: 'https://example.com/commit', message: 'fix\nmore' }], user_name: 'Example' }, 'info'],
  ['merge_request', { object_attributes: { action: 'merge', iid: 1, title: 'Fix', source_branch: 'fix', target_branch: 'main' } }, 'success'],
  ['pipeline', { object_attributes: { status: 'running', id: 1, ref: 'main' } }, 'start'],
  ['pipeline', { object_attributes: { status: 'failed', id: 1 } }, 'failed'],
])('parses GitLab %s', (kind, payload, status) => {
  expect(parseGitlab({ ...gitlab, object_kind: kind, ...payload })).toMatchObject({ project: 'group/project', status });
});
it.each([
  ['push', { ref: 'refs/heads/main', commits: [{ id: 'abc123456789', url: 'https://example.com/commit', message: 'fix' }] }, 'info'],
  ['pull_request', { action: 'closed', pull_request: { merged: true, number: 1, title: 'Fix', head: { ref: 'fix' }, base: { ref: 'main' } } }, 'success'],
  ['workflow_run', { action: 'requested', workflow_run: { name: 'CI' } }, 'start'],
  ['workflow_run', { action: 'completed', workflow_run: { name: 'CI', conclusion: 'failure' } }, 'failed'],
  ['release', { action: 'published', release: { tag_name: 'v1', name: 'First release' } }, 'success'],
])('parses GitHub %s', (kind, payload, status) => {
  expect(parseGithub(kind, { ...github, ...payload })).toMatchObject({ project: 'owner/repo', status });
});
it('ignores unsupported events and actions', () => {
  expect(parseGitlab({ ...gitlab, object_kind: 'issue' })).toBeNull();
  expect(parseGitlab({ ...gitlab, object_kind: 'pipeline', object_attributes: { status: 'pending' } })).toBeNull();
  expect(parseGitlab({ ...gitlab, object_kind: 'merge_request', object_attributes: { action: 'update' } })).toBeNull();
  expect(parseGithub('ping', github)).toBeNull();
  expect(parseGithub('pull_request', { ...github, action: 'edited' })).toBeNull();
  expect(parseGithub('workflow_run', { ...github, action: 'in_progress' })).toBeNull();
  expect(parseGithub('release', { ...github, action: 'created' })).toBeNull();
  expect(parseGeneric({ title: 'missing project' })).toBeNull();
});
it('clips all embed properties and total characters', () => {
  const long = 'x'.repeat(10000);
  const embed = toEmbed(long, { project: long, title: long, description: long, status: 'info', fields: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [i + long, long])) });
  expect(embed.title.length).toBeLessThanOrEqual(256);
  expect(embed.description!.length).toBeLessThanOrEqual(4096);
  expect(embed.fields!.length).toBeLessThanOrEqual(25);
  for (const field of embed.fields!) {
    expect(field.name.length).toBeLessThanOrEqual(256);
    expect(field.value.length).toBeLessThanOrEqual(1024);
  }
  const size = embed.title.length + embed.description!.length + embed.footer!.text.length + embed.fields!.reduce((n, f) => n + f.name.length + f.value.length, 0);
  expect(size).toBeLessThanOrEqual(5500);
});
it('clips generic fields and rejects non-http links', () => {
  const event = parseGeneric({ project: 'example', title: 'x'.repeat(1000), url: 'javascript:alert(1)', fields: { duration: 'x'.repeat(2000) } })!;
  expect(event.title.length).toBe(256);
  expect(event.fields.duration.length).toBe(1024);
  expect(event.url).toBeUndefined();
  expect(event.status).toBe('info');
});
it('retains at most 25 fields when the character budget allows them', () => {
  const embed = toEmbed('example', { project: 'example', title: 'hello', status: 'info', fields: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field ${i}`, 'value'])) });
  expect(embed.fields).toHaveLength(25);
});
it('clips long field names and values even with short descriptions', () => {
  const embed = toEmbed('example', { project: 'example', title: 'hello', status: 'info', fields: { ['n'.repeat(400)]: 'v'.repeat(2000) } });
  expect(embed.fields![0].name.length).toBe(256);
  expect(embed.fields![0].value.length).toBe(1024);
});
