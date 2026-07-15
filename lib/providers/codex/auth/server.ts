import http from "node:http";

import {
  CALLBACK_HOST,
  CALLBACK_PATH,
  CALLBACK_PORT,
} from "../constants.js";
import { logger } from "../../../core/logger.js";

/**
 * One-shot local callback server for the Codex loopback OAuth flow.
 *
 * Public redirect_uri uses `localhost:1455/auth/callback` (registered with
 * the OAuth client). We bind concrete loopback interfaces 127.0.0.1 and ::1
 * so dual-stack OS resolution can land on either without dropping the code.
 *
 * Resolves with the authorization `code` when the browser hits CALLBACK_PATH,
 * after validating `state`. Serves a small HTML success page and shuts down.
 * Times out after ~180s.
 */

const DEFAULT_TIMEOUT_MS = 180_000;

/** Bind hosts: IPv4 primary + IPv6 loopback when available. */
const BIND_HOSTS = [CALLBACK_HOST, "::1"] as const;

export interface CallbackResult {
  code: string;
  state: string;
}

/** Escape a string for safe interpolation into HTML text/attribute context. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlPage(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0b0b0d;
         color: #e6e6e6; display: grid; place-items: center; height: 100vh; margin: 0; }
  .card { text-align: center; padding: 2.5rem 3rem; border: 1px solid #23232a;
          border-radius: 14px; background: #141419; max-width: 30rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: #a1a1aa; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="card">
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
  </div>
</body>
</html>`;
}

function bindOne(
  host: string,
  handler: http.RequestListener,
): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    let settled = false;
    const settle = (value: http.Server | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    server.once("error", (err) => {
      logger.warn(
        `callback bind failed on ${host}:${CALLBACK_PORT}: ${(err as Error).message}`,
      );
      try {
        server.close();
      } catch {
        /* ignore */
      }
      settle(null);
    });
    server.listen(CALLBACK_PORT, host, () => {
      logger.debug(
        `callback server listening on http://${host}:${CALLBACK_PORT}${CALLBACK_PATH}`,
      );
      settle(server);
    });
  });
}

/**
 * Start the one-shot callback server and wait for the OAuth redirect.
 *
 * @param expectedState the `state` value generated for this authorize request.
 * @param timeoutMs how long to wait before rejecting (default ~180s).
 */
export function waitForCallback(
  expectedState: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let settled = false;
    const servers: http.Server[] = [];

    if (signal?.aborted) {
      reject(Object.assign(new Error("login cancelled"), { name: "AbortError" }));
      return;
    }

    const handler: http.RequestListener = (req, res) => {
      const url = new URL(
        req.url ?? "/",
        `http://localhost:${CALLBACK_PORT}`,
      );

      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }

      const params = url.searchParams;
      const error = params.get("error");
      const code = params.get("code");
      const state = params.get("state");

      if (error) {
        const desc = params.get("error_description") ?? error;
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Login failed", desc));
        finish(new Error(`OAuth error: ${error} — ${desc}`));
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Login failed", "Missing code or state."));
        finish(new Error("callback missing code or state"));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(htmlPage("Login failed", "State mismatch (possible CSRF)."));
        finish(new Error("state mismatch on OAuth callback"));
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        htmlPage(
          "Login complete",
          "You can close this window and return to your terminal.",
        ),
      );
      finish(null, { code, state });
    };

    const timer = setTimeout(() => {
      finish(new Error(`timed out after ${timeoutMs}ms waiting for callback`));
    }, timeoutMs);
    timer.unref?.();

    function finish(err: Error | null, result?: CallbackResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      setImmediate(() => {
        for (const s of servers) {
          try {
            s.close();
          } catch {
            /* ignore */
          }
        }
      });
      if (err) reject(err);
      else resolve(result as CallbackResult);
    }

    const onAbort = () => {
      finish(Object.assign(new Error("login cancelled"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Bind all loopback hosts; require at least IPv4 (primary).
    void (async () => {
      for (const host of BIND_HOSTS) {
        const server = await bindOne(host, handler);
        if (server) servers.push(server);
      }
      if (servers.length === 0) {
        finish(
          new Error(
            `failed to bind callback on port ${CALLBACK_PORT} (tried ${BIND_HOSTS.join(", ")})`,
          ),
        );
      }
    })();
  });
}
