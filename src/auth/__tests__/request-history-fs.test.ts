import { resolve } from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const DATA_DIR = "C:/tmp/request-history";
const FILE_PATH = resolve(DATA_DIR, "request-history.jsonl");
const TMP_PATH = `${FILE_PATH}.tmp`;

const files = new Map<string, string>();
const renameSync = vi.fn((from: string, to: string) => {
  const content = files.get(from);
  if (content == null) {
    throw new Error(`ENOENT: ${from}`);
  }
  files.set(to, content);
  files.delete(from);
});

vi.mock("fs", () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn((path: string) => files.has(path)),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn((path: string) => {
    const content = files.get(path);
    if (content == null) {
      throw new Error(`ENOENT: ${path}`);
    }
    return content;
  }),
  renameSync,
  unlinkSync: vi.fn((path: string) => files.delete(path)),
  writeFileSync: vi.fn((path: string, content: string) => files.set(path, content)),
}));

vi.mock("../../paths.js", () => ({
  getDataDir: vi.fn(() => DATA_DIR),
}));

describe("createFsRequestHistoryPersistence", () => {
  beforeEach(() => {
    files.clear();
    renameSync.mockClear();
  });

  it("recovers from a stale tmp file when the main file is missing", async () => {
    files.set(
      TMP_PATH,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        request_id: "req_tmp",
        response_id: null,
        path: "/v1/responses",
        method: "POST",
        model: "gpt-5.4",
        streaming: true,
        route_family: "responses",
        account_entry_id: null,
        account_email: null,
        account_label: null,
        status_code: 200,
        outcome: "success",
        error_code: null,
        error_message: null,
        duration_ms: 100,
        input_tokens: 1,
        output_tokens: 2,
        cached_tokens: null,
        reasoning_tokens: null,
        attempt_count: 1,
      })}\n`,
    );

    const { createFsRequestHistoryPersistence } = await import("../request-history.js");
    const records = createFsRequestHistoryPersistence().load();

    expect(records).toHaveLength(1);
    expect(records[0].request_id).toBe("req_tmp");
    expect(renameSync).toHaveBeenCalledWith(TMP_PATH, FILE_PATH);
  });
});
