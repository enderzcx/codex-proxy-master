import { describe, it, expect } from "vitest";
import { Hono } from "hono";

import {
  computeRequestFingerprint,
  extractClientIp,
  extractUserAgent,
  extractRequestSize,
  recordRawBody,
  createRequestHistoryContext,
  FINGERPRINT_BODY_CAP,
} from "../request-history.js";

describe("computeRequestFingerprint", () => {
  it("is deterministic for same (method, path, body)", () => {
    const fp1 = computeRequestFingerprint("POST", "/v1/chat/completions", '{"model":"x"}');
    const fp2 = computeRequestFingerprint("POST", "/v1/chat/completions", '{"model":"x"}');
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(16);
  });

  it("changes when path differs", () => {
    const a = computeRequestFingerprint("POST", "/v1/chat/completions", "{}");
    const b = computeRequestFingerprint("POST", "/v1/messages", "{}");
    expect(a).not.toBe(b);
  });

  it("changes when method differs", () => {
    const a = computeRequestFingerprint("POST", "/v1/chat/completions", "{}");
    const b = computeRequestFingerprint("GET", "/v1/chat/completions", "{}");
    expect(a).not.toBe(b);
  });

  it("collapses bodies that differ only after the 2KB cap", () => {
    const base = "a".repeat(FINGERPRINT_BODY_CAP);
    const a = computeRequestFingerprint("POST", "/x", base + "suffix-A");
    const b = computeRequestFingerprint("POST", "/x", base + "suffix-B");
    expect(a).toBe(b);
  });

  it("handles empty body (GET request)", () => {
    const a = computeRequestFingerprint("GET", "/v1/models", "");
    const b = computeRequestFingerprint("GET", "/v1/models", "");
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("extraSalt differentiates fingerprints that share path+body", () => {
    // Motivated by Gemini routes where ctx.path is the Hono route template
    // (/v1beta/models/:modelAction) — without a salt, two requests to
    // different modelAction values with the same body would collide.
    const body = '{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}';
    const tpl = "/v1beta/models/:modelAction";
    const withoutSalt = computeRequestFingerprint("POST", tpl, body);
    const saltA = computeRequestFingerprint("POST", tpl, body, "gemini-2.5-pro:generateContent");
    const saltB = computeRequestFingerprint("POST", tpl, body, "gemini-2.5-flash:generateContent");
    const saltC = computeRequestFingerprint("POST", tpl, body, "gemini-2.5-pro:streamGenerateContent");
    expect(saltA).not.toBe(withoutSalt);
    expect(saltA).not.toBe(saltB);
    expect(saltA).not.toBe(saltC);
    expect(saltB).not.toBe(saltC);
    // Same salt reproduces the same fingerprint.
    const saltA2 = computeRequestFingerprint("POST", tpl, body, "gemini-2.5-pro:generateContent");
    expect(saltA2).toBe(saltA);
  });
});

/** Build a Hono Context by running a fake request through a tiny app. */
async function makeContext(headers: Record<string, string>) {
  let captured: unknown = null;
  const app = new Hono();
  app.get("/test", (c) => {
    captured = {
      clientIp: extractClientIp(c),
      userAgent: extractUserAgent(c),
      requestSize: extractRequestSize(c),
      rawCtx: createRequestHistoryContext(c, "/test", "m", false, "test"),
    };
    return c.text("ok");
  });
  await app.request("/test", { method: "GET", headers });
  return captured as {
    clientIp: string | null;
    userAgent: string | null;
    requestSize: number | null;
    rawCtx: ReturnType<typeof createRequestHistoryContext>;
  };
}

describe("extractClientIp", () => {
  it("prefers X-Real-IP over X-Forwarded-For", async () => {
    const ctx = await makeContext({
      "X-Real-IP": "1.2.3.4",
      "X-Forwarded-For": "5.6.7.8",
    });
    expect(ctx.clientIp).toBe("1.2.3.4");
  });

  it("falls back to leftmost X-Forwarded-For entry", async () => {
    const ctx = await makeContext({
      "X-Forwarded-For": "9.9.9.9, 5.6.7.8",
    });
    expect(ctx.clientIp).toBe("9.9.9.9");
  });

  it("returns null when neither header is present", async () => {
    const ctx = await makeContext({});
    expect(ctx.clientIp).toBeNull();
  });

  it("trims surrounding whitespace", async () => {
    const ctx = await makeContext({
      "X-Real-IP": "  10.0.0.5  ",
    });
    expect(ctx.clientIp).toBe("10.0.0.5");
  });
});

describe("extractUserAgent", () => {
  it("returns the UA header when present", async () => {
    const ctx = await makeContext({ "User-Agent": "codex-cli/1.0" });
    expect(ctx.userAgent).toBe("codex-cli/1.0");
  });

  it("truncates absurdly long UA strings to 200 chars", async () => {
    const longUa = "x".repeat(500);
    const ctx = await makeContext({ "User-Agent": longUa });
    expect(ctx.userAgent?.length).toBe(200);
  });

  it("returns null when UA is missing", async () => {
    const ctx = await makeContext({});
    expect(ctx.userAgent).toBeNull();
  });
});

describe("extractRequestSize", () => {
  it("parses numeric Content-Length", async () => {
    const ctx = await makeContext({ "Content-Length": "12345" });
    expect(ctx.requestSize).toBe(12345);
  });

  it("returns null on missing Content-Length", async () => {
    const ctx = await makeContext({});
    expect(ctx.requestSize).toBeNull();
  });

  it("returns null on negative or non-numeric Content-Length", async () => {
    const ctxNeg = await makeContext({ "Content-Length": "-5" });
    expect(ctxNeg.requestSize).toBeNull();
    const ctxBad = await makeContext({ "Content-Length": "abc" });
    expect(ctxBad.requestSize).toBeNull();
  });
});

describe("recordRawBody", () => {
  it("sets fingerprint and measured byte length on the context", async () => {
    const ctx = await makeContext({});
    const body = '{"model":"test-model","prompt":"hello"}';
    recordRawBody(ctx.rawCtx, body);
    expect(ctx.rawCtx.request_fingerprint).toHaveLength(16);
    expect(ctx.rawCtx.request_size_bytes).toBe(Buffer.byteLength(body, "utf-8"));
  });

  it("overwrites Content-Length-derived size with measured size", async () => {
    const ctx = await makeContext({ "Content-Length": "999" });
    // Initial size from the header.
    expect(ctx.rawCtx.request_size_bytes).toBe(999);
    recordRawBody(ctx.rawCtx, "{}");
    // Now overwritten with the measured value.
    expect(ctx.rawCtx.request_size_bytes).toBe(2);
  });
});
