import dns from "node:dns/promises";
import https from "node:https";
import { Readable } from "node:stream";
import { logger } from "../../../core/logger.js";

const resolver = new dns.Resolver();
resolver.setServers(["8.8.8.8", "1.1.1.1"]);

const googleAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60_000,
  maxSockets: 32,
  maxFreeSockets: 10,
  timeout: 60_000,
});

const ipCache = new Map<string, { ip: string; cachedAt: number }>();

export async function resolveRealGoogleIp(hostname: string): Promise<string> {
  const cached = ipCache.get(hostname);
  if (cached && Date.now() - cached.cachedAt < 300_000) {
    return cached.ip;
  }
  try {
    const ips = await resolver.resolve4(hostname);
    if (ips && ips.length > 0) {
      ipCache.set(hostname, { ip: ips[0], cachedAt: Date.now() });
      return ips[0];
    }
  } catch (err) {
    logger.warn(`Failed to resolve ${hostname} via public DNS: ${(err as Error).message}`);
  }
  return hostname;
}

/**
 * Direct HTTPS fetch bypassing /etc/hosts MITM hijack.
 * Uses real public Google DNS IP + TLS SNI with official Google cert verification.
 */
export async function directGoogleFetch(
  urlStr: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const parsed = new URL(urlStr);
  const realIp = await resolveRealGoogleIp(parsed.hostname);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
    };

    if (typeof init.timeoutMs === "number" && init.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          req.destroy(new Error(`Request timed out after ${init.timeoutMs}ms`));
          reject(new Error(`Request timed out after ${init.timeoutMs}ms`));
        }
      }, init.timeoutMs);
    }

    const headersRecord: Record<string, string> = {};
    const headers = new Headers(init.headers);
    for (const [k, v] of headers.entries()) {
      headersRecord[k] = v;
    }
    headersRecord["Host"] = parsed.hostname;

    const bodyStr =
      typeof init.body === "string"
        ? init.body
        : init.body
          ? JSON.stringify(init.body)
          : undefined;

    if (bodyStr && !headersRecord["Content-Length"]) {
      headersRecord["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }

    const reqOptions: https.RequestOptions = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: init.method || "POST",
      headers: headersRecord,
      agent: googleAgent,
      lookup: (
        _hostname: string,
        options: unknown,
        callback?: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
      ) => {
        let cb = callback;
        let opts: { all?: boolean } = {};
        if (typeof options === "function") {
          cb = options as typeof callback;
        } else if (options && typeof options === "object") {
          opts = options as { all?: boolean };
        }
        if (cb) {
          if (opts.all) {
            cb(null, [{ address: realIp, family: 4 }]);
          } else {
            cb(null, realIp, 4);
          }
        }
      },
    };

    const req = https.request(reqOptions, (res) => {
      if (settled) return;
      settled = true;
      cleanup();

      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) {
          v.forEach((val) => resHeaders.append(k, val));
        } else if (v !== undefined) {
          resHeaders.set(k, v);
        }
      }

      const bodyStream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
      const response = new Response(bodyStream, {
        status: res.statusCode || 200,
        statusText: res.statusMessage || "OK",
        headers: resHeaders,
      });

      resolve(response);
    });

    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    });

    if (init.signal) {
      if (init.signal.aborted) {
        settled = true;
        cleanup();
        req.destroy(new Error("Request aborted"));
        reject(new Error("Request aborted"));
        return;
      }
      init.signal.addEventListener(
        "abort",
        () => {
          cleanup();
          req.destroy(new Error("Request aborted"));
        },
        { once: true },
      );
    }

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}
