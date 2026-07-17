# Kiro provider (`lib/providers/kiro/`)

**Generated:** 2026-07-17  
**Scope:** AWS CodeWhisperer / Kiro IDE multi-account domain only. Parent pool/storage lives in `lib/core/`.

## OVERVIEW

Provider id `kiro-multi`, kind `kiro`, npm `@ai-sdk/openai-compatible`.

Custom transport (not pure HTTP rotation): OpenAI-compat body → CodeWhisperer SDK stream → SSE out. Adapter: `createKiroAdapter` / `kiroAdapter` (`TransportProviderAdapter`, `transport.kind: "custom"`, `createFetch` → `createKiroFetch`).

Auth methods: IDC device, desktop, credentials import, API key. Usage snapshot: `usedCount` / `limitCount` via `recordKiroUsage`. Selection: `sticky` | `round-robin` | `lowest-usage`.

Plugin entry: `lib/plugin/kiro.ts`. CLI force: `op-kiro`.

## STRUCTURE

```
kiro/
├── adapter.ts           # createKiroAdapter / kiroAdapter
├── constants.ts         # PROVIDER_ID, regions, MODEL_MAPPING, endpoints, KIRO_AUTH_SERVICE
├── models.ts            # catalog helpers
├── models-sync.ts       # disk cache multi-ai-models-kiro.json
├── effort.ts            # thinking budget / effort
├── types.ts
├── auth/                # login, refresh, oauth-idc, api-key, credentials/cli/legacy import
├── request/             # kiro-fetch, sdk-client, transform, classify-error, usage, account-lane
├── streaming/           # sdk-stream-transformer, sse-response, stream-parser/state
└── transformers/        # message + tool (+ tool-call-parser)
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Adapter contract | `adapter.ts` | custom transport; listSubtitle / probeQuota |
| Region / models / dummy key | `constants.ts` | `KIRO_BASE_URL` = `https://q.{region}.amazonaws.com`; `DUMMY_API_KEY`; `MODEL_MAPPING` thinking→base; `KIRO_AUTH_SERVICE` SSO OIDC |
| Inference path | `request/kiro-fetch.ts` | pool loop, `ensureFreshToken`, SDK send, SSE |
| SDK wire | `request/sdk-client.ts`, `request/transform.ts` | GenerateAssistantResponse |
| Error taxonomy | `request/classify-error.ts` | auth-dead, quota, entitlement, transient |
| Usage probe | `request/usage.ts` | `fetchKiroUsageLimits` → `recordKiroUsage` |
| Concurrency | `request/account-lane.ts` | per-account lane |
| Stream out | `streaming/sdk-stream-transformer.ts`, `sse-response.ts` | SDK events → OpenAI SSE |
| Body map | `transformers/message-transformer.ts`, `tool-transformer.ts` | OpenCode msgs/tools → CW |
| Login / refresh | `auth/login.ts`, `auth/refresh.ts` | IDC/desktop/credentials/API key |
| Models cache | `models-sync.ts` | `~/.config/opencode/multi-ai-models-kiro.json` |

## CONVENTIONS

- Route through `createProviderFetch` + `transport.kind: "custom"` only.
- Region-aware endpoints: `q.{region}.amazonaws.com` and `runtime.{region}.kiro.dev`.
- `MODEL_MAPPING` strips `-thinking` suffix to base model ids for the SDK.
- Dummy API key overwrites SDK Authorization; real token from account + refresh.
- Account selection policy optional on adapter (`accountSelectionStrategy`); default sticky.
- Usage is count-based (`usedCount`/`limitCount`), not xAI credits or Codex windows.
- Auth payloads carry `region`, `oidcRegion`, `profileArn`, `clientId`/`clientSecret` as needed per method.
- Quiet logs; never log tokens.

## ANTI-PATTERNS

- NEVER force Kiro through pure `createRotationFetch` HTTP path.
- NEVER skip OpenAI body → CodeWhisperer SDK transform (no raw OpenAI POST to Q).
- NEVER hardcode a single region; normalize via `normalizeKiroRegion` / ARN extract.
- NEVER mark dead on recoverable quota/usage exhaustion; cooldown / rotate / markQuotaExhausted.
- NEVER prune solely on quota; dead or `flaggedForRemoval` only.
- NEVER rotate pool on `unknown-client-error` / bare client 4xx (return error response).
- NEVER use rotated refresh token before durable persist; always `refresh_token ?? old`.
- NEVER free-form paste tokens into storage helpers outside Kiro auth methods.
- NEVER re-merge kiro domain into xai/codex plugin modules.
