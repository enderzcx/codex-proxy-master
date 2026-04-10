/**
 * Response processing helpers for the proxy handler.
 *
 * Encapsulates streaming (SSE) and non-streaming (collect) response paths.
 */

import type { UpstreamAdapter } from "../../proxy/upstream-adapter.js";
import type { FormatAdapter } from "./proxy-handler.js";
import type { UsageInfo } from "../../translation/codex-event-extractor.js";

/** Minimal subset of Hono's StreamingApi that we actually use. */
export interface StreamWriter {
  write(chunk: string): Promise<unknown>;
  onAbort(cb: () => void): void;
}

export interface StreamResult {
  aborted: boolean;
  errorMessage: string | null;
  /** v2: total bytes written to the client SSE stream (includes framing). */
  responseBytes: number;
}

/**
 * Stream SSE chunks from the Codex upstream to the client.
 *
 * Handles: client disconnect (stops reading upstream), stream errors
 * (sends error SSE event before closing).
 */
export async function streamResponse(
  s: StreamWriter,
  api: UpstreamAdapter,
  rawResponse: Response,
  model: string,
  adapter: FormatAdapter,
  onUsage: (u: UsageInfo) => void,
  tupleSchema?: Record<string, unknown> | null,
  onResponseId?: (id: string) => void,
): Promise<StreamResult> {
  let responseBytes = 0;
  try {
    for await (const chunk of adapter.streamTranslator(
      api,
      rawResponse,
      model,
      onUsage,
      onResponseId ?? (() => {}),
      tupleSchema,
    )) {
      try {
        await s.write(chunk);
        responseBytes += Buffer.byteLength(chunk, "utf-8");
      } catch {
        // Client disconnected mid-stream — stop reading upstream
        return { aborted: true, errorMessage: null, responseBytes };
      }
    }
    return { aborted: false, errorMessage: null, responseBytes };
  } catch (err) {
    // Send error SSE event to client before closing
    const errMsg = err instanceof Error ? err.message : "Stream interrupted";
    try {
      const errChunk = `data: ${JSON.stringify({ error: { message: errMsg, type: "stream_error" } })}\n\n`;
      await s.write(errChunk);
      responseBytes += Buffer.byteLength(errChunk, "utf-8");
    } catch { /* client already gone */ }
    return { aborted: false, errorMessage: errMsg, responseBytes };
  }
}
