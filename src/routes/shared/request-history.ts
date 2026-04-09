import type { Context } from "hono";
import type { AccountPool } from "../../auth/account-pool.js";
import type { RequestHistoryRecord, RequestOutcome, RequestHistoryStore } from "../../auth/request-history.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";

export interface RequestHistoryContext {
  request_id: string;
  path: string;
  method: string;
  model: string;
  streaming: boolean;
  route_family: string;
  started_at_ms: number;
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
