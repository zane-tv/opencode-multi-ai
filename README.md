# opencode-multi-ai

OpenCode multi-account plugin for **SuperGrok (xAI)** and **ChatGPT / Codex** in one package: sticky rotation, usage/quota visibility, priority ordering, agent tools, and a tabbed **`op-ai`** CLI + OpenTUI manager.

| | xAI | Codex |
| --- | --- | --- |
| Provider ID | `xai-multi` | `codex-multi` |
| Display name | Grok Multi-Account | Codex Multi-Account |
| Auth | SuperGrok OAuth (browser + device) | ChatGPT/Codex OAuth (browser + device); optional auth.json import |
| Runtime | `@ai-sdk/xai` + host-pinned fetch | `@ai-sdk/openai` + rewrite to `chatgpt.com/backend-api` |
| Plugin module | `lib/plugin/xai.ts` | `lib/plugin/codex.ts` |
| CLI force | `op-xai` | `op-codex` |
| OAuth redirect | `http://127.0.0.1:56121/callback` | `http://localhost:1455/auth/callback` |

| | |
| --- | --- |
| Unified CLI | `op-ai` (tabbed TUI default) |
| UI language | English default; Vietnamese via `--lang vi` / `g` in TUI |
| Package | `opencode-multi-ai` |
| Account store | `~/.config/opencode/multi-ai-accounts.json` (v2, both providers) |

## Features

- **Two providers, one pool file** — accounts tagged `xai` / `codex`, isolated selection
- **Sticky active account** + automatic rotation on auth/quota/transient failures
- **Priority order** — list order is rotation preference
- **OAuth add** from OpenCode, CLI, or TUI (device code recommended)
- **xAI:** plan, billing credits %, rate-limit headers  
  **Codex:** primary/secondary usage windows, plan type, reset times
- **Tabbed OpenTUI** (`op-ai tui`) — switch providers without leaving the manager
- **Migration** from legacy `opencode-multi-xai` / `opencode-multi-codex` account files
- Quiet logs; models.dev network sync only after successful login

## Requirements

- [OpenCode](https://opencode.ai) (tested with 1.17.x)
- Node.js 18+ or [Bun](https://bun.sh)
- One or more SuperGrok and/or ChatGPT / Codex subscription accounts

## Install

### Quick install (one command)

Set the remote first if you use curl (placeholder until published):

```bash
export MULTI_AI_REPO_URL="https://github.com/<owner>/opencode-multi-ai.git"
curl -fsSL https://raw.githubusercontent.com/<owner>/opencode-multi-ai/main/install.sh | bash -s -- --path
```

Also useful:

```bash
# CLI only
curl -fsSL …/install.sh | bash

# + wire OpenCode dual providers/plugins
curl -fsSL …/install.sh | bash -s -- --path --with-plugin

# reinstall / update
curl -fsSL …/install.sh | bash -s -- --path --force
```

What it does:

1. Clones/updates to `~/.local/share/opencode-multi-ai` (override: `MULTI_AI_HOME`, falls back to `MULTI_XAI_HOME` / `MULTI_CODEX_HOME`)
2. Installs dependencies
3. Installs **global CLI** shims into `~/.local/bin` (`MULTI_AI_BIN_DIR`)
4. With `--path`, ensures `~/.local/bin` is on your shell PATH
5. With `--with-plugin`, runs `scripts/install.ts --with-plugin-entry`

Then **from any directory**:

```bash
op-ai tui
op-ai list
op-xai list
op-codex list
op-ai limits --probe
op-ai help
```

| Command | Role |
| --- | --- |
| `op-ai` | primary (both providers / tabs) |
| `op-xai` | force xAI |
| `op-codex` | force Codex |
| `opencode-multi-ai` | alias |
| `opencode-multi-xai` / `xai-multi` | historical → same CLI |
| `opencode-multi-codex` / `codex-multi` | historical → same CLI |

Open a **new terminal** after `--path`, or `source ~/.zshrc`.

### Install from a local clone

```bash
git clone <your-remote>/opencode-multi-ai.git
cd opencode-multi-ai
./install.sh --path
# or: npm run setup
```

```bash
npm run install-cli       # shims only
npm run install:global    # shims + PATH
```

### Wire plugins into OpenCode

OpenCode must load **both** plugin modules (not the package root):

`~/.config/opencode/opencode.json` or `opencode.jsonc`:

```jsonc
{
  "plugin": [
    "/absolute/path/to/opencode-multi-ai/lib/plugin/xai.ts",
    "/absolute/path/to/opencode-multi-ai/lib/plugin/codex.ts"
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
    }
  }
}
```

Or:

```bash
bun scripts/install.ts
# optional — also write both plugin array entries + replace legacy packages:
bun scripts/install.ts --with-plugin-entry --config ~/.config/opencode/opencode.json
```

`install.ts` merges **idempotently**:

- Registers **both** `xai-multi` and `codex-multi`
- Backs up `opencode.json` → `.bak` (does not overwrite an existing bak)
- Replaces old `opencode-multi-xai` / `opencode-multi-codex` plugin entries
- Preserves unrelated plugins and built-in `xai` / `openai`
- Never writes built-in ids as multi providers
- Fills missing fields only; user model/option edits win

Restart OpenCode after config changes.

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

> **`opencode xai-add` / `opencode codex-add` do not work** — OpenCode treats those as project paths. Use `op-ai` / `op-xai` / `op-codex` or in-session agent tools.

## Add accounts

### Via OpenCode

1. Restart OpenCode after install
2. `opencode auth login`
3. Choose provider **`xai-multi`** or **`codex-multi`**
4. Pick browser or device-code OAuth

### Via CLI / TUI

```bash
op-ai tui                    # tabs: xAI | Codex
op-ai add --provider xai
op-ai add --provider codex
op-xai add                  # forced xAI
op-codex add                # forced Codex
op-codex import --file ~/.codex/auth.json   # OAuth blob import (Codex)
```

OAuth only — no raw API-key paste into the multi pool.

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

Mutating commands on `op-ai` need `--provider xai|codex` when the target is ambiguous. `op-xai` / `op-codex` force the provider.

## Migration from multi-xai / multi-codex

On first load, legacy account files are imported into `multi-ai-accounts.json` (v2):

- `~/.config/opencode/multi-xai-accounts.json`
- `~/.config/opencode/multi-codex-accounts.json`

Legacy files are preserved (optional `.bak` copies). Existing v2 accounts for a provider are never clobbered. Install scripts **do not** delete account files.

Plugin array entries for `opencode-multi-xai` / `opencode-multi-codex` are replaced when you run:

```bash
bun scripts/install.ts --with-plugin-entry
```

## Settings & env

See `lib/core/settings-inventory.ts` for the full inventory.

| Path | Purpose |
| --- | --- |
| `multi-ai-accounts.json` | Unified account pool |
| `multi-ai-settings.json` | Locale (`lang`: `en` \| `vi`) |
| `multi-ai-models-xai.json` | xAI model cache |
| `multi-ai-models-codex.json` | Codex model cache |

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
npm run typecheck
npm test
bun scripts/cli.ts help
bun scripts/install.ts --config /tmp/opencode.json
```

## License

MIT
