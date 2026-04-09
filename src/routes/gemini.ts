/**
 * Google Gemini API route handler.
 * POST /v1beta/models/{model}:generateContent — non-streaming
 * POST /v1beta/models/{model}:streamGenerateContent — streaming
 */

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import type { GeminiErrorResponse } from "../types/gemini.js";
import { GEMINI_STATUS_MAP } from "../types/gemini.js";
import { GeminiGenerateContentRequestSchema } from "../types/gemini.js";
import type { AccountPool } from "../auth/account-pool.js";
import type { CookieJar } from "../proxy/cookie-jar.js";
import type { ProxyPool } from "../proxy/proxy-pool.js";
import {
  translateGeminiToCodexRequest,
} from "../translation/gemini-to-codex.js";
import {
  streamCodexToGemini,
  collectCodexToGeminiResponse,
} from "../translation/codex-to-gemini.js";
import { getConfig } from "../config.js";
import { getModelCatalog } from "../models/model-store.js";
import {
  handleProxyRequest,
  handleDirectRequest,
  type FormatAdapter,
} from "./shared/proxy-handler.js";
import type { UpstreamRouter } from "../proxy/upstream-router.js";
import type { RequestHistoryStore } from "../auth/request-history.js";
import {
  createRequestHistoryContext,
  recordRequestHistoryFailure,
} from "./shared/request-history.js";

function makeError(
  code: number,
  message: string,
  status?: string,
): GeminiErrorResponse {
  return {
    error: {
      code,
      message,
      status: status ?? GEMINI_STATUS_MAP[code] ?? "INTERNAL",
    },
  };
}

/**
 * Parse model name and action from the URL param.
 * e.g. "gemini-2.5-pro:generateContent" → { model: "gemini-2.5-pro", action: "generateContent" }
 */
function parseModelAction(param: string): {
  model: string;
  action: string;
} | null {
  const lastColon = param.lastIndexOf(":");
  if (lastColon <= 0) return null;
  return {
    model: param.slice(0, lastColon),
    action: param.slice(lastColon + 1),
  };
}

const GEMINI_FORMAT: FormatAdapter = {
  tag: "Gemini",
  noAccountStatus: 503,
  formatNoAccount: () =>
    makeError(
      503,
      "No available accounts. All accounts are expired or rate-limited.",
      "UNAVAILABLE",
    ),
  format429: (msg) => makeError(429, msg, "RESOURCE_EXHAUSTED"),
  formatError: (status, msg) => makeError(status, msg),
  streamTranslator: (api, response, model, onUsage, onResponseId, tupleSchema) =>
    streamCodexToGemini(api, response, model, onUsage, onResponseId, tupleSchema),
  collectTranslator: (api, response, model, tupleSchema) =>
    collectCodexToGeminiResponse(api, response, model, tupleSchema),
};

export function createGeminiRoutes(
  accountPool: AccountPool,
  cookieJar?: CookieJar,
  proxyPool?: ProxyPool,
  upstreamRouter?: UpstreamRouter,
  requestHistoryStore?: RequestHistoryStore,
): Hono {
  const app = new Hono();

  // Handle both generateContent and streamGenerateContent
  app.post("/v1beta/models/:modelAction", async (c) => {
    const modelActionParam = c.req.param("modelAction");
    const parsed = parseModelAction(modelActionParam);

    if (
      !parsed ||
      (parsed.action !== "generateContent" &&
        parsed.action !== "streamGenerateContent")
    ) {
      c.status(400);
      recordRequestHistoryFailure(
        requestHistoryStore,
        createRequestHistoryContext(c, "/v1beta/models/:modelAction", "unknown", false, "gemini"),
        400,
        "invalid_request",
        `Invalid action. Expected :generateContent or :streamGenerateContent, got: ${modelActionParam}`,
      );
      return c.json(
        makeError(
          400,
          `Invalid action. Expected :generateContent or :streamGenerateContent, got: ${modelActionParam}`,
        ),
      );
    }

    const { model: geminiModel, action } = parsed;
    const isStreaming =
      action === "streamGenerateContent" ||
      c.req.query("alt") === "sse";

    // Auth check
    if (!accountPool.isAuthenticated()) {
      c.status(401);
      recordRequestHistoryFailure(
        requestHistoryStore,
        createRequestHistoryContext(c, "/v1beta/models/:modelAction", geminiModel, isStreaming, "gemini"),
        401,
        "invalid_api_key",
        "Not authenticated. Please login first at /",
      );
      return c.json(
        makeError(401, "Not authenticated. Please login first at /"),
      );
    }

    // API key check: query param ?key= or header x-goog-api-key
    const config = getConfig();
    if (config.server.proxy_api_key) {
      const queryKey = c.req.query("key");
      const headerKey = c.req.header("x-goog-api-key");
      const authHeader = c.req.header("Authorization");
      const bearerKey = authHeader?.replace("Bearer ", "");
      const providedKey = queryKey ?? headerKey ?? bearerKey;

      if (!providedKey || !accountPool.validateProxyApiKey(providedKey)) {
        c.status(401);
        recordRequestHistoryFailure(
          requestHistoryStore,
          createRequestHistoryContext(c, "/v1beta/models/:modelAction", geminiModel, isStreaming, "gemini"),
          401,
          "invalid_api_key",
          "Invalid API key",
        );
        return c.json(makeError(401, "Invalid API key"));
      }
    }

    // Parse request
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      c.status(400);
      recordRequestHistoryFailure(
        requestHistoryStore,
        createRequestHistoryContext(c, "/v1beta/models/:modelAction", geminiModel, isStreaming, "gemini"),
        400,
        "invalid_json",
        "Invalid JSON in request body",
      );
      return c.json(makeError(400, "Invalid JSON in request body"));
    }
    const validationResult = GeminiGenerateContentRequestSchema.safeParse(body);
    if (!validationResult.success) {
      c.status(400);
      recordRequestHistoryFailure(
        requestHistoryStore,
        createRequestHistoryContext(c, "/v1beta/models/:modelAction", geminiModel, isStreaming, "gemini"),
        400,
        "invalid_request",
        `Invalid request: ${validationResult.error.message}`,
      );
      return c.json(
        makeError(400, `Invalid request: ${validationResult.error.message}`),
      );
    }
    const req = validationResult.data;

    const { codexRequest, tupleSchema } = translateGeminiToCodexRequest(
      req,
      geminiModel,
    );

    console.log(
      `[Gemini] Model: ${geminiModel} → ${codexRequest.model}`,
    );

    const proxyReq = {
      codexRequest,
      model: geminiModel,
      isStreaming,
      requestHistory: createRequestHistoryContext(
        c,
        "/v1beta/models/:modelAction",
        geminiModel,
        isStreaming,
        "gemini",
      ),
      tupleSchema,
    };

    if (upstreamRouter && !upstreamRouter.isCodexModel(geminiModel)) {
      const directReq = { ...proxyReq, codexRequest: { ...codexRequest, model: geminiModel } };
      return handleDirectRequest(c, upstreamRouter.resolve(geminiModel), directReq, GEMINI_FORMAT, requestHistoryStore);
    }

    return handleProxyRequest(c, accountPool, cookieJar, proxyReq, GEMINI_FORMAT, proxyPool, requestHistoryStore);
  });

  // List available models (Gemini format)
  app.get("/v1beta/models", (c) => {
    const catalog = getModelCatalog();
    const models = catalog.map((m) => ({
      name: `models/${m.id}`,
      displayName: m.displayName,
      description: m.description,
      supportedGenerationMethods: [
        "generateContent",
        "streamGenerateContent",
      ],
    }));

    return c.json({ models });
  });

  return app;
}
