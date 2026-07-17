# lib/core — multi-provider pool

## OVERVIEW

Shared sticky pool: disk → AccountManager → HTTP/custom fetch. Provider plugins/CLI/TUI all sit on this spine.

## STRUCTURE

```
accounts.ts          AccountManager; getAccountManager() plugins; new AccountManager() CLI/TUI
storage.ts           atomic write, chmod 600, lock; v3 (version:3, sticky map); migrateV2ToV3
rotation-fetch.ts    HTTP rotation pipeline (xai + codex)
provider-fetch.ts    routes HTTP vs transport.kind:"custom"
adapter.ts           ProviderAdapter / TransportProviderAdapter; Classification; ProviderId
schemas.ts           Zod v3 boundary; ProviderKind xai|codex|kiro
paths.ts             multi-ai-accounts.json (+ settings/models paths)
account-rotation.ts  toKiroFetchManager / rotation helpers
settings-inventory.ts  files / env / bins inventory
i18n.ts, logger.ts, format-time.ts, tui-status.ts, session-options.ts
```

## WHERE TO LOOK

| Need | File |
|------|------|
| Select sticky / rotate / priority | `accounts.ts` |
| Persist pool, locks, v2→v3 | `storage.ts` |
| xAI/Codex HTTP retry+rotate | `rotation-fetch.ts` |
| Custom transport (Kiro) branch | `provider-fetch.ts` |
| Adapter contract + 8 classifications | `adapter.ts` |
| On-disk shapes / dead rules | `schemas.ts` |
| Kiro usage meters | `AccountManager.recordKiroUsage` |
| Paths under `~/.config/opencode/` | `paths.ts` |

**Spine:** `storage` → `accounts` → (`rotation-fetch` \| `provider-fetch` → custom)

## CONVENTIONS

- Plugins: `getAccountManager()` singleton. CLI/TUI: `new AccountManager()`.
- Provider ids: `xai-multi` \| `codex-multi` \| `kiro-multi`. Kinds: `xai` \| `codex` \| `kiro`.
- Sticky is per-provider accountId map (v3). Selection: sticky first, then priority DESC.
- Classification (8): `ok` · `transient` · `quota-exhausted` · `entitlement-blocked` · `auth-dead` · `server` · `network` · `unknown-client-error`.
- Kiro meters: only via `recordKiroUsage` on AccountManager (`usedCount`/`limitCount`).
- Quiet logs; never pass tokens to `logger`.

## ANTI-PATTERNS

- NEVER touch OpenCode `auth.json` from storage.
- NEVER nest storage transactions on the same path.
- NEVER set `subscriptionStatus: "dead"` except refresh-grant `invalid_grant`.
- NEVER mark dead on inference 401 after successful refresh (cooldown + rotate).
- NEVER map quota/usage strings → dead or prune; never prune solely on quota.
- NEVER rotate pool on `unknown-client-error` / bare param 4xx.
- NEVER use rotated refresh token before durable persist; always `refresh_token ?? old`.
- NEVER force Kiro through pure HTTP `createRotationFetch` — custom transport only.
- NEVER log token values.
