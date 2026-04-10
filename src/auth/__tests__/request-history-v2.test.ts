import { describe, it, expect, vi } from "vitest";

import {
  RequestHistoryStore,
  normalizeLegacyRecord,
  type RequestHistoryRecord,
} from "../request-history.js";

/** Build a complete v2 record with sensible defaults and override points. */
function makeRecord(overrides?: Partial<RequestHistoryRecord>): RequestHistoryRecord {
  return {
    timestamp: new Date().toISOString(),
    request_id: "req_v2",
    response_id: "resp_v2",
    path: "/v1/chat/completions",
    method: "POST",
    model: "gpt-5.4",
    streaming: false,
    route_family: "chat",
    account_entry_id: "entry_1",
    account_email: "user@example.com",
    account_label: null,
    status_code: 200,
    outcome: "success",
    error_code: null,
    error_message: null,
    duration_ms: 100,
    input_tokens: 100,
    output_tokens: 50,
    cached_tokens: 0,
    reasoning_tokens: 0,
    attempt_count: 1,
    client_ip: "1.2.3.4",
    user_agent: "codex-cli/1.0",
    request_size_bytes: 1024,
    response_size_bytes: 2048,
    request_fingerprint: "abc1234567890def",
    ...overrides,
  };
}

describe("normalizeLegacyRecord", () => {
  it("fills missing v2 fields with null on a legacy (v1) record", () => {
    const legacy = {
      timestamp: "2026-04-01T00:00:00.000Z",
      request_id: "legacy_1",
      response_id: null,
      path: "/v1/chat/completions",
      method: "POST",
      model: "gpt-5.4",
      streaming: false,
      route_family: "chat",
      account_entry_id: null,
      account_email: null,
      account_label: null,
      status_code: 200,
      outcome: "success" as const,
      error_code: null,
      error_message: null,
      duration_ms: 50,
      input_tokens: 10,
      output_tokens: 5,
      cached_tokens: null,
      reasoning_tokens: null,
      attempt_count: 1,
    };
    const normalized = normalizeLegacyRecord(legacy);
    expect(normalized.client_ip).toBeNull();
    expect(normalized.user_agent).toBeNull();
    expect(normalized.request_size_bytes).toBeNull();
    expect(normalized.response_size_bytes).toBeNull();
    expect(normalized.request_fingerprint).toBeNull();
    // Existing fields preserved.
    expect(normalized.request_id).toBe("legacy_1");
    expect(normalized.duration_ms).toBe(50);
  });

  it("preserves existing v2 field values when already set", () => {
    const v2 = makeRecord({ client_ip: "9.8.7.6", user_agent: "curl/8" });
    const normalized = normalizeLegacyRecord(v2);
    expect(normalized.client_ip).toBe("9.8.7.6");
    expect(normalized.user_agent).toBe("curl/8");
  });

  it("handles outcome default on a record missing the field", () => {
    const degenerate = { request_id: "r" };
    const normalized = normalizeLegacyRecord(degenerate as Partial<RequestHistoryRecord>);
    expect(normalized.outcome).toBe("error");
    expect(normalized.status_code).toBe(0);
  });
});

describe("RequestHistoryStore.aggregate", () => {
  function buildStore(records: RequestHistoryRecord[]): RequestHistoryStore {
    return new RequestHistoryStore({
      load: () => records,
      append: vi.fn(),
      replace: vi.fn(),
    });
  }

  it("groups by client_ip and sorts by request_count desc", () => {
    const now = Date.now();
    const records = [
      makeRecord({ request_id: "a", timestamp: new Date(now - 1000).toISOString(), client_ip: "1.1.1.1", request_fingerprint: "fp-a" }),
      makeRecord({ request_id: "b", timestamp: new Date(now - 2000).toISOString(), client_ip: "1.1.1.1", request_fingerprint: "fp-a" }),
      makeRecord({ request_id: "c", timestamp: new Date(now - 3000).toISOString(), client_ip: "1.1.1.1", request_fingerprint: "fp-b" }),
      makeRecord({ request_id: "d", timestamp: new Date(now - 4000).toISOString(), client_ip: "2.2.2.2", request_fingerprint: "fp-c" }),
    ];
    const store = buildStore(records);
    const result = store.aggregate({ by: "client_ip", hours: 24, limit: 10 });
    expect(result.by).toBe("client_ip");
    expect(result.groups.length).toBe(2);
    expect(result.groups[0].key).toBe("1.1.1.1");
    expect(result.groups[0].request_count).toBe(3);
    expect(result.groups[0].distinct_fingerprints).toBe(2);
    expect(result.groups[1].key).toBe("2.2.2.2");
    expect(result.groups[1].request_count).toBe(1);
  });

  it("groups by request_fingerprint", () => {
    const now = Date.now();
    const records = [
      makeRecord({ timestamp: new Date(now - 1000).toISOString(), client_ip: "1.1.1.1", request_fingerprint: "fp-x" }),
      makeRecord({ timestamp: new Date(now - 2000).toISOString(), client_ip: "2.2.2.2", request_fingerprint: "fp-x" }),
      makeRecord({ timestamp: new Date(now - 3000).toISOString(), client_ip: "3.3.3.3", request_fingerprint: "fp-y" }),
    ];
    const store = buildStore(records);
    const result = store.aggregate({ by: "request_fingerprint", hours: 24, limit: 10 });
    expect(result.groups[0].key).toBe("fp-x");
    expect(result.groups[0].request_count).toBe(2);
  });

  it("respects time-window filter and excludes old records", () => {
    const now = Date.now();
    const sixHoursAgo = now - 6 * 60 * 60 * 1000;
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    const records = [
      makeRecord({ timestamp: new Date(sixHoursAgo).toISOString(), client_ip: "5.5.5.5" }),
      makeRecord({ timestamp: new Date(tenDaysAgo).toISOString(), client_ip: "5.5.5.5" }),
    ];
    const store = buildStore(records);
    const result = store.aggregate({ by: "client_ip", hours: 24, limit: 10 });
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].request_count).toBe(1);
  });

  it("counts outcomes (success / error / aborted) separately", () => {
    const now = Date.now();
    const records = [
      makeRecord({ timestamp: new Date(now - 1000).toISOString(), client_ip: "9.9.9.9", outcome: "success" }),
      makeRecord({ timestamp: new Date(now - 2000).toISOString(), client_ip: "9.9.9.9", outcome: "error" }),
      makeRecord({ timestamp: new Date(now - 3000).toISOString(), client_ip: "9.9.9.9", outcome: "aborted" }),
      makeRecord({ timestamp: new Date(now - 4000).toISOString(), client_ip: "9.9.9.9", outcome: "success" }),
    ];
    const store = buildStore(records);
    const result = store.aggregate({ by: "client_ip", hours: 24, limit: 10 });
    expect(result.groups[0].success_count).toBe(2);
    expect(result.groups[0].error_count).toBe(1);
    expect(result.groups[0].aborted_count).toBe(1);
  });

  it("uses (unknown) sentinel when the grouping field is null", () => {
    const records = [
      makeRecord({ client_ip: null }),
      makeRecord({ client_ip: null }),
      makeRecord({ client_ip: "6.6.6.6" }),
    ];
    const store = buildStore(records);
    const result = store.aggregate({ by: "client_ip", hours: 24, limit: 10 });
    const unknown = result.groups.find((g) => g.key === "(unknown)");
    expect(unknown?.request_count).toBe(2);
  });
});
