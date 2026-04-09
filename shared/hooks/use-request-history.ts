import { useCallback, useEffect, useState } from "preact/hooks";

export type RequestHistoryOutcome = "success" | "error" | "aborted";

export interface RequestHistoryItem {
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
  outcome: RequestHistoryOutcome;
  error_code: string | null;
  error_message: string | null;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  attempt_count: number;
}

export interface RequestHistoryFilters {
  hours: number;
  page: number;
  page_size: number;
  status: "all" | RequestHistoryOutcome;
  path: string;
  query: string;
}

export function useRequestHistory(initial?: Partial<RequestHistoryFilters>) {
  const [filters, setFilters] = useState<RequestHistoryFilters>({
    hours: initial?.hours ?? 24,
    page: initial?.page ?? 1,
    page_size: initial?.page_size ?? 50,
    status: initial?.status ?? "all",
    path: initial?.path ?? "all",
    query: initial?.query ?? "",
  });
  const [items, setItems] = useState<RequestHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        hours: String(filters.hours),
        page: String(filters.page),
        page_size: String(filters.page_size),
        status: filters.status,
        path: filters.path,
      });
      if (filters.query.trim()) {
        params.set("query", filters.query.trim());
      }
      const resp = await fetch(`/admin/request-history?${params.toString()}`);
      if (!resp.ok) throw new Error("Failed to load request history");
      const body = await resp.json();
      setItems(body.items ?? []);
      setTotal(body.total ?? 0);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  const exportCsv = useCallback(async () => {
    const params = new URLSearchParams({
      hours: String(filters.hours),
      status: filters.status,
      path: filters.path,
    });
    if (filters.query.trim()) {
      params.set("query", filters.query.trim());
    }
    const resp = await fetch(`/admin/request-history/export?${params.toString()}`);
    if (!resp.ok) throw new Error("Failed to export request history");
    const csv = await resp.text();
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `request-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [filters]);

  const setFilter = useCallback(<K extends keyof RequestHistoryFilters>(key: K, value: RequestHistoryFilters[K]) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value,
      page: key === "page" ? (value as number) : 1,
    }));
  }, []);

  return {
    filters,
    items,
    total,
    loading,
    reload: load,
    exportCsv,
    setFilter,
  };
}
