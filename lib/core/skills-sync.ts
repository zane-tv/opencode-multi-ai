import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { logger } from "./logger.js";

export function getPackageSkillsDir(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(dir, "../../skills");
}

export function getDefaultSkillsDestDir(): string {
  const fromEnv = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (fromEnv) return path.join(path.resolve(fromEnv), "skills");
  return path.join(os.homedir(), ".config", "opencode", "skills");
}

/**
 * Ensure bundled skills (deep-code-review, system-architect-planner, etc.)
 * are present in the user's OpenCode skills directory.
 * Runs idempotently on plugin startup or installer execution.
 */
export async function ensureBundledSkillsInstalled(
  destSkillsDir: string = getDefaultSkillsDestDir(),
): Promise<string[]> {
  const srcSkillsDir = getPackageSkillsDir();
  const installed: string[] = [];

  try {
    const entries = await readdir(srcSkillsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        const skillName = ent.name;
        const srcSkillFile = path.join(srcSkillsDir, skillName, "SKILL.md");
        const destSkillFolder = path.join(destSkillsDir, skillName);
        const destSkillFile = path.join(destSkillFolder, "SKILL.md");

        try {
          let needsCopy = false;
          try {
            await readFile(destSkillFile, "utf8");
          } catch {
            needsCopy = true;
          }

          if (needsCopy) {
            const content = await readFile(srcSkillFile, "utf8");
            await mkdir(destSkillFolder, { recursive: true });
            await writeFile(destSkillFile, content, "utf8");
            installed.push(skillName);
          }
        } catch {
          // ignore individual read/write failure
        }
      }
    }
  } catch (err) {
    logger.debug(`ensureBundledSkillsInstalled skipped: ${(err as Error).message}`);
  }

  if (installed.length > 0) {
    logger.info(`Auto-installed ${installed.length} smart skill(s): ${installed.join(", ")}`);
  }
  return installed;
}
