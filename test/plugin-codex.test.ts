import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAccountManager,
  resetAccountManager,
} from "../lib/core/accounts.js";
import type { PluginInput } from "@opencode-ai/plugin";

const bootstrapHostAuthIfNeeded = vi.fn(
  (_providerId?: string): boolean => true,
);
const ensureHostAuthAfterLogin = vi.fn(
  (_providerId?: string, _accountId?: string): void => {},
);

vi.mock("../lib/providers/codex/auth/host-auth.js", () => ({
  bootstrapHostAuthIfNeeded: (providerId?: string) =>
    bootstrapHostAuthIfNeeded(providerId),
  ensureHostAuthAfterLogin: (providerId?: string, accountId?: string) =>
    ensureHostAuthAfterLogin(providerId, accountId),
  openCodeAuthPath: () =>
    path.join(os.tmpdir(), `multi-ai-auth-${crypto.randomUUID()}.json`),
}));

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-plugin-codex-${crypto.randomUUID()}.json`,
  );
}

function minimalPluginInput(): PluginInput {
  return {
    client: {} as PluginInput["client"],
    project: {} as PluginInput["project"],
    directory: process.cwd(),
    worktree: process.cwd(),
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:0"),
    $: {} as PluginInput["$"],
  };
}

describe("lib/plugin/codex.ts", () => {
  const paths: string[] = [];

  beforeEach(() => {
    resetAccountManager();
    bootstrapHostAuthIfNeeded.mockClear();
    bootstrapHostAuthIfNeeded.mockReturnValue(true);
    ensureHostAuthAfterLogin.mockClear();
  });

  afterEach(async () => {
    resetAccountManager();
    await Promise.all(
      paths.splice(0).map(async (p) => {
        try {
          await fs.unlink(p);
        } catch {
          /* ignore */
        }
        try {
          await fs.unlink(`${p}.lock`);
        } catch {
          /* ignore */
        }
      }),
    );
    vi.restoreAllMocks();
  });

  it("exports ONLY default with id codex-multi and a server function", async () => {
    const mod = await import("../lib/plugin/codex.js");
    expect(Object.keys(mod).sort()).toEqual(["default"]);
    expect(mod.default.id).toBe("codex-multi");
    expect(typeof mod.default.server).toBe("function");
  });

  it("bootstraps host auth on load and config registers only codex-multi", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    getAccountManager(storePath);

    const mod = await import("../lib/plugin/codex.js");
    const hooks = await mod.default.server(minimalPluginInput());

    expect(bootstrapHostAuthIfNeeded).toHaveBeenCalledWith("codex-multi");
    expect(hooks.auth?.provider).toBe("codex-multi");
    expect(hooks.tool).toEqual({});

    const cfg: {
      provider?: Record<string, Record<string, unknown>>;
    } = {
      provider: {
        openai: { npm: "@ai-sdk/openai", name: "OpenAI" },
      },
    };
    await hooks.config?.(cfg as never);

    expect(cfg.provider?.["codex-multi"]).toBeDefined();
    expect(cfg.provider?.["codex-multi"]?.npm).toBe("@ai-sdk/openai");
    expect(cfg.provider?.["codex-multi"]?.name).toBe("Codex Multi-Account");
    const opts = cfg.provider?.["codex-multi"]?.options as
      | Record<string, unknown>
      | undefined;
    expect(opts?.baseURL).toBe("https://chatgpt.com/backend-api");
    expect(opts?.apiKey).toBe("chatgpt-oauth");
    expect(opts?.store).toBe(false);
    expect(opts?.reasoningEffort).toBe("medium");
    const models = cfg.provider?.["codex-multi"]?.models as
      | Record<string, unknown>
      | undefined;
    expect(models && Object.keys(models).length).toBeGreaterThan(0);

    // Built-in openai and xai-multi must not be written by this plugin.
    expect(cfg.provider?.openai).toEqual({
      npm: "@ai-sdk/openai",
      name: "OpenAI",
    });
    expect(cfg.provider?.xai).toBeUndefined();
    expect(cfg.provider?.["xai-multi"]).toBeUndefined();
  });

  it("auth.loader returns dummy key, baseURL, and a fetch function", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    getAccountManager(storePath);

    const mod = await import("../lib/plugin/codex.js");
    const hooks = await mod.default.server(minimalPluginInput());
    expect(hooks.auth?.provider).toBe("codex-multi");
    expect(hooks.auth?.methods?.length).toBe(2);
    expect(hooks.auth?.methods?.[0]?.type).toBe("oauth");
    expect(hooks.auth?.methods?.[1]?.type).toBe("oauth");

    const loaded = await hooks.auth?.loader?.(
      async () => ({ type: "api", key: "unused" }) as never,
      {} as never,
    );
    expect(loaded?.apiKey).toBe("chatgpt-oauth");
    expect(loaded?.baseURL).toBe("https://chatgpt.com/backend-api");
    expect(typeof loaded?.fetch).toBe("function");
  });

  it("chat.params remembers options only for codex-multi provider", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    getAccountManager(storePath);

    const sessionOptions = await import("../lib/core/session-options.js");
    const spy = vi.spyOn(sessionOptions, "rememberSessionOptions");

    const mod = await import("../lib/plugin/codex.js");
    const hooks = await mod.default.server(minimalPluginInput());
    const chatParams = hooks["chat.params"];
    expect(typeof chatParams).toBe("function");

    const output = {
      temperature: 0,
      topP: 1,
      topK: 0,
      maxOutputTokens: undefined as number | undefined,
      options: { reasoningEffort: "high" },
    };

    await chatParams?.(
      {
        sessionID: "sess-codex",
        agent: "build",
        model: { providerID: "xai-multi", modelID: "grok-3" } as never,
        provider: {} as never,
        message: {} as never,
      },
      output,
    );
    expect(spy).not.toHaveBeenCalled();

    await chatParams?.(
      {
        sessionID: "sess-codex",
        agent: "build",
        model: { providerID: "codex-multi", modelID: "gpt-5" } as never,
        provider: {} as never,
        message: {} as never,
      },
      output,
    );
    expect(spy).toHaveBeenCalledWith("sess-codex", {
      reasoningEffort: "high",
    });
  });

  it("does not share tools with xai plugin (both empty until todo 21)", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    getAccountManager(storePath);

    const xaiMod = await import("../lib/plugin/xai.js");
    const codexMod = await import("../lib/plugin/codex.js");
    const xaiHooks = await xaiMod.default.server(minimalPluginInput());
    const codexHooks = await codexMod.default.server(minimalPluginInput());

    const xaiTools = Object.keys(xaiHooks.tool ?? {});
    const codexTools = Object.keys(codexHooks.tool ?? {});
    expect(xaiTools.every((k) => k.startsWith("xai-") || k.length === 0)).toBe(
      true,
    );
    expect(
      codexTools.every((k) => k.startsWith("codex-") || k.length === 0),
    ).toBe(true);
    // No cross-registration of the other provider's tools.
    expect(xaiTools.some((k) => k.startsWith("codex-"))).toBe(false);
    expect(codexTools.some((k) => k.startsWith("xai-"))).toBe(false);
  });
});
