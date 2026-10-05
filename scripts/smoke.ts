import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
// Secrets stay local. Only response status and event labels are printed.
const vars = Object.fromEntries((await readFile('.dev.vars', 'utf8')).split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const i = line.indexOf('=');
  return [line.slice(0, i), line.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, '$2')];
}));
const base = process.env.CORAN_SMOKE_URL ?? 'http://localhost:8787';
async function send(source: string, payload: unknown, headers: Record<string, string>) {
  const body = JSON.stringify(payload);
  if (source === 'deploy-runner') {
    const ts = String(Math.floor(Date.now() / 1000));
    headers['x-timestamp'] = ts;
    headers['x-signature'] = createHmac('sha256', vars.DEPLOY_INGRESS).update(`${ts}.${body}`).digest('hex');
  } else if (source === 'integration-stream') {
    headers['x-hub-signature-256'] = 'sha256=' + createHmac('sha256', vars.INTEGRATION_INGRESS).update(body).digest('hex');
  }
  const response = await fetch(`${base}/hook/${source}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  console.log(`${source}: ${response.status}`);
  if (response.status !== 202) throw new Error('Smoke event was not accepted');
}
for (const key of ['DEPLOY_INGRESS', 'INTEGRATION_INGRESS', 'RELEASE_INGRESS', 'RELEASE_EGRESS']) {
  if (!vars[key]) throw new Error(`Set ${key} in .dev.vars first`);
}
await send('deploy-runner', { project: 'web-app-staging', title: 'Coran HMAC smoke test', status: 'success' }, {});
await send('release-stream', { project: { path_with_namespace: 'group/project' }, object_kind: 'pipeline', object_attributes: { id: 1, status: 'success', ref: 'main' } }, { 'x-gitlab-token': vars.RELEASE_INGRESS, 'idempotency-key': randomUUID() });
await send('integration-stream', { repository: { full_name: 'owner/repo' }, action: 'published', release: { tag_name: 'smoke-test' } }, { 'x-github-event': 'release', 'x-github-delivery': randomUUID() });
await new Promise(resolve => setTimeout(resolve, 3000));
await Promise.all(Array.from({ length: 5 }, (_, i) => send('deploy-runner', { project: 'web-app-staging', title: `Coran batch smoke ${i + 1}`, description: randomUUID() }, {})));
console.log('Check Discord for source embeds and one message containing five batch embeds.');
