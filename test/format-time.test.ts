import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  formatAge,
  formatDate,
  formatDateTime,
  formatUntil,
} from "../lib/core/format-time.js";
import { setLocale } from "../lib/core/i18n.js";

describe("format-time", () => {
  const now = new Date(2026, 6, 13, 22, 30, 0).getTime(); // local 13 Jul 2026 22:30

  beforeEach(() => setLocale("en", false));
  afterEach(() => setLocale("en", false));

  it("formats English absolute datetime by default", () => {
    expect(formatDateTime(now, "en")).toMatch(/13 Jul 2026 22:30/);
    expect(formatDate(now, "en")).toMatch(/13 Jul 2026/);
  });

  it("formats Vietnamese absolute datetime", () => {
    expect(formatDateTime(now, "vi")).toBe("13/07/2026 22:30");
    expect(formatDate(now, "vi")).toBe("13/07/2026");
  });

  it("formats relative past in English", () => {
    expect(formatAge(now - 2_000, now)).toBe("just now");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5m ago");
  });

  it("formats relative past in Vietnamese", () => {
    setLocale("vi", false);
    expect(formatAge(now - 2_000, now)).toBe("vừa xong");
    expect(formatAge(now - 30_000, now)).toBe("30 giây trước");
    expect(formatAge(now - 5 * 60_000, now)).toBe("5 phút trước");
    expect(formatAge(now - 3 * 3_600_000, now)).toBe("3 giờ trước");
  });

  it("formats relative future in Vietnamese", () => {
    setLocale("vi", false);
    const s = formatUntil(now + 2 * 3_600_000, now);
    expect(s.startsWith("sau 2 giờ")).toBe(true);
    expect(s).toContain("·");
    expect(s).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it("formats English relative future", () => {
    expect(formatUntil(now + 3_600_000, now, { withAbsolute: false })).toBe(
      "in 1h",
    );
  });
});
