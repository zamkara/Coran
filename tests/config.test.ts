import { expect, it } from 'vitest';
import { validateConfig } from '../src/config';
import example from '../relay.config.json';
it('accepts the generic example config', () => {
  expect(validateConfig(example)).toEqual(example);
});
it.each([null, [], {}, { sources: {}, destinations: {}, routes: {} }])('rejects invalid config shape', input => {
  expect(() => validateConfig(input)).toThrow('relay.config.json:');
});
it.each([
  (c: typeof example) => { c.sources['my-server'].ratePerMin = 0; },
  (c: typeof example) => { c.sources['my-server'].allow = []; },
  (c: typeof example) => { c.sources['my-server'].secret = 'https://example.com/secret'; },
  (c: typeof example) => { c.routes[0].source = 'missing'; },
  (c: typeof example) => { c.routes[0].to = ['missing']; },
  (c: typeof example) => { c.routes[0].status = ['invalid']; },
])('rejects invalid source or route', change => {
  const input = structuredClone(example);
  change(input);
  expect(() => validateConfig(input)).toThrow('relay.config.json:');
});

import bundled, { configFor } from '../src/config';
it('uses bundled config only when RELAY_CONFIG is absent', () => {
  expect(configFor({})).toBe(bundled);
});
it('uses a complete private config without changing the bundled one', () => {
  const custom = { sources: { private: { type: 'gitlab', secret: 'SRC_PRIVATE', allow: ['example/private'] } }, destinations: { private: { secret: 'DEST_PRIVATE' } }, routes: [{ source: 'private', to: ['private'] }] };
  expect(configFor({ RELAY_CONFIG: JSON.stringify(custom) })).toEqual(custom);
  expect(bundled.sources.private).toBeUndefined();
});
it.each(['', '{', '{}', 42])('rejects invalid overrides without falling back', value => {
  expect(() => configFor({ RELAY_CONFIG: value })).toThrow('RELAY_CONFIG');
});
it('does not expose private config values in errors', () => {
  const custom = { sources: { 'private.invalid.identifier': {} }, destinations: {}, routes: [] };
  expect(() => configFor({ RELAY_CONFIG: JSON.stringify(custom) })).toThrow('RELAY_CONFIG failed configuration validation');
});
