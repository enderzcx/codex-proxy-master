/**
 * Anthropic Messages API route handler.
 * POST /v1/messages — compatible with Claude Code CLI and other Anthropic clients.
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { AnthropicMessagesRequestSchema } from "../types/anthropic.js";
import type { AnthropicErrorBody, AnthropicErrorType } from "../types/anthropic.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { translateAnthropicToCodexRequest } from "../translation/anthropic-to-codex.js";
import {
  streamCodexToAnthropic,
  collectCodexToAnthropicResponse,
} from "../translation/codex-to-anthropic.js";
import { getConfig } from "../config.js";
import { parseModelName, buildDisplayModelName } from "../models/model-store.js";
import {
  handleProxyRequest,
  handleDirectRequest,
  type FormatAdapter,
} from "./shared/proxy-handler.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import type { RequestHistoryStore } from "../auth/request-history.js";
import {
  createRequestHistoryContext,
  recordRawBody,
  recordRequestHistoryFailure,
} from "./shared/request-history.js";

function makeError(
  type: AnthropicErrorType,
  message: string,
): AnthropicErrorBody {
  return { type: "error", error: { type, message } };
}

function makeAnthropicFormat(wantThinking: boolean): FormatAdapter {
  return {
    tag: "Messages",
    noAccountStatus: 529 as StatusCode,
    formatNoAccount: () =>
      makeError(
        "overloaded_error",
        "No available accounts. All accounts are expired or rate-limited.",
      ),
    format429: (msg) => makeError("rate_limit_error", msg),
    formatError: (_status, msg) => makeError("api_error", msg),
    streamTranslator: (api, response, model, onUsage, onResponseId, _tupleSchema) =>
      streamCodexToAnthropic(api, response, model, onUsage, onResponseId, wantThinking),
    collectTranslator: (api, response, model, _tupleSchema) =>
      collectCodexToAnthropicResponse(api, response, model, wantThinking),
  };
}

export function createMessagesRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
  requestHistoryStore?: RequestHistoryStore,
): Hono {
  const app = new Hono();

  app.post("/v1/messages", async (c) => {
    // Auth check
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      recordRequestHistoryFailure(
        requestHistoryStore,
        createRequestHistoryContext(c, "/v1/messages", "unknown", false, "messages"),
        401,
        "invalid_api_key",
        "Not authenticated. Please login first at /",
      );
      return c.json(
        makeError("authentication_error", "Not authenticated. Please login first at /"),
      );
    }

    // Optional proxy API key check (x-api-key or Bearer token)
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const xApiKey = c.req.header("x-api-key");
      const authHeader = c.req.header("Authorization");
      const bearerKey = authHeader?.replace("Bearer ", "");
      const providedKey = xApiKey ?? bearerKey;

      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        recordRequestHistoryFailure(
          requestHistoryStore,
          createRequestHistoryContext(c, "/v1/messages", "unknown", false, "messages"),
          401,
          "invalid_api_key",
          "Invalid API key",
        );
        return c.json(makeError("authentication_error", "Invalid API key"));
      }
    }

    // Parse request
    let rawBody: string = "";
    let body: unknown;
    try {
      rawBody = await c.req.text();
      body = JSON.parse(rawBody);
    } catch {
      c.status(400);
      const ctx = createRequestHistoryContext(c, "/v1/messages", "unknown", false, "messages");
      if (rawBody) recordRawBody(ctx, rawBody);
      recordRequestHistoryFailure(
        requestHistoryStore,
        ctx,
        400,
        "invalid_json",
        "Invalid JSON in request body",
      );
      return c.json(
        makeError("invalid_request_error", "Invalid JSON in request body"),
      );
    }
    const parsed = AnthropicMessagesRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      const rawModel = typeof (body as Record<string, unknown>)?.model === "string"
        ? String((body as Record<string, unknown>).model)
        : "unknown";
      const ctx = createRequestHistoryContext(c, "/v1/messages", rawModel, false, "messages");
      recordRawBody(ctx, rawBody);
      recordRequestHistoryFailure(
        requestHistoryStore,
        ctx,
        400,
        "invalid_request",
        `Invalid request: ${parsed.error.message}`,
      );
      return c.json(
        makeError("invalid_request_error", `Invalid request: ${parsed.error.message}`),
      );
    }
    const req = parsed.data;

    const codexRequest = translateAnthropicToCodexRequest(req);
    const wantThinking = req.thinking?.type === "enabled" || req.thinking?.type === "adaptive";
    const displayModel = buildDisplayModelName(parseModelName(req.model));
    const successCtx = createRequestHistoryContext(
      c,
      "/v1/messages",
      displayModel,
      !!req.stream,
      "messages",
    );
    recordRawBody(successCtx, rawBody);
    const proxyReq = {
      codexRequest,
      model: displayModel,
      isStreaming: req.stream,
      requestHistory: successCtx,
    };
    const fmt = makeAnthropicFormat(wantThinking);

    if (upstreamRouter && !upstreamRouter.isCodexModel(req.model)) {
      const directReq = { ...proxyReq, codexRequest: { ...codexRequest, model: req.model } };
      return handleDirectRequest(c, upstreamRouter.resolve(req.model), directReq, fmt, requestHistoryStore);
    }

    return handleProxyRequest(c, accountPool, cookieJar, proxyReq, fmt, proxyPool, requestHistoryStore);
  });

  return app;
}
