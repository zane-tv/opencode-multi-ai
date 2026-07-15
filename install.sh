#!/usr/bin/env bash
# Quick install for opencode-multi-ai + global op-ai CLI (xAI + Codex).
#
# One-liner (no manual git clone):
#   curl -fsSL …/install.sh | bash
#   curl -fsSL …/install.sh | bash -s -- --path
#   curl -fsSL …/install.sh | bash -s -- --path --with-plugin
#
# From a local clone:
#   ./install.sh --path
#
set -euo pipefail

# Repo URL is a placeholder until the remote is published. Override with MULTI_AI_REPO_URL.
REPO_URL="${MULTI_AI_REPO_URL:-${MULTI_XAI_REPO_URL:-${MULTI_CODEX_REPO_URL:-https://github.com/<owner>/opencode-multi-ai.git}}}"
REPO_REF="${MULTI_AI_REPO_REF:-${MULTI_XAI_REPO_REF:-${MULTI_CODEX_REPO_REF:-main}}}"
# Default install location when using curl | bash
DEFAULT_ROOT="${MULTI_AI_HOME:-${MULTI_XAI_HOME:-${MULTI_CODEX_HOME:-$HOME/.local/share/opencode-multi-ai}}}"

WITH_PATH=0
WITH_PLUGIN=0
FORCE_CLONE=0
CUSTOM_ROOT=""

for arg in "$@"; do
  case "$arg" in
    --path|--fix-path) WITH_PATH=1 ;;
    --with-plugin|--plugin) WITH_PLUGIN=1 ;;
    --force|--reinstall) FORCE_CLONE=1 ;;
    --dir=*) CUSTOM_ROOT="${arg#--dir=}" ;;
    -h|--help)
      cat <<'EOF'
opencode-multi-ai install

One command (recommended):
  curl -fsSL https://raw.githubusercontent.com/<owner>/opencode-multi-ai/main/install.sh | bash -s -- --path

Options:
  --path           Ensure ~/.local/bin is on PATH (shell rc)
  --with-plugin    Wire OpenCode dual providers + dual plugin entries
  --force          Re-clone / reset install dir (curl mode)
  --dir=PATH       Install repo to PATH (default: ~/.local/share/opencode-multi-ai)

Env:
  MULTI_AI_HOME       Install dir for curl mode (fallback: MULTI_XAI_HOME / MULTI_CODEX_HOME)
  MULTI_AI_REPO_URL   Git remote
  MULTI_AI_REPO_REF   Branch/tag (default: main)
  MULTI_AI_BIN_DIR    Shim install dir (default: ~/.local/bin)

After install, from any directory:
  op-ai tui
  op-ai list
  op-xai list
  op-codex list
  op-ai limits --probe
  op-ai help
EOF
      exit 0
      ;;
  esac
done

# Detect local repo vs curl | bash
is_repo_root() {
  local d="$1"
  [[ -f "$d/package.json" && -f "$d/scripts/cli.ts" && -f "$d/scripts/install-cli.sh" ]]
}

SCRIPT_PATH="${BASH_SOURCE[0]:-}"
LOCAL_ROOT=""
if [[ -n "$SCRIPT_PATH" && -f "$SCRIPT_PATH" ]]; then
  case "$SCRIPT_PATH" in
    /dev/*|pipe:*|-) ;;
    *)
      cand="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
      if is_repo_root "$cand"; then
        LOCAL_ROOT="$cand"
      fi
      ;;
  esac
fi

if [[ -n "$LOCAL_ROOT" && "$FORCE_CLONE" -eq 0 ]]; then
  ROOT="$LOCAL_ROOT"
  echo "==> opencode-multi-ai install (local repo)"
else
  ROOT="${CUSTOM_ROOT:-$DEFAULT_ROOT}"
  echo "==> opencode-multi-ai install (remote)"
  echo "    repo: $REPO_URL ($REPO_REF)"
  echo "    dir:  $ROOT"

  if ! command -v git >/dev/null 2>&1; then
    echo "error: git is required for curl install" >&2
    exit 1
  fi

  if [[ -d "$ROOT/.git" ]] && is_repo_root "$ROOT" && [[ "$FORCE_CLONE" -eq 0 ]]; then
    echo "==> updating existing install"
    git -C "$ROOT" fetch --depth 1 origin "$REPO_REF"
    git -C "$ROOT" checkout -q -B "$REPO_REF" "origin/$REPO_REF" 2>/dev/null \
      || git -C "$ROOT" pull --ff-only origin "$REPO_REF"
  else
    if [[ -e "$ROOT" && "$FORCE_CLONE" -eq 1 ]]; then
      echo "==> removing $ROOT (--force)"
      rm -rf "$ROOT"
    fi
    if [[ -e "$ROOT" ]] && ! is_repo_root "$ROOT"; then
      echo "error: $ROOT exists and is not an opencode-multi-ai checkout" >&2
      echo "  use --force or MULTI_AI_HOME=/other/path" >&2
      exit 1
    fi
    if [[ ! -d "$ROOT/.git" ]]; then
      echo "==> cloning…"
      mkdir -p "$(dirname "$ROOT")"
      git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$ROOT"
    fi
  fi

  if ! is_repo_root "$ROOT"; then
    echo "error: clone incomplete at $ROOT" >&2
    exit 1
  fi
fi

cd "$ROOT"
echo "    root: $ROOT"
echo ""

# --- runtime ---
if command -v bun >/dev/null 2>&1; then
  RUNNER=bun
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  export PATH="$HOME/.bun/bin:$PATH"
  RUNNER=bun
elif command -v npm >/dev/null 2>&1; then
  RUNNER=npm
else
  echo "error: need bun or npm on PATH" >&2
  echo "  install bun: https://bun.sh" >&2
  exit 1
fi

# --- deps ---
if [[ ! -d node_modules ]]; then
  echo "==> installing dependencies ($RUNNER)"
  if [[ "$RUNNER" == "bun" ]]; then
    bun install
  else
    npm install
  fi
else
  echo "==> dependencies already present (node_modules)"
fi

# --- global CLI ---
BIN_DIR="${MULTI_AI_BIN_DIR:-${MULTI_XAI_BIN_DIR:-${MULTI_CODEX_BIN_DIR:-$HOME/.local/bin}}}"
echo "==> installing global CLI shortcuts → $BIN_DIR"
if [[ "$WITH_PATH" -eq 1 ]]; then
  bash "$ROOT/scripts/install-cli.sh" --path
else
  bash "$ROOT/scripts/install-cli.sh"
fi

# --- optional OpenCode plugin wiring (both providers + both plugin entries) ---
if [[ "$WITH_PLUGIN" -eq 1 ]]; then
  echo ""
  echo "==> wiring OpenCode dual providers/plugins (xai-multi + codex-multi)"
  if command -v bun >/dev/null 2>&1 || [[ -x "$HOME/.bun/bin/bun" ]]; then
    BUN_BIN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
    "$BUN_BIN" "$ROOT/scripts/install.ts" --with-plugin-entry 2>/dev/null \
      || "$BUN_BIN" "$ROOT/scripts/install.ts" || true
  else
    echo "note: bun required for scripts/install.ts; skipped plugin wiring" >&2
  fi
fi

export PATH="${HOME}/.local/bin:$PATH"
hash -r 2>/dev/null || true

echo ""
echo "==> done"
echo "    installed at: $ROOT"
echo ""
echo "Global commands (any directory):"
echo "  op-ai tui"
echo "  op-ai list"
echo "  op-xai list"
echo "  op-codex list"
echo "  op-ai limits --probe"
echo "  op-ai add --provider xai"
echo "  op-ai help"
echo ""
echo "Aliases: opencode-multi-ai · op-xai · op-codex · xai-multi · codex-multi"
echo ""

if command -v op-ai >/dev/null 2>&1; then
  echo "Verified: $(command -v op-ai)"
else
  echo "If 'op-ai' is not found, open a new terminal or run:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo "Or re-run with --path:"
  echo "  ./install.sh --path"
fi
