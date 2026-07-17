/**
 * Register the multi-ai session sidebar TUI plugin in tui.json.
 *
 *   bun scripts/install-tui.ts
 *   bun scripts/install-tui.ts --config ~/.config/opencode/tui.json
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TUI_PLUGIN_ID_HINT = "opencode-multi-ai.sidebar";

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function defaultTuiConfigPath(): string {
  const env = process.env.OPENCODE_TUI_CONFIG?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".config", "opencode", "tui.json");
}

function tuiPluginPath(root: string = packageRoot()): string {
  return path.join(root, "lib", "plugin", "tui.tsx");
}

function isOurTuiEntry(entry: unknown): boolean {
  if (typeof entry === "string") {
    return (
      entry.includes("opencode-multi-ai") &&
      (entry.includes("/tui") || entry.endsWith("tui.tsx") || entry.endsWith("/tui"))
    );
  }
  if (Array.isArray(entry) && typeof entry[0] === "string") {
    return isOurTuiEntry(entry[0]);
  }
  return false;
}

async function main(): Promise<void> {
  let configPath = defaultTuiConfigPath();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a === "--config" && process.argv[i + 1]) {
      configPath = path.resolve(process.argv[++i]!);
    }
  }

  const entry = tuiPluginPath();
  let raw = "";
  let config: Record<string, unknown> = {
    $schema: "https://opencode.ai/tui.json",
    plugin: [],
  };
  try {
    raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const plugin = Array.isArray(config.plugin) ? [...config.plugin] : [];
  const next = plugin.filter((e) => !isOurTuiEntry(e));
  next.push(entry);
  config.plugin = next;
  if (config.$schema === undefined) {
    config.$schema = "https://opencode.ai/tui.json";
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const body = `${JSON.stringify(config, null, 2)}\n`;
  if (raw && raw !== body) {
    const bak = `${configPath}.bak`;
    try {
      await fs.access(bak);
    } catch {
      await fs.writeFile(bak, raw, "utf8");
    }
  }
  await fs.writeFile(configPath, body, "utf8");

  console.log("multi-ai TUI sidebar installer");
  console.log("─".repeat(48));
  console.log(`config: ${configPath}`);
  console.log(`plugin: ${entry}`);
  console.log(`id:     ${TUI_PLUGIN_ID_HINT}`);
  console.log("Restart OpenCode TUI to load the Accounts sidebar section.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
