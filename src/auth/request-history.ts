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
] as const;
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
    .map((line) => JSON.parse(line) as RequestHistoryRecord)
    .filter((record) => typeof record.request_id === "string");
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
      ].map(toCsvCell).join(",");
    });
    return [CSV_HEADERS.join(","), ...rows].join("\n");
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
