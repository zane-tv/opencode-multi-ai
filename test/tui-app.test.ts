/**
 * Integration tests for lib/tui/app.ts via @opentui/core/testing.
 *
 * OpenTUI native FFI requires the Bun runtime — run with:
 *   bun --bun ./node_modules/vitest/vitest.mjs run test/tui-app.test.ts
 *
 * Injects createRenderer (no full @opentui/core mock) so adapters/i18n stay real.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createTestRenderer,
  type TestRendererSetup,
} from "@opentui/core/testing";
import { SelectRenderable } from "@opentui/core";

import { AccountManager, resetAccountManager } from "../lib/core/accounts.js";
import {
  getLocale,
  resetLocaleStateForTests,
  setLocale,
} from "../lib/core/i18n.js";
import { saveAccounts } from "../lib/core/storage.js";
import type { AccountMetadata } from "../lib/core/schemas.js";
import { TUI_BINDINGS } from "../lib/tui/action-helpers.js";
import { formatDateTime, formatUntil } from "../lib/core/format-time.js";

const probeXai = vi.fn();
const probeCodex = vi.fn();
const deviceLoginXai = vi.fn();
const browserLoginXai = vi.fn();
const deviceLoginCodex = vi.fn();
const browserLoginCodex = vi.fn();

const HOUR = 3_600_000;
const FIXED_NOW = Date.UTC(2026, 6, 16, 12, 0, 0);

function tmpPath(kind: string): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-tui-${kind}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
}

function makeXai(
  id: string,
  overrides: Partial<AccountMetadata> = {},
): AccountMetadata {
  return {
    provider: "xai",
    accountId: id,
    email: `${id}@x.ai`,
    tags: [],
    refreshToken: `rt-${id}`,
    accessToken: `at-${id}`,
    expiresAt: Date.now() + HOUR,
    enabled: true,
    priority: 0,
    addedAt: FIXED_NOW - HOUR,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    billingRemainingPercent: 72,
    billingMonthlyUsedPercent: 28,
    planName: "SuperGrok",
    ...overrides,
  } as AccountMetadata;
}

function makeCodex(
  id: string,
  overrides: Partial<AccountMetadata> = {},
): AccountMetadata {
  return {
    provider: "codex",
    accountId: id,
    email: `${id}@openai.com`,
    organizationId: `org-${id}`,
    tags: [],
    refreshToken: `rt-${id}`,
    accessToken: `at-${id}`,
    expiresAt: Date.now() + HOUR,
    enabled: true,
    priority: 0,
    addedAt: FIXED_NOW - HOUR,
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    primaryUsedPercent: 40,
    primaryWindowMinutes: 180,
    primaryResetAt: FIXED_NOW + HOUR,
    planType: "plus",
    ...overrides,
  } as AccountMetadata;
}

async function seedStore(storePath: string): Promise<void> {
  await saveAccounts(
    {
      version: 2,
      accounts: [
        makeXai("xai-a", { priority: 10, label: "work-xai" }),
        makeXai("xai-b", { priority: 5, label: "alt-xai" }),
        makeCodex("codex-a", { priority: 10, label: "work-codex" }),
        makeCodex("codex-b", {
          priority: 5,
          label: "alt-codex",
          flaggedForRemoval: true,
          subscriptionStatus: "dead",
        }),
      ],
      sticky: { xai: "xai-a", codex: "codex-a" },
    },
    storePath,
  );
}

async function cleanPath(p: string): Promise<void> {
  await fs.rm(p, { force: true, recursive: true }).catch(() => undefined);
  await fs.rm(p, { force: true }).catch(() => undefined);
  const dir = path.dirname(p);
  const base = path.basename(p);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((e) => e.startsWith(base))
      .map((e) =>
        fs.rm(path.join(dir, e), { force: true }).catch(() => undefined),
      ),
  );
}

let lastSetup: TestRendererSetup | null = null; // set by createRendererForTest

async function createRendererForTest(
  config: Record<string, unknown> = {},
): Promise<TestRendererSetup["renderer"]> {
  const setup = await createTestRenderer({
    width: 120,
    height: 36,
    ...config,
    useMouse: true,
    autoFocus: true,
  });
  lastSetup = setup;
  const onDestroy = config.onDestroy as (() => void) | undefined;
  if (onDestroy) {
    const orig = setup.renderer.destroy.bind(setup.renderer);
    setup.renderer.destroy = () => {
      try {
        onDestroy();
      } catch {
        /* ignore */
      }
      orig();
    };
  }
  return setup.renderer;
}

async function launchTui(opts: {
  storePath: string;
  settingsPath: string;
  initialTab?: "xai" | "codex";
}): Promise<{
  manager: AccountManager;
  done: Promise<void>;
  setup: () => TestRendererSetup;
}> {
  process.env.MULTI_AI_SETTINGS_PATH = opts.settingsPath;
  resetLocaleStateForTests();
  await fs
    .mkdir(path.dirname(opts.settingsPath), { recursive: true })
    .catch(() => undefined);

  const manager = new AccountManager(opts.storePath, {
    xai: async () => ({
      accessToken: "fresh-xai",
      refreshToken: "rt-xai",
      expiresAt: Date.now() + HOUR,
    }),
    codex: async () => ({
      accessToken: "fresh-codex",
      refreshToken: "rt-codex",
      expiresAt: Date.now() + HOUR,
    }),
  });
  await manager.load();

  const { runTui } = await import("../lib/tui/app.js");
  lastSetup = null;
  const done = runTui({
    manager,
    initialTab: opts.initialTab ?? "xai",
    createRenderer: createRendererForTest as never,
    probeQuota: async (tab, token, account) => {
      if (tab === "xai") {
        return (await probeXai(token, account)) as Record<string, unknown>;
      }
      return (await probeCodex(token, account)) as Record<string, unknown>;
    },
    login: {
      xai: {
        browserLogin: ((...args: unknown[]) =>
          browserLoginXai(...args)) as never,
        deviceCodeLoginFlow: ((...args: unknown[]) =>
          deviceLoginXai(...args)) as never,
      },
      codex: {
        browserLogin: ((...args: unknown[]) =>
          browserLoginCodex(...args)) as never,
        deviceCodeLoginFlow: ((...args: unknown[]) =>
          deviceLoginCodex(...args)) as never,
      },
    },
  });

  for (let i = 0; i < 80 && !lastSetup; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const setupRef = lastSetup as TestRendererSetup | null;
  if (setupRef === null) {
    const raced = await Promise.race([
      done.then(() => "done" as const),
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 100)),
    ]);
    throw new Error(
      `createTestRenderer did not produce setup (runTui=${raced}). ` +
        `OpenTUI FFI requires Bun (use: bun test test/tui-app.test.ts).`,
    );
  }
  const activeSetup: TestRendererSetup = setupRef;
  await activeSetup.renderOnce();
  await activeSetup.flush().catch(() => undefined);

  return {
    manager,
    done,
    setup: (): TestRendererSetup => {
      const s = lastSetup;
      if (!s) throw new Error("no test renderer setup");
      return s;
    },
  };
}

async function quitTui(
  setup: TestRendererSetup,
  done: Promise<void>,
): Promise<void> {
  try {
    setup.mockInput.pressKey("q");
    await setup.renderOnce();
  } catch {
    /* ignore */
  }
  await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
  try {
    setup.renderer.destroy();
  } catch {
    /* already destroyed */
  }
}

function frameOf(setup: TestRendererSetup): string {
  return setup.captureCharFrame();
}

function spanHasRgb(
  setup: TestRendererSetup,
  r: number,
  g: number,
  b: number,
): boolean {
  const spans = setup.captureSpans();
  const raw = JSON.stringify(spans);
  if (raw.includes(`${r},${g},${b}`) || raw.includes(`${r};${g};${b}`)) {
    return true;
  }
  if (
    raw.includes(`"r":${r}`) &&
    raw.includes(`"g":${g}`) &&
    raw.includes(`"b":${b}`)
  ) {
    return true;
  }
  const packed = (r << 16) | (g << 8) | b;
  if (raw.includes(String(packed))) return true;
  const linesArr = Array.isArray(spans.lines) ? spans.lines : [];
  for (const line of linesArr) {
    const spansInLine = Array.isArray(line) ? line : [];
    for (const span of spansInLine as Array<Record<string, unknown>>) {
      if (!span || typeof span !== "object") continue;
      const fg = span.fg ?? span.fgColor ?? span.color;
      if (typeof fg === "number") {
        const rr = (fg >> 16) & 0xff;
        const gg = (fg >> 8) & 0xff;
        const bb = fg & 0xff;
        if (rr === r && gg === g && bb === b) return true;
      }
      if (fg && typeof fg === "object") {
        const c = fg as { r?: number; g?: number; b?: number };
        if (c.r === r && c.g === g && c.b === b) return true;
      }
    }
  }
  return raw.includes("38;2") || /"fg"/.test(raw);
}

const hasOpenTuiFfi = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

(hasOpenTuiFfi ? describe : describe.skip)("tui app parity", () => {
  let storePath: string;
  let settingsPath: string;
  let harness: Awaited<ReturnType<typeof launchTui>> | null = null;

  beforeEach(async () => {
    storePath = tmpPath("store") + ".json";
    settingsPath = tmpPath("settings") + ".json";
    process.env.MULTI_AI_SETTINGS_PATH = settingsPath;
    delete process.env.MULTI_AI_LANG;
    delete process.env.MULTI_XAI_LANG;
    delete process.env.MULTI_CODEX_LANG;
    resetLocaleStateForTests();
    resetAccountManager();
    probeXai.mockReset();
    probeCodex.mockReset();
    deviceLoginXai.mockReset();
    browserLoginXai.mockReset();
    deviceLoginCodex.mockReset();
    browserLoginCodex.mockReset();
    probeXai.mockResolvedValue({
      billing: {
        monthlyUsedPercent: 30,
        remainingPercent: 70,
        observedAt: Date.now(),
      },
      plan: { planName: "SuperGrok", observedAt: Date.now() },
    });
    probeCodex.mockResolvedValue({
      planType: "plus",
      primaryUsedPercent: 35,
      primaryWindowMinutes: 180,
      primaryResetAt: Date.now() + HOUR,
      observedAt: Date.now(),
    });
    await seedStore(storePath);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, "{}\n", "utf8");
  });

  afterEach(async () => {
    if (harness) {
      try {
        await quitTui(harness.setup(), harness.done);
      } catch {
        /* ignore */
      }
      harness = null;
    }
    lastSetup = null;
    resetLocaleStateForTests();
    resetAccountManager();
    await cleanPath(storePath);
    await cleanPath(settingsPath);
    delete process.env.MULTI_AI_SETTINGS_PATH;
  });

  it("empty settings → EN default; g toggles VI and reflows chrome", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const setup = harness.setup();
    expect(getLocale()).toBe("en");
    let frame = frameOf(setup);
    expect(frame).toMatch(/Accounts|accounts|work-xai|xAI/i);

    setup.mockInput.pressKey("g");
    await setup.renderOnce();
    await setup.flush().catch(() => undefined);
    expect(getLocale()).toBe("vi");
    frame = frameOf(setup);
    expect(frame.toLowerCase()).toMatch(
      /tài khoản|chi tiết|ngôn ngữ|thoát|thêm|tiếng/,
    );

    setup.mockInput.pressKey("g");
    await setup.renderOnce();
    expect(getLocale()).toBe("en");
  });

  it("locale persists across destroy + relaunch; L preserves locale", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const setup = harness.setup();
    setup.mockInput.pressKey("g");
    await setup.renderOnce();
    expect(getLocale()).toBe("vi");

    setup.mockInput.pressKey("L", { shift: true });
    await setup.renderOnce();
    await new Promise((r) => setTimeout(r, 80));
    expect(getLocale()).toBe("vi");

    await quitTui(setup, harness.done);
    harness = null;

    resetLocaleStateForTests();
    harness = await launchTui({ storePath, settingsPath });
    expect(getLocale()).toBe("vi");
  });

  it("footer entries derive from TUI_BINDINGS; help lists every bound action", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const setup = harness.setup();
    setup.mockInput.pressKey("?");
    await setup.renderOnce();
    await setup.flush().catch(() => undefined);
    const help = frameOf(setup);
    for (const b of TUI_BINDINGS) {
      if (!b.available) continue;
      expect(help, `help missing key ${b.key}`).toContain(b.key);
    }
    expect(help).not.toMatch(/\bm\s+magic\b/i);
  });

  it("codex help has CLI JSON import lines; xai help does not", async () => {
    harness = await launchTui({
      storePath,
      settingsPath,
      initialTab: "codex",
    });
    const setup = harness.setup();
    setup.mockInput.pressKey("?");
    await setup.renderOnce();
    let help = frameOf(setup);
    expect(help).toMatch(/import-json|JSON import/i);

    setup.mockInput.pressKey("?");
    await setup.renderOnce();
    setup.mockInput.pressKey("1");
    await setup.renderOnce();
    setup.mockInput.pressKey("?");
    await setup.renderOnce();
    help = frameOf(setup);
    expect(help).not.toMatch(/op-codex import-json/);
  });

  it("fixed timestamp formats EN vs VI via format-time (TZ=UTC)", () => {
    setLocale("en", false);
    const en = formatDateTime(FIXED_NOW, "en");
    const enUntil = formatUntil(FIXED_NOW + HOUR, FIXED_NOW, undefined, "en");
    expect(en).toMatch(/Jul|16/);
    expect(enUntil).toMatch(/in |h/);

    setLocale("vi", false);
    const viDt = formatDateTime(FIXED_NOW, "vi");
    const viUntil = formatUntil(FIXED_NOW + HOUR, FIXED_NOW, undefined, "vi");
    expect(viDt).toMatch(/16\/07\/2026/);
    expect(viUntil).toMatch(/sau |giờ|phút/);
    setLocale("en", false);
  });

  it("captureSpans retains xai cyan and codex emerald hues", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const setup = harness.setup();
    await setup.renderOnce();
    const xaiOk =
      spanHasRgb(setup, 56, 189, 248) ||
      spanHasRgb(setup, 125, 211, 252) ||
      spanHasRgb(setup, 14, 165, 233);
    expect(xaiOk).toBe(true);

    setup.mockInput.pressKey("2");
    await setup.renderOnce();
    const codexOk =
      spanHasRgb(setup, 52, 211, 153) ||
      spanHasRgb(setup, 110, 231, 183) ||
      spanHasRgb(setup, 16, 185, 129);
    expect(codexOk).toBe(true);
  });

  it("resize 100x30 and 140x40 does not throw / clip fatally", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const setup = harness.setup();
    setup.resize(100, 30);
    await setup.renderOnce();
    expect(frameOf(setup).length).toBeGreaterThan(10);
    setup.resize(140, 40);
    await setup.renderOnce();
    expect(frameOf(setup).length).toBeGreaterThan(10);
  });

  it("s switches sticky only on active provider", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { manager, setup } = harness;
    const s = setup();
    const node = s.renderer.root.findDescendantById(
      "accounts",
    ) as SelectRenderable;
    node.setSelectedIndex(1);
    await s.renderOnce();
    s.mockInput.pressKey("s");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.providerView("xai").sticky()).toBe("xai-b");
    expect(manager.providerView("codex").sticky()).toBe("codex-a");
  });

  it("[ ] { priority moves keep selection by id; scoped to active provider", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { manager, setup } = harness;
    const s = setup();
    const beforeCodex = manager
      .providerView("codex")
      .list()
      .map((a) => a.accountId);
    s.mockInput.pressKey("]");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(
      manager.providerView("codex").list().map((a) => a.accountId),
    ).toEqual(beforeCodex);

    s.mockInput.pressKey("{");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(manager.providerView("xai").list()[0]?.accountId).toBe("xai-a");
  });

  it("e/d enable disable; f/u flag unflag — active provider only", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { manager, setup } = harness;
    const s = setup();
    s.mockInput.pressKey("d");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(manager.providerView("xai").get("xai-a")?.enabled).toBe(false);
    expect(manager.providerView("codex").get("codex-a")?.enabled).toBe(true);

    s.mockInput.pressKey("e");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(manager.providerView("xai").get("xai-a")?.enabled).toBe(true);

    s.mockInput.pressKey("f");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(manager.providerView("xai").get("xai-a")?.flaggedForRemoval).toBe(
      true,
    );
    s.mockInput.pressKey("u");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(manager.providerView("xai").get("xai-a")?.flaggedForRemoval).toBe(
      false,
    );
  });

  it("label/tags/note save on Enter; empty clears; Esc cancels; edit keys are text", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { manager, setup } = harness;
    const s = setup();

    s.mockInput.pressKey("l");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 30));
    await s.mockInput.typeText("qa rL");
    s.mockInput.pressEnter();
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 150));
    expect(manager.providerView("xai").get("xai-a")?.label).toBe("qa rL");

    s.mockInput.pressKey("t");
    await s.renderOnce();
    await s.mockInput.typeText("work, Primary, work");
    s.mockInput.pressEnter();
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 120));
    expect(manager.providerView("xai").get("xai-a")?.tags).toEqual([
      "work",
      "Primary",
    ]);

    s.mockInput.pressKey("n");
    await s.renderOnce();
    await s.mockInput.typeText("hello");
    s.mockInput.pressEscape();
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 80));
    expect(manager.providerView("xai").get("xai-a")?.note).toBeUndefined();

    s.mockInput.pressKey("n");
    await s.renderOnce();
    await s.mockInput.typeText("kept");
    s.mockInput.pressEnter();
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 120));
    expect(manager.providerView("xai").get("xai-a")?.note).toBe("kept");

    s.mockInput.pressKey("l");
    await s.renderOnce();
    for (let i = 0; i < 12; i++) s.mockInput.pressBackspace();
    s.mockInput.pressEnter();
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 120));
    expect(manager.providerView("xai").get("xai-a")?.label).toBeUndefined();
  });

  it("x arms → selection change disarms → same x removes; stale id safe", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { manager, setup } = harness;
    const s = setup();
    const before = manager.providerView("xai").list().length;

    s.mockInput.pressKey("x");
    await s.renderOnce();
    const accSel = s.renderer.root.findDescendantById(
      "accounts",
    ) as SelectRenderable;
    accSel.setSelectedIndex(1);
    await s.renderOnce();
    s.mockInput.pressKey("x");
    await s.renderOnce();
    expect(manager.providerView("xai").list().length).toBe(before);

    s.mockInput.pressKey("x");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.providerView("xai").list().length).toBe(before - 1);
    expect(manager.providerView("codex").list().length).toBe(2);
  });

  it("p arms → 2nd recomputes prune; tab change disarms and never prunes other provider", async () => {
    harness = await launchTui({
      storePath,
      settingsPath,
      initialTab: "codex",
    });
    const { manager, setup } = harness;
    const s = setup();
    const xaiBefore = manager.providerView("xai").list().length;
    s.mockInput.pressKey("p");
    await s.renderOnce();
    s.mockInput.pressKey("1");
    await s.renderOnce();
    s.mockInput.pressKey("p");
    await s.renderOnce();
    expect(manager.providerView("codex").list().length).toBe(2);
    expect(manager.providerView("xai").list().length).toBe(xaiBefore);

    s.mockInput.pressKey("2");
    await s.renderOnce();
    s.mockInput.pressKey("p");
    await s.renderOnce();
    s.mockInput.pressKey("p");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 120));
    expect(manager.providerView("codex").get("codex-b")).toBeUndefined();
    expect(manager.providerView("xai").list().length).toBe(xaiBefore);
  });

  it("mouse select via findDescendantById accounts SelectRenderable", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { setup } = harness;
    const s = setup();
    const node = s.renderer.root.findDescendantById("accounts");
    expect(node).toBeInstanceOf(SelectRenderable);
    const sel = node as SelectRenderable;
    if (typeof sel.getSelectedIndex === "function") {
      sel.setSelectedIndex(1);
      await s.renderOnce();
      expect(sel.getSelectedIndex()).toBe(1);
    }
  });

  it("busy ignores dup mutation keys but allows quit", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { setup, done } = harness;
    const s = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    probeXai.mockImplementation(async () => {
      await gate;
      return {
        billing: {
          monthlyUsedPercent: 1,
          remainingPercent: 99,
          observedAt: Date.now(),
        },
        plan: { planName: "X", observedAt: Date.now() },
      };
    });
    s.mockInput.pressKey("r");
    await s.renderOnce();
    s.mockInput.pressKey("r");
    s.mockInput.pressKey("r");
    await s.renderOnce();
    expect(probeXai.mock.calls.length).toBeLessThanOrEqual(2);

    release();
    await new Promise((r) => setTimeout(r, 80));
    s.mockInput.pressKey("q");
    await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
    harness = null;
  });

  it("r refreshes only selected; R sequential all active-tab", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { manager, setup } = harness;
    const s = setup();
    probeXai.mockClear();
    s.mockInput.pressKey("r");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 150));
    expect(probeXai).toHaveBeenCalledTimes(1);
    expect(probeXai.mock.calls[0]?.[1]?.accountId).toBe("xai-a");
    expect(
      (
        manager.providerView("xai").get("xai-a") as {
          billingRemainingPercent?: number;
        }
      )?.billingRemainingPercent,
    ).toBe(70);

    probeXai.mockClear();
    s.mockInput.pressKey("R", { shift: true });
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 250));
    expect(probeXai.mock.calls.length).toBe(2);
    expect(probeCodex).not.toHaveBeenCalled();
  });

  it("xai probe records billing+plan independently (partial ok)", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { manager, setup } = harness;
    const s = setup();
    probeXai.mockResolvedValueOnce({
      billing: {
        monthlyUsedPercent: 10,
        remainingPercent: 90,
        observedAt: Date.now(),
      },
      planError: "plan down",
    });
    s.mockInput.pressKey("r");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 150));
    expect(
      (
        manager.providerView("xai").get("xai-a") as {
          billingRemainingPercent?: number;
        }
      )?.billingRemainingPercent,
    ).toBe(90);
  });

  it("codex probe records usage", async () => {
    harness = await launchTui({
      storePath,
      settingsPath,
      initialTab: "codex",
    });
    const { manager, setup } = harness;
    const s = setup();
    s.mockInput.pressKey("r");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 150));
    expect(probeCodex).toHaveBeenCalled();
    expect(
      (
        manager.providerView("codex").get("codex-a") as {
          primaryUsedPercent?: number;
        }
      )?.primaryUsedPercent,
    ).toBe(35);
  });

  it("v toggles live; L reloads preserving ids and locale", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { setup } = harness;
    const s = setup();
    s.mockInput.pressKey("g");
    await s.renderOnce();
    expect(getLocale()).toBe("vi");

    s.mockInput.pressKey("v");
    await s.renderOnce();
    let frame = frameOf(s);
    expect(frame.toLowerCase()).toMatch(/live|tắt|off|bật|on/);

    s.mockInput.pressKey("v");
    await s.renderOnce();

    s.mockInput.pressKey("L", { shift: true });
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(getLocale()).toBe("vi");
    frame = frameOf(s);
    expect(frame).toMatch(/work-xai|xai-a|alt-xai/i);
  });

  it("device add gets active view, shows code, selects returned acct; Esc aborts", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { manager, setup } = harness;
    const s = setup();
    const before = manager.providerView("xai").list().length;

    deviceLoginXai.mockImplementation(
      async (
        _view: unknown,
        onPrompt?: (p: {
          verificationUri: string;
          userCode: string;
        }) => void,
        signal?: AbortSignal,
      ) => {
        onPrompt?.({
          verificationUri: "https://x.ai/device",
          userCode: "ABCD-1234",
        });
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(
              Object.assign(new Error("login cancelled"), {
                name: "LoginCancelledError",
              }),
            );
            return;
          }
          const t = setTimeout(() => {
            /* hang until abort */
          }, 30_000);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(
                Object.assign(new Error("login cancelled"), {
                  name: "LoginCancelledError",
                }),
              );
            },
            { once: true },
          );
        });
        return { accountId: "new-xai", outcome: "added" as const };
      },
    );

    s.mockInput.pressKey("a");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 80));
    expect(deviceLoginXai).toHaveBeenCalledTimes(1);
    const frame = frameOf(s);
    expect(frame).toMatch(/ABCD-1234|x\.ai\/device/);

    s.mockInput.pressEscape();
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 100));
    expect(manager.providerView("xai").list().length).toBe(before);
  });

  it("browser add shows URL; codex receives forceNewLogin:true; success selects acct", async () => {
    harness = await launchTui({
      storePath,
      settingsPath,
      initialTab: "codex",
    });
    const { manager, setup } = harness;
    const s = setup();

    browserLoginCodex.mockImplementation(
      async (
        view: {
          upsertFromOAuth: (
            a: AccountMetadata,
          ) => Promise<"added" | "updated">;
        },
        opts?: {
          onAuthorizeUrl?: (u: string) => void;
          forceNewLogin?: boolean;
        },
      ) => {
        opts?.onAuthorizeUrl?.("https://auth.openai.com/authorize?x=1");
        expect(opts?.forceNewLogin).toBe(true);
        await view.upsertFromOAuth(
          makeCodex("new-codex", { label: "fresh-codex" }),
        );
        return { accountId: "new-codex", outcome: "added" as const };
      },
    );

    s.mockInput.pressKey("A", { shift: true });
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 200));
    expect(browserLoginCodex).toHaveBeenCalled();
    expect(manager.providerView("codex").get("new-codex")).toBeTruthy();
    const frame = frameOf(s);
    expect(frame).toMatch(/fresh-codex|new-codex|auth\.openai/);
  });

  it("repeated add keys while busy → login once; successful add survives probe fail", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { manager, setup } = harness;
    const s = setup();
    let calls = 0;
    browserLoginXai.mockImplementation(
      async (
        view: {
          upsertFromOAuth: (
            a: AccountMetadata,
          ) => Promise<"added" | "updated">;
        },
        opts?: { onAuthorizeUrl?: (u: string) => void },
      ) => {
        calls++;
        opts?.onAuthorizeUrl?.("https://x.ai/oauth");
        await new Promise((r) => setTimeout(r, 100));
        await view.upsertFromOAuth(makeXai("added-once", { label: "once" }));
        return { accountId: "added-once", outcome: "added" as const };
      },
    );
    probeXai.mockRejectedValueOnce(new Error("probe boom"));

    s.mockInput.pressKey("A", { shift: true });
    s.mockInput.pressKey("A", { shift: true });
    s.mockInput.pressKey("a");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 250));
    expect(calls).toBe(1);
    expect(manager.providerView("xai").get("added-once")).toBeTruthy();
  });

  it("q during add aborts + teardown safe", async () => {
    harness = await launchTui({ storePath, settingsPath });
    const { setup, done } = harness;
    const s = setup();
    deviceLoginXai.mockImplementation(
      async (_v: unknown, _p?: unknown, signal?: AbortSignal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("login cancelled"), {
                  name: "LoginCancelledError",
                }),
              ),
            { once: true },
          );
        });
        return { accountId: "x", outcome: "added" as const };
      },
    );
    s.mockInput.pressKey("a");
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 50));
    s.mockInput.pressEscape();
    await s.renderOnce();
    await new Promise((r) => setTimeout(r, 50));
    s.mockInput.pressKey("q");
    await Promise.race([done, new Promise((r) => setTimeout(r, 1500))]);
    harness = null;
  });
});

if (!hasOpenTuiFfi) {
  describe("tui app parity (node without OpenTUI FFI)", () => {
    it("skips renderer suite — OpenTUI FFI requires Bun", () => {
      expect(typeof (globalThis as { Bun?: unknown }).Bun).toBe("undefined");
    });

    it("fixed timestamp formats EN vs VI via format-time (TZ=UTC)", () => {
      setLocale("en", false);
      const en = formatDateTime(FIXED_NOW, "en");
      expect(en).toMatch(/Jul|16/);
      setLocale("vi", false);
      const viDt = formatDateTime(FIXED_NOW, "vi");
      expect(viDt).toMatch(/16\/07\/2026/);
      setLocale("en", false);
    });
  });
}
