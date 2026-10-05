import { env } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import type { Destination } from '../src/destination';
import type { Embed, Env } from '../src/types';
const bindings = env as Env;
const embed = (title = 'hello'): Embed => ({ title, color: 1 });
const stub = () => bindings.DESTINATION.get(bindings.DESTINATION.newUniqueId());
const queue = (s: ReturnType<typeof stub>) => runInDurableObject(s, (_: Destination, state) => state.storage.sql.exec('SELECT body FROM q ORDER BY id').toArray().map(row => JSON.parse(row.body as string)));
const alarm = (s: ReturnType<typeof stub>) => runInDurableObject(s, (_: Destination, state) => state.storage.getAlarm());
afterEach(() => vi.restoreAllMocks());
it('batches 5 events in one message with mentions disabled', async () => {
  const s = stub();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  for (let i = 0; i < 5; i++) await s.push('deploys', embed(String(i)));
  await runDurableObjectAlarm(s);
  expect(fetch).toHaveBeenCalledTimes(1);
  const message = JSON.parse(fetch.mock.calls[0][1]!.body as string);
  expect(message.embeds).toHaveLength(5);
  expect(message.allowed_mentions).toEqual({ parse: [] });
  expect(await queue(s)).toHaveLength(0);
});
it('limits batches to 10 embeds and keeps the rest ordered', async () => {
  const s = stub();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  for (let i = 0; i < 12; i++) await s.push('deploys', embed(String(i)));
  await runDurableObjectAlarm(s);
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).embeds).toHaveLength(10);
  expect(await queue(s)).toEqual([embed('10'), embed('11')]);
  expect(await alarm(s)).not.toBeNull();
});
it('caps combined text at 5500 characters', async () => {
  const s = stub();
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
  await s.push('deploys', embed('x'.repeat(3000)));
  await s.push('deploys', embed('y'.repeat(3000)));
  await runDurableObjectAlarm(s);
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).embeds).toHaveLength(1);
  expect(await queue(s)).toHaveLength(1);
});
it('keeps only the newest 200 queued embeds', async () => {
  const s = stub();
  for (let i = 0; i < 201; i++) await s.push('deploys', embed(String(i)));
  const rows = await queue(s);
  expect(rows).toHaveLength(200);
  expect(rows[0].title).toBe('1');
});
it.each([429, 500, 503, 'network'] as const)('retains messages and schedules retry on %s', async status => {
  const s = stub();
  const fetch = vi.spyOn(globalThis, 'fetch');
  if (status === 'network') fetch.mockRejectedValue(new Error('network'));
  else fetch.mockResolvedValue(new Response(status === 429 ? '{"retry_after":2.5}' : null, { status }));
  await s.push('deploys', embed());
  const before = Date.now();
  await runDurableObjectAlarm(s);
  expect(await queue(s)).toHaveLength(1);
  const next = await alarm(s);
  expect(next).toBeGreaterThanOrEqual(before + (status === 429 ? 2600 : 5000));
});
it.each([400, 401, 403, 404])('drops rejected batch on %s', async status => {
  const s = stub();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status }));
  await s.push('deploys', embed());
  await runDurableObjectAlarm(s);
  expect(await queue(s)).toHaveLength(0);
});
it('clears queue when the destination secret is missing', async () => {
  const s = stub();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetch = vi.spyOn(globalThis, 'fetch');
  await s.push('alerts', embed());
  await runDurableObjectAlarm(s);
  expect(await queue(s)).toHaveLength(0);
  expect(fetch).not.toHaveBeenCalled();
});
