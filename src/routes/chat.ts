import { Hono } from "hono";
import { ChatCompletionRequestSchema } from "../types/openai.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import { translateToCodexRequest } from "../translation/openai-to-codex.js";
import {
  streamCodexToOpenAI,
  collectCodexResponse,
} from "../translation/codex-to-openai.js";
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

function makeOpenAIFormat(wantReasoning: boolean): FormatAdapter {
  return {
    tag: "Chat",
    noAccountStatus: 503,
    formatNoAccount: () => ({
      error: {
        message:
          "No available accounts. All accounts are expired or rate-limited.",
        type: "server_error",
        param: null,
        code: "no_available_accounts",
      },
    }),
    format429: (msg) => ({
      error: {
        message: msg,
        type: "rate_limit_error",
        param: null,
        code: "rate_limit_exceeded",
      },
    }),
    formatError: (_status, msg) => ({
      error: {
        message: msg,
        type: "server_error",
        param: null,
        code: "codex_api_error",
      },
    }),
    streamTranslator: (api, response, model, onUsage, onResponseId, tupleSchema) =>
      streamCodexToOpenAI(api, response, model, onUsage, onResponseId, wantReasoning, tupleSchema),
    collectTranslator: (api, response, model, tupleSchema) =>
      collectCodexResponse(api, response, model, wantReasoning, tupleSchema),
  };
}

export function createChatRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
  requestHistoryStore?: RequestHistoryStore,
): Hono {
  const app = new Hono();

  app.post("/v1/chat/completions", async (c) => {
    // Auth check
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      recordRequestHistoryFailure(
        requestHistoryStore,
        createRequestHistoryContext(c, "/v1/chat/completions", "unknown", false, "chat"),
        401,
        "invalid_api_key",
        "Not authenticated. Please login first at /",
      );
      return c.json({
        error: {
          message: "Not authenticated. Please login first at /",
          type: "invalid_request_error",
          param: null,
          code: "invalid_api_key",
        },
      });
    }

    // Optional proxy API key check
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const authHeader = c.req.header("Authorization");
      const providedKey = authHeader?.replace("Bearer ", "");
      if (
        !providedKey ||
        !accountPool.validateProxyApiKey(providedKey)
      ) {
        c.status(401);
        recordRequestHistoryFailure(
          requestHistoryStore,
          createRequestHistoryContext(c, "/v1/chat/completions", "unknown", false, "chat"),
          401,
          "invalid_api_key",
          "Invalid proxy API key",
        );
        return c.json({
          error: {
            message: "Invalid proxy API key",
            type: "invalid_request_error",
            param: null,
            code: "invalid_api_key",
          },
        });
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
      const ctx = createRequestHistoryContext(c, "/v1/chat/completions", "unknown", false, "chat");
      if (rawBody) recordRawBody(ctx, rawBody);
      recordRequestHistoryFailure(
        requestHistoryStore,
        ctx,
        400,
        "invalid_json",
        "Malformed JSON request body",
      );
      return c.json({
        error: {
          message: "Malformed JSON request body",
          type: "invalid_request_error",
          param: null,
          code: "invalid_json",
        },
      });
    }
    const parsed = ChatCompletionRequestSchema.safeParse(body);
    if (!parsed.success) {
      c.status(400);
      const rawModel = typeof (body as Record<string, unknown>)?.model === "string"
        ? String((body as Record<string, unknown>).model)
        : "unknown";
      const ctx = createRequestHistoryContext(c, "/v1/chat/completions", rawModel, false, "chat");
      recordRawBody(ctx, rawBody);
      recordRequestHistoryFailure(
        requestHistoryStore,
        ctx,
        400,
        "invalid_request",
        `Invalid request: ${parsed.error.message}`,
      );
      return c.json({
        error: {
          message: `Invalid request: ${parsed.error.message}`,
          type: "invalid_request_error",
          param: null,
          code: "invalid_request",
        },
      });
    }
    const req = parsed.data;

    const { codexRequest, tupleSchema } = translateToCodexRequest(req);
    const displayModel = buildDisplayModelName(parseModelName(req.model));
    const wantReasoning = !!req.reasoning_effort;
    const successCtx = createRequestHistoryContext(
      c,
      "/v1/chat/completions",
      displayModel,
      !!req.stream,
      "chat",
    );
    recordRawBody(successCtx, rawBody);
    const proxyReq = {
      codexRequest,
      model: displayModel,
      isStreaming: req.stream,
      requestHistory: successCtx,
      tupleSchema,
    };
    const fmt = makeOpenAIFormat(wantReasoning);

    if (upstreamRouter && !upstreamRouter.isCodexModel(req.model)) {
      const directReq = { ...proxyReq, codexRequest: { ...codexRequest, model: req.model } };
      return handleDirectRequest(c, upstreamRouter.resolve(req.model), directReq, fmt, requestHistoryStore);
    }

    return handleProxyRequest(c, accountPool, cookieJar, proxyReq, fmt, proxyPool, requestHistoryStore);
  });

  return app;
}
