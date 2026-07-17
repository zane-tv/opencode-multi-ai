# xAI Provider

**Domain:** SuperGrok / xAI multi-account  
**Provider id:** `xai-multi` · **kind:** `xai` · **npm:** `@ai-sdk/xai`

## OVERVIEW

HTTP multi-account pool for SuperGrok (xAI). `xaiAdapter` host-pins every request to `api.x.ai`. Transport: pure HTTP via `createRotationFetch`. Plugin: `lib/plugin/xai.ts` → `{ id, server }` only.

| Piece | Role |
| --- | --- |
| `xaiAdapter` | Host-pin, headers, classify, rate-limit record |
| `auth/` | Browser OAuth (`:56121`, `plan=generic`) + device code + refresh |
| `request/` | classify-error, rate-limit headers, plan/billing credits, body bridge |
| `models-sync.ts` | Catalog cache / network sync after OAuth |
| `constants.ts` | OAuth ports, hosts, client ids |

## STRUCTURE

```
lib/providers/xai/
├── adapter.ts           # xaiAdapter (HTTP host-pin)
├── constants.ts
├── models-sync.ts
├── index.ts
├── auth/
│   ├── oauth.ts         # browser :56121, plan=generic
│   ├── device-code.ts
│   ├── login.ts         # finalize → pool
│   ├── refresh.ts
│   ├── server.ts        # loopback callback
│   └── pkce.ts
└── request/
    ├── classify-error.ts
    ├── rate-limit.ts
    ├── plan.ts / billing-quota.ts
    ├── user-profile.ts
    └── body-bridge.ts
```

## WHERE TO LOOK

| Task | File |
| --- | --- |
| Adapter / host-pin | `adapter.ts` |
| Browser OAuth | `auth/oauth.ts`, `auth/server.ts` |
| Device code / refresh / login | `auth/device-code.ts`, `refresh.ts`, `login.ts` |
| Failure taxonomy | `request/classify-error.ts` |
| Rate-limit / plan / credits | `request/rate-limit.ts`, `plan.ts`, `billing-quota.ts` |
| Body transform | `request/body-bridge.ts` |
| Models catalog | `models-sync.ts` |
| OpenCode plugin | `lib/plugin/xai.ts` |
| Shared HTTP rotate | `lib/core/rotation-fetch.ts` |

## CONVENTIONS

- Transport: `transport.kind: "http"` → `createRotationFetch` (not custom).
- `resolveUrl`: host-pin only; throw if not `api.x.ai`.
- Bearer: overwrite `Authorization` (never append); dummy SDK key only.
- OAuth constants frozen: loopback `:56121`, `plan=generic`.
- Models network sync after successful OAuth (or explicit allowNetwork).
- Rate-limit / billing → `recordSuccess`; recoverable quota ≠ dead.
- Display: label → email → short id.

## ANTI-PATTERNS

- NEVER send bearer except to `api.x.ai`.
- NEVER change OAuth port `:56121` or `plan=generic`.
- NEVER raw token paste into the multi pool (OAuth only).
- NEVER override built-in id `xai` (use `xai-multi`).
- NEVER mark `subscriptionStatus: "dead"` except refresh `invalid_grant`.
- NEVER dead-mark on inference 401 after successful refresh (cooldown + rotate).
- NEVER map quota/usage strings to dead or prune.
- NEVER rotate on `unknown-client-error` / bare param 4xx.
- NEVER use rotated refresh token before durable persist (`refresh_token ?? old`).
- NEVER force Kiro-style custom transport here.
