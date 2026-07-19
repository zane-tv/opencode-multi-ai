/**
 * Human-friendly date/time for CLI + TUI.
 * Local timezone; locale via getLocale() (en default, vi optional).
 *
 * Vietnamese examples:
 *   13/07/2026 22:30
 *   5 phút trước · sau 2 giờ · 13/07/2026 22:30
 */

import { getLocale, t, type Locale } from "./i18n.js";

const MONTHS_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function localeOr(loc?: Locale): Locale {
  return loc ?? getLocale();
}

/** Absolute local datetime */
export function formatDateTime(
  ms: number | undefined | null,
  loc?: Locale,
): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) {
    return t("empty");
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return t("empty");
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  if (localeOr(loc) === "vi") {
    // 13/07/2026 22:30
    return `${pad2(day)}/${pad2(month)}/${year} ${hh}:${mm}`;
  }
  return `${day} ${MONTHS_EN[d.getMonth()]!} ${year} ${hh}:${mm}`;
}

/** Absolute local date only */
export function formatDate(
  ms: number | undefined | null,
  loc?: Locale,
): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) {
    return t("empty");
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return t("empty");
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  if (localeOr(loc) === "vi") {
    return `${pad2(day)}/${pad2(month)}/${year}`;
  }
  return `${day} ${MONTHS_EN[d.getMonth()]!} ${year}`;
}

/**
 * Relative age (past): just now / 5m ago / …
 * vi: vừa xong · 5 phút trước · 2 giờ trước
 */
export function formatAge(
  ms: number | undefined | null,
  now: number = Date.now(),
  loc?: Locale,
): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) {
    return t("never");
  }
  const delta = now - ms;
  if (delta < 0) return formatUntil(ms, now, undefined, loc);
  const sec = Math.floor(delta / 1000);
  if (sec < 5) return t("just_now");
  if (sec < 60) return t("ago_s", { n: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return t("ago_m", { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 48) return t("ago_h", { n: hr });
  const day = Math.floor(hr / 24);
  if (day < 14) return t("ago_d", { n: day });
  return formatDate(ms, loc);
}

/**
 * Relative future: in 2h · 13/07/2026 22:30
 * vi: sau 2 giờ · 13/07/2026 22:30
 */
export function formatUntil(
  ms: number | undefined | null,
  now: number = Date.now(),
  opts?: { withAbsolute?: boolean },
  loc?: Locale,
): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) {
    return t("empty");
  }
  const delta = ms - now;
  if (delta <= 0) return t("now");
  const sec = Math.ceil(delta / 1000);
  let rel: string;
  if (sec < 60) rel = t("in_s", { n: sec });
  else {
    const min = Math.ceil(sec / 60);
    if (min < 60) rel = t("in_m", { n: min });
    else {
      const hr = Math.ceil(min / 60);
      if (hr < 48) rel = t("in_h", { n: hr });
      else {
        const day = Math.ceil(hr / 24);
        if (day < 21) rel = t("in_d", { n: day });
        else rel = formatDateTime(ms, loc);
      }
    }
  }
  if (opts?.withAbsolute !== false && sec >= 60) {
    // Avoid double absolute if already absolute long-horizon string
    if (rel.includes("/") || MONTHS_EN.some((m) => rel.includes(m))) {
      return rel;
    }
    return `${rel} · ${formatDateTime(ms, loc)}`;
  }
  return rel;
}

/** Period end for plan window */
export function formatPeriodEnd(
  ms: number | undefined | null,
  loc?: Locale,
): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) {
    return t("empty");
  }
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return t("empty");
  if (d.getHours() === 0 && d.getMinutes() === 0) return formatDate(ms, loc);
  return formatDateTime(ms, loc);
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Credit period reset: future countdown, or weekly "ended · next +7d". */
export function formatBillingReset(
  ms: number | undefined | null,
  now: number = Date.now(),
  opts?: { periodType?: string },
  loc?: Locale,
): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) {
    return t("empty");
  }
  if (ms > now) {
    return formatUntil(ms, now, undefined, loc);
  }
  const abs = formatDateTime(ms, loc);
  if (opts?.periodType === "weekly") {
    let next = ms + WEEK_MS;
    while (next <= now) next += WEEK_MS;
    return `ended · next ${formatUntil(next, now, undefined, loc)}`;
  }
  return `ended · ${abs}`;
}
