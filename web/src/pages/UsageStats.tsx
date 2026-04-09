import { useState } from "preact/hooks";
import { useT } from "../../../shared/i18n/context";
import { useUsageSummary, useUsageHistory, type Granularity } from "../../../shared/hooks/use-usage-stats";
import { useRequestHistory } from "../../../shared/hooks/use-request-history";
import { UsageChart, formatNumber } from "../components/UsageChart";
import { RequestHistoryTable } from "../components/RequestHistoryTable";
import type { TranslationKey } from "../../../shared/i18n/translations";

const granularityOptions: Array<{ value: Granularity; label: TranslationKey }> = [
  { value: "hourly", label: "granularityHourly" },
  { value: "daily", label: "granularityDaily" },
];

const rangeOptions: Array<{ hours: number; label: TranslationKey }> = [
  { hours: 24, label: "last24h" },
  { hours: 72, label: "last3d" },
  { hours: 168, label: "last7d" },
];

const requestRangeOptions: Array<{ hours: number; label: TranslationKey }> = [
  { hours: 24, label: "last24h" },
  { hours: 168, label: "last7d" },
  { hours: 720, label: "last30d" },
];

const requestPathOptions = [
  { value: "all", label: "requestHistoryAllPaths" as TranslationKey },
  { value: "/v1/chat/completions", label: "/v1/chat/completions" },
  { value: "/v1/messages", label: "/v1/messages" },
  { value: "/v1/responses", label: "/v1/responses" },
  { value: "/v1/responses/compact", label: "/v1/responses/compact" },
  { value: "/v1beta/models/:modelAction", label: "/v1beta/models/:modelAction" },
  { value: "/v1/embeddings", label: "/v1/embeddings" },
];

function UsageContent({ t, summary, summaryLoading, granularity, setGranularity, hours, setHours, dataPoints, historyLoading, requestHistory }: {
  t: (key: TranslationKey) => string;
  summary: ReturnType<typeof useUsageSummary>["summary"];
  summaryLoading: boolean;
  granularity: Granularity;
  setGranularity: (g: Granularity) => void;
  hours: number;
  setHours: (h: number) => void;
  dataPoints: ReturnType<typeof useUsageHistory>["dataPoints"];
  historyLoading: boolean;
  requestHistory: ReturnType<typeof useRequestHistory>;
}) {
  return (
    <>
      {/* Summary cards */}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <SummaryCard
          label={t("totalInputTokens")}
          value={summaryLoading ? "—" : formatNumber(summary?.total_input_tokens ?? 0)}
        />
        <SummaryCard
          label={t("totalOutputTokens")}
          value={summaryLoading ? "—" : formatNumber(summary?.total_output_tokens ?? 0)}
        />
        <SummaryCard
          label={t("totalRequestCount")}
          value={summaryLoading ? "—" : formatNumber(summary?.total_request_count ?? 0)}
        />
        <SummaryCard
          label={t("activeAccounts")}
          value={summaryLoading ? "—" : `${summary?.active_accounts ?? 0} / ${summary?.total_accounts ?? 0}`}
        />
      </div>

      {/* Controls */}
      <div class="flex flex-wrap gap-2 mb-4">
        {granularityOptions.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => {
              setGranularity(value);
              // Daily with 24h produces a single bucket — auto-switch to 3d
              if (value === "daily" && hours <= 24) setHours(72);
            }}
            class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
              granularity === value
                ? "bg-primary text-white border-primary"
                : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50"
            }`}
          >
            {t(label)}
          </button>
        ))}
        <div class="w-px h-5 bg-gray-200 dark:bg-border-dark self-center" />
        {rangeOptions
          .filter(({ hours: h }) => !(granularity === "daily" && h <= 24))
          .map(({ hours: h, label }) => (
          <button
            key={h}
            onClick={() => setHours(h)}
            class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
              hours === h
                ? "bg-primary text-white border-primary"
                : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50"
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark p-4">
        {historyLoading ? (
          <div class="text-center py-12 text-slate-400 dark:text-text-dim text-sm">Loading...</div>
        ) : (
          <UsageChart data={dataPoints} />
        )}
      </div>

      <section class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark p-4 mt-6">
        <div class="flex flex-col gap-4">
          <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-800 dark:text-text-main">{t("requestHistoryTitle")}</h2>
              <p class="text-xs text-slate-400 dark:text-text-dim">{t("requestHistoryDesc")}</p>
            </div>
            <button
              onClick={() => requestHistory.exportCsv()}
              class="px-3 py-2 text-xs font-medium rounded-lg border border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-main hover:border-primary/50 transition-colors"
            >
              {t("exportBtn")}
            </button>
          </div>

          <div class="flex flex-col xl:flex-row gap-2">
            <div class="flex flex-wrap gap-2">
              {requestRangeOptions.map(({ hours: h, label }) => (
                <button
                  key={h}
                  onClick={() => requestHistory.setFilter("hours", h)}
                  class={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                    requestHistory.filters.hours === h
                      ? "bg-primary text-white border-primary"
                      : "bg-white dark:bg-card-dark border-gray-200 dark:border-border-dark text-slate-600 dark:text-text-dim hover:border-primary/50"
                  }`}
                >
                  {t(label)}
                </button>
              ))}
            </div>

            <div class="flex flex-1 flex-col md:flex-row gap-2">
              <select
                value={requestHistory.filters.status}
                onChange={(e) => requestHistory.setFilter("status", (e.target as HTMLSelectElement).value as "all" | "success" | "error" | "aborted")}
                class="px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="all">{t("allStatuses")}</option>
                <option value="success">{t("requestHistoryOutcomeSuccess")}</option>
                <option value="error">{t("requestHistoryOutcomeError")}</option>
                <option value="aborted">{t("requestHistoryOutcomeAborted")}</option>
              </select>

              <select
                value={requestHistory.filters.path}
                onChange={(e) => requestHistory.setFilter("path", (e.target as HTMLSelectElement).value)}
                class="px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {requestPathOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label.startsWith("/") ? option.label : t(option.label)}
                  </option>
                ))}
              </select>

              <input
                type="text"
                value={requestHistory.filters.query}
                onInput={(e) => requestHistory.setFilter("query", (e.target as HTMLInputElement).value)}
                placeholder={t("requestHistorySearch")}
                class="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-border-dark rounded-lg bg-white dark:bg-bg-dark text-slate-700 dark:text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          <RequestHistoryTable
            items={requestHistory.items}
            total={requestHistory.total}
            page={requestHistory.filters.page}
            loading={requestHistory.loading}
            onPageChange={(nextPage) => requestHistory.setFilter("page", nextPage)}
          />
        </div>
      </section>
    </>
  );
}

export function UsageStats({ embedded }: { embedded?: boolean } = {}) {
  const t = useT();
  const { summary, loading: summaryLoading } = useUsageSummary();
  const [granularity, setGranularity] = useState<Granularity>("hourly");
  const [hours, setHours] = useState(24);
  const { dataPoints, loading: historyLoading } = useUsageHistory(granularity, hours);
  const requestHistory = useRequestHistory();

  const contentProps = { t, summary, summaryLoading, granularity, setGranularity, hours, setHours, dataPoints, historyLoading, requestHistory };

  if (embedded) {
    return (
      <div class="flex flex-col gap-4">
        <UsageContent {...contentProps} />
      </div>
    );
  }

  return (
    <div class="min-h-screen bg-slate-50 dark:bg-bg-dark flex flex-col">
      <header class="sticky top-0 z-50 bg-white dark:bg-card-dark border-b border-gray-200 dark:border-border-dark px-4 py-3">
        <div class="max-w-[1100px] mx-auto flex items-center gap-3">
          <a
            href="#/"
            class="text-sm text-slate-500 dark:text-text-dim hover:text-primary transition-colors"
          >
            &larr; {t("backToDashboard")}
          </a>
          <h1 class="text-base font-semibold text-slate-800 dark:text-text-main">
            {t("usageStats")}
          </h1>
        </div>
      </header>

      <main class="flex-grow px-4 md:px-8 py-6 max-w-[1100px] mx-auto w-full">
        <UsageContent {...contentProps} />
      </main>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div class="bg-white dark:bg-card-dark rounded-xl border border-gray-200 dark:border-border-dark p-4">
      <div class="text-xs text-slate-500 dark:text-text-dim mb-1">{label}</div>
      <div class="text-lg font-semibold text-slate-800 dark:text-text-main">{value}</div>
    </div>
  );
}
