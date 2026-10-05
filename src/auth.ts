import type { SourceType } from "./types";

const enc = new TextEncoder();
const MAX_SKEW_S = 300;

export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Auth = { ok: false } | { ok: true; nonce: string | null };

export async function authenticate(type: SourceType, req: Request, raw: string, secret: string): Promise<Auth> {
  const h = (name: string) => req.headers.get(name) ?? "";
  switch (type) {
    case "gitlab":
      return (await safeEqual(h("x-gitlab-token"), secret))
        ? { ok: true, nonce: req.headers.get("idempotency-key") }
        : { ok: false };
    case "github": {
      const expected = "sha256=" + (await hmacHex(secret, raw));
      return (await safeEqual(h("x-hub-signature-256"), expected))
        ? { ok: true, nonce: req.headers.get("x-github-delivery") }
        : { ok: false };
    }
    case "bearer":
      return (await safeEqual(h("authorization"), `Bearer ${secret}`)) ? { ok: true, nonce: null } : { ok: false };
    case "hmac": {
      const ts = h("x-timestamp");
      if (!/^\d{1,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_S) return { ok: false };
      const expected = await hmacHex(secret, `${ts}.${raw}`);
      return (await safeEqual(h("x-signature"), expected)) ? { ok: true, nonce: expected } : { ok: false };
    }
  }
}
