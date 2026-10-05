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
