/**
 * Embeddings route — forwards /v1/embeddings to OpenAI or configured provider.
 * Used by TradeAgent RAG knowledge base.
 */

import { Hono } from "hono";
import type { AccountPool } from "../auth/account-pool.js";
import { getConfig } from "../config.js";
import type { RequestHistoryStore } from "../auth/request-history.js";
import type { UsageInfo } from "../translation/codex-event-extractor.js";
import {
  createRequestHistoryContext,
  finalizeRequestHistory,
  recordRequestHistoryFailure,
} from "./shared/request-history.js";

export function createEmbeddingsRoutes(
  accountPool: AccountPool,
  requestHistoryStore?: RequestHistoryStore,
): Hono {
  const app = new Hono();

  app.post("/v1/embeddings", async (c) => {
    const historyCtx = createRequestHistoryContext(c, "/v1/embeddings", "unknown", false, "embeddings");

    // Auth check
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      recordRequestHistoryFailure(
        requestHistoryStore,
        historyCtx,
        401,
        "invalid_api_key",
        "Not authenticated",
      );
      return c.json({
        error: { message: "Not authenticated", type: "invalid_request_error", code: "invalid_api_key" },
      });
    }

    // Optional proxy API key check
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const authHeader = c.req.header("Authorization");
      const providedKey = authHeader?.replace("Bearer ", "");
      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        recordRequestHistoryFailure(
          requestHistoryStore,
          historyCtx,
          401,
          "invalid_api_key",
          "Invalid proxy API key",
        );
        return c.json({
          error: { message: "Invalid proxy API key", type: "invalid_request_error", code: "invalid_api_key" },
        });
      }
    }

    // Parse body
    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
      if (typeof body.model === "string") {
        historyCtx.model = body.model;
      }
    } catch {
      c.status(400);
      recordRequestHistoryFailure(
        requestHistoryStore,
        historyCtx,
        400,
        "invalid_json",
        "Malformed JSON",
      );
      return c.json({ error: { message: "Malformed JSON", type: "invalid_request_error" } });
    }

    // Determine embedding endpoint: prefer configured OpenAI provider, fall back to openai.com
    const openaiProvider = config.providers?.openai;
    const baseUrl = openaiProvider?.base_url?.replace(/\/$/, "") || "https://api.openai.com/v1";
    const apiKey = openaiProvider?.api_key;

    if (apiKey) {
      // Use configured OpenAI provider API key
      try {
        const res = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        });
        const data = await res.text();
        let usage: UsageInfo | undefined;
        let errorMessage: string | null = null;
        let errorCode: string | null = null;
        try {
          const parsed = JSON.parse(data) as { usage?: { prompt_tokens?: number }; error?: { code?: string; message?: string } };
          if (parsed.usage?.prompt_tokens != null) {
            usage = { input_tokens: parsed.usage.prompt_tokens, output_tokens: 0 };
          }
          errorMessage = parsed.error?.message ?? null;
          errorCode = parsed.error?.code ?? null;
        } catch {
          // best effort only
        }
        finalizeRequestHistory(requestHistoryStore, undefined, historyCtx, {
          statusCode: res.status,
          outcome: res.ok ? "success" : "error",
          errorCode,
          errorMessage: res.ok ? null : (errorMessage ?? `Embeddings upstream returned ${res.status}`),
          usage,
          attemptCount: 1,
        });
        c.status(res.status as any);
        c.header("Content-Type", "application/json");
        return c.body(data);
      } catch (err: any) {
        c.status(502);
        recordRequestHistoryFailure(
          requestHistoryStore,
          historyCtx,
          502,
          "upstream_error",
          `Upstream error: ${err.message}`,
        );
        return c.json({ error: { message: `Upstream error: ${err.message}`, type: "server_error" } });
      }
    }

    // No OpenAI API key configured — embeddings require an API key
    c.status(501);
    recordRequestHistoryFailure(
      requestHistoryStore,
      historyCtx,
      501,
      "missing_upstream_api_key",
      "Embeddings require an OpenAI API key. Configure providers.openai.api_key in local.yaml",
    );
    return c.json({
      error: {
        message: "Embeddings require an OpenAI API key. Configure providers.openai.api_key in local.yaml",
        type: "server_error",
      },
    });
  });

  return app;
}
