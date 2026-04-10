import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";

import { rateLimit, resetRateLimitState, rateLimitBucketCount } from "../rate-limit.js";

function buildApp(): Hono {
  // Re-create the middleware each call so env vars are re-read.
  const app = new Hono();
  app.use("*", rateLimit());
  app.post("/v1/chat/completions", (c) => c.json({ ok: true }));
  app.post("/v1beta/models/foo:generateContent", (c) => c.json({ ok: true }));
  app.get("/admin/request-history", (c) => c.json({ ok: true }));
  app.get("/health", (c) => c.text("ok"));
  return app;
}

async function fire(app: Hono, path: string, headers: Record<string, string> = {}): Promise<number> {
  const res = await app.request(path, {
    method: path.startsWith("/admin") || path === "/health" ? "GET" : "POST",
    headers: { "X-Real-IP": "10.20.30.40", ...headers },
    body: path.startsWith("/admin") || path === "/health" ? undefined : '{"test":1}',
  });
  return res.status;
}

describe("rateLimit middleware", () => {
  beforeEach(() => {
    resetRateLimitState();
    // Tight limits for deterministic tests.
    process.env.RATE_LIMIT_ENABLED = "true";
    process.env.RATE_LIMIT_RPS = "1";
    process.env.RATE_LIMIT_BURST = "3";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    process.env.RATE_LIMIT_ALLOWLIST = "127.0.0.1";
  });

  it("allows burst up to capacity then 429s", async () => {
    const app = buildApp();
    expect(await fire(app, "/v1/chat/completions")).toBe(200);
    expect(await fire(app, "/v1/chat/completions")).toBe(200);
    expect(await fire(app, "/v1/chat/completions")).toBe(200);
    // 4th request exceeds burst of 3.
    expect(await fire(app, "/v1/chat/completions")).toBe(429);
  });

  it("applies to /v1beta/ Gemini routes", async () => {
    const app = buildApp();
    expect(await fire(app, "/v1beta/models/foo:generateContent")).toBe(200);
    expect(await fire(app, "/v1beta/models/foo:generateContent")).toBe(200);
    expect(await fire(app, "/v1beta/models/foo:generateContent")).toBe(200);
    expect(await fire(app, "/v1beta/models/foo:generateContent")).toBe(429);
  });

  it("does NOT rate-limit admin or health endpoints", async () => {
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      expect(await fire(app, "/admin/request-history")).toBe(200);
      expect(await fire(app, "/health")).toBe(200);
    }
  });

  it("allowlist bypasses bucket (exact-string match)", async () => {
    process.env.RATE_LIMIT_ALLOWLIST = "10.20.30.40";
    const app = buildApp();
    // Same IP as allowlist — should pass forever.
    for (let i = 0; i < 10; i++) {
      expect(await fire(app, "/v1/chat/completions")).toBe(200);
    }
  });

  it("allowlist does NOT match a near-neighbor IP", async () => {
    process.env.RATE_LIMIT_ALLOWLIST = "10.20.30.99";
    const app = buildApp();
    expect(await fire(app, "/v1/chat/completions")).toBe(200);
    expect(await fire(app, "/v1/chat/completions")).toBe(200);
    expect(await fire(app, "/v1/chat/completions")).toBe(200);
    expect(await fire(app, "/v1/chat/completions")).toBe(429);
  });

  it("treats IPv4-mapped IPv6 loopback as localhost", async () => {
    // Node often exposes local sockets as ::ffff:127.0.0.1 in getConnInfo.
    // isLocalhostRequest covers the common forms; rate-limit must honor it.
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      expect(await fire(app, "/v1/chat/completions", { "X-Real-IP": "::ffff:127.0.0.1" })).toBe(200);
    }
    // Pure IPv6 loopback also bypassed.
    for (let i = 0; i < 10; i++) {
      expect(await fire(app, "/v1/chat/completions", { "X-Real-IP": "::1" })).toBe(200);
    }
  });

  it("rate-limits requests with no X-Real-IP header via a shared (unknown) bucket", async () => {
    // When forwarding headers are absent, the limiter must NOT bypass — it
    // buckets all anonymous callers into a single shared bucket. This is the
    // P1 fix from codex review on commit effe249: the previous behavior let
    // any caller evade the limiter by omitting headers.
    const app = buildApp();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        body: '{"test":1}',
      });
      statuses.push(res.status);
    }
    // With burst=3, the first 3 succeed and the 4th/5th are 429'd.
    expect(statuses.filter((s) => s === 200).length).toBe(3);
    expect(statuses.filter((s) => s === 429).length).toBe(2);
  });

  it("allowlist can include (unknown) to explicitly whitelist anonymous callers", async () => {
    process.env.RATE_LIMIT_ALLOWLIST = "127.0.0.1,(unknown)";
    const app = buildApp();
    // With (unknown) allowlisted, anonymous callers bypass the bucket again.
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/v1/chat/completions", {
        method: "POST",
        body: '{"test":1}',
      });
      expect(res.status).toBe(200);
    }
  });

  it("disabled flag short-circuits the middleware", async () => {
    process.env.RATE_LIMIT_ENABLED = "false";
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      expect(await fire(app, "/v1/chat/completions")).toBe(200);
    }
  });

  it("tracks distinct IPs independently", async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) {
      expect(await fire(app, "/v1/chat/completions", { "X-Real-IP": "1.1.1.1" })).toBe(200);
      expect(await fire(app, "/v1/chat/completions", { "X-Real-IP": "2.2.2.2" })).toBe(200);
    }
    // Both buckets now empty.
    expect(await fire(app, "/v1/chat/completions", { "X-Real-IP": "1.1.1.1" })).toBe(429);
    expect(await fire(app, "/v1/chat/completions", { "X-Real-IP": "2.2.2.2" })).toBe(429);
    // Third IP still fresh.
    expect(await fire(app, "/v1/chat/completions", { "X-Real-IP": "3.3.3.3" })).toBe(200);
    expect(rateLimitBucketCount()).toBeGreaterThanOrEqual(3);
  });

  it("caps bucket map growth against IP-spray attacks", async () => {
    // Use a very short idle window + tight burst so each new IP creates a
    // fresh bucket instantly, then hit it with many distinct IPs and assert
    // the map stays bounded.
    process.env.RATE_LIMIT_RPS = "1000";
    process.env.RATE_LIMIT_BURST = "100";
    process.env.RATE_LIMIT_WINDOW_MS = "60000";
    const app = buildApp();
    for (let i = 0; i < 10500; i++) {
      const ip = `10.${Math.floor(i / 65536)}.${Math.floor((i % 65536) / 256)}.${i % 256}`;
      await fire(app, "/v1/chat/completions", { "X-Real-IP": ip });
    }
    // MAX_BUCKETS is 10000 — we should be at or near that after the spray.
    expect(rateLimitBucketCount()).toBeLessThanOrEqual(10000);
  });

  it("429 response body has the documented shape", async () => {
    const app = buildApp();
    for (let i = 0; i < 3; i++) await fire(app, "/v1/chat/completions");
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "X-Real-IP": "10.20.30.40" },
      body: "{}",
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("1");
    const body = await res.json() as { error: { type: string; code: string } };
    expect(body.error.type).toBe("rate_limit_error");
    expect(body.error.code).toBe("rate_limit_exceeded");
  });
});
