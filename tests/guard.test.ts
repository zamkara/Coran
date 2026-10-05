import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { Guard } from '../src/guard';
import type { Env } from '../src/types';
const bindings = env as Env;
it('rejects duplicates until the dedupe window rolls over', async () => {
  const stub = bindings.GUARD.get(bindings.GUARD.newUniqueId());
  expect(await stub.check('nonce', 60)).toBe('ok');
  expect(await stub.check('nonce', 60)).toBe('duplicate');
  await runInDurableObject(stub, (_instance: Guard, state) => {
    state.storage.sql.exec('UPDATE seen SET ts = ?', Date.now() - 600001);
  });
  expect(await stub.check('nonce', 60)).toBe('ok');
});
it('rolls over the rate window without consuming a rejected nonce', async () => {
  const stub = bindings.GUARD.get(bindings.GUARD.newUniqueId());
  expect(await stub.check('first', 1)).toBe('ok');
  expect(await stub.check('later', 1)).toBe('rate');
  await runInDurableObject(stub, (_instance: Guard, state) => {
    expect(state.storage.sql.exec('SELECT * FROM seen WHERE nonce = ?', 'later').toArray()).toHaveLength(0);
    state.storage.sql.exec('UPDATE hits SET ts = ?', Date.now() - 60001);
  });
  expect(await stub.check('later', 1)).toBe('ok');
});
