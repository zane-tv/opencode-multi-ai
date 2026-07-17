import type { OpenAIChatCompletionChunk } from "./openai-converter.js";

export type SseResponseOptions = {
  readonly onClose?: () => void;
  readonly signal?: AbortSignal;
};

export function createSseResponse(
  chunks: AsyncIterable<OpenAIChatCompletionChunk>,
  options: SseResponseOptions = {},
): Response {
  const iterator = chunks[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  let closed = false;
  let finalized = false;
  let iteratorReleased = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    options.onClose?.();
  };
  const detachAbort = (): void => {
    options.signal?.removeEventListener("abort", abort);
  };
  const releaseIterator = (): void => {
    if (iteratorReleased) return;
    iteratorReleased = true;
    const result = iterator.return?.();
    if (result) void Promise.resolve(result).catch(() => undefined);
  };
  const abort = (): void => {
    if (closed) return;
    closed = true;
    detachAbort();
    releaseIterator();
    controller?.close();
    finalize();
  };

  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
    },
    async pull(streamController) {
      if (closed) return;
      try {
        const next = await iterator.next();
        if (closed) return;
        if (next.done) {
          closed = true;
          detachAbort();
          streamController.enqueue(encoder.encode("data: [DONE]\n\n"));
          streamController.close();
          finalize();
          return;
        }
        streamController.enqueue(
          encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`),
        );
      } catch (error) {
        if (closed) return;
        closed = true;
        detachAbort();
        releaseIterator();
        streamController.error(error);
        finalize();
      }
    },
    cancel() {
      if (!closed) closed = true;
      detachAbort();
      releaseIterator();
      finalize();
    },
  });

  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}
