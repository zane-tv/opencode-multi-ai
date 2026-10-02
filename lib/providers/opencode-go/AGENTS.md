# OpenCode Go provider (`lib/providers/opencode-go/`)

**Scope:** OpenCode Go multi-account domain only. Parent pool/storage lives in `lib/core/`.

## OVERVIEW

Provider id `opencode-go-multi`, kind `opencode-go`, npm `@ai-sdk/openai-compatible` (adapter metadata only).

**Manual config-file rotation** — no HTTP proxy, no OAuth: the active pool API key is mirrored into OpenCode's `auth.json` entry `opencode-go` (shape `{ type: "api", key }`) and the instance is reloaded. The **built-in `opencode-go` OpenCode provider** (serving `glm-5.2` / `glm-5.1` etc. via `BASE_URL`) handles actual requests, so this domain is display/probe + auth-file only. Adapter: `openCodeGoAdapter` (`TransportProviderAdapter` with `transport.kind: "custom"` whose `createFetch` **throws** — nothing may route through the multi pool).

Sticky key: `opencodeGo` (camelCase) via `stickyKey(provider)` in `lib/core/accounts.ts`. No v1 legacy, no migration. Plugin entry: `lib/plugin/opencode-go.ts` (tool `opencodeGoRotate`). CLI force: `op-opencode-go` (`add --api-key KEY [--label L] [--workspace-id ID] [--auth-cookie COOKIE]`).

## STRUCTURE

```
opencode-go/
├── constants.ts      # PROVIDER_ID, BASE_URL, AUTH_JSON_KEY, MODELS_CACHE, DUMMY_API_KEY
├── adapter.ts        # openCodeGoAdapter — display / probe only; createFetch throws
├── dashboard.ts      # workspace quota: env cred + dashboard HTML scrape + parser
└── auth/
    └── auth-file.ts  # writeActiveKeyToAuthJson — atomic mirror into auth.json
```

## DASHBOARD QUOTA FETCH

The OpenCode Go API (`BASE_URL`) exposes NO quota via response headers (no `X-RateLimit-*`). Quota is fetched by **scraping the dashboard HTML** at `https://opencode.ai/workspace/<workspaceID>/go` with an **auth cookie** — NOT the API key (reference: `github.com/opgginc/opencode-bar` `OpenCodeGoProvider.swift`). The HTML inlines three usage windows (optionally as SolidJS `$R[N] = {…}` hydration objects):

```
rollingUsage: { usagePercent, resetInSec }   // 5-hour window
weeklyUsage:  { usagePercent, resetInSec }
monthlyUsage: { usagePercent, resetInSec }
```

- **Credential source: per-account first, ENV fallback** (no browser cookie scan):
  - Per-account: `openCodeGoWorkspaceId` + `openCodeGoAuthCookie` (schema fields; optional, both required together — set via TUI wizard steps 3–4, `op-opencode-go add --workspace-id … --auth-cookie …`, or the `opencode-go-add` tool). This supports multiple Go subscriptions / workspaces in one pool.
  - Env: `MULTI_AI_OPENCODE_GO_WORKSPACE_ID` / `MULTI_AI_OPENCODE_GO_AUTH_COOKIE` (legacy fallbacks `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE`).
  - Precedence: account cred > env; `resolveDashboardCredForAccount(account)` implements this — `resolveDashboardCred()` stays as the env-only resolver. Both fields must be non-empty (after trim); the cookie is stored WITHOUT the `auth=` prefix (`normalizeAuthCookie` strips it at add time; `fetchDashboardUsage` always prepends `auth=`).
- `fetchDashboardUsage` is a READ-ONLY GET at probe time — not a request interceptor; failures must never downgrade a successful models probe (`probeQuota` returns `ok:true` with `openCodeGoQuota` absent).
- `parseDashboardUsageHTML` normalizes HTML entities (`&quot;` `&#34;` `&#x27;` `&#39;` `&amp;`) and `\"` / `\u0022` escapes before regex extraction; missing windows are omitted, all-missing → `{}`.
- **Quota is WORKSPACE-LEVEL** — shared across every pool key. The snapshot is stored on whichever account was probed last (`setOpenCodeGoQuota` writes 6 fields: `openCodeGo{FiveHour,Weekly,Monthly}{Usage,Reset}`); the TUI shows it ONCE per tab (tab header, read from the sticky account), never per account.
- Refresh trigger: probe-on-demand only (`r` in the TUI, `opencode-go-probe` tool). No background fetch, no auto-interval.

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Constants | `constants.ts` | `BASE_URL` = `https://opencode.ai/zen/go/v1`; `AUTH_JSON_KEY` = `opencode-go`; `MODELS_CACHE` = `multi-ai-models-opencode-go.json` |
| Adapter contract | `adapter.ts` | display/probe only; `resolveModels` static catalog (glm-5.2); `probeQuota` → `GET {BASE_URL}/models` + optional dashboard quota |
| Workspace quota | `dashboard.ts` | per-account cred (`resolveDashboardCredForAccount`) → env fallback → dashboard HTML scrape → `rolling/weekly/monthly` windows (`OpenCodeGoDashboardUsage`) |
| Key mirror | `auth/auth-file.ts` | `writeActiveKeyToAuthJson`: merge entry `opencode-go`, atomic temp+rename, 0600; preserves all other auth.json entries |
| Rotation model | `lib/plugin/opencode-go.ts`, `lib/core/accounts.ts` | sticky switch → mirror → `client.config.update({})` reload |
| Probe failure mapping | `lib/core/accounts.ts` | `recordCooldown` 15-min: 401 → `auth-failure`, 429 → `rate-limit`, else → `network-error` |

## CONVENTIONS

- **No HTTP proxy, no OAuth:** the built-in `opencode-go` provider owns npm/baseURL/env and reads the key from `auth.json`. Never register a provider config entry.
- **auth.json exception:** `writeActiveKeyToAuthJson` is the ONLY authorized OpenCode `auth.json` writer in the package — the pool file is never touched for other providers.
- Pool keys live in `~/.config/opencode/multi-ai-accounts.json`; only the ACTIVE key is mirrored to `~/.local/share/opencode/auth.json` on rotate.
- Account `accountId` is a `sha256(key)` hash (dedupe); the key is stored in both `refreshToken` (persisted boundary) and `accessToken` (what rotate mirrors).
- Per-account dashboard cred schema fields (both optional, omitted → env fallback at probe time): `openCodeGoWorkspaceId` (`wrk_XXXX`), `openCodeGoAuthCookie` (raw `auth` cookie value; SENSITIVE). `ProbeQuotaAccount` carries them into `probeQuota`; the TUI detail shows `workspace: <id> · cred: set|env` — never the cookie value.
- Passthrough refresh handler (core): same tokens, `expiresAt = Number.MAX_SAFE_INTEGER` — `ensureFreshToken` fast path.
- Static-key accounts have no per-key quota/usage semantics; `isRotationReady` only checks enabled / dead / entitlement / quotaReset / cooldown / flaggedForRemoval.
- Workspace quota snapshot: `AccountManager.setOpenCodeGoQuota(id, {rolling?, weekly?, monthly?})` writes the 6 `openCodeGo*` fields (undefined clears a window); tab-level display reads the sticky account only.
- Probe is `GET {BASE_URL}/models` with `Authorization: Bearer <key>`; on success it optionally appends `openCodeGoQuota` from the dashboard scrape (per-account cred, else env fallback). Dashboard failure never downgrades a successful models probe.
- Quiet logs; never log keys or the auth cookie value.

## ANTI-PATTERNS

- NEVER intercept requests for opencode-go — adapter `createFetch` must throw (built-in provider handles them).
- NEVER write `provider.opencode-go` to opencode.json (built-in catalog owns it).
- NEVER put the pool's non-active keys into auth.json; mirror only the active key.
- NEVER add OAuth flows / refresh logic for opencode-go (static keys; passthrough refresh only).
- NEVER merge opencode-go into xai/codex plugin modules or force it through pure HTTP rotation-fetch.
- NEVER use the kebab-case kind as the v3 sticky key (`stickyKey` → `opencodeGo`).
- NEVER treat dashboard quota as per-account (workspace-level): display tab-level only, store on the probed/sticky account.
- NEVER let a dashboard scrape failure downgrade a successful models probe (`probeQuota` stays `ok:true`).
- NEVER scan browser cookies for dashboard credentials (per-account cred + env only) and NEVER log the auth cookie — `openCodeGoAuthCookie` is a session secret: never log its value, never echo it in tool output or TUI detail (show `set` / `env` only), never include it in error messages. Only `fetchDashboardUsage` sees it, in the `Cookie` header.
