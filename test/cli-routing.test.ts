import { describe, expect, it } from "vitest";

import {
  isKnownCommand,
  numFlag,
  parseArgs,
  parseProviderFlag,
  requiresProvider,
  resolveProvider,
  resolveProviderFromArgv0,
  strFlag,
  toolNameFor,
} from "../lib/cli/routing.js";

describe("cli routing", () => {
  describe("resolveProviderFromArgv0", () => {
    it("forces xai from op-xai / xai-multi aliases", () => {
      expect(resolveProviderFromArgv0("op-xai")).toBe("xai");
      expect(resolveProviderFromArgv0("/usr/local/bin/op-xai")).toBe("xai");
      expect(resolveProviderFromArgv0("xai-multi")).toBe("xai");
      expect(resolveProviderFromArgv0("opencode-multi-xai")).toBe("xai");
      expect(resolveProviderFromArgv0("op-xai.ts")).toBe("xai");
    });

    it("forces codex from op-codex / codex-multi aliases", () => {
      expect(resolveProviderFromArgv0("op-codex")).toBe("codex");
      expect(resolveProviderFromArgv0("codex-multi")).toBe("codex");
      expect(resolveProviderFromArgv0("opencode-multi-codex")).toBe("codex");
    });

    it("leaves op-ai / scripts/cli unforced", () => {
      expect(resolveProviderFromArgv0("op-ai")).toBeUndefined();
      expect(resolveProviderFromArgv0("opencode-multi-ai")).toBeUndefined();
      expect(resolveProviderFromArgv0("cli")).toBeUndefined();
      expect(resolveProviderFromArgv0("scripts/cli.ts")).toBeUndefined();
    });
  });

  describe("parseArgs", () => {
    it("defaults to tui when no command", () => {
      expect(parseArgs([]).command).toBe("tui");
      expect(parseArgs(["--lang", "vi"]).command).toBe("tui");
      expect(parseArgs(["--provider", "xai"]).command).toBe("tui");
    });

    it("parses command + flags", () => {
      const { command, flags } = parseArgs([
        "list",
        "--tag",
        "work",
        "--provider",
        "xai",
        "--probe",
      ]);
      expect(command).toBe("list");
      expect(flags.tag).toBe("work");
      expect(flags.provider).toBe("xai");
      expect(flags.probe).toBe(true);
    });
  });

  describe("resolveProvider", () => {
    it("argv0 wins over --provider", () => {
      expect(
        resolveProvider({
          argv0: "op-xai",
          flags: { provider: "codex" },
        }),
      ).toBe("xai");
    });

    it("uses --provider for op-ai", () => {
      expect(
        resolveProvider({
          argv0: "op-ai",
          flags: { provider: "codex" },
        }),
      ).toBe("codex");
      expect(parseProviderFlag({ provider: "grok" })).toBe("xai");
      expect(parseProviderFlag({ provider: "chatgpt" })).toBe("codex");
    });
  });

  describe("requiresProvider", () => {
    it("does not require when forced by argv0", () => {
      expect(requiresProvider("switch", "xai")).toBe(false);
    });

    it("optional for list/status/tui/help on op-ai", () => {
      expect(requiresProvider("list", undefined)).toBe(false);
      expect(requiresProvider("status", undefined)).toBe(false);
      expect(requiresProvider("tui", undefined)).toBe(false);
      expect(requiresProvider("help", undefined)).toBe(false);
    });

    it("required for mutating commands on op-ai", () => {
      expect(requiresProvider("switch", undefined)).toBe(true);
      expect(requiresProvider("remove", undefined)).toBe(true);
      expect(requiresProvider("add", undefined)).toBe(true);
      expect(requiresProvider("import", undefined)).toBe(true);
    });
  });

  describe("toolNameFor", () => {
    it("maps quota → limits and prefixes provider", () => {
      expect(toolNameFor("xai", "list")).toBe("xai-list");
      expect(toolNameFor("codex", "quota")).toBe("codex-limits");
      expect(toolNameFor("xai", "limits")).toBe("xai-limits");
    });
  });

  describe("flag helpers", () => {
    it("numFlag / strFlag", () => {
      expect(numFlag({ index: "2" }, "index")).toBe(2);
      expect(numFlag({ index: true }, "index")).toBeUndefined();
      expect(strFlag({ id: "abc" }, "id")).toBe("abc");
      expect(strFlag({ id: true }, "id")).toBeUndefined();
    });
  });

  describe("isKnownCommand", () => {
    it("accepts shared and codex import", () => {
      expect(isKnownCommand("list", "xai")).toBe(true);
      expect(isKnownCommand("import", "codex")).toBe(true);
      expect(isKnownCommand("import", undefined)).toBe(true);
      expect(isKnownCommand("nope", "xai")).toBe(false);
    });
  });
});
