import { Fragment } from "preact";
import { useState } from "preact/hooks";
import type { RequestHistoryItem } from "../../../shared/hooks/use-request-history";
import { formatNumber } from "./UsageChart";
import { useT } from "../../../shared/i18n/context";

const PAGE_SIZE = 50;
const UA_INLINE_MAX = 24;
const FINGERPRINT_INLINE_LEN = 8;

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format a byte count for the compact column. We intentionally keep this
 * terse (the cell is narrow); the expanded detail panel shows the raw
 * byte count without any unit rounding.
 */
function formatBytes(value: number | null | undefined): string {
  if (value == null) return "-";
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.max(1, Math.floor((max - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

function accountLabel(item: RequestHistoryItem): string {
  if (item.account_label && item.account_email) {
    return `${item.account_label} (${item.account_email})`;
  }
  return item.account_label ?? item.account_email ?? "-";
}

function outcomeClass(outcome: RequestHistoryItem["outcome"]): string {
  switch (outcome) {
    case "success":
      return "bg-green-100 text-green-700 border-green-200 dark:bg-[#11281d] dark:text-primary dark:border-[#1a442e]";
    case "aborted":
      return "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800/30";
    default:
      return "bg-red-100 text-red-600 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800/30";
  }
}

interface RequestHistoryTableProps {
  items: RequestHistoryItem[];
  total: number;
  page: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}

/**
 * Stable row identity for expand state + react key. Uses (request_id,
 * timestamp) because request_id can repeat in the JSONL when the proxy
 * retries internally — timestamp disambiguates them.
 */
function rowKey(item: RequestHistoryItem): string {
  return `${item.request_id}-${item.timestamp}`;
}

export function RequestHistoryTable({
  items,
  total,
  page,
  loading,
  onPageChange,
}: RequestHistoryTableProps) {
  const t = useT();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Per-row expand state. A Set of rowKey strings so toggling one row
  // re-renders the whole body once (cheap for the 50-row page cap).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleRow = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Column count including the new fields AND the leading expand chevron:
  // chevron + time + endpoint + model + account + input + output + duration
  // + outcome + request_id + client_ip + ua + req_size + resp_size +
  // fingerprint = 15. Kept as a constant so the empty/loading <td colSpan>
  // stays in sync if the layout changes again.
  const COL_COUNT = 15;

  return (
    <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark overflow-hidden">
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-slate-50 dark:bg-bg-dark text-slate-500 dark:text-text-dim">
            <tr>
              <th class="w-8 px-2 py-3"></th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryTime")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryEndpoint")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryModel")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryAccount")}</th>
              <th class="px-4 py-3 text-right font-medium">{t("totalInputTokens")}</th>
              <th class="px-4 py-3 text-right font-medium">{t("totalOutputTokens")}</th>
              <th class="px-4 py-3 text-right font-medium">{t("requestHistoryDuration")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryOutcome")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryRequestId")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryClientIp")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryUserAgent")}</th>
              <th class="px-4 py-3 text-right font-medium">{t("requestHistoryReqSize")}</th>
              <th class="px-4 py-3 text-right font-medium">{t("requestHistoryRespSize")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryFingerprint")}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={COL_COUNT} class="px-4 py-10 text-center text-slate-400 dark:text-text-dim">Loading...</td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={COL_COUNT} class="px-4 py-10 text-center text-slate-400 dark:text-text-dim">{t("requestHistoryEmpty")}</td>
              </tr>
            ) : (
              items.map((item) => {
                const key = rowKey(item);
                const isOpen = expanded.has(key);
                const ua = item.user_agent ?? null;
                const uaShort = ua ? truncateMiddle(ua, UA_INLINE_MAX) : "-";
                const fp = item.request_fingerprint ?? null;
                const fpShort = fp ? fp.slice(0, FINGERPRINT_INLINE_LEN) : "-";
                return (
                  <Fragment key={key}>
                    <tr class="border-t border-gray-100 dark:border-border-dark align-top">
                      <td class="px-2 py-3 text-center">
                        <button
                          type="button"
                          onClick={() => toggleRow(key)}
                          aria-label={t(isOpen ? "requestHistoryCollapseRow" : "requestHistoryExpandRow")}
                          aria-expanded={isOpen}
                          class="inline-flex items-center justify-center w-6 h-6 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 dark:text-text-dim dark:hover:text-text-main dark:hover:bg-border-dark transition-colors"
                        >
                          <span class={`inline-block transform transition-transform ${isOpen ? "rotate-90" : ""}`}>▸</span>
                        </button>
                      </td>
                      <td class="px-4 py-3 whitespace-nowrap text-slate-700 dark:text-text-main">{formatTimestamp(item.timestamp)}</td>
                      <td class="px-4 py-3">
                        <div class="font-medium text-slate-700 dark:text-text-main">{item.path}</div>
                        <div class="text-xs text-slate-400 dark:text-text-dim">{item.method}{item.streaming ? " • stream" : ""}</div>
                      </td>
                      <td class="px-4 py-3 text-slate-700 dark:text-text-main">{item.model}</td>
                      <td class="px-4 py-3 text-slate-700 dark:text-text-main">{accountLabel(item)}</td>
                      <td class="px-4 py-3 text-right text-slate-700 dark:text-text-main">{item.input_tokens == null ? "-" : formatNumber(item.input_tokens)}</td>
                      <td class="px-4 py-3 text-right text-slate-700 dark:text-text-main">{item.output_tokens == null ? "-" : formatNumber(item.output_tokens)}</td>
                      <td class="px-4 py-3 text-right text-slate-700 dark:text-text-main">{formatDuration(item.duration_ms)}</td>
                      <td class="px-4 py-3">
                        <span class={`inline-flex px-2 py-0.5 rounded-full text-[0.65rem] font-medium border ${outcomeClass(item.outcome)}`}>
                          {t(item.outcome === "success" ? "requestHistoryOutcomeSuccess" : item.outcome === "aborted" ? "requestHistoryOutcomeAborted" : "requestHistoryOutcomeError")}
                        </span>
                        {(item.attempt_count > 1 || item.error_message || item.response_id) && (
                          <div class="mt-1 text-xs text-slate-400 dark:text-text-dim">
                            {item.attempt_count > 1 ? `${t("requestHistoryAttempts")}: ${item.attempt_count}` : null}
                            {item.response_id ? `${item.attempt_count > 1 ? " • " : ""}resp: ${item.response_id}` : null}
                            {item.error_message ? <div class="mt-1 max-w-[240px] break-words">{item.error_message}</div> : null}
                          </div>
                        )}
                      </td>
                      <td class="px-4 py-3">
                        <div class="font-mono text-xs text-slate-700 dark:text-text-main break-all">{item.request_id}</div>
                      </td>
                      <td class="px-4 py-3 font-mono text-xs text-slate-700 dark:text-text-main whitespace-nowrap">
                        {item.client_ip ?? "-"}
                      </td>
                      <td class="px-4 py-3 text-xs text-slate-700 dark:text-text-main whitespace-nowrap" title={ua ?? undefined}>
                        {uaShort}
                      </td>
                      <td class="px-4 py-3 text-right text-xs text-slate-700 dark:text-text-main whitespace-nowrap">
                        {formatBytes(item.request_size_bytes)}
                      </td>
                      <td class="px-4 py-3 text-right text-xs text-slate-700 dark:text-text-main whitespace-nowrap">
                        {formatBytes(item.response_size_bytes)}
                      </td>
                      <td class="px-4 py-3 font-mono text-xs text-slate-700 dark:text-text-main whitespace-nowrap" title={fp ?? undefined}>
                        {fpShort}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr class="bg-slate-50/60 dark:bg-bg-dark/40 border-t border-gray-100 dark:border-border-dark">
                        <td></td>
                        <td colSpan={COL_COUNT - 1} class="px-4 py-3 text-xs text-slate-600 dark:text-text-main">
                          <div class="font-medium text-slate-500 dark:text-text-dim mb-2">{t("requestHistoryDetailsTitle")}</div>
                          <dl class="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
                            <div class="flex gap-2">
                              <dt class="text-slate-400 dark:text-text-dim min-w-[84px]">{t("requestHistoryClientIp")}:</dt>
                              <dd class="font-mono break-all">{item.client_ip ?? "-"}</dd>
                            </div>
                            <div class="flex gap-2">
                              <dt class="text-slate-400 dark:text-text-dim min-w-[84px]">{t("requestHistoryUserAgent")}:</dt>
                              <dd class="break-all">{item.user_agent ?? "-"}</dd>
                            </div>
                            <div class="flex gap-2">
                              <dt class="text-slate-400 dark:text-text-dim min-w-[84px]">{t("requestHistoryReqSize")}:</dt>
                              <dd>
                                {formatBytes(item.request_size_bytes)}
                                {item.request_size_bytes != null && ` (${formatNumber(item.request_size_bytes)} B)`}
                              </dd>
                            </div>
                            <div class="flex gap-2">
                              <dt class="text-slate-400 dark:text-text-dim min-w-[84px]">{t("requestHistoryRespSize")}:</dt>
                              <dd>
                                {formatBytes(item.response_size_bytes)}
                                {item.response_size_bytes != null && ` (${formatNumber(item.response_size_bytes)} B)`}
                              </dd>
                            </div>
                            <div class="flex gap-2 md:col-span-2">
                              <dt class="text-slate-400 dark:text-text-dim min-w-[84px]">{t("requestHistoryFingerprint")}:</dt>
                              <dd class="font-mono break-all">{item.request_fingerprint ?? "-"}</dd>
                            </div>
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div class="flex items-center justify-between px-4 py-3 border-t border-gray-100 dark:border-border-dark text-xs text-slate-500 dark:text-text-dim">
          <span>{t("totalItems")} {total}</span>
          <div class="flex items-center gap-2">
            <button
              onClick={() => onPageChange(Math.max(1, page - 1))}
              disabled={page <= 1}
              class="px-2.5 py-1 rounded-md border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {t("prevPage")}
            </button>
            <span class="font-medium">{page} / {totalPages}</span>
            <button
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              class="px-2.5 py-1 rounded-md border border-gray-200 dark:border-border-dark hover:bg-slate-50 dark:hover:bg-border-dark disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {t("nextPage")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
