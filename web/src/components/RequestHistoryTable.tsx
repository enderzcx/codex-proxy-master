import type { RequestHistoryItem } from "../../../shared/hooks/use-request-history";
import { formatNumber } from "./UsageChart";
import { useT } from "../../../shared/i18n/context";

const PAGE_SIZE = 50;

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

export function RequestHistoryTable({
  items,
  total,
  page,
  loading,
  onPageChange,
}: RequestHistoryTableProps) {
  const t = useT();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark overflow-hidden">
      <div class="overflow-x-auto">
        <table class="min-w-full text-sm">
          <thead class="bg-slate-50 dark:bg-bg-dark text-slate-500 dark:text-text-dim">
            <tr>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryTime")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryEndpoint")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryModel")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryAccount")}</th>
              <th class="px-4 py-3 text-right font-medium">{t("totalInputTokens")}</th>
              <th class="px-4 py-3 text-right font-medium">{t("totalOutputTokens")}</th>
              <th class="px-4 py-3 text-right font-medium">{t("requestHistoryDuration")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryOutcome")}</th>
              <th class="px-4 py-3 text-left font-medium">{t("requestHistoryRequestId")}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} class="px-4 py-10 text-center text-slate-400 dark:text-text-dim">Loading...</td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={9} class="px-4 py-10 text-center text-slate-400 dark:text-text-dim">{t("requestHistoryEmpty")}</td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={`${item.request_id}-${item.timestamp}`} class="border-t border-gray-100 dark:border-border-dark align-top">
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
                </tr>
              ))
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
