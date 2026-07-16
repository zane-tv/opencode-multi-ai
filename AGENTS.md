# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-15  
**Package:** opencode-multi-ai

## OVERVIEW

OpenCode multi-account package unifying **SuperGrok (xAI)** and **ChatGPT/Codex** under one codebase:

| Provider id | Plugin module | npm adapter | CLI force |
| --- | --- | --- | --- |
| `xai-multi` | `lib/plugin/xai.ts` | `@ai-sdk/xai` | `op-xai` |
| `codex-multi` | `lib/plugin/codex.ts` | `@ai-sdk/openai` | `op-codex` |

Shared core: sticky rotation, v2 unified storage, agent tools, tabbed OpenTUI (`op-ai`). OpenCode config uses **one package-root plugin path**; `index.ts` re-exports both PluginModules as named exports (`xai`, `codex`) so the legacy loader registers both. Ships TypeScript source (Bun/OpenCode load `.ts`; no `dist/`).

## STRUCTURE

```
opencode-multi-ai/
├── index.ts                 # package root: named exports { xai, codex } (no default)
├── install.sh               # curl|bash + local setup
├── lib/
│   ├── core/                # accounts, storage, rotation-fetch, i18n, adapter types
│   ├── providers/
│   │   ├── xai/             # OAuth, classify, models, adapter
│   │   └── codex/           # OAuth, rewrite, usage, adapter
│   ├── plugin/
│   │   ├── xai.ts           # PluginModule { id: xai-multi, server }
│   │   └── codex.ts         # PluginModule { id: codex-multi, server }
│   ├── tools/               # buildTools / buildXaiTools / buildCodexTools
│   ├── tui/                 # tabbed OpenTUI
│   ├── cli/                 # argv routing
│   └── migrate.ts           # legacy v1 → multi-ai v2
├── scripts/
│   ├── cli.ts               # op-ai / op-xai / op-codex
│   ├── install.ts           # dual providers + dual plugins
│   └── install-cli.sh       # global shims
└── test/                    # flat vitest
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| OpenCode load | `lib/plugin/xai.ts`, `lib/plugin/codex.ts` | default export `{ id, server }` only |
| Package root | `index.ts` | named `{ xai, codex }` PluginModules (no default) |
| Pool / sticky select | `lib/core/accounts.ts` | provider-scoped selection |
| Rotation fetch | `lib/core/rotation-fetch.ts` | adapter-driven |
| Provider adapters | `lib/providers/*/adapter.ts` | host-pin (xAI) vs rewrite (Codex) |
| Disk + lock | `lib/core/storage.ts` | never touch OpenCode `auth.json` for pool |
| v2 migration | `lib/migrate.ts` | legacy multi-xai / multi-codex → multi-ai |
| Agent tools | `lib/tools/registry.ts` | `xai-*` / `codex-*` / dual |
| CLI | `scripts/cli.ts` + `lib/cli/routing.ts` | bin name forces provider |
| TUI tabs | `lib/tui/app.ts`, `lib/tui/tabs.ts` | |
| Settings inventory | `lib/core/settings-inventory.ts` | files / env / bins |
| Install OpenCode | `scripts/install.ts`, `install.sh` | |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `xai` / `codex` plugins | Plugin | `lib/plugin/*.ts` | OpenCode entries |
| `AccountManager` | class | `lib/core/accounts.ts` | Canonical pool |
| `createRotationFetch` | fn | `lib/core/rotation-fetch.ts` | Shared pipeline |
| `xaiAdapter` / `codexAdapter` | ProviderAdapter | `lib/providers/*/adapter.ts` | Provider strategy |
| `buildTools` | fn | `lib/tools/registry.ts` | Tool maps |
| `migrateLegacyIfNeeded` | fn | `lib/migrate.ts` | One-shot v2 import |
| `installProvider` | fn | `scripts/install.ts` | Dual config writer |
| `main` | fn | `scripts/cli.ts` | `op-ai` dispatcher |
| `runTui` | fn | `lib/tui/app.ts` | OpenTUI entry |

**Spine:** `storage` → `accounts` → `rotation-fetch` ← adapters ← `auth/refresh`.  
**Satellites:** tools, tui, dual plugins.  
**Dual construction:** plugins use `getAccountManager()`; CLI/TUI use `new AccountManager()`.

## CONVENTIONS

- ESM only; imports use **`.js` extensions** on TS sources. No path aliases.
- Ship source: `"main": "index.ts"`, `tsc --noEmit`, Bun preferred.
- **Plugin export hygiene:** each `lib/plugin/*.ts` default-exports **only** `{ id, server }`. No named function exports on those modules. Root `index.ts` re-exports them as **named** `xai` / `codex` only (no default) so one config path loads both.
- Zod (`lib/core/schemas.ts`) is the **persisted** boundary (`version: 2` unified). Tools use OpenCode `tool.schema`, not Zod.
- Provider ids **`xai-multi`** and **`codex-multi` only** — never override built-in `xai` / `openai`.
- Data under `~/.config/opencode/`:
  - `multi-ai-accounts.json` (600) — both providers
  - `multi-ai-settings.json` — locale
  - `multi-ai-models-xai.json` / `multi-ai-models-codex.json`
- Env: prefer `MULTI_AI_*`; accept `MULTI_XAI_*` / `MULTI_CODEX_*` fallbacks (see settings inventory).
- Quiet logs; never pass tokens to `logger`.
- Tests: flat `test/*.test.ts`.

## STORAGE & MIGRATION

- **v2 truth:** one account file, accounts tagged with `provider: "xai" | "codex"`.
- **Legacy:** `multi-xai-accounts.json` / `multi-codex-accounts.json` (v1) imported by `lib/migrate.ts`.
- Migration is idempotent; never clobbers existing v2 accounts for a provider already present; writes `.bak` copies of legacy without deleting originals.
- Install **does not** delete user account files.

## INSTALL (OPENCODE)

`scripts/install.ts`:

1. Target `OPENCODE_CONFIG` or `~/.config/opencode/opencode.json`
2. Backup existing config to `.bak` (once; never overwrite existing bak)
3. Merge **both** providers (fill missing only; user edits win)
4. With `--with-plugin-entry`: register **one** package-root plugin path (loads both providers); rewrite dual module paths; strip `opencode-multi-xai` / `opencode-multi-codex` string or path forms
5. Preserve unrelated plugins; never write built-in `xai` / `openai` as multi ids
6. Idempotent reinstall

CLI shims (`scripts/install-cli.sh`): all historical bins → `scripts/cli.ts`.

## ANTI-PATTERNS (THIS PROJECT)

- NEVER raw token/API-key paste — OAuth only (browser/device; Codex also JSON import for OAuth blobs).
- NEVER override built-in `xai` or `openai` in generated config.
- NEVER default-export a single PluginModule from package root (would load only one provider). Keep dual named exports; canonical modules stay under `lib/plugin/`.
- NEVER send xAI bearer except `api.x.ai`; NEVER skip Codex URL rewrite to `chatgpt.com`.
- NEVER append `Authorization` — always overwrite (dummy SDK key).
- NEVER set `subscriptionStatus: "dead"` except refresh-grant `invalid_grant`.
- NEVER mark dead on inference 401 after successful refresh — cooldown + rotate.
- NEVER map quota/usage strings to dead or prune (recoverable).
- NEVER prune solely on quota/usage-exhausted — dead **or** `flaggedForRemoval`.
- NEVER rotate pool on `unknown-client-error` / bare param 4xx.
- NEVER use rotated refresh token before durable persist; always `refresh_token ?? old`.
- NEVER nest storage transactions on same path; never log token values.
- NEVER named exports from plugin modules; no `as any` / `@ts-ignore`.
- NEVER change public OAuth constants (xAI `:56121` + `plan=generic`; Codex `:1455` + extras).
- NEVER delete user account files from install scripts.
- NEVER publish to npm as part of routine agent work.

## UNIQUE STYLES

- Selection: sticky active per provider → on fail, rescan **priority-sorted** list.
- Priority DESC, then `addedAt` ASC.
- Models.dev network sync **only after successful OAuth**, not cold start.
- CLI reuses agent tools; bin name (`op-xai` / `op-codex`) forces provider.
- Display name: label → email → short id.
- xAI: host-pin + rate-limit headers + billing credits.  
  Codex: URL rewrite + usage windows (primary/secondary).

## COMMANDS

```bash
bun install                 # or npm install
npm run typecheck           # tsc --noEmit
npm test                    # vitest run

./install.sh --path         # or npm run setup
npm run install:global      # shims → ~/.local/bin
bun scripts/install.ts [--with-plugin-entry]
bun scripts/cli.ts help

# remote (set MULTI_AI_REPO_URL first):
curl -fsSL …/install.sh | bash -s -- --path --with-plugin
```

## NOTES

- Package `opencode-multi-ai`; bins `op-ai`, `op-xai`, `op-codex`, historical aliases.
- `opencode xai-add` / `opencode codex-add` do **not** work as CLI shortcuts (paths); use `op-ai` / TUI / agent tools.
- Settings inventory: `lib/core/settings-inventory.ts`.
- Child domains live under `lib/providers/{xai,codex}/` — do not re-merge into a single plugin.
