import { describe, it, expect, vi } from "vitest";

import {
  RequestHistoryStore,
  type RequestHistoryRecord,
} from "../request-history.js";

function createRecord(overrides?: Partial<RequestHistoryRecord>): RequestHistoryRecord {
  return {
    timestamp: new Date().toISOString(),
    request_id: "req_1",
    response_id: "resp_1",
    path: "/v1/responses",
    method: "POST",
    model: "gpt-5.4",
    streaming: true,
    route_family: "responses",
    account_entry_id: "entry_1",
    account_email: "user@example.com",
    account_label: "Team",
    status_code: 200,
    outcome: "success",
    error_code: null,
    error_message: null,
    duration_ms: 321,
    input_tokens: 123,
    output_tokens: 45,
    cached_tokens: 0,
    reasoning_tokens: 0,
    attempt_count: 1,
    ...overrides,
  };
}

describe("RequestHistoryStore", () => {
  it("loads existing records and prunes expired ones", () => {
    const replace = vi.fn();
    const store = new RequestHistoryStore({
      load: () => [
        createRecord({ request_id: "fresh", timestamp: new Date().toISOString() }),
        createRecord({
          request_id: "old",
          timestamp: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
        }),
      ],
      append: vi.fn(),
      replace,
    });

    expect(store.size).toBe(1);
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("appends records and queries with filters", () => {
    const append = vi.fn();
    const store = new RequestHistoryStore({
      load: () => [],
      append,
      replace: vi.fn(),
    });

    store.record(createRecord({
      request_id: "req_a",
      outcome: "success",
      path: "/v1/chat/completions",
      model: "gpt-5.4",
      account_email: "alpha@example.com",
    }));
    store.record(createRecord({
      request_id: "req_b",
      response_id: "resp_b",
      outcome: "error",
      path: "/v1/messages",
      model: "claude",
      account_email: "beta@example.com",
      error_message: "boom",
    }));

    expect(append).toHaveBeenCalledTimes(2);

    const result = store.query({
      hours: 24,
      page: 1,
      page_size: 50,
      status: "error",
      path: "/v1/messages",
      query: "beta",
    });

    expect(result.total).toBe(1);
    expect(result.items[0].request_id).toBe("req_b");
  });

  it("exports csv with table fields", () => {
    const store = new RequestHistoryStore({
      load: () => [
        createRecord({
          request_id: "req_csv",
          path: "/v1/responses",
          account_label: "Ops",
          account_email: "ops@example.com",
        }),
      ],
      append: vi.fn(),
      replace: vi.fn(),
    });

    const csv = store.exportCsv({
      hours: 24,
      status: "all",
      path: "all",
      query: "",
    });

    expect(csv).toContain("timestamp,path,model,account,input_tokens,output_tokens,duration_ms,outcome,request_id");
    expect(csv).toContain("/v1/responses");
    expect(csv).toContain("Ops (ops@example.com)");
    expect(csv).toContain("req_csv");
  });

  it("sanitizes csv formula cells", () => {
    const store = new RequestHistoryStore({
      load: () => [
        createRecord({
          request_id: "req_formula",
          model: "=2+3",
          account_label: "@ops",
          account_email: "ops@example.com",
        }),
      ],
      append: vi.fn(),
      replace: vi.fn(),
    });

    const csv = store.exportCsv({
      hours: 24,
      status: "all",
      path: "all",
      query: "",
    });

    expect(csv).toContain("'=2+3");
    expect(csv).toContain("'@ops (ops@example.com)");
  });
});
