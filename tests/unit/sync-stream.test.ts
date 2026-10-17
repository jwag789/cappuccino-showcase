import { describe, expect, it } from "vitest";
import { streamingSync } from "@/lib/sync/stream";
import type { SyncResult } from "@/lib/sync/types";

const RESULT: SyncResult = {
  sources: 3,
  items: 42,
  conflictsDetected: 2,
  errors: [],
  notes: [],
};

/** Reads a whole NDJSON body into parsed events. */
async function readEvents(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

describe("streamingSync", () => {
  it("emits every progress event and a terminal done event", async () => {
    const response = streamingSync(async (onProgress) => {
      onProgress({ phase: "fetching", detail: "reading channels" });
      onProgress({ phase: "extracting", done: 1, total: 3 });
      onProgress({ phase: "extracting", done: 3, total: 3 });
      onProgress({ phase: "detecting", detail: "comparing" });
      return RESULT;
    });

    const events = await readEvents(response);
    expect(events.map((e) => e.phase)).toEqual([
      "fetching",
      "extracting",
      "extracting",
      "detecting",
      "done",
    ]);
    expect(events.at(-1)).toMatchObject({ phase: "done", result: RESULT });
  });

  it("serves NDJSON and tells proxies not to buffer it", async () => {
    // Without X-Accel-Buffering an nginx-style proxy holds the whole body and
    // the progress arrives all at once at the end, which defeats the point.
    const response = streamingSync(async () => RESULT);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reports a failure as a final event rather than throwing", async () => {
    // The status line was committed minutes ago, so the body is the only place
    // left to say something went wrong.
    const response = streamingSync(async () => {
      throw new Error("Slack rate limited");
    });

    expect(response.status).toBe(200);
    const events = await readEvents(response);
    expect(events.at(-1)).toEqual({ phase: "error", error: "Slack rate limited" });
  });

  it("keeps progress already sent when the sync fails partway", async () => {
    const response = streamingSync(async (onProgress) => {
      onProgress({ phase: "fetching", detail: "reading channels" });
      onProgress({ phase: "extracting", done: 2, total: 5 });
      throw new Error("model timeout");
    });

    const events = await readEvents(response);
    expect(events.map((e) => e.phase)).toEqual(["fetching", "extracting", "error"]);
  });

  it("puts each event on its own line so a reader can split safely", async () => {
    const response = streamingSync(async (onProgress) => {
      onProgress({ phase: "storing", detail: "2 stored" });
      return RESULT;
    });

    const text = await response.text();
    expect(text.endsWith("\n")).toBe(true);
    for (const line of text.split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
