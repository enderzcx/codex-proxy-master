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

  it("falls through when no client IP header is present (no nginx)", async () => {
    const app = buildApp();
    // Many requests with no X-Real-IP / X-Forwarded-For should all pass.
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
