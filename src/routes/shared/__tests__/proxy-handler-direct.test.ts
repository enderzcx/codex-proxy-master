import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { handleDirectRequest, type FormatAdapter } from "../proxy-handler.js";
import { createRequestHistoryContext } from "../request-history.js";

describe("handleDirectRequest", () => {
  it("records usage and response id for streaming direct upstream requests", async () => {
    const historyStore = { record: vi.fn() };
    const upstream = {
      tag: "openai",
      createResponse: vi.fn(async () => new Response("ok")),
      parseStream: vi.fn(),
    };

    const format: FormatAdapter = {
      tag: "DirectTest",
      noAccountStatus: 503,
      formatNoAccount: () => ({ error: "no_account" }),
      format429: (message: string) => ({ error: message }),
      formatError: (_status: number, message: string) => ({ error: message }),
      streamTranslator: async function* (
        _api,
        _response,
        _model,
        onUsage,
        onResponseId,
      ) {
        onResponseId("resp_stream_1");
        onUsage({
          input_tokens: 11,
          output_tokens: 22,
          cached_tokens: 3,
          reasoning_tokens: 4,
        });
        yield "data: done\n\n";
      },
      collectTranslator: vi.fn(),
    };

    const app = new Hono();
    app.post("/direct-stream", (c) => {
      c.set("requestId", "req_stream_1");
      return handleDirectRequest(
        c,
        upstream as never,
        {
          codexRequest: {
            model: "gpt-5.4",
            input: [],
            stream: true,
            store: false,
          } as never,
          model: "gpt-5.4",
          isStreaming: true,
          requestHistory: createRequestHistoryContext(c, "/v1/responses", "gpt-5.4", true, "responses"),
        },
        format,
        historyStore as never,
      );
    });

    const res = await app.request("/direct-stream", { method: "POST" });
    expect(res.status).toBe(200);
    await res.text();

    expect(historyStore.record).toHaveBeenCalledWith(expect.objectContaining({
      request_id: "req_stream_1",
      response_id: "resp_stream_1",
      outcome: "success",
      input_tokens: 11,
      output_tokens: 22,
      cached_tokens: 3,
      reasoning_tokens: 4,
      attempt_count: 1,
    }));
  });
});
