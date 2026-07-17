# opencode-multi-ai

OpenCode multi-account plugin unifying **SuperGrok (xAI)**, **ChatGPT / Codex**, and **Kiro (AWS CodeWhisperer)** in one package: sticky rotation, usage/quota visibility, priority ordering, agent tools, and a tabbed **`op-ai`** CLI + OpenTUI manager.

| | xAI | Codex | Kiro |
| --- | --- | --- | --- |
| Provider ID | `xai-multi` | `codex-multi` | `kiro-multi` |
| Display name | Grok Multi-Account | Codex Multi-Account | Kiro Multi-Account |
| Auth | SuperGrok OAuth (browser + device) | ChatGPT/Codex OAuth (browser + device); optional `auth.json` import | AWS IDC device / desktop / `ksk_*` API key / credentials import |
| Runtime | `@ai-sdk/xai` + host-pinned fetch | `@ai-sdk/openai` + rewrite to `chatgpt.com/backend-api` | `@ai-sdk/openai-compatible` + **custom** CodeWhisperer SDK transport |
| Plugin module | `lib/plugin/xai.ts` | `lib/plugin/codex.ts` | `lib/plugin/kiro.ts` |
| CLI force | `op-xai` | `op-codex` | `op-kiro` |

| | |
| --- | --- |
| Unified CLI | `op-ai` (tabbed TUI default) |
| Default TUI tab | **Codex** (`op-ai tui`; override with `--provider xai\|kiro` or `op-xai`/`op-kiro tui`) |
| TUI tab order | Codex → xAI → Kiro (`1` / `2` / `3`) |
| UI language | English default; Vietnamese via `--lang vi` / `g` in TUI |
| Package | `opencode-multi-ai` |
| Account store | `~/.config/opencode/multi-ai-accounts.json` (v3, all providers) |
| Repo | [zane-tv/opencode-multi-ai](https://github.com/zane-tv/opencode-multi-ai) |

## Features

- **Three providers, one pool file** — accounts tagged `xai` / `codex` / `kiro`, isolated selection
- **Sticky active account** + automatic rotation on auth/quota/transient failures
- **Priority order** — list order is rotation preference
- **Selection strategies** — `sticky` (default), `round-robin`, `lowest-usage` (Kiro exposes the option)
- **OAuth add** from OpenCode, CLI, or TUI (device code recommended)
- **xAI:** plan, billing credits %, rate-limit headers
  **Codex:** primary/secondary usage windows, plan type, reset times
  **Kiro:** region-aware CodeWhisperer endpoints, `usedCount` / `limitCount` meters
- **Tabbed OpenTUI** (`op-ai tui`) — Codex tab first; switch providers without leaving the manager
- **Full action menu** — provider-scoped account actions in their own bordered pane
- **Mouse support** — click accounts and action rows
- **VI + EN locale** — toggle with `g` (persisted in settings)
- **Migration** from legacy `opencode-multi-xai` / `opencode-multi-codex` account files
- Quiet logs; models.dev network sync only after successful login

## Requirements

- [OpenCode](https://opencode.ai) (tested with 1.17.x)
- Node.js 20+ or [Bun](https://bun.sh)
- One or more SuperGrok, ChatGPT / Codex, and/or Kiro (AWS CodeWhisperer) subscription accounts

## Install

### Quick install (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/zane-tv/opencode-multi-ai/main/install.sh | bash -s -- --path
```

Also useful:

```bash
# CLI only
curl -fsSL https://raw.githubusercontent.com/zane-tv/opencode-multi-ai/main/install.sh | bash

# + wire OpenCode providers/plugins
curl -fsSL https://raw.githubusercontent.com/zane-tv/opencode-multi-ai/main/install.sh | bash -s -- --path --with-plugin

# reinstall / update
curl -fsSL https://raw.githubusercontent.com/zane-tv/opencode-multi-ai/main/install.sh | bash -s -- --path --force
```

What it does:

1. Clones/updates to `~/.local/share/opencode-multi-ai` (override: `MULTI_AI_HOME`)
2. Installs dependencies
3. Installs **global CLI** shims into `~/.local/bin` (`MULTI_AI_BIN_DIR`)
4. With `--path`, ensures `~/.local/bin` is on your shell PATH
5. With `--with-plugin`, runs `scripts/install.ts --with-plugin-entry`

Then **from any directory**:

```bash
op-ai tui                 # opens on Codex tab
op-ai list
op-xai list
op-codex list
op-kiro list
op-ai limits --probe
op-ai help
```

| Command | Role |
| --- | --- |
| `op-ai` | primary (all providers / tabs) |
| `op-xai` | force xAI |
| `op-codex` | force Codex |
| `op-kiro` | force Kiro |
| `opencode-multi-ai` | alias |
| `opencode-multi-xai` / `xai-multi` | historical → same CLI |
| `opencode-multi-codex` / `codex-multi` | historical → same CLI |
| `kiro-multi` | historical → same CLI |

Open a **new terminal** after `--path`, or `source ~/.zshrc`.

### Install from a local clone

```bash
git clone https://github.com/zane-tv/opencode-multi-ai.git
cd opencode-multi-ai
./install.sh --path
# or: npm run setup
```

```bash
npm run install-cli       # shims only
npm run install:global    # shims + PATH
```

### Wire plugins into OpenCode

**One plugin line** loads all three providers (package root re-exports `xai` + `codex` + `kiro`):

`~/.config/opencode/opencode.json` or `opencode.jsonc`:

```jsonc
{
  "plugin": [
    "/absolute/path/to/opencode-multi-ai"
  ],
  "provider": {
    "xai-multi": {
      "npm": "@ai-sdk/xai",
      "name": "Grok Multi-Account",
      "options": {
        "baseURL": "https://api.x.ai/v1"
      }
    },
    "codex-multi": {
      "npm": "@ai-sdk/openai",
      "name": "Codex Multi-Account",
      "options": {
        "baseURL": "https://chatgpt.com/backend-api",
        "store": false,
        "include": ["reasoning.encrypted_content"]
      }
    },
    "kiro-multi": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kiro Multi-Account",
      "options": {
        "baseURL": "https://q.us-east-1.amazonaws.com",
        "accountSelectionStrategy": "sticky"
      }
    }
  }
}
```

Local clone example:

```jsonc
"plugin": ["/Users/you/opencode-multi-ai"]
```

Or:

```bash
bun scripts/install.ts
# optional — write the single package-root plugin entry + replace legacy packages:
bun scripts/install.ts --with-plugin-entry --config ~/.config/opencode/opencode.json
```

`install.ts` merges **idempotently**:

- Registers **all three** providers `xai-multi`, `codex-multi`, and `kiro-multi`
- Writes **one** plugin path (package root) that loads all modules
- Rewrites old dual paths (`…/lib/plugin/xai.ts` + `…/codex.ts`) → single root
- Backs up `opencode.json` → `.bak` (does not overwrite an existing bak)
- Replaces old `opencode-multi-xai` / `opencode-multi-codex` plugin entries
- Preserves unrelated plugins and built-in `xai` / `openai`
- Never writes built-in ids as multi providers
- Fills missing fields only; user model/option edits win

Restart OpenCode after config changes.

### Session sidebar (ACTIVE account + quota)

OpenCode’s **right session sidebar** is a separate TUI plugin surface. Register it once:

```bash
bun scripts/install-tui.ts
# or: npm run install-tui
```

This appends to `~/.config/opencode/tui.json`:

```jsonc
{
  "plugin": [
    "/absolute/path/to/opencode-multi-ai/lib/plugin/tui.tsx"
  ]
}
```

After restart, the sidebar shows an **Accounts** section near the bottom (after Context / MCP / LSP / Models):

- `★ Codex  <name> · plan`
- colored meter + remaining %
- `★ xAI  <name> · plan` and `★ Kiro  <name> · usage` (same)

Only the **ACTIVE (sticky)** account per provider is listed. Manage sticky with `op-ai tui` → `s`.

### Global CLI (if you skipped quick install)

```bash
./install.sh --path
# or:
bash scripts/install-cli.sh --path
npm run install:global
```

Without global install:

```bash
bun scripts/cli.ts help
npm run cli -- list
```

> **`opencode xai-add` / `opencode codex-add` do not work** — OpenCode treats those as project paths. Use `op-ai` / `op-xai` / `op-codex` / `op-kiro` or in-session agent tools.

## Add accounts

### Via OpenCode

1. Restart OpenCode after install
2. `opencode auth login`
3. Choose provider **`xai-multi`**, **`codex-multi`**, or **`kiro-multi`**
4. Pick an auth method (OAuth browser/device, or Kiro API key / import)

### Via CLI / TUI

```bash
op-ai tui                    # default tab: Codex
op-ai tui --provider xai     # start on xAI
op-ai tui --provider kiro    # start on Kiro
op-ai add --provider xai
op-ai add --provider codex
op-ai add --provider kiro
op-xai add                   # forced xAI
op-codex add                 # forced Codex
op-kiro add                  # forced Kiro
op-codex import --file ~/.codex/auth.json     # OAuth blob import (Codex)
op-kiro import --api-key ksk_xxx --region us-east-1   # Kiro API key
op-kiro import --kiro-cli                      # import from local kiro-cli
```

OAuth only for xAI/Codex — no raw API-key paste into the multi pool. Kiro adds via its own auth methods (`ksk_*`, AWS IDC, or credential imports).

## TUI (`op-ai tui`)

Layout: **tab bar** → **account list** → **action menu** (own bordered box) → status / footer.

| Input | Action |
| --- | --- |
| `Tab` / `1` / `2` / `3` | Next tab / Codex / xAI / Kiro |
| `↑` `↓` or mouse | Select account or action row |
| `s` | Make sticky (active) |
| `a` / `A` / `+` | Add (device) / add (browser) |
| `e` / `d` | Enable / disable |
| `[` / `]` / `{` | Priority up / down / top |
| `l` / `t` / `n` | Label / tags / note |
| `f` / `u` | Flag / unflag for prune |
| `x` / `p` | Remove (confirm) / prune (confirm) |
| `r` / `R` | Refresh selected / refresh all |
| `v` | Toggle live quota probe |
| `L` | Reload pool from disk |
| `g` | Toggle language (EN ↔ VI) |
| `?` | Help |
| `q` / `Esc` | Quit / cancel |

Default tab is **Codex**. `op-xai tui` / `op-codex tui` / `op-kiro tui` force that provider; `op-ai tui --provider xai|codex|kiro` overrides.

## Everyday commands

```bash
op-ai list
op-ai status
op-ai limits --probe
op-ai health
op-ai switch <id>
op-ai priority <id> top
op-ai remove <id>
op-ai help
```

Mutating commands on `op-ai` need `--provider xai|codex|kiro` when the target is ambiguous. `op-xai` / `op-codex` / `op-kiro` force the provider.

## Migration from multi-xai / multi-codex

On first load, legacy account files are imported into `multi-ai-accounts.json` (v3):

- `~/.config/opencode/multi-xai-accounts.json`
- `~/.config/opencode/multi-codex-accounts.json`

Legacy files are preserved (optional `.bak` copies). Existing accounts for a provider already present are never clobbered. Install scripts **do not** delete account files. Kiro has no legacy v1 file — only xAI/Codex migrate.

Plugin array entries for `opencode-multi-xai` / `opencode-multi-codex` are replaced when you run:

```bash
bun scripts/install.ts --with-plugin-entry
```

## Settings & env

See `lib/core/settings-inventory.ts` for the full inventory.

| Path | Purpose |
| --- | --- |
| `multi-ai-accounts.json` | Unified account pool (v3) |
| `multi-ai-settings.json` | Locale (`lang`: `en` \| `vi`) |
| `multi-ai-models-xai.json` | xAI model cache |
| `multi-ai-models-codex.json` | Codex model cache |
| `multi-ai-models-kiro.json` | Kiro model cache |

| Env | Purpose |
| --- | --- |
| `MULTI_AI_LANG` | Locale (fallback: `MULTI_XAI_LANG` / `MULTI_CODEX_LANG`) |
| `MULTI_AI_BIN_DIR` | Shim install dir |
| `MULTI_AI_HOME` | curl install root |
| `MULTI_AI_REPO_URL` / `MULTI_AI_REPO_REF` | clone source |
| `OPENCODE_CONFIG` | alternate `opencode.json` path for install |

## Develop

```bash
bun install
npm run typecheck        # tsc --noEmit
npm test                 # vitest run
npm run test:tui-ffi     # TUI test under bun
bun scripts/cli.ts help
bun scripts/install.ts --config /tmp/opencode.json
```

## License

MIT
