import type {
  ProbeQuotaAccount,
  ProbeQuotaResult,
  ResolveModelsOptions,
  TransportProviderAdapter,
} from "../../core/adapter.js";
import {
  formatAge,
  formatUntil,
} from "../../core/format-time.js";
import { accountDisplayName } from "../../core/tui-status.js";
import {
  BASE_URL,
  DISPLAY_NAME,
  DUMMY_API_KEY,
  PROVIDER_ID,
} from "./constants.js";
import {
  fetchDashboardUsage,
  hasAnyUsage,
  resolveDashboardCredForAccount,
} from "./dashboard.js";

/**
 * OpenCode Go adapter — TUI display / probe only.
 *
 * opencode-go rotation is MANUAL config-file rotation: the plugin writes the
 * active pool key into OpenCode's auth.json (entry "opencode-go") and reloads.
 * The built-in `opencode-go` provider handles actual requests, so this adapter
 * never intercepts them: `transport.kind: "custom"` with a `createFetch` that
 * throws, so nothing can accidentally route through the multi pool.
 */
export const openCodeGoAdapter: TransportProviderAdapter = {
  id: PROVIDER_ID,
  provider: "opencode-go",
  displayName: DISPLAY_NAME,
  npmPackage: "@ai-sdk/openai-compatible",
  baseURL: BASE_URL,
  dummyApiKey: DUMMY_API_KEY,

  async resolveModels(_opts: ResolveModelsOptions) {
    // Static catalog: the built-in provider owns the real model list. Kept
    // minimal here; a disk cache can layer on later if needed.
    return {
      "glm-5.2": {
        name: "GLM 5.2",
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ["text"], output: ["text"] },
      },
    };
  },
  providerDefaultOptions() {
    return {};
  },
  listSubtitle(account) {
    return accountDisplayName({
      accountId: String(account.accountId ?? ""),
      email: typeof account.email === "string" ? account.email : undefined,
      label: typeof account.label === "string" ? account.label : undefined,
    });
  },
  detailLines(account, now) {
    const lines: string[] = [];
    const id = String(account.accountId ?? "");
    lines.push(`id: ${id.length > 12 ? `${id.slice(0, 12)}…` : id}`);
    if (typeof account.label === "string" && account.label) {
      lines.push(`label: ${account.label}`);
    }
    if (typeof account.email === "string" && account.email) {
      lines.push(`email: ${account.email}`);
    }
    if (typeof account.priority === "number") {
      lines.push(`priority: ${account.priority}`);
    }
    if (typeof account.lastUsed === "number" && account.lastUsed > 0) {
      lines.push(`last used: ${formatAge(account.lastUsed, now)}`);
    }
    if (typeof account.subscriptionStatus === "string") {
      lines.push(`sub: ${account.subscriptionStatus}`);
    }
    // Note: the TUI styledDetail renders the workspace/cred + dashboard quota
    // windows from the account object directly, so detailLines deliberately
    // omits them to avoid duplication in the right-hand panel.
    if (
      typeof account.coolingDownUntil === "number" &&
      account.coolingDownUntil > now
    ) {
      lines.push(
        `cooldown: ${account.cooldownReason ?? "unknown"} ` +
          `${formatUntil(account.coolingDownUntil, now)}`,
      );
    }
    return lines;
  },
  async probeQuota(
    accessToken: string,
    account: ProbeQuotaAccount,
  ): Promise<ProbeQuotaResult> {
    let modelsStatus = 200;
    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        return {
          ok: false,
          reason: `HTTP ${res.status}`,
          status: res.status,
        };
      }
      modelsStatus = res.status;
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    // The API key works. Optionally attach the workspace dashboard quota
    // (scraped from opencode.ai with the account's auth cookie, or the env
    // fallback when the account carries none). Dashboard quota is
    // workspace-level, so it is stored on the probed account and displayed
    // tab-level. A dashboard failure must NEVER downgrade a successful models
    // probe — the key check already passed.
    try {
      const cred = resolveDashboardCredForAccount(account);
      if (cred) {
        const usage = await fetchDashboardUsage(cred);
        if (hasAnyUsage(usage)) {
          return {
            ok: true,
            status: modelsStatus,
            openCodeGoQuota: {
              rolling: usage.rolling
                ? {
                    usagePercent: usage.rolling.usagePercent,
                    resetAt: usage.rolling.resetAt,
                  }
                : undefined,
              weekly: usage.weekly
                ? {
                    usagePercent: usage.weekly.usagePercent,
                    resetAt: usage.weekly.resetAt,
                  }
                : undefined,
              monthly: usage.monthly
                ? {
                    usagePercent: usage.monthly.usagePercent,
                    resetAt: usage.monthly.resetAt,
                  }
                : undefined,
            },
          };
        }
        // The dashboard was reached (HTTP 200) but the workspace carries no
        // Go subscription — the probe is pointed at the WRONG workspace.
        // Return an EMPTY quota object so callers can show a diagnostic
        // ("use set-cred") instead of treating it as "no quota configured"
        // (undefined: no cred / fetch failed).
        return { ok: true, status: modelsStatus, openCodeGoQuota: {} };
      }
    } catch {
      // Dashboard fetch/parse failed — key is still valid; quota stays absent
      // and the TUI falls back to "no quota configured".
    }
    return { ok: true, status: modelsStatus };
  },
  transport: {
    kind: "custom",
    createFetch(_ctx) {
      throw new Error(
        "opencode-go plugin does not intercept requests; built-in opencode-go provider handles them.",
      );
    },
  },
};
