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

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-plugin-xai-${crypto.randomUUID()}.json`,
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

describe("lib/plugin/xai.ts", () => {
  const paths: string[] = [];

  beforeEach(() => {
    resetAccountManager();
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

  it("exports ONLY default with id xai-multi and a server function", async () => {
    const mod = await import("../lib/plugin/xai.js");
    expect(Object.keys(mod).sort()).toEqual(["default"]);
    expect(mod.default.id).toBe("xai-multi");
    expect(typeof mod.default.server).toBe("function");
  });

  it("config registers only xai-multi and leaves built-in xai untouched", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    getAccountManager(storePath);

    const mod = await import("../lib/plugin/xai.js");
    const hooks = await mod.default.server(minimalPluginInput());

    expect(hooks.auth?.provider).toBe("xai-multi");
    expect(hooks.tool).toEqual({});

    const cfg: {
      provider?: Record<string, Record<string, unknown>>;
    } = {
      provider: {
        // Pre-existing built-in must remain untouched.
        xai: { npm: "@ai-sdk/xai", name: "xAI" },
      },
    };
    await hooks.config?.(cfg as never);

    expect(cfg.provider?.["xai-multi"]).toBeDefined();
    expect(cfg.provider?.["xai-multi"]?.npm).toBe("@ai-sdk/xai");
    expect(cfg.provider?.["xai-multi"]?.name).toBe("Grok Multi-Account");
    const opts = cfg.provider?.["xai-multi"]?.options as
      | Record<string, unknown>
      | undefined;
    expect(opts?.baseURL).toBe("https://api.x.ai/v1");
    const models = cfg.provider?.["xai-multi"]?.models as
      | Record<string, unknown>
      | undefined;
    expect(models && Object.keys(models).length).toBeGreaterThan(0);

    // Built-in and other providers must not be registered or overwritten.
    expect(cfg.provider?.xai).toEqual({ npm: "@ai-sdk/xai", name: "xAI" });
    expect(cfg.provider?.openai).toBeUndefined();
    expect(cfg.provider?.["codex-multi"]).toBeUndefined();
  });

  it("auth.loader returns dummy key, baseURL, and a fetch function", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    getAccountManager(storePath);

    const mod = await import("../lib/plugin/xai.js");
    const hooks = await mod.default.server(minimalPluginInput());
    expect(hooks.auth?.provider).toBe("xai-multi");
    expect(hooks.auth?.methods?.length).toBe(2);
    expect(hooks.auth?.methods?.[0]?.type).toBe("oauth");
    expect(hooks.auth?.methods?.[1]?.type).toBe("oauth");

    const loaded = await hooks.auth?.loader?.(
      async () => ({ type: "api", key: "unused" }) as never,
      {} as never,
    );
    expect(loaded?.apiKey).toBe("multi-xai-dummy-key");
    expect(loaded?.baseURL).toBe("https://api.x.ai/v1");
    expect(typeof loaded?.fetch).toBe("function");
  });

  it("chat.params remembers options only for xai-multi provider", async () => {
    const storePath = tmpStorePath();
    paths.push(storePath);
    getAccountManager(storePath);

    const { rememberSessionOptions } = await import(
      "../lib/core/session-options.js"
    );
    const spy = vi.spyOn(
      await import("../lib/core/session-options.js"),
      "rememberSessionOptions",
    );

    const mod = await import("../lib/plugin/xai.js");
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
        sessionID: "sess-xai",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt" } as never,
        provider: {} as never,
        message: {} as never,
      },
      output,
    );
    expect(spy).not.toHaveBeenCalled();

    await chatParams?.(
      {
        sessionID: "sess-xai",
        agent: "build",
        model: { providerID: "xai-multi", modelID: "grok-3" } as never,
        provider: {} as never,
        message: {} as never,
      },
      output,
    );
    expect(spy).toHaveBeenCalledWith("sess-xai", {
      reasoningEffort: "high",
    });

    // silence unused import lint if any
    void rememberSessionOptions;
  });
});
