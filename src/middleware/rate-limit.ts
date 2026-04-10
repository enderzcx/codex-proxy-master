/**
 * Per-IP token-bucket rate limit middleware.
 *
 * Motivation: the 2026-04-10 incident showed a single abuser can burn hundreds
 * of requests in a few minutes once they have a valid proxy_api_key. This
 * middleware stops that kind of pattern at the edge before a request ever hits
 * account routing, independent of the account-pool quota system.
 *
 * Scope: applied to /v1/* and /v1beta/* upstream LLM routes only. Admin,
 * dashboard, auth, static and health endpoints are NOT rate-limited.
 *
 * Algorithm: token bucket per client IP. Refills at RATE_LIMIT_RPS tokens/sec
 * up to RATE_LIMIT_BURST capacity. Each request consumes 1 token. If the
 * bucket is empty, return 429 with Retry-After.
 *
 * Failure mode: wrapped in try/catch. Known benign errors (malformed headers,
 * empty IP) fall through with a debug log. Unexpected errors (TypeError, OOM)
 * fail CLOSED with 500 `rate_limit_internal_error` — never silently bypass,
 * never silently take the proxy down.
 */

import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { extractClientIp } from "../routes/shared/request-history.js";
import { isLocalhostRequest } from "../utils/is-localhost.js";

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Hard cap on the buckets map, independent of idle-prune timing. Prevents an
 * IP-spray DoS where an attacker touches millions of unique source IPs before
 * the first time-based prune fires. When the cap is reached we force an idle
 * prune immediately; if that still leaves the map over the cap we evict the
 * oldest entries by lastRefillMs.
 */
const MAX_BUCKETS = 10000;

interface RateLimitConfig {
  enabled: boolean;
  rps: number;
  burst: number;
  idleMs: number;
  allowlist: Set<string>;
}

function loadConfig(): RateLimitConfig {
  const enabled = (process.env.RATE_LIMIT_ENABLED ?? "true").toLowerCase() !== "false";
  const rps = Math.max(1, parseFloat(process.env.RATE_LIMIT_RPS ?? "5") || 5);
  const burst = Math.max(1, parseInt(process.env.RATE_LIMIT_BURST ?? "20", 10) || 20);
  const idleMs = Math.max(10000, parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10) || 60000);
  const allowlistRaw = (process.env.RATE_LIMIT_ALLOWLIST ?? "127.0.0.1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowlist = new Set<string>(allowlistRaw);
  // Loopback is always implicitly whitelisted so internal services never trip.
  allowlist.add("127.0.0.1");
  allowlist.add("::1");
  return { enabled, rps, burst, idleMs, allowlist };
}

const RATE_LIMITED_PREFIXES = ["/v1/", "/v1beta/"];

function isRateLimitedPath(path: string): boolean {
  return RATE_LIMITED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

/** Token-bucket state, reset on test calls via resetRateLimitState(). */
const buckets = new Map<string, Bucket>();
let lastPruneMs = Date.now();

function pruneStale(nowMs: number, idleMs: number): void {
  // Cheap periodic sweep — only run once per idleMs at most.
  if (nowMs - lastPruneMs < idleMs) return;
  lastPruneMs = nowMs;
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.lastRefillMs > idleMs) {
      buckets.delete(key);
    }
  }
}

/**
 * Enforce MAX_BUCKETS cap. First tries a forced idle-prune (bypassing the
 * idleMs cooldown), then falls back to evicting the oldest entries by
 * lastRefillMs until the map is at cap - 1.
 */
function enforceBucketsCap(nowMs: number, idleMs: number): void {
  if (buckets.size <= MAX_BUCKETS) return;
  // Force an idle prune regardless of how recently we last ran one.
  lastPruneMs = 0;
  pruneStale(nowMs, idleMs);
  if (buckets.size <= MAX_BUCKETS) return;
  // Still over cap — evict oldest entries.
  const entries = Array.from(buckets.entries());
  entries.sort((a, b) => a[1].lastRefillMs - b[1].lastRefillMs);
  const toEvict = buckets.size - (MAX_BUCKETS - 1);
  for (let i = 0; i < toEvict; i++) {
    buckets.delete(entries[i][0]);
  }
}

function takeToken(ip: string, cfg: RateLimitConfig, nowMs: number): boolean {
  let bucket = buckets.get(ip);
  if (!bucket) {
    bucket = { tokens: cfg.burst, lastRefillMs: nowMs };
    buckets.set(ip, bucket);
    // Defend against IP-spray DoS: cap map growth regardless of idle timer.
    enforceBucketsCap(nowMs, cfg.idleMs);
  }
  // Refill based on elapsed time.
  const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
  bucket.tokens = Math.min(cfg.burst, bucket.tokens + elapsedSec * cfg.rps);
  bucket.lastRefillMs = nowMs;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

export function rateLimit(): (c: Context, next: Next) => Promise<Response | void> {
  // Load config once at middleware-creation time. Hot-reload is out of scope
  // for v2 — restart the proxy to change rate limit settings.
  const cfg = loadConfig();

  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!cfg.enabled) return next();
    const path = c.req.path;
    if (!isRateLimitedPath(path)) return next();

    try {
      // Identity resolution order:
      //   1. X-Real-IP / X-Forwarded-For (set by nginx / trusted reverse proxy)
      //   2. Actual socket remote address via getConnInfo (direct deployments)
      //   3. Sentinel "(unknown)" bucket as last resort so a caller cannot
      //      trivially bypass the limiter by stripping forwarding headers.
      // This closes the 2026-04-10 abuse pattern (header omission bypass)
      // without collapsing direct-localhost deployments into a single shared
      // bucket — each local client still gets its own 127.0.0.1 / ::1 entry,
      // and the implicit loopback allowlist still short-circuits it.
      let ip = extractClientIp(c);
      if (!ip) {
        try {
          const remote = getConnInfo(c).remote.address;
          if (remote) ip = remote;
        } catch {
          // getConnInfo can throw if the underlying adapter doesn't support
          // connection info (edge runtimes, some test stubs). Fall through.
        }
      }
      if (!ip) ip = "(unknown)";
      // Normalize loopback via the shared utility so IPv4-mapped IPv6
      // localhost (`::ffff:127.0.0.1`) and the empty-string case used by
      // isLocalhostRequest are treated as a single allowlisted identity.
      // Without this, direct-deployment localhost traffic would start
      // consuming rate-limit tokens on Node-default socket representations.
      if (isLocalhostRequest(ip)) return next();
      if (cfg.allowlist.has(ip)) return next();

      const nowMs = Date.now();
      pruneStale(nowMs, cfg.idleMs);
      if (takeToken(ip, cfg, nowMs)) {
        return next();
      }

      // Rate limited: return 429 with Retry-After.
      c.status(429);
      c.header("Retry-After", "1");
      return c.json({
        error: {
          message: "Too many requests. Please slow down.",
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
        },
      });
    } catch (err) {
      // Fail-CLOSED on any unexpected error. The rate limit path is simple
      // (header read + Map lookup + arithmetic) so reaching here means
      // something is genuinely broken and silently passing traffic would be
      // a bypass. Return 500 rather than crashing the proxy.
      console.error("[RateLimit] Unexpected error:", err);
      c.status(500);
      return c.json({
        error: {
          message: "Rate limiter internal error",
          type: "server_error",
          code: "rate_limit_internal_error",
        },
      });
    }
  };
}

/** Test-only helper: wipe bucket state between test cases. */
export function resetRateLimitState(): void {
  buckets.clear();
  lastPruneMs = Date.now();
}

/** Test-only helper: inspect bucket count. */
export function rateLimitBucketCount(): number {
  return buckets.size;
}
