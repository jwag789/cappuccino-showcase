import type { OnSyncProgress, SyncProgress, SyncResult } from "./types";

/**
 * Wraps a sync in a streamed NDJSON response so the browser can show progress.
 *
 * A sync is already a single blocking request with `maxDuration = 300` — this
 * does not hold the connection open any longer than before, it just stops the
 * connection being silent for the whole time. One JSON object per line, because
 * the client only appends events and needs no event types or reconnection
 * semantics that SSE would bring.
 *
 * Errors are reported as a final event rather than a status code: by the time a
 * sync fails, the response has been open for minutes and the 200 is long gone.
 * The client reads the last line to decide whether it worked.
 */
export function streamingSync(
  run: (onProgress: OnSyncProgress) => Promise<SyncResult>
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: SyncProgress | { phase: "error"; error: string }) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The client navigated away mid-sync. The work itself continues —
          // artifacts are already durably stored — so there is nothing to undo.
        }
      };

      try {
        send({ phase: "done", result: await run(send) });
      } catch (error) {
        send({
          phase: "error",
          error: error instanceof Error ? error.message : "Sync failed.",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Without this an nginx-style proxy buffers the whole body and the
      // progress arrives all at once at the end, which is worse than nothing.
      "X-Accel-Buffering": "no",
    },
  });
}
