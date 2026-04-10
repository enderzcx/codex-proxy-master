import { Hono } from "hono";
import type { RequestHistoryStore, RequestOutcome, RequestHistoryAggregateBy } from "../../auth/request-history.js";

const ALLOWED_STATUSES = new Set<RequestOutcome | "all">(["all", "success", "error", "aborted"]);
const ALLOWED_AGGREGATE_BY = new Set<RequestHistoryAggregateBy>(["client_ip", "request_fingerprint", "user_agent"]);

export function createRequestHistoryRoutes(store: RequestHistoryStore): Hono {
  const app = new Hono();

  app.get("/admin/request-history", (c) => {
    const hours = Math.min(Math.max(1, parseInt(c.req.query("hours") ?? "24", 10) || 24), 720);
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);
    const page_size = Math.min(Math.max(1, parseInt(c.req.query("page_size") ?? "50", 10) || 50), 200);
    const statusRaw = c.req.query("status") ?? "all";
    const path = c.req.query("path") ?? "all";
    const query = (c.req.query("query") ?? "").trim();

    if (!ALLOWED_STATUSES.has(statusRaw as RequestOutcome | "all")) {
      c.status(400);
      return c.json({ error: "Invalid status. Must be all, success, error, or aborted." });
    }

    return c.json(store.query({
      hours,
      page,
      page_size,
      status: statusRaw as RequestOutcome | "all",
      path,
      query,
    }));
  });

  app.get("/admin/request-history/aggregate", (c) => {
    const byRaw = c.req.query("by") ?? "client_ip";
    const hours = Math.min(Math.max(1, parseInt(c.req.query("hours") ?? "24", 10) || 24), 720);
    const limit = Math.min(Math.max(1, parseInt(c.req.query("limit") ?? "50", 10) || 50), 500);

    if (!ALLOWED_AGGREGATE_BY.has(byRaw as RequestHistoryAggregateBy)) {
      c.status(400);
      return c.json({ error: "Invalid 'by'. Must be client_ip, request_fingerprint, or user_agent." });
    }

    return c.json(store.aggregate({
      by: byRaw as RequestHistoryAggregateBy,
      hours,
      limit,
    }));
  });

  app.get("/admin/request-history/export", (c) => {
    const hours = Math.min(Math.max(1, parseInt(c.req.query("hours") ?? "24", 10) || 24), 720);
    const statusRaw = c.req.query("status") ?? "all";
    const path = c.req.query("path") ?? "all";
    const query = (c.req.query("query") ?? "").trim();

    if (!ALLOWED_STATUSES.has(statusRaw as RequestOutcome | "all")) {
      c.status(400);
      return c.json({ error: "Invalid status. Must be all, success, error, or aborted." });
    }

    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", "attachment; filename=\"request-history.csv\"");
    return c.body(store.exportCsv({
      hours,
      status: statusRaw as RequestOutcome | "all",
      path,
      query,
    }));
  });

  return app;
}
