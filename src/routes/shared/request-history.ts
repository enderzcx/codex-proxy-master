import { createHash } from "crypto";
import type { Context } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";
import type { RequestHistoryRecord, RequestOutcome, RequestHistoryStore } from "../../auth/request-history.js";
import { USER_AGENT_MAX } from "../../auth/request-history.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";

export interface RequestHistoryContext {
  request_id: string;
  path: string;
  method: string;
  model: string;
  streaming: boolean;
  route_family: string;
  started_at_ms: number;
  /** v2: extracted at ctor time; immutable afterwards. */
  client_ip: string | null;
  /** v2: truncated User-Agent. */
  user_agent: string | null;
  /** v2: initially from Content-Length header; overwritten by measured byte length if raw body is buffered. */
  request_size_bytes: number | null;
  /** v2: accumulated by stream forwarders or set from non-streaming response text. null if not captured. */
  response_size_bytes: number | null;
  /** v2: populated by recordFingerprint() after raw body is available. null if body parse failed. */
  request_fingerprint: string | null;
}

/** Body prefix length that feeds sha256 for fingerprint. Keep fingerprint deterministic across callers. */
export const FINGERPRINT_BODY_CAP = 2048;

export function extractClientIp(c: Context): string | null {
  const realIp = c.req.header("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

export function extractUserAgent(c: Context): string | null {
  const ua = c.req.header("user-agent");
  if (!ua) return null;
  return ua.length > USER_AGENT_MAX ? ua.slice(0, USER_AGENT_MAX) : ua;
}

export function extractRequestSize(c: Context): number | null {
  // Content-Length is what the client claims; may be absent for chunked TE.
  // We treat this as a best-effort initial value and overwrite with the real
  // measured byte count after the body is buffered in the route handler.
  const cl = c.req.header("content-length");
  if (!cl) return null;
  const n = parseInt(cl, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Compute a short fingerprint of a request. Optionally mixes in an extra salt
 * that does NOT alter `ctx.path` — used by routes like Gemini where the stored
 * path is a Hono route template (`/v1beta/models/:modelAction`) but we still
 * want two different model/action combinations with the same body to produce
 * different fingerprints. Keeping `ctx.path` as a stable template preserves
 * the admin dashboard's exact-match path filter.
 */
export function computeRequestFingerprint(
  method: string,
  path: string,
  body: string,
  extraSalt?: string,
): string {
  const capped = body.length > FINGERPRINT_BODY_CAP ? body.slice(0, FINGERPRINT_BODY_CAP) : body;
  const hash = createHash("sha256");
  hash.update(method);
  hash.update("\n");
  hash.update(path);
  hash.update("\n");
  if (extraSalt) {
    hash.update(extraSalt);
    hash.update("\n");
  }
  hash.update(capped);
  return hash.digest("hex").slice(0, 16);
}

/**
 * Apply raw-body-derived fields (size + fingerprint) to an existing context.
 *
 * `extraSalt` is an optional per-request discriminator that is hashed into
 * the fingerprint but NOT stored in the context. Use it when the stored
 * `ctx.path` is a route template and two concrete requests would otherwise
 * collide on fingerprint (e.g. Gemini `:modelAction`).
 */
export function recordRawBody(
  ctx: RequestHistoryContext,
  rawBody: string,
  extraSalt?: string,
): void {
  ctx.request_fingerprint = computeRequestFingerprint(ctx.method, ctx.path, rawBody, extraSalt);
  // Only overwrite the header-derived request_size_bytes when we actually
  // measured a non-empty body. An empty string likely means we failed to read
  // the body before the catch block ran — preserve Content-Length in that case.
  if (rawBody.length > 0) {
    ctx.request_size_bytes = Buffer.byteLength(rawBody, "utf-8");
  }
}

export interface FinalizeRequestHistoryOptions {
  responseId?: string | null;
  entryId?: string | null;
  statusCode: number;
  outcome: RequestOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
  usage?: UsageInfo;
  attemptCount: number;
}

export function createRequestHistoryContext(
  c: Context,
  path: string,
  model: string,
  streaming: boolean,
  routeFamily: string,
): RequestHistoryContext {
  const requestId = c.get("requestId");
  return {
    request_id: typeof requestId === "string" && requestId.length > 0 ? requestId : "unknown",
    path,
    method: c.req.method,
    model,
    streaming,
    route_family: routeFamily,
    started_at_ms: Date.now(),
    client_ip: extractClientIp(c),
    user_agent: extractUserAgent(c),
    request_size_bytes: extractRequestSize(c),
    response_size_bytes: null,
    request_fingerprint: null,
  };
}

export function finalizeRequestHistory(
  store: RequestHistoryStore | undefined,
  pool: AccountPool | undefined,
  ctx: RequestHistoryContext | undefined,
  options: FinalizeRequestHistoryOptions,
): void {
  if (!store || !ctx) return;
  const entry = options.entryId && pool ? pool.getEntry(options.entryId) : undefined;
  const record: RequestHistoryRecord = {
    timestamp: new Date().toISOString(),
    request_id: ctx.request_id,
    response_id: options.responseId ?? null,
    path: ctx.path,
    method: ctx.method,
    model: ctx.model,
    streaming: ctx.streaming,
    route_family: ctx.route_family,
    account_entry_id: options.entryId ?? null,
    account_email: entry?.email ?? null,
    account_label: entry?.label ?? null,
    status_code: options.statusCode,
    outcome: options.outcome,
    error_code: options.errorCode ?? null,
    error_message: options.errorMessage ?? null,
    duration_ms: Math.max(0, Date.now() - ctx.started_at_ms),
    input_tokens: options.usage?.input_tokens ?? null,
    output_tokens: options.usage?.output_tokens ?? null,
    cached_tokens: options.usage?.cached_tokens ?? null,
    reasoning_tokens: options.usage?.reasoning_tokens ?? null,
    attempt_count: options.attemptCount,
    client_ip: ctx.client_ip,
    user_agent: ctx.user_agent,
    request_size_bytes: ctx.request_size_bytes,
    response_size_bytes: ctx.response_size_bytes,
    request_fingerprint: ctx.request_fingerprint,
  };
  store.record(record);
}

export function recordRequestHistoryFailure(
  store: RequestHistoryStore | undefined,
  ctx: RequestHistoryContext | undefined,
  statusCode: number,
  errorCode: string,
  errorMessage: string,
): void {
  finalizeRequestHistory(store, undefined, ctx, {
    statusCode,
    outcome: "error",
    errorCode,
    errorMessage,
    attemptCount: 0,
  });
}
