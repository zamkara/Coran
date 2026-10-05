import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate, hmacHex } from '../src/auth';
const secret = 'test-secret';
const body = '{"project":"example","title":"hello"}';
const request = (headers: Record<string, string>) => new Request('https://example.com', { headers });
afterEach(() => vi.restoreAllMocks());
describe('authentication', () => {
  it.each(['gitlab', 'github', 'bearer', 'hmac'] as const)('%s accepts valid credentials and rejects invalid ones', async (type) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = type === 'gitlab' ? { 'x-gitlab-token': secret, 'idempotency-key': 'delivery' }
      : type === 'github' ? { 'x-hub-signature-256': 'sha256=' + await hmacHex(secret, body), 'x-github-delivery': 'delivery' }
      : type === 'bearer' ? { authorization: `Bearer ${secret}` }
      : { 'x-timestamp': ts, 'x-signature': await hmacHex(secret, `${ts}.${body}`) };
    expect((await authenticate(type, request(headers), body, secret)).ok).toBe(true);
    expect((await authenticate(type, request({}), body, secret)).ok).toBe(false);
    expect((await authenticate(type, request(headers), body, 'wrong')).ok).toBe(false);
    const malformed = Object.fromEntries(Object.keys(headers).map(key => [key, 'malformed']));
    expect((await authenticate(type, request(malformed), body, secret)).ok).toBe(false);
    if (type === 'github' || type === 'hmac') expect((await authenticate(type, request(headers), body + ' ', secret)).ok).toBe(false);
  });
  it.each([-301, 301])('rejects timestamp skew %s', async (skew) => {
    const ts = String(Math.floor(Date.now() / 1000) + skew);
    expect(await authenticate('hmac', request({ 'x-timestamp': ts, 'x-signature': await hmacHex(secret, `${ts}.${body}`) }), body, secret)).toEqual({ ok: false });
  });
  it.each(['-1', '1.5', 'NaN', '9999999999999'])('rejects malformed timestamp %s', async ts => {
    expect(await authenticate('hmac', request({ 'x-timestamp': ts, 'x-signature': await hmacHex(secret, `${ts}.${body}`) }), body, secret)).toEqual({ ok: false });
  });
});
