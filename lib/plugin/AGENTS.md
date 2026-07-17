# lib/plugin — OpenCode plugin entries

**Domain:** OpenCode PluginModules for opencode-multi-ai (server + session sidebar).

## OVERVIEW

Three **server** plugins + one **TUI sidebar** plugin.

| File | id | Default export | Role |
|------|-----|----------------|------|
| `xai.ts` | `xai-multi` | `{ id, server }` only | SuperGrok OAuth + host-pin rotation |
| `codex.ts` | `codex-multi` | `{ id, server }` only | ChatGPT/Codex OAuth + URL rewrite |
| `kiro.ts` | `kiro-multi` | `{ id, server }` only | Kiro auth + custom transport |
| `tui.tsx` | sidebar | `{ id, tui }` only | ACTIVE account + quota in session sidebar |

Server modules wire: `getAccountManager()` → `createProviderFetch(adapter)` → auth methods → provider config.  
Package root `index.ts` re-exports named `xai` / `codex` / `kiro` (no default).  
`package.json` exports `./lib/plugin/*` and `./tui`.

## WHERE TO LOOK

| Task | File | Notes |
|------|------|-------|
| Server plugin shape | `xai.ts` / `codex.ts` / `kiro.ts` | default `{ id, server }` only |
| Session sidebar | `tui.tsx` | default `{ id, tui }`; register via `tui.json` |
| Package multi-load | `../../index.ts` | named exports only |
| Pool singleton | `../core/accounts.ts` | `getAccountManager()` |
| Fetch glue | `../core/provider-fetch.ts` | HTTP vs Kiro custom |
| Adapters | `../providers/*/adapter.ts` | strategy objects |
| Sidebar rows | `../sidebar/active-quota.ts` | ACTIVE sticky + meter |
| Install server path | `../../scripts/install.ts` | one package-root plugin entry |
| Install sidebar | `../../scripts/install-tui.ts` | writes `tui.json` only |

## CONVENTIONS

- **Export hygiene:** each server file default-exports **only** `{ id, server }` PluginModule. No named function exports (OpenCode legacy loader may invoke every export as a Plugin and silently drop the module).
- **TUI exclusive:** `tui.tsx` default-exports **only** `{ id, tui }`. Registered in `~/.config/opencode/tui.json`, not the server `opencode.json` plugin array.
- **Never** combine `server` + `tui` in one file (OpenCode rejects dual-target modules).
- Provider ids: **`xai-multi` / `codex-multi` / `kiro-multi` only**. Never override built-in `xai` / `openai`.
- Construction: plugins use `getAccountManager()` (singleton). CLI/TUI use `new AccountManager()`.
- Each server plugin: load manager → `createProviderFetch(adapter)` → register auth methods (OAuth/device/etc.) → models after successful login only.
- Root `index.ts`: named `xai`, `codex`, `kiro` only so one config path loads all three.
- ESM; relative imports with `.js` extensions.

## ANTI-PATTERNS

- NEVER named exports from plugin server modules (functions get mis-invoked).
- NEVER default-export a single PluginModule from package root (loads only one provider).
- NEVER put sidebar in `opencode.json` plugin array; use `tui.json` via `install-tui.ts`.
- NEVER merge server + tui into one module.
- NEVER re-merge provider domains into a single plugin file.
- NEVER log tokens; never write raw keys into OpenCode `auth.json` for the multi pool.
- NEVER use built-in ids `xai` / `openai` as multi provider ids.
