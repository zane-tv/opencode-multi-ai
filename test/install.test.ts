import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  BUILTIN_PROVIDER_IDS,
  LEGACY_PLUGIN_PACKAGES,
  PLUGIN_PACKAGE,
  defaultPluginEntries,
  installProvider,
  pluginEntryKey,
  stripLegacyPluginEntries,
} from "../scripts/install.js";
import {
  CODEX_BASE_URL,
  PROVIDER_ID as CODEX_PROVIDER_ID,
} from "../lib/providers/codex/constants.js";
import {
  PROVIDER_ID as XAI_PROVIDER_ID,
  XAI_API_BASE,
} from "../lib/providers/xai/constants.js";

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "multi-ai-install-"));
  configPath = path.join(dir, "opencode.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readJson(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
}

function providerMap(
  config: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const p = config.provider;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return {};
  return p as Record<string, Record<string, unknown>>;
}

describe("installProvider — creates from absent", () => {
  it("creates a config file with schema + BOTH providers", async () => {
    const result = await installProvider(configPath);

    expect(result.created).toBe(true);
    expect(result.providers).toHaveLength(2);
    expect(result.providers.every((p) => p.added)).toBe(true);
    expect(result.pluginEntriesAdded).toEqual([]);

    const config = await readJson(configPath);
    expect(config.$schema).toBe("https://opencode.ai/config.json");

    const providers = providerMap(config);
    expect(XAI_PROVIDER_ID).toBe("xai-multi");
    expect(CODEX_PROVIDER_ID).toBe("codex-multi");

    const xai = providers[XAI_PROVIDER_ID];
    expect(xai.npm).toBe("@ai-sdk/xai");
    expect(xai.name).toBe("Grok Multi-Account");
    const xaiOpts = xai.options as Record<string, unknown>;
    expect(xaiOpts.baseURL).toBe(XAI_API_BASE);
    const xaiModels = xai.models as Record<string, { name?: string }>;
    expect(xaiModels["grok-4.5"]?.name).toBe("Grok 4.5");

    const codex = providers[CODEX_PROVIDER_ID];
    expect(codex.npm).toBe("@ai-sdk/openai");
    expect(codex.name).toBe("Codex Multi-Account");
    const codexOpts = codex.options as Record<string, unknown>;
    expect(codexOpts.baseURL).toBe(CODEX_BASE_URL);
    expect(codexOpts.store).toBe(false);
    expect(codexOpts.include).toEqual(["reasoning.encrypted_content"]);
    const codexModels = codex.models as Record<string, { name?: string }>;
    expect(codexModels["gpt-5-codex"]?.name).toBe("GPT-5 Codex");
    expect(codexModels["gpt-5.5"]?.name).toBe("GPT-5.5");
  });

  it("never writes built-in xai or openai provider ids as multi entries", async () => {
    await installProvider(configPath);
    const providers = providerMap(await readJson(configPath));
    for (const id of BUILTIN_PROVIDER_IDS) {
      expect(providers[id]).toBeUndefined();
    }
    expect(providers["xai-multi"]).toBeTruthy();
    expect(providers["codex-multi"]).toBeTruthy();
  });

  it("creates missing parent directories", async () => {
    const nested = path.join(dir, "a", "b", "opencode.json");
    const result = await installProvider(nested);
    expect(result.created).toBe(true);
    await expect(readJson(nested)).resolves.toBeTruthy();
  });

  it("pretty-prints with 2-space indent and a trailing newline", async () => {
    await installProvider(configPath);
    const raw = await readFile(configPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('\n  "provider": {');
  });
});

describe("installProvider — merges without clobbering", () => {
  it("preserves unrelated keys, other providers, and built-ins", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        theme: "gruvbox",
        model: "anthropic/claude-3",
        provider: {
          anthropic: { options: { apiKey: "sk-existing" } },
          openai: { npm: "@ai-sdk/openai", name: "OpenAI built-in" },
          xai: { npm: "@ai-sdk/xai", name: "xAI built-in" },
        },
      }),
      "utf8",
    );

    const result = await installProvider(configPath);
    expect(result.created).toBe(false);
    expect(result.providers.every((p) => p.added)).toBe(true);

    const config = await readJson(configPath);
    expect(config.theme).toBe("gruvbox");
    expect(config.model).toBe("anthropic/claude-3");
    const providers = providerMap(config);
    expect(
      (providers.anthropic.options as Record<string, unknown>).apiKey,
    ).toBe("sk-existing");
    expect(providers.openai.name).toBe("OpenAI built-in");
    expect(providers.xai.name).toBe("xAI built-in");
    expect(
      (providers[XAI_PROVIDER_ID].options as Record<string, unknown>).baseURL,
    ).toBe(XAI_API_BASE);
    expect(
      (providers[CODEX_PROVIDER_ID].options as Record<string, unknown>).baseURL,
    ).toBe(CODEX_BASE_URL);
  });

  it("merges new default models under user edits (user overrides win)", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          [XAI_PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            name: "My Custom Grok Name",
            options: { baseURL: XAI_API_BASE, extra: "keep-xai" },
            models: {
              "grok-4.5": { name: "Grok Custom" },
              "grok-custom": { name: "Custom XAI" },
            },
          },
          [CODEX_PROVIDER_ID]: {
            npm: "@ai-sdk/openai-compatible",
            name: "My Custom Codex Name",
            options: { baseURL: CODEX_BASE_URL, extra: "keep-codex" },
            models: {
              "gpt-5-codex": { name: "GPT-5 Codex Custom" },
              "gpt-custom": { name: "Custom Codex" },
            },
          },
        },
      }),
      "utf8",
    );

    const result = await installProvider(configPath);
    expect(result.providers.every((p) => p.added === false)).toBe(true);
    expect(result.providers.some((p) => p.updated)).toBe(true);

    const providers = providerMap(await readJson(configPath));
    const xai = providers[XAI_PROVIDER_ID];
    expect(xai.name).toBe("My Custom Grok Name");
    expect((xai.options as Record<string, unknown>).extra).toBe("keep-xai");
    const xaiModels = xai.models as Record<string, { name?: string }>;
    expect(xaiModels["grok-4.5"].name).toBe("Grok Custom");
    expect(xaiModels["grok-custom"]).toEqual({ name: "Custom XAI" });

    const codex = providers[CODEX_PROVIDER_ID];
    expect(codex.name).toBe("My Custom Codex Name");
    expect((codex.options as Record<string, unknown>).extra).toBe("keep-codex");
    const codexModels = codex.models as Record<
      string,
      { name?: string; variants?: Record<string, unknown> }
    >;
    expect(codexModels["gpt-5-codex"].name).toBe("GPT-5 Codex Custom");
    expect(codexModels["gpt-5-codex"].variants).toMatchObject({
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
    });
    expect(codexModels["gpt-custom"]).toEqual({ name: "Custom Codex" });
    expect(codexModels["gpt-5.1-codex"]?.name).toBe("GPT-5.1 Codex");
  });

  it("fills in only missing fields on partial provider entries", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        provider: {
          [XAI_PROVIDER_ID]: { name: "Kept XAI" },
          [CODEX_PROVIDER_ID]: { name: "Kept Codex" },
        },
      }),
      "utf8",
    );

    const result = await installProvider(configPath);
    expect(result.providers.every((p) => p.added === false)).toBe(true);
    expect(result.providers.every((p) => p.updated)).toBe(true);

    const providers = providerMap(await readJson(configPath));
    expect(providers[XAI_PROVIDER_ID].name).toBe("Kept XAI");
    expect(providers[XAI_PROVIDER_ID].npm).toBe("@ai-sdk/xai");
    expect(providers[CODEX_PROVIDER_ID].name).toBe("Kept Codex");
    expect(providers[CODEX_PROVIDER_ID].npm).toBe("@ai-sdk/openai");
  });
});

describe("installProvider — plugin entries + legacy replace", () => {
  it("appends ONE package-root plugin entry with --with-plugin-entry", async () => {
    const without = await installProvider(configPath);
    expect(without.pluginEntriesAdded).toEqual([]);
    expect((await readJson(configPath)).plugin).toBeUndefined();

    const withEntry = await installProvider(configPath, {
      withPluginEntry: true,
      pluginEntries: ["opencode-multi-ai"],
    });
    expect(withEntry.pluginEntriesAdded).toEqual(["opencode-multi-ai"]);
    expect((await readJson(configPath)).plugin).toEqual(["opencode-multi-ai"]);
  });

  it("never duplicates plugin array entries on rerun", async () => {
    const entries = ["opencode-multi-ai"];
    await installProvider(configPath, {
      withPluginEntry: true,
      pluginEntries: entries,
    });
    const r2 = await installProvider(configPath, {
      withPluginEntry: true,
      pluginEntries: entries,
    });
    const r3 = await installProvider(configPath, {
      withPluginEntry: true,
      pluginEntries: entries,
    });

    expect(r2.pluginEntriesAdded).toEqual([]);
    expect(r3.pluginEntriesAdded).toEqual([]);
    expect((await readJson(configPath)).plugin).toEqual(entries);
  });

  it("replaces legacy opencode-multi-xai / opencode-multi-codex plugin entries", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        plugin: [
          "some-other-plugin",
          "opencode-multi-xai",
          "opencode-multi-codex",
          ["/path/to/opencode-multi-xai", { foo: 1 }],
        ],
      }),
      "utf8",
    );

    const result = await installProvider(configPath, {
      withPluginEntry: true,
      pluginEntries: ["opencode-multi-ai"],
    });

    expect(result.legacyPluginsRemoved).toEqual(
      expect.arrayContaining([...LEGACY_PLUGIN_PACKAGES]),
    );
    const plugin = (await readJson(configPath)).plugin as unknown[];
    expect(plugin).toContain("some-other-plugin");
    expect(plugin).toContain("opencode-multi-ai");
    expect(plugin).not.toContain("opencode-multi-xai");
    expect(plugin).not.toContain("opencode-multi-codex");
    expect(
      plugin.some((e) => pluginEntryKey(e)?.includes("opencode-multi-xai")),
    ).toBe(false);
  });

  it("rewrites dual module paths to a single package-root entry", async () => {
    await writeFile(
      configPath,
      JSON.stringify({
        plugin: [
          "some-other-plugin",
          "/tmp/opencode-multi-ai/lib/plugin/xai.ts",
          "/tmp/opencode-multi-ai/lib/plugin/codex.ts",
        ],
      }),
      "utf8",
    );

    await installProvider(configPath, {
      withPluginEntry: true,
      pluginEntries: ["/tmp/opencode-multi-ai"],
    });
    const plugin = (await readJson(configPath)).plugin as string[];
    expect(plugin).toEqual(["some-other-plugin", "/tmp/opencode-multi-ai"]);
  });

  it("preserves other existing plugin array entries", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ plugin: ["some-other-plugin"] }),
      "utf8",
    );

    await installProvider(configPath, {
      withPluginEntry: true,
      pluginEntries: ["opencode-multi-ai"],
    });
    const plugin = (await readJson(configPath)).plugin as string[];
    expect(plugin[0]).toBe("some-other-plugin");
    expect(plugin).toContain("opencode-multi-ai");
    expect(plugin).toHaveLength(2);
  });

  it("defaultPluginEntries points at the package root only", () => {
    const entries = defaultPluginEntries("/tmp/pkg");
    expect(entries).toEqual(["/tmp/pkg"]);
    expect(PLUGIN_PACKAGE).toBe("opencode-multi-ai");
  });
});

describe("installProvider — backup + idempotent", () => {
  it("backs up existing config before first rewrite", async () => {
    await writeFile(
      configPath,
      JSON.stringify({ theme: "old", provider: {} }),
      "utf8",
    );
    const result = await installProvider(configPath);
    expect(result.backedUp).toBe(true);
    expect(result.backupPath).toBe(`${configPath}.bak`);
    const bak = await readFile(`${configPath}.bak`, "utf8");
    expect(JSON.parse(bak).theme).toBe("old");
  });

  it("does not overwrite an existing .bak", async () => {
    await writeFile(configPath, JSON.stringify({ theme: "v1" }), "utf8");
    await writeFile(`${configPath}.bak`, JSON.stringify({ keep: true }), "utf8");
    const result = await installProvider(configPath);
    expect(result.backedUp).toBe(false);
    expect(JSON.parse(await readFile(`${configPath}.bak`, "utf8")).keep).toBe(
      true,
    );
  });

  it("produces byte-identical output on a second run", async () => {
    await installProvider(configPath);
    const first = await readFile(configPath, "utf8");

    const result = await installProvider(configPath);
    const second = await readFile(configPath, "utf8");

    expect(second).toBe(first);
    expect(result.created).toBe(false);
    expect(result.providers.every((p) => !p.added && !p.updated)).toBe(true);
  });
});

describe("installProvider — throws on malformed JSON", () => {
  it("throws a clear error and never overwrites malformed JSON", async () => {
    const malformed = '{ "provider": { broken';
    await writeFile(configPath, malformed, "utf8");

    await expect(installProvider(configPath)).rejects.toThrow(/malformed JSON/i);
    expect(await readFile(configPath, "utf8")).toBe(malformed);
  });

  it("throws when the top level is not a JSON object", async () => {
    await writeFile(configPath, JSON.stringify(["array", "config"]), "utf8");
    await expect(installProvider(configPath)).rejects.toThrow(
      /expected a JSON object/i,
    );
  });

  it("treats an empty existing file as an empty config (not malformed)", async () => {
    await writeFile(configPath, "   \n", "utf8");
    const result = await installProvider(configPath);
    expect(result.created).toBe(false);
    expect(result.providers.every((p) => p.added)).toBe(true);
    const providers = providerMap(await readJson(configPath));
    expect(providers[XAI_PROVIDER_ID]).toBeTruthy();
    expect(providers[CODEX_PROVIDER_ID]).toBeTruthy();
  });
});

describe("stripLegacyPluginEntries", () => {
  it("removes string and path forms of legacy packages", () => {
    const config: Record<string, unknown> = {
      plugin: [
        "keep-me",
        "opencode-multi-xai",
        "/Users/me/.local/share/opencode-multi-codex",
        "opencode-multi-ai/lib/plugin/xai",
      ],
    };
    const removed = stripLegacyPluginEntries(config);
    expect(removed).toContain("opencode-multi-xai");
    expect(removed.some((r) => r.includes("opencode-multi-codex"))).toBe(true);
    expect(config.plugin).toEqual([
      "keep-me",
      "opencode-multi-ai/lib/plugin/xai",
    ]);
  });
});
