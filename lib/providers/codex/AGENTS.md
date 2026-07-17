# CODEX PROVIDER

**Domain:** ChatGPT/Codex multi-account · kind `codex` · id `codex-multi`  
**npm:** `@ai-sdk/openai` · **plugin:** `lib/plugin/codex.ts` · **CLI:** `op-codex`

## OVERVIEW

HTTP `ProviderAdapter` (`codexAdapter`). OpenAI-compat SDK base + **URL rewrite** to `chatgpt.com/backend-api`. Shared pool path: `createProviderFetch` → `createRotationFetch`. Usage = primary/secondary windows (not xAI credits).

## STRUCTURE

```
lib/providers/codex/
├── adapter.ts          # codexAdapter strategy
├── constants.ts        # OAuth :1455, endpoints, public IDs
├── index.ts            # barrel
├── models-sync.ts      # catalog after OAuth / allowNetwork
├── auth/
│   ├── oauth.ts        # browser localhost:1455 + extras
│   ├── device-code.ts  # device flow
│   ├── import-json.ts  # OAuth-blob / auth.json import
│   ├── host-auth.ts    # host bootstrap
│   ├── refresh.ts      # token refresh
│   ├── login.ts, server.ts, pkce.ts
└── request/
    ├── classify-error.ts   # large error taxonomy
    ├── usage.ts            # primary/secondary windows
    ├── body-transform.ts, body-bridge.ts
    ├── codex-url.ts, codex-headers.ts, sse.ts
```

## WHERE TO LOOK

| Task | File |
|------|------|
| Adapter / transport | `adapter.ts` |
| OAuth ports & IDs | `constants.ts` |
| Browser / device login | `auth/oauth.ts`, `auth/device-code.ts` |
| Import JSON OAuth blob | `auth/import-json.ts` |
| Refresh | `auth/refresh.ts` |
| URL rewrite | `request/codex-url.ts` |
| Error → rotate/dead | `request/classify-error.ts` |
| Usage windows | `request/usage.ts` |
| Body / headers / SSE | `request/body-*.ts`, `codex-headers.ts`, `sse.ts` |
| Models cache | `models-sync.ts` |
| OpenCode entry | `lib/plugin/codex.ts` |
| HTTP rotation | `lib/core/rotation-fetch.ts`, `provider-fetch.ts` |

## CONVENTIONS

- Provider id **`codex-multi` only** — never override built-in `openai`.
- Transport: HTTP rotation-fetch (not Kiro custom).
- Auth: OAuth only (browser/device) + JSON OAuth-blob import; no raw API-key paste into pool.
- Models.dev / catalog sync only after successful OAuth (or explicit allowNetwork).
- Display: label → email → short id.
- Env: prefer `MULTI_AI_*`; accept `MULTI_CODEX_*` fallbacks.
- Quiet logs; never log tokens.

## ANTI-PATTERNS

- **NEVER** skip URL rewrite to `chatgpt.com` / backend-api.
- **NEVER** change public OAuth constants (`:1455` + extras).
- **NEVER** append `Authorization` — always overwrite (dummy SDK key).
- **NEVER** `subscriptionStatus: "dead"` except refresh-grant `invalid_grant`.
- **NEVER** mark dead on inference 401 after successful refresh — cooldown + rotate.
- **NEVER** map quota/usage strings to dead or prune (recoverable).
- **NEVER** prune solely on quota/usage-exhausted — dead or `flaggedForRemoval`.
- **NEVER** rotate pool on `unknown-client-error` / bare param 4xx.
- **NEVER** use rotated refresh token before durable persist; always `refresh_token ?? old`.
- **NEVER** raw token paste into multi pool for OAuth path.
