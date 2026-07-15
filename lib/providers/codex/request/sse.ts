/**
 * Convert a Codex Responses SSE stream into a single JSON Response.
 *
 * Used when the caller requested stream:false but the backend still emits
 * text/event-stream. Stream mode (stream:true) must pass the body through
 * untouched — this helper is only for the non-stream path.
 *
 * Bounds:
 *  - stall timeout ~45s between chunks (or until first byte if empty)
 *  - hard size cap ~10MB accumulated text
 */

const DEFAULT_STALL_MS = 45_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export type ConvertSseOptions = {
  stallTimeoutMs?: number;
  maxBytes?: number;
};

/**
 * Read the full SSE body with stall/size guards and extract the best JSON
 * payload (prefer `response.completed` / `response.done` event data, else the
 * last parseable `data:` line, else wrap raw text).
 */
export async function convertSseToJson(
  res: Response,
  options?: ConvertSseOptions,
): Promise<Response> {
  const stallMs = options?.stallTimeoutMs ?? DEFAULT_STALL_MS;
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  const text = await readBodyWithGuards(res, stallMs, maxBytes);
  const jsonText = extractJsonFromSse(text);

  const headers = new Headers(res.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  // Length may change after conversion.
  headers.delete("content-length");

  return new Response(jsonText, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function readBodyWithGuards(
  res: Response,
  stallMs: number,
  maxBytes: number,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const decoder = new TextDecoder();

  try {
    while (total < maxBytes) {
      const { done, value } = await readWithStall(reader, stallMs);
      if (done) break;
      if (value && value.byteLength > 0) {
        const remaining = maxBytes - total;
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          total = maxBytes;
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  // Concatenate without relying on Buffer (browser-safe path).
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return decoder.decode(merged);
}

function readWithStall(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stallMs: number,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`SSE stall: no data for ${stallMs}ms`));
    }, stallMs);
    reader
      .read()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Prefer the data payload of response.completed / response.done events.
 * Fall back to the last JSON-looking `data:` line, else wrap raw text.
 */
export function extractJsonFromSse(sseText: string): string {
  if (!sseText.trim()) return "{}";

  const events = splitSseEvents(sseText);
  let completedData: string | undefined;
  let lastJsonData: string | undefined;

  for (const ev of events) {
    if (!ev.data) continue;
    const data = ev.data;
    if (data === "[DONE]") continue;

    // Track last parseable JSON data line.
    if (looksLikeJson(data)) lastJsonData = data;

    const eventName = (ev.event ?? "").toLowerCase();
    if (
      eventName === "response.completed" ||
      eventName === "response.done" ||
      eventName === "response.completed.failed"
    ) {
      if (looksLikeJson(data)) completedData = data;
    } else if (!eventName && looksLikeJson(data)) {
      // Some backends put type inside the JSON payload.
      try {
        const parsed = JSON.parse(data) as { type?: string; response?: unknown };
        const t = typeof parsed.type === "string" ? parsed.type : "";
        if (
          t === "response.completed" ||
          t === "response.done" ||
          (parsed.response && typeof parsed.response === "object")
        ) {
          // Prefer full completed envelope; if nested response, keep envelope.
          completedData = data;
        }
      } catch {
        // ignore
      }
    }
  }

  const chosen = completedData ?? lastJsonData;
  if (chosen) return chosen;

  // Not SSE-shaped — maybe already JSON.
  if (looksLikeJson(sseText.trim())) return sseText.trim();

  return JSON.stringify({ raw: sseText });
}

function looksLikeJson(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

type SseEvent = { event?: string; data?: string };

function splitSseEvents(text: string): SseEvent[] {
  // Normalize newlines; split on blank line (SSE event boundary).
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n\n+/);
  const out: SseEvent[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":") || line.trim() === "") continue;
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^\s/, ""));
        continue;
      }
      // Bare JSON line without data: prefix (lenient).
      if (looksLikeJson(line)) dataLines.push(line.trim());
    }
    if (dataLines.length === 0 && !event) continue;
    out.push({
      event,
      data: dataLines.length > 0 ? dataLines.join("\n") : undefined,
    });
  }
  return out;
}
