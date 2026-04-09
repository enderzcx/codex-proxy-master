import { describe, it, expect } from "vitest";
import { Hono } from "hono";

import { createRequestHistoryRoutes } from "../admin/request-history.js";
import type { RequestHistoryStore } from "../../auth/request-history.js";

function createStore() {
  return {
    query: (params: { page: number; page_size: number }) => ({
      items: [{ request_id: "req_1" }],
      total: 1,
      page: params.page,
      page_size: params.page_size,
    }),
    exportCsv: () => "timestamp,path,model,account,input_tokens,output_tokens,duration_ms,outcome,request_id\n",
  } as unknown as RequestHistoryStore;
}

describe("request history routes", () => {
  it("returns paginated request history", async () => {
    const app = new Hono();
    app.route("/", createRequestHistoryRoutes(createStore()));

    const res = await app.request("/admin/request-history?hours=24&page=2&page_size=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.page).toBe(2);
    expect(body.page_size).toBe(10);
  });

  it("rejects invalid status", async () => {
    const app = new Hono();
    app.route("/", createRequestHistoryRoutes(createStore()));

    const res = await app.request("/admin/request-history?status=weird");
    expect(res.status).toBe(400);
  });

  it("exports csv", async () => {
    const app = new Hono();
    app.route("/", createRequestHistoryRoutes(createStore()));

    const res = await app.request("/admin/request-history/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const body = await res.text();
    expect(body).toContain("timestamp,path,model");
  });
});
