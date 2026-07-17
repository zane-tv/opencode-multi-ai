/**
 * Lightweight locale for op-ai CLI/TUI.
 * Default: English (en).
 *
 * Load order:
 *   MULTI_AI_LANG || MULTI_XAI_LANG || MULTI_CODEX_LANG env
 *   > multi-ai-settings.json
 *   > en
 *
 * Settings path: ~/.config/opencode/multi-ai-settings.json
 * (override with MULTI_AI_SETTINGS_PATH for hermetic tests)
 *
 * TUI `g` / setLocale / toggleLocale persist to settings file.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Locale = "vi" | "en";

type SettingsFile = {
  lang?: string;
};

let current: Locale = "en";
let loaded = false;

/** UI settings (locale, …): ~/.config/opencode/multi-ai-settings.json */
export function defaultSettingsPath(): string {
  const override = process.env.MULTI_AI_SETTINGS_PATH?.trim();
  if (override) return override;
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-ai-settings.json",
  );
}

function normalizeLocale(raw: string | undefined | null): Locale | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "vi" || v.startsWith("vi") || v.includes("vn")) return "vi";
  if (v === "en" || v.startsWith("en")) return "en";
  return null;
}

function readSettingsFile(): SettingsFile {
  try {
    const p = defaultSettingsPath();
    if (!fs.existsSync(p)) return {};
    const raw = fs.readFileSync(p, "utf8");
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object") return {};
    return data as SettingsFile;
  } catch {
    return {};
  }
}

function writeSettingsFile(patch: SettingsFile): void {
  try {
    const p = defaultSettingsPath();
    const dir = p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
    fs.mkdirSync(dir, { recursive: true });
    const prev = readSettingsFile();
    const next = { ...prev, ...patch };
    const body = `${JSON.stringify(next, null, 2)}\n`;
    // Same-fs rename is atomic — prevents truncated concurrent reads.
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, p);
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      /* ignore chmod failures */
    }
  } catch {
    // non-fatal
  }
}

function envLocale(): Locale | null {
  return normalizeLocale(
    process.env.MULTI_AI_LANG ||
      process.env.MULTI_XAI_LANG ||
      process.env.MULTI_CODEX_LANG,
  );
}

export function ensureLocaleLoaded(): Locale {
  if (loaded) return current;
  loaded = true;

  const fromEnv = envLocale();
  if (fromEnv) {
    current = fromEnv;
    return current;
  }

  const fromFile = normalizeLocale(readSettingsFile().lang);
  if (fromFile) {
    current = fromFile;
    return current;
  }

  current = "en";
  return current;
}

ensureLocaleLoaded();

export function getLocale(): Locale {
  ensureLocaleLoaded();
  return current;
}

export function setLocale(locale: Locale, persist = true): void {
  loaded = true;
  current = locale === "en" ? "en" : "vi";
  if (persist) writeSettingsFile({ lang: current });
}

export function toggleLocale(persist = true): Locale {
  ensureLocaleLoaded();
  current = current === "vi" ? "en" : "vi";
  if (persist) writeSettingsFile({ lang: current });
  return current;
}

/**
 * Reset module locale state for hermetic tests.
 * Does not delete settings files.
 */
export function resetLocaleStateForTests(): void {
  loaded = false;
  current = "en";
}

type Dict = Record<string, string>;

const en: Dict = {
  never: "never",
  just_now: "just now",
  now: "now",
  empty: "—",
  ago_s: "{n}s ago",
  ago_m: "{n}m ago",
  ago_h: "{n}h ago",
  ago_d: "{n}d ago",
  in_s: "in {n}s",
  in_m: "in {n}m",
  in_h: "in {n}h",
  in_d: "in {n}d",
  brand: "  op-ai  ·  SuperGrok + Codex multi-account",
  status_hint:
    "  ↑↓/mouse select  ·  Tab panes  ·  live: ALL accounts ~20s · parallel batches ×4",
  footer:
    "  a/A add  [ ]/{ priority  s switch  e/d on/off  r/R quota  v live(all)  l/t/n edit\n  f/u flag  x del  p prune  L reload  g lang  Esc cancel  Tab  q quit",
  live_on: "  ·  live on",
  live_off: "  ·  live off",
  live_busy: "  ·  live …",
  accounts_title: " accounts ",
  actions_title: " actions ",
  menu_account: "› Account",
  menu_edit: "› Edit",
  menu_add: "› Add",
  menu_quota: "› Quota",
  menu_danger: "› Danger",
  menu_back: "‹ Back",
  menu_desc_back: "Return to main action menu",
  menu_desc_account: "Switch, enable/disable, priority",
  menu_desc_edit: "Label, tags, note",
  menu_desc_add: "Device or browser OAuth",
  menu_desc_add_kiro:
    "API key, Builder ID / IDC, Profile ARN, JSON import, kiro-cli",
  menu_desc_quota: "Refresh, live probe, reload pool",
  menu_desc_danger: "Flag, remove, prune",
  detail_title: " detail / quota ",
  empty_pool: "  empty pool",
  empty_hint:
    "opencode auth login → xai-multi / codex-multi / kiro-multi",
  no_accounts:
    "No accounts yet.\n\nAdd one:\n  xAI/Codex: a device · A browser\n  Kiro: a IDC · i API key · I ARN · o JSON · O export · c kiro-cli\n  Esc cancels while waiting\n\nTabs: Codex | xAI | Kiro",
  lang_switched: "Language: English",
  add_device: "a  Add (device)",
  add_browser: "A  Add (browser)",
  add_kiro_api_key: "i  API key (ksk_)",
  add_kiro_idc_arn: "I  IDC + Profile ARN",
  add_kiro_json: "o  Import credentials JSON",
  add_kiro_export: "O  Import Account Manager export",
  add_kiro_cli: "c  Import kiro-cli DB",
  how_to_add: "?  How to add",
  refresh: "r  Refresh",
  refresh_all: "R  Refresh all",
  live_quota: "v  Live quota",
  switch: "s  Switch",
  prio_up: "[  Priority up",
  prio_down: "]  Priority down",
  prio_top: "{  Priority top",
  enable: "e  Enable",
  disable: "d  Disable",
  label: "l  Label",
  tags: "t  Tags",
  note: "n  Note",
  flag: "f  Flag",
  unflag: "u  Unflag",
  remove: "x  Remove",
  prune: "p  Prune",
  clean_dead: "P  Clean dead",
  reload: "L  Reload",
  quit: "q  Quit",
  lang: "g  Language",
  desc_add_device:
    "Start device OAuth for the active tab — open URL, enter code; Esc cancels mid-flow",
  desc_add_browser:
    "Open browser OAuth on the active tab's loopback — same pool upsert; Esc cancels",
  desc_add_kiro_api_key:
    "Add Kiro account with API key (ksk_…) and optional region",
  desc_add_kiro_idc_arn:
    "IAM Identity Center device login with required Profile ARN",
  desc_add_kiro_json:
    "Paste single-account credentials JSON (refreshToken + method fields)",
  desc_add_kiro_export:
    "Paste Kiro Account Manager export JSON (accounts array)",
  desc_add_kiro_cli:
    "Import accounts from local kiro-cli SQLite (default path or custom)",
  desc_how_to_add:
    "Show step-by-step add guide for the active provider",
  desc_refresh: "Probe selected account quota / usage for the active tab",
  desc_refresh_all:
    "Probe every account on the active tab in parallel batches",
  desc_live:
    "Toggle auto-probe of ALL accounts on the active tab ~every 20s (default on)",
  desc_switch:
    "Make selected sticky active — rotation drains this account first",
  desc_prio_up:
    "Move selected one step earlier in rotation preference (list order)",
  desc_prio_down:
    "Move selected one step later in rotation preference (list order)",
  desc_prio_top:
    "Jump selected to front of the queue (highest rotation preference)",
  desc_enable:
    "Re-include account in selection / sticky rotation after disable",
  desc_disable:
    "Skip this account in selection until re-enabled (tokens kept)",
  desc_label:
    "Set friendly display name (shown instead of email / short id)",
  desc_tags:
    "Replace tags (comma-separated, e.g. work, primary) for filtering",
  desc_note:
    "Attach a free-form operator note (shown in detail panel only)",
  desc_flag: "Mark for prune — prune tool / TUI prune can remove later",
  desc_unflag:
    "Clear removal flag so the account is no longer prunable by flag",
  desc_remove:
    "Permanently delete selected account (press twice to confirm; OAuth gone)",
  desc_prune:
    "Bulk-remove dead or flagged accounts (press twice to confirm)",
  desc_clean_dead:
    "Remove only dead (invalid_grant) accounts — not quota-exhausted (press P twice)",
  desc_reload:
    "Re-read multi-ai-accounts.json from disk (other process edits)",
  desc_quit: "Exit the TUI (pool file stays; OpenCode keeps running)",
  desc_lang: "Toggle UI language English ↔ Vietnamese and save preference",
};

const vi: Dict = {
  never: "chưa có",
  just_now: "vừa xong",
  now: "bây giờ",
  empty: "—",
  ago_s: "{n} giây trước",
  ago_m: "{n} phút trước",
  ago_h: "{n} giờ trước",
  ago_d: "{n} ngày trước",
  in_s: "sau {n} giây",
  in_m: "sau {n} phút",
  in_h: "sau {n} giờ",
  in_d: "sau {n} ngày",
  brand: "  op-ai  ·  SuperGrok + Codex đa tài khoản",
  status_hint:
    "  ↑↓/chuột chọn  ·  Tab panel  ·  live: TẤT CẢ acc ~20s · batch song song ×4",
  footer:
    "  a/A thêm  [ ]/{ ưu tiên  s switch  e/d bật/tắt  r/R quota  v live(all)  l/t/n sửa\n  f/u cờ  x xoá  p dọn  L tải lại  g ngôn ngữ  Esc huỷ  Tab  q thoát",
  live_on: "  ·  live bật",
  live_off: "  ·  live tắt",
  live_busy: "  ·  live …",
  accounts_title: " tài khoản ",
  actions_title: " thao tác ",
  menu_account: "› Tài khoản",
  menu_edit: "› Sửa",
  menu_add: "› Thêm",
  menu_quota: "› Hạn mức",
  menu_danger: "› Nguy hiểm",
  menu_back: "‹ Quay lại",
  menu_desc_back: "Về menu thao tác chính",
  menu_desc_account: "Switch, bật/tắt, ưu tiên",
  menu_desc_edit: "Nhãn, tags, ghi chú",
  menu_desc_add: "OAuth thiết bị hoặc trình duyệt",
  menu_desc_add_kiro:
    "API key, Builder ID / IDC, Profile ARN, import JSON, kiro-cli",
  menu_desc_quota: "Refresh, live probe, tải lại pool",
  menu_desc_danger: "Cờ, xoá, dọn",
  detail_title: " chi tiết / hạn mức ",
  empty_pool: "  chưa có tài khoản",
  empty_hint:
    "opencode auth login → xai-multi / codex-multi / kiro-multi",
  no_accounts:
    "Chưa có tài khoản.\n\nThêm:\n  xAI/Codex: a mã thiết bị · A trình duyệt\n  Kiro: a IDC · i API key · I ARN · o JSON · O export · c kiro-cli\n  Esc huỷ khi đang chờ\n\nTab: Codex | xAI | Kiro",
  lang_switched: "Ngôn ngữ: Tiếng Việt",
  add_device: "a  Thêm (mã thiết bị)",
  add_browser: "A  Thêm (trình duyệt)",
  add_kiro_api_key: "i  API key (ksk_)",
  add_kiro_idc_arn: "I  IDC + Profile ARN",
  add_kiro_json: "o  Import credentials JSON",
  add_kiro_export: "O  Import Account Manager export",
  add_kiro_cli: "c  Import kiro-cli DB",
  how_to_add: "?  Hướng dẫn thêm",
  refresh: "r  Làm mới",
  refresh_all: "R  Làm mới tất cả",
  live_quota: "v  Live hạn mức",
  switch: "s  Chuyển active",
  prio_up: "[  Ưu tiên lên",
  prio_down: "]  Ưu tiên xuống",
  prio_top: "{  Ưu tiên đầu",
  enable: "e  Bật",
  disable: "d  Tắt",
  label: "l  Nhãn",
  tags: "t  Thẻ",
  note: "n  Ghi chú",
  flag: "f  Đánh dấu xoá",
  unflag: "u  Bỏ đánh dấu",
  remove: "x  Xoá",
  prune: "p  Dọn dead/flag",
  clean_dead: "P  Xoá dead",
  reload: "L  Tải lại",
  quit: "q  Thoát",
  lang: "g  Ngôn ngữ",
  desc_add_device:
    "OAuth mã thiết bị cho tab đang chọn — mở URL, nhập mã; Esc huỷ giữa chừng",
  desc_add_browser:
    "OAuth trình duyệt loopback của tab đang chọn — upsert vào pool; Esc huỷ",
  desc_add_kiro_api_key:
    "Thêm tài khoản Kiro bằng API key (ksk_…) và region tuỳ chọn",
  desc_add_kiro_idc_arn:
    "Đăng nhập IAM Identity Center (device) kèm Profile ARN bắt buộc",
  desc_add_kiro_json:
    "Dán credentials JSON một account (refreshToken + các field method)",
  desc_add_kiro_export:
    "Dán export JSON của Kiro Account Manager (mảng accounts)",
  desc_add_kiro_cli:
    "Import từ SQLite kiro-cli local (đường dẫn mặc định hoặc tuỳ chọn)",
  desc_how_to_add:
    "Hiện hướng dẫn thêm cho provider đang chọn",
  desc_refresh: "Probe acc đang chọn (quota / usage) cho tab hiện tại",
  desc_refresh_all:
    "Probe mọi tài khoản trên tab hiện tại theo batch song song",
  desc_live:
    "Bật/tắt tự probe TẤT CẢ acc trên tab ~20s (batch song song; mặc định bật)",
  desc_switch:
    "Đặt sticky active — rotation ưu tiên rút acc này trước",
  desc_prio_up:
    "Đưa acc lên sớm hơn một bậc trong thứ tự rotation (list)",
  desc_prio_down:
    "Đưa acc xuống muộn hơn một bậc trong thứ tự rotation (list)",
  desc_prio_top:
    "Nhảy acc lên đầu hàng đợi (ưu tiên rotation cao nhất)",
  desc_enable:
    "Cho acc trở lại selection / sticky rotation sau khi disable",
  desc_disable:
    "Bỏ qua acc khi chọn (giữ token) cho đến khi bật lại",
  desc_label:
    "Đặt tên hiển thị thân thiện (ưu tiên hơn email / short id)",
  desc_tags:
    "Thay tags (phẩy, vd. work, primary) để lọc / nhóm",
  desc_note:
    "Gắn ghi chú operator tự do (chỉ hiện ở panel chi tiết)",
  desc_flag: "Đánh dấu dọn — prune tool / TUI có thể xoá sau",
  desc_unflag:
    "Bỏ cờ dọn để acc không còn trong danh sách prunable theo flag",
  desc_remove:
    "Xoá vĩnh viễn acc đang chọn (nhấn 2 lần xác nhận; mất OAuth)",
  desc_prune:
    "Xoá hàng loạt dead hoặc flagged (bấm p hai lần để xác nhận)",
  desc_clean_dead:
    "Chỉ xoá account dead (invalid_grant) — không đụng quota-exhausted (bấm P hai lần)",
  desc_reload:
    "Đọc lại multi-ai-accounts.json từ disk (sửa từ process khác)",
  desc_quit: "Thoát TUI (file pool giữ nguyên; OpenCode vẫn chạy)",
  desc_lang: "Đổi ngôn ngữ UI Anh ↔ Việt và lưu preference",
};

const catalogs: Record<Locale, Dict> = { en, vi };

export function t(key: string, vars?: Record<string, string | number>): string {
  ensureLocaleLoaded();
  const dict = catalogs[current] ?? en;
  let s = dict[key] ?? catalogs.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

export function localeLabel(locale: Locale = getLocale()): string {
  return locale === "vi" ? "Tiếng Việt" : "English";
}

export function settingsPath(): string {
  return defaultSettingsPath();
}
