import { tool, type Plugin } from "@opencode-ai/plugin";

import { getAccountManager } from "../core/accounts.js";
import { logger } from "../core/logger.js";
import { writeActiveKeyToAuthJson } from "../providers/opencode-go/auth/auth-file.js";
import { PROVIDER_ID } from "../providers/opencode-go/constants.js";

/**
 * OpenCode plugin entry for the multi-account opencode-go provider.
 *
 * IMPORTANT EXPORT SHAPE: this module must default-export ONLY a PluginModule
 * `{ id, server }` and must NOT export other plain functions (OpenCode's
 * legacy loader may invoke every export as a Plugin and silently drop the
 * module).
 *
 * opencode-go rotation is MANUAL config-file rotation: the tool switches the
 * sticky account, mirrors the active key into OpenCode's auth.json entry
 * "opencode-go", and triggers a config reload. The built-in `opencode-go`
 * provider serves actual requests — this plugin registers no auth methods and
 * no provider config entry.
 */
const plugin: Plugin = async (input) => {
  logger.debug("multi-opencode-go plugin loading (server entry)");
  const manager = getAccountManager();
  await manager.load();

  return {
    tool: {
      opencodeGoRotate: tool({
        description:
          "Rotate the active OpenCode Go account. Writes the active account's " +
          "API key into OpenCode's auth.json (entry opencode-go) and triggers " +
          "a config reload; if reload is unavailable, restart opencode for the " +
          "new key to take effect.",
        args: {
          accountId: tool.schema
            .string()
            .optional()
            .describe(
              "explicit account id to activate; when omitted, rotates to the " +
                "next account in priority order after the current sticky one",
            ),
        },
        async execute(args) {
          const accounts = manager.list("opencode-go");
          if (accounts.length === 0) {
            return "No OpenCode Go accounts in the pool. Add one first.";
          }

          // Explicit id: activate it (switchTo promotes to the front).
          if (args.accountId !== undefined) {
            if (!manager.get("opencode-go", args.accountId)) {
              return `Unknown OpenCode Go account id "${args.accountId}".`;
            }
            await manager.switchTo("opencode-go", args.accountId);
            const account = manager.get("opencode-go", args.accountId);
            if (!account || typeof account.accessToken !== "string") {
              return `Switched sticky to ${args.accountId}, but it has no access token; cannot write auth.json.`;
            }
            await writeActiveKeyToAuthJson(account.accessToken);
            try {
              await input.client.config.update({});
            } catch (err) {
              logger.debug(
                `opencode-go: config reload unavailable: ${(err as Error).message}`,
              );
              return `Rotated to account ${args.accountId}. Restart opencode for the new key to take effect.`;
            }
            return `Rotated to account ${args.accountId}.`;
          }

          // Implicit: rotate FORWARD in stable priority order (round-robin),
          // without promotion — switchTo promote would reorder the list and
          // collapse rotation to a 2-cycle between the top two accounts.
          const attempted = new Set<string>();
          const stickyId = manager.sticky("opencode-go");
          if (stickyId) attempted.add(stickyId);
          const next = manager.selectAccount(
            "opencode-go",
            attempted,
            "round-robin",
          );
          if (!next) {
            return "No other OpenCode Go account to rotate to.";
          }
          if (typeof next.accessToken !== "string") {
            return `Rotated sticky to ${next.accountId}, but it has no access token; cannot write auth.json.`;
          }
          await writeActiveKeyToAuthJson(next.accessToken);

          try {
            await input.client.config.update({});
          } catch (err) {
            logger.debug(
              `opencode-go: config reload unavailable: ${(err as Error).message}`,
            );
            return `Rotated to account ${next.accountId}. Restart opencode for the new key to take effect.`;
          }
          return `Rotated to account ${next.accountId}.`;
        },
      }),
    },
  };
};

export default { id: PROVIDER_ID, server: plugin };
