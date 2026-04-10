/**
 * Request history store for per-request metadata ledger.
 *
 * Persists entries as JSONL under data/request-history.jsonl and keeps a
 * rolling in-memory index for the last 30 days.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, resolve } from "path";
import { getDataDir } from "../paths.js";

export type RequestOutcome = "success" | "error" | "aborted";

export interface RequestHistoryRecord {
  timestamp: string;
  request_id: string;
  response_id: string | null;
  path: string;
  method: string;
  model: string;
  streaming: boolean;
  route_family: string;
  account_entry_id: string | null;
  account_email: string | null;
  account_label: string | null;
  status_code: number;
  outcome: RequestOutcome;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  attempt_count: number;
  /** v2: client source IP from X-Real-IP / X-Forwarded-For. null when absent. */
  client_ip: string | null;
  /** v2: User-Agent header, truncated to USER_AGENT_MAX chars. */
  user_agent: string | null;
  /** v2: request body size in bytes (header Content-Length preferred, measured fallback). */
  request_size_bytes: number | null;
  /** v2: accumulated upstream response body byte count. null if not captured. */
  response_size_bytes: number | null;
  /** v2: first 16 hex chars of sha256(method + "\n" + path + "\n" + body[0:2048]). */
  request_fingerprint: string | null;
}

/** v2: normalize a possibly-legacy record so callers can rely on all fields being present. */
export function normalizeLegacyRecord(raw: Partial<RequestHistoryRecord>): RequestHistoryRecord {
  return {
    timestamp: raw.timestamp ?? "",
    request_id: raw.request_id ?? "",
    response_id: raw.response_id ?? null,
    path: raw.path ?? "",
    method: raw.method ?? "",
    model: raw.model ?? "",
    streaming: raw.streaming ?? false,
    route_family: raw.route_family ?? "",
    account_entry_id: raw.account_entry_id ?? null,
    account_email: raw.account_email ?? null,
    account_label: raw.account_label ?? null,
    status_code: raw.status_code ?? 0,
    outcome: raw.outcome ?? "error",
    error_code: raw.error_code ?? null,
    error_message: raw.error_message ?? null,
    duration_ms: raw.duration_ms ?? 0,
    input_tokens: raw.input_tokens ?? null,
    output_tokens: raw.output_tokens ?? null,
    cached_tokens: raw.cached_tokens ?? null,
    reasoning_tokens: raw.reasoning_tokens ?? null,
    attempt_count: raw.attempt_count ?? 0,
    client_ip: raw.client_ip ?? null,
    user_agent: raw.user_agent ?? null,
    request_size_bytes: raw.request_size_bytes ?? null,
    response_size_bytes: raw.response_size_bytes ?? null,
    request_fingerprint: raw.request_fingerprint ?? null,
  };
}

export interface RequestHistoryQuery {
  hours: number;
  page: number;
  page_size: number;
  status: "all" | RequestOutcome;
  path: string;
  query: string;
}

export interface RequestHistoryQueryResult {
  items: RequestHistoryRecord[];
  total: number;
  page: number;
  page_size: number;
}

/** v2: aggregation grouping dimension. */
export type RequestHistoryAggregateBy = "client_ip" | "request_fingerprint" | "user_agent";

export interface RequestHistoryAggregateQuery {
  by: RequestHistoryAggregateBy;
  hours: number;
  limit: number;
}

export interface RequestHistoryAggregateGroup {
  key: string;
  request_count: number;
  success_count: number;
  error_count: number;
  aborted_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  first_seen: string;
  last_seen: string;
  distinct_fingerprints: number;
  distinct_models: string[];
}

export interface RequestHistoryAggregateResult {
  by: RequestHistoryAggregateBy;
  hours: number;
  groups: RequestHistoryAggregateGroup[];
}

interface RequestHistoryPersistence {
  load(): RequestHistoryRecord[];
  append(record: RequestHistoryRecord): void;
  replace(records: RequestHistoryRecord[]): void;
}

const HISTORY_FILE = "request-history.jsonl";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CSV_HEADERS = [
  "timestamp",
  "path",
  "model",
  "account",
  "input_tokens",
  "output_tokens",
  "duration_ms",
  "outcome",
  "request_id",
  "client_ip",
  "user_agent",
  "request_size_bytes",
  "response_size_bytes",
  "request_fingerprint",
] as const;
export const USER_AGENT_MAX = 200;
const TMP_SUFFIX = ".tmp";

function getFilePath(): string {
  return resolve(getDataDir(), HISTORY_FILE);
}

function getTmpFilePath(filePath: string): string {
  return filePath + TMP_SUFFIX;
}

function toCsvCell(value: string | number | null): string {
  const raw = value == null ? "" : String(value);
  const sanitized = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n]/.test(sanitized)) {
    return `"${sanitized.replace(/"/g, "\"\"")}"`;
  }
  return sanitized;
}

function matchesQuery(record: RequestHistoryRecord, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [
    record.request_id,
    record.response_id,
    record.model,
    record.account_email,
    record.account_label,
  ].some((value) => value?.toLowerCase().includes(needle));
}

function isExpired(record: RequestHistoryRecord, cutoff: number): boolean {
  return new Date(record.timestamp).getTime() < cutoff;
}

function readJsonlFile(filePath: string): RequestHistoryRecord[] {
  const raw = readFileSync(filePath, "utf-8");
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Partial<RequestHistoryRecord>)
    .filter((record): record is Partial<RequestHistoryRecord> & { request_id: string } =>
      typeof record.request_id === "string",
    )
    .map(normalizeLegacyRecord);
}

export function createFsRequestHistoryPersistence(): RequestHistoryPersistence {
  return {
    load(): RequestHistoryRecord[] {
      try {
        const filePath = getFilePath();
        const tmpFile = getTmpFilePath(filePath);

        if (!existsSync(filePath) && existsSync(tmpFile)) {
          renameSync(tmpFile, filePath);
        }

        if (!existsSync(filePath)) return [];
        return readJsonlFile(filePath);
      } catch (err) {
        const filePath = getFilePath();
        const tmpFile = getTmpFilePath(filePath);
        if (existsSync(tmpFile)) {
          try {
            const recovered = readJsonlFile(tmpFile);
            if (recovered.length > 0 || !existsSync(filePath)) {
              if (existsSync(filePath)) {
                unlinkSync(filePath);
              }
              renameSync(tmpFile, filePath);
            }
            console.warn("[RequestHistory] Recovered history from temporary file");
            return recovered;
          } catch (recoveryErr) {
            console.warn("[RequestHistory] Temporary recovery failed:", recoveryErr instanceof Error ? recoveryErr.message : recoveryErr);
          }
        }
        console.warn("[RequestHistory] Failed to load history:", err instanceof Error ? err.message : err);
        return [];
      }
    },

    append(record: RequestHistoryRecord): void {
      try {
        const filePath = getFilePath();
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(filePath, JSON.stringify(record) + "\n", "utf-8");
      } catch (err) {
        console.error("[RequestHistory] Failed to append history:", err instanceof Error ? err.message : err);
      }
    },

    replace(records: RequestHistoryRecord[]): void {
      try {
        const filePath = getFilePath();
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const tmpFile = getTmpFilePath(filePath);
        const content = records.map((record) => JSON.stringify(record)).join("\n");
        writeFileSync(tmpFile, content ? content + "\n" : "", "utf-8");
        renameSync(tmpFile, filePath);
      } catch (err) {
        console.error("[RequestHistory] Failed to rewrite history:", err instanceof Error ? err.message : err);
      }
    },
  };
}

export class RequestHistoryStore {
  private readonly persistence: RequestHistoryPersistence;
  private records: RequestHistoryRecord[];

  constructor(persistence?: RequestHistoryPersistence) {
    this.persistence = persistence ?? createFsRequestHistoryPersistence();
    this.records = this.persistence.load().sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    this.pruneExpired();
  }

  record(record: RequestHistoryRecord): void {
    this.records.push(record);
    this.persistence.append(record);
    this.pruneExpired(record.timestamp);
  }

  query(params: RequestHistoryQuery): RequestHistoryQueryResult {
    const cutoff = Date.now() - params.hours * 60 * 60 * 1000;
    const filtered = this.records
      .filter((record) => new Date(record.timestamp).getTime() >= cutoff)
      .filter((record) => params.status === "all" || record.outcome === params.status)
      .filter((record) => !params.path || params.path === "all" || record.path === params.path)
      .filter((record) => matchesQuery(record, params.query))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = filtered.length;
    const start = (params.page - 1) * params.page_size;
    const items = filtered.slice(start, start + params.page_size);
    return { items, total, page: params.page, page_size: params.page_size };
  }

  exportCsv(params: Omit<RequestHistoryQuery, "page" | "page_size">): string {
    const { items } = this.query({
      ...params,
      page: 1,
      page_size: Math.max(this.records.length, 1),
    });
    const rows = items.map((record) => {
      const account = record.account_label
        ? `${record.account_label} (${record.account_email ?? "-"})`
        : (record.account_email ?? "-");
      return [
        record.timestamp,
        record.path,
        record.model,
        account,
        record.input_tokens,
        record.output_tokens,
        record.duration_ms,
        record.outcome,
        record.request_id,
        record.client_ip,
        record.user_agent,
        record.request_size_bytes,
        record.response_size_bytes,
        record.request_fingerprint,
      ].map(toCsvCell).join(",");
    });
    return [CSV_HEADERS.join(","), ...rows].join("\n");
  }

  /**
   * v2: group request records by a categorical dimension within a time window.
   *
   * Used by the admin aggregation endpoint to spot abuse patterns (e.g. same
   * client_ip replaying the same fingerprint many times = agent loop).
   *
   * Complexity: O(n) over records in the window. At realistic volumes
   * (< 1M records for 30 days) this is a few hundred ms in the worst case,
   * which is acceptable for admin-only endpoints.
   */
  aggregate(params: RequestHistoryAggregateQuery): RequestHistoryAggregateResult {
    const cutoff = Date.now() - params.hours * 60 * 60 * 1000;
    const buckets = new Map<string, {
      key: string;
      request_count: number;
      success_count: number;
      error_count: number;
      aborted_count: number;
      total_input_tokens: number;
      total_output_tokens: number;
      first_seen_ms: number;
      last_seen_ms: number;
      fingerprints: Set<string>;
      models: Set<string>;
    }>();

    for (const r of this.records) {
      const ts = new Date(r.timestamp).getTime();
      if (ts < cutoff) continue;
      let key: string | null = null;
      if (params.by === "client_ip") key = r.client_ip ?? "(unknown)";
      else if (params.by === "request_fingerprint") key = r.request_fingerprint ?? "(unknown)";
      else if (params.by === "user_agent") key = r.user_agent ?? "(unknown)";
      if (key == null) continue;

      let b = buckets.get(key);
      if (!b) {
        b = {
          key,
          request_count: 0,
          success_count: 0,
          error_count: 0,
          aborted_count: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          first_seen_ms: ts,
          last_seen_ms: ts,
          fingerprints: new Set<string>(),
          models: new Set<string>(),
        };
        buckets.set(key, b);
      }
      b.request_count++;
      if (r.outcome === "success") b.success_count++;
      else if (r.outcome === "error") b.error_count++;
      else if (r.outcome === "aborted") b.aborted_count++;
      b.total_input_tokens += r.input_tokens ?? 0;
      b.total_output_tokens += r.output_tokens ?? 0;
      if (ts < b.first_seen_ms) b.first_seen_ms = ts;
      if (ts > b.last_seen_ms) b.last_seen_ms = ts;
      if (r.request_fingerprint) b.fingerprints.add(r.request_fingerprint);
      if (r.model) b.models.add(r.model);
    }

    const groups: RequestHistoryAggregateGroup[] = Array.from(buckets.values())
      .map((b) => ({
        key: b.key,
        request_count: b.request_count,
        success_count: b.success_count,
        error_count: b.error_count,
        aborted_count: b.aborted_count,
        total_input_tokens: b.total_input_tokens,
        total_output_tokens: b.total_output_tokens,
        first_seen: new Date(b.first_seen_ms).toISOString(),
        last_seen: new Date(b.last_seen_ms).toISOString(),
        distinct_fingerprints: b.fingerprints.size,
        distinct_models: Array.from(b.models).sort(),
      }))
      .sort((a, b) => b.request_count - a.request_count)
      .slice(0, params.limit);

    return { by: params.by, hours: params.hours, groups };
  }

  get size(): number {
    return this.records.length;
  }

  private pruneExpired(nowIso?: string): void {
    if (this.records.length === 0) return;
    const now = nowIso ? new Date(nowIso).getTime() : Date.now();
    const cutoff = now - MAX_AGE_MS;
    if (!isExpired(this.records[0], cutoff)) return;
    const next = this.records.filter((record) => !isExpired(record, cutoff));
    if (next.length !== this.records.length) {
      this.records = next;
      this.persistence.replace(this.records);
    }
  }
}
