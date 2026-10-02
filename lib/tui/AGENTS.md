# lib/tui — AGENTS

**Domain:** tabbed OpenTUI account manager (`op-ai` tui / provider-forced bins).

## OVERVIEW

Interactive terminal UI for multi-provider account pool: list, sticky, probe quota, add/remove/edit, action menus. Tabs: **Codex → xAI → Kiro → OpenCode Go**. Entry `runTui` in `app.ts`. Pure tab/action logic lives outside OpenTUI for unit tests.

## STRUCTURE

```
lib/tui/
├── app.ts              # runTui — OpenTUI renderables, live probe, actions (~3k LOC)
├── tabs.ts             # pure: TUI_TABS, keys 1/2/3/4, selection/generation helpers
└── action-helpers.ts   # pure: action menu tree, confirmations, key bindings
```

## WHERE TO LOOK

| Task | File | Notes |
|------|------|--------|
| Entry / render loop | `app.ts` → `runTui` | `new AccountManager()` (not plugin singleton) |
| Tab order / keys | `tabs.ts` | `TUI_TABS = codex, xai, kiro, opencode-go`; keys `1`/`2`/`3`/`4` |
| Action menu / confirm | `action-helpers.ts` | decode bindings, group menus, confirm state |
| List/detail/probe text | adapters via `ADAPTERS` in `app.ts` | all four: `listSubtitle` / detail / probe |
| Locale | `g` key → i18n | toggles; re-paint strings |

## CONVENTIONS

- **CLI owns manager:** `new AccountManager()` + default refresh handlers; never `getAccountManager()` (plugin singleton).
- **Default tab Codex.** Bins force provider: `op-xai` / `op-codex` / `op-kiro` / `op-opencode-go` → `initialTab`.
- **ADAPTERS map** all four adapters for subtitle, detail, live quota probe.
- **OpenCode Go tab** (`4`, pink accent `#f472b6`): `a` opens the API-key paste wizard (no OAuth — key + optional label; `accountId = sha256(key)` for dedupe; key stored in both `refreshToken` and `accessToken`); `w` rotates round-robin to the next key, calls `writeActiveKeyToAuthJson`, and shows "Restart opencode for the new key to take effect." (plugin path reloads via `client.config.update({})`; standalone TUI cannot).
- **Live probe:** timers tagged with per-tab generation so stale results never paint wrong tab.
- **Prefer pure helpers** in `tabs.ts` / `action-helpers.ts` for unit tests.
- **Extract before growing** `app.ts` further — keep OpenTUI wiring thin; logic pure.

## ANTI-PATTERNS

- NEVER grow `app.ts` with new pure logic — extract to `tabs` / `action-helpers` (or new pure module).
- NEVER couple `tabs.ts` / `action-helpers.ts` to OpenTUI renderables.
- NEVER use plugin `getAccountManager()` singleton from TUI.
- NEVER hardcode tab order outside `TUI_TABS` / `tabs.ts`.
- NEVER paint live probe without generation check (stale tab bleed).
- NEVER skip provider-forced `initialTab` when launched via `op-xai` / `op-codex` / `op-kiro` / `op-opencode-go`.
- NEVER run the opencode-go rotate on a non-opencode-go tab (bindings are provider-scoped).
