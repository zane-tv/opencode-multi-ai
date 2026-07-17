# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-17  
**Commit:** d6fcc38  
**Branch:** main  
**Package:** opencode-multi-ai

## OVERVIEW

OpenCode multi-account package unifying **SuperGrok (xAI)**, **ChatGPT/Codex**, and **Kiro (AWS CodeWhisperer)** under one sticky-rotation pool, v3 storage, agent tools, and tabbed OpenTUI (`op-ai`). Ships TypeScript source (Bun/OpenCode load `.ts`; no `dist/`). One package-root plugin path loads all three via named exports.

| Provider id | Plugin | npm adapter | CLI force | Transport |
| --- | --- | --- | --- | --- |
| `xai-multi` | `lib/plugin/xai.ts` | `@ai-sdk/xai` | `op-xai` | host-pin + HTTP rotation-fetch |
| `codex-multi` | `lib/plugin/codex.ts` | `@ai-sdk/openai` | `op-codex` | URL rewrite → chatgpt.com + HTTP rotation-fetch |
| `kiro-multi` | `lib/plugin/kiro.ts` | `@ai-sdk/openai-compatible` | `op-kiro` | **custom** transport (`createKiroFetch` / CodeWhisperer SDK) |

## STRUCTURE

```
opencode-multi-ai/
├── index.ts              # named { xai, codex, kiro } — NO default
├── install.sh
├── lib/
│   ├── core/             # accounts, storage v3, rotation-fetch, adapter, i18n
│   ├── providers/{xai,codex,kiro}/  # per-provider auth/request (+kiro stream)
│   ├── plugin/           # server plugins + tui.tsx sidebar (separate)
│   ├── tools/ tui/ cli/ sidebar/
│   └── migrate.ts        # legacy xai/codex → unified pool
├── scripts/              # cli, install, install-cli, install-tui
└── test/                 # flat vitest
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| OpenCode load | `lib/plugin/{xai,codex,kiro}.ts` | default `{ id, server }` only |
| Package root | `index.ts` | named `{ xai, codex, kiro }` — no default |
| Pool / sticky | `lib/core/accounts.ts` | provider-scoped sticky map |
| HTTP rotate / fetch | `rotation-fetch.ts`, `provider-fetch.ts` | HTTP vs custom transport |
| Adapter contract | `lib/core/adapter.ts` | + `lib/providers/*/adapter.ts` |
| Disk / schemas | `storage.ts`, `schemas.ts` | v3; never touch `auth.json` |
| Migration | `lib/migrate.ts` | legacy xai/codex only |
| Tools / CLI / TUI | `tools/registry.ts`, `scripts/cli.ts`, `tui/` | bins force provider |
| Sidebar | `plugin/tui.tsx`, `sidebar/active-quota.ts` | `tui.json` only |
| Install / inventory | `scripts/install.ts`, `settings-inventory.ts` | triple providers |

## CODE MAP

| Symbol | Location | Role |
|--------|----------|------|
| `xai`/`codex`/`kiro` | `lib/plugin/*.ts` | OpenCode server entries |
| `AccountManager` / `getAccountManager` | `lib/core/accounts.ts` | Pool + plugin singleton |
| `createRotationFetch` / `createProviderFetch` | `rotation-fetch.ts` / `provider-fetch.ts` | HTTP vs custom |
| `*Adapter` / `createKiroFetch` | `providers/*/adapter.ts`, `kiro/request/kiro-fetch.ts` | Strategy + Kiro SDK |
| `buildTools` / `runTui` / `installProvider` | `tools/registry.ts`, `tui/app.ts`, `scripts/install.ts` | Surfaces |

**Spine:** `storage` → `accounts` → (`rotation-fetch` \| kiro custom) ← adapters.  
**Construction:** plugins `getAccountManager()`; CLI/TUI `new AccountManager()`.

## CONVENTIONS

- ESM only; imports use **`.js` extensions** on TS. No path aliases. Ship source (`main: index.ts`); Bun preferred.
- Plugin hygiene: server modules default `{ id, server }` only; root named `{ xai, codex, kiro }` only; sidebar `{ id, tui }` separate (`tui.json`).
- Zod v3 persisted boundary (`provider: xai|codex|kiro`); tools use OpenCode `tool.schema`.
- Provider ids **`xai-multi` / `codex-multi` / `kiro-multi` only**.
- Data: `~/.config/opencode/multi-ai-accounts.json` (600), `multi-ai-settings.json`, `multi-ai-models-{xai,codex,kiro}.json`.
- Env: prefer `MULTI_AI_*` (legacy `MULTI_XAI_*` / `MULTI_CODEX_*` fallbacks). Quiet logs; no tokens.
- Tests: flat `test/*.test.ts`.

## STORAGE & MIGRATION

- **v3:** one file; accounts tagged `provider`; sticky map per kind. On-disk v2→v3 via `migrateV2ToV3`.
- Legacy v1 xai/codex → `lib/migrate.ts` (idempotent; no clobber; `.bak` without delete). No kiro v1.
- Install never deletes account files.

## INSTALL (OPENCODE)

`scripts/install.ts`: merge **xai-multi + codex-multi + kiro-multi** into `OPENCODE_CONFIG` or `~/.config/opencode/opencode.json`; backup once to `.bak`; `--with-plugin-entry` → one package-root path; strip legacy plugin entries; never write built-ins. Sidebar: `bun scripts/install-tui.ts` → `tui.json`.

## ANTI-PATTERNS (THIS PROJECT)

- NEVER raw-token paste into multi pool for xAI/Codex (OAuth / OAuth-JSON import only). Kiro: only via its auth methods (`ksk_*`, IDC, imports) — not free-form storage helpers.
- NEVER put pool tokens in OpenCode `auth.json`; never leave host `type=oauth` there (host-auth placeholder only).
- NEVER override built-in `xai` / `openai`; never default-export a single PluginModule from package root.
- NEVER send xAI bearer except `api.x.ai`; NEVER skip Codex rewrite to `chatgpt.com`; NEVER host-pin/rewrite inside `rotation-fetch` (adapter owns URL).
- NEVER attach `Authorization` before `adapter.resolveUrl`; NEVER append — always overwrite (dummy SDK key).
- NEVER set `subscriptionStatus: "dead"` except refresh `invalid_grant`; NEVER dead-mark on post-refresh inference 401.
- NEVER map quota/usage → dead/prune; prune only dead **or** `flaggedForRemoval`.
- NEVER rotate on `unknown-client-error` / bare param 4xx; NEVER cross-provider select/sticky.
- NEVER use `activeIndex` storage (sticky map only, v3); NEVER nest storage txs; NEVER log tokens.
- NEVER use rotated refresh before durable persist; always `refresh_token ?? old`.
- NEVER named exports from plugin server modules; NEVER combine `server`+`tui`; no `as any` / `@ts-ignore`.
- NEVER change OAuth constants (xAI `:56121`+`plan=generic`; Codex `:1455`+extras).
- NEVER force Kiro through pure `createRotationFetch` — `transport.kind: "custom"` + `createKiroFetch`.
- NEVER models.dev network on cold start; NEVER delete user account files from install; NEVER publish npm as routine agent work.

## UNIQUE STYLES

- Selection: sticky active per provider → on fail, rescan **priority-sorted** list (priority DESC, then lastUsed/addedAt rules in `resolveActiveAccount`).
- Account selection strategies: `sticky` \| `round-robin` \| `lowest-usage` (Kiro exposes strategy option).
- Models.dev / catalog network sync **only after successful OAuth** (or explicit allowNetwork), not cold start.
- CLI reuses agent tools; bin name forces provider (`op-xai` / `op-codex` / `op-kiro`).
- Display name: label → email → short id.
- **xAI:** host-pin + rate-limit headers + billing credits.  
- **Codex:** URL rewrite + primary/secondary usage windows.  
- **Kiro:** region-aware CodeWhisperer endpoints, OpenAI-compat body → SDK request, SSE stream out; usage `usedCount`/`limitCount`.
- TUI tabs order: **Codex → xAI → Kiro** (`1`/`2`/`3`).

## COMMANDS

```bash
bun install                 # or npm install
npm run typecheck           # tsc --noEmit
npm test                    # vitest run
npm run test:tui-ffi        # TUI test under bun

./install.sh --path         # or npm run setup
npm run install:global      # shims → ~/.local/bin
bun scripts/install.ts [--with-plugin-entry]
bun scripts/install-tui.ts  # session sidebar plugin
bun scripts/cli.ts help

# remote (set MULTI_AI_REPO_URL first):
curl -fsSL …/install.sh | bash -s -- --path --with-plugin
```

## NOTES

- Package `opencode-multi-ai`; bins `op-ai`, `op-xai`, `op-codex`, `op-kiro`, historical aliases.
- `opencode xai-add` / `opencode codex-add` do **not** work as CLI shortcuts (paths); use `op-ai` / TUI / agent tools.
- Child domains: `lib/providers/{xai,codex,kiro}/` — keep isolated; implement `TransportProviderAdapter`.
- Hotspots: `lib/tui/app.ts` (~3k), `lib/tools/registry.ts`, `lib/core/accounts.ts` — prefer targeted edits.
- Hierarchical docs: `lib/core/AGENTS.md`, `lib/providers/*/AGENTS.md`, `lib/plugin/AGENTS.md`, `lib/tui/AGENTS.md`.
