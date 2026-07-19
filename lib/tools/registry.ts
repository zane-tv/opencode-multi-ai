import { tool, type ToolDefinition } from "@opencode-ai/plugin";

import type {
  AccountManager,
  ProviderAccountView,
} from "../core/accounts.js";
import type { AccountMetadata, ProviderKind } from "../core/schemas.js";
import {
  formatAge,
  formatBillingReset,
  formatUntil,
} from "../core/format-time.js";
import { renderStatusLine } from "../core/tui-status.js";
import { MAX_ACCOUNTS as XAI_MAX } from "../providers/xai/constants.js";
import { MAX_ACCOUNTS as CODEX_MAX } from "../providers/codex/constants.js";
import {
  formatCostUsd,
  formatRemaining,
  probeAccountRateLimit,
} from "../providers/xai/request/rate-limit.js";
import { fetchGrokBillingQuota } from "../providers/xai/request/billing-quota.js";
import {
  deriveRemainingFromPlanUsage,
  fetchGrokPlan,
  formatPlanLimit,
  planFromAccessToken,
  resolveXaiCreditResetsAtMs,
  resolveXaiPlanResetsAtMs,
} from "../providers/xai/request/plan.js";
import { fetchGrokUserProfile } from "../providers/xai/request/user-profile.js";
import {
  fetchCodexUsage,
  isWindowDisabled,
  leftPercent,
  windowLabel,
} from "../providers/codex/request/usage.js";
import {
  accountDisplayName,
  resolveAccount,
  shortId,
} from "./resolve.js";

/**
 * CLI management tools registered via the plugin `tool` hook.
 *
 * Kept in a SEPARATE module from plugin entries on purpose: OpenCode's
 * plugin loader (legacy path) may invoke every export of a plugin module as a
 * Plugin. Do not re-export this from plugin entry files.
 *
 * Each tool map is provider-scoped via `manager.providerView("xai"|"codex"|"kiro")`.
 * Tool names stay `xai-*`, `codex-*`, and `kiro-*` (never mixed in one action).
 */

const { schema } = tool;

const KIRO_MAX = 20;

const MAX: Partial<Record<ProviderKind, number>> = {
  xai: XAI_MAX,
  codex: CODEX_MAX,
  kiro: KIRO_MAX,
};

function identify(a: AccountMetadata): string {
  const who = accountDisplayName(a);
  if (who === shortId(a.accountId)) return who;
  return `${who}  (${shortId(a.accountId)})`;
}

function pruneReason(a: AccountMetadata): string {
  if (a.subscriptionStatus === "dead") return "dead (subscription terminated)";
  return "flagged for removal";
}

function describeState(a: AccountMetadata, now: number): string {
  const parts: string[] = [];
  if (!a.enabled) parts.push("disabled");
  if (a.subscriptionStatus === "dead") parts.push("DEAD");
  if (a.entitlementBlocked) parts.push("entitlement-blocked");
  if (typeof a.quotaResetAt === "number" && a.quotaResetAt > now) {
    parts.push(`quota-exhausted ${formatUntil(a.quotaResetAt)}`);
  }
  if (typeof a.coolingDownUntil === "number" && a.coolingDownUntil > now) {
    const why = a.cooldownReason ? ` (${a.cooldownReason})` : "";
    parts.push(`cooling down${why} ${formatUntil(a.coolingDownUntil)}`);
  }
  if (a.flaggedForRemoval) parts.push("flagged-for-removal");
  if (parts.length === 0) parts.push("ready");
  return parts.join(", ");
}

function activeIndex(view: ProviderAccountView): number {
  const sticky = view.sticky();
  if (!sticky) return -1;
  return view.list().findIndex((a) => a.accountId === sticky);
}

function selectorArgs(listTool: string) {
  return {
    index: schema
      .number()
      .int()
      .optional()
      .describe(`0-based position of the account (see ${listTool})`),
    id: schema
      .string()
      .optional()
      .describe("account id (a unique prefix is accepted)"),
  };
}

function usageSummaryLine(a: AccountMetadata): string {
  if (a.provider !== "codex") return "";
  const plan = a.planType ?? "—";
  const primary =
    a.primaryUsedPercent !== undefined
      ? isWindowDisabled(a.primaryWindowMinutes)
        ? "primary=disabled"
        : `primary ${leftPercent(a.primaryUsedPercent).toFixed(0)}% left`
      : "primary=?";
  const secondary =
    a.secondaryUsedPercent !== undefined
      ? isWindowDisabled(a.secondaryWindowMinutes)
        ? "secondary=disabled"
        : `secondary ${leftPercent(a.secondaryUsedPercent).toFixed(0)}% left`
      : "secondary=?";
  return `plan=${plan}  ${primary}  ${secondary}`;
}

function xaiSummaryLine(a: AccountMetadata): string {
  if (a.provider !== "xai") return "";
  return `plan=${a.planName ?? (a.planTier !== undefined ? `tier ${a.planTier}` : "—")}`;
}

function kiroSummaryLine(a: AccountMetadata): string {
  if (a.provider !== "kiro") return "";
  const method = a.authMethod ?? "kiro";
  const region = a.region ?? "—";
  if (
    typeof a.usedCount === "number" &&
    typeof a.limitCount === "number" &&
    a.limitCount > 0
  ) {
    const rem = Math.max(0, Math.round(100 - (a.usedCount / a.limitCount) * 100));
    return `auth=${method}  region=${region}  ${rem}% left (${a.usedCount}/${a.limitCount})`;
  }
  return `auth=${method}  region=${region}`;
}

function providerSummaryLine(a: AccountMetadata): string {
  if (a.provider === "codex") return usageSummaryLine(a);
  if (a.provider === "xai") return xaiSummaryLine(a);
  if (a.provider === "kiro") return kiroSummaryLine(a);
  return "";
}

function renderList(
  view: ProviderAccountView,
  brand: string,
  emptyHint: string,
): string {
  const accounts = view.list();
  if (accounts.length === 0) return emptyHint;
  const active = activeIndex(view);
  const now = Date.now();
  const lines = accounts.map((a, i) => {
    const isActive = i === active;
    const marker = isActive ? "★" : " ";
    const who = accountDisplayName(a);
    const activeTag = isActive ? " ★ ACTIVE" : "";
    const tags = a.tags.length > 0 ? ` [${a.tags.join(", ")}]` : "";
    const summary = providerSummaryLine(a);
    return (
      `${marker} ${i}  ${who}${activeTag}${tags}\n` +
      `     id=${shortId(a.accountId)}  ${summary}  sub=${a.subscriptionStatus}  ` +
      `state=${describeState(a, now)}`
    );
  });
  return (
    `${brand} accounts (${accounts.length}/${MAX[view.provider]}) — ★ = ACTIVE sticky:\n` +
    lines.join("\n")
  );
}

function formatWindowLine(
  name: string,
  used: number | undefined,
  windowMinutes: number | undefined,
  resetAt: number | undefined,
  now: number,
): string {
  if (isWindowDisabled(windowMinutes)) {
    return `    ${name}:     disabled (${windowLabel(windowMinutes)})`;
  }
  if (used === undefined) {
    return `    ${name}:     unknown`;
  }
  const left = leftPercent(used);
  const win = windowLabel(windowMinutes);
  const reset =
    typeof resetAt === "number" ? `  reset ${formatUntil(resetAt, now)}` : "";
  return (
    `    ${name}:     ${left.toFixed(1)}% left` +
    ` (used ${used.toFixed(1)}%, window ${win})${reset}`
  );
}

/** Shared mutating tools for one provider (list/status/switch/…/prune). */
function buildSharedTools(
  view: ProviderAccountView,
  prefix: ProviderKind,
  brand: string,
  emptyHint: string,
  addHelp: (n: number) => string,
): Record<string, ToolDefinition> {
  const listTool = `${prefix}-list`;
  const sel = selectorArgs(listTool);
  const target = (args: { index?: number; id?: string }): AccountMetadata =>
    resolveAccount(view.list(), args);

  return {
    [`${prefix}-status`]: tool({
      description:
        `Show a compact one-line status of the ${brand} account pool: the active ` +
        "account plus counts of ready / quota-exhausted / cooling / " +
        "entitlement-blocked / dead accounts, and a warning badge when any " +
        "account is dead or flagged for removal.",
      args: {},
      async execute() {
        return renderStatusLine(
          view.list(),
          activeIndex(view),
          Date.now(),
          { prefix, pruneCommand: `${prefix}-prune` },
        );
      },
    }),

    [`${prefix}-list`]: tool({
      description:
        `List all configured ${brand} accounts, their state, and which is active. ` +
        "Optional tag filter.",
      args: {
        tag: schema
          .string()
          .optional()
          .describe("only list accounts whose tags include this tag"),
      },
      async execute(args) {
        const tag = args.tag?.trim();
        if (!tag) return renderList(view, brand, emptyHint);
        const accounts = view.list().filter((a) => a.tags.includes(tag));
        if (accounts.length === 0) {
          return `No ${brand} accounts with tag "${tag}".`;
        }
        const active = activeIndex(view);
        const all = view.list();
        const now = Date.now();
        const lines = accounts.map((a) => {
          const i = all.findIndex((x) => x.accountId === a.accountId);
          const isActive = i === active;
          const marker = isActive ? "★" : " ";
          const who = accountDisplayName(a);
          const activeTag = isActive ? " ★ ACTIVE" : "";
          const tags = a.tags.length > 0 ? ` [${a.tags.join(", ")}]` : "";
          const summary = providerSummaryLine(a);
          return (
            `${marker} ${i}  ${who}${activeTag}${tags}\n` +
            `     id=${shortId(a.accountId)}  ${summary}  sub=${a.subscriptionStatus}  ` +
            `state=${describeState(a, now)}`
          );
        });
        return (
          `${brand} accounts with tag "${tag}" (${accounts.length}) — ★ = ACTIVE:\n` +
          lines.join("\n")
        );
      },
    }),

    [`${prefix}-add`]: tool({
      description:
        prefix === "xai"
          ? "How to add another SuperGrok account to the pool. " +
            "Accounts are only created via SuperGrok OAuth (no raw token paste)."
          : prefix === "codex"
            ? "How to add another ChatGPT/Codex account to the pool " +
              "(OAuth device/browser, or JSON import like 9router / Codex auth.json)."
            : "How to add another Kiro account to the pool " +
              "(IDC device OAuth, API key ksk_*, JSON credentials, or kiro-cli DB import).",
      args: {},
      async execute() {
        return addHelp(view.list().length);
      },
    }),

    [`${prefix}-switch`]: tool({
      description:
        `Switch the active ${brand} account by index or id. Selection is sticky, so ` +
        "subsequent requests drain the chosen account first.",
      args: sel,
      async execute(args) {
        const account = target(args);
        await view.switchTo(account.accountId);
        return `Active account is now ${shortId(account.accountId)}${
          account.label ? ` (${account.label})` : ""
        }.`;
      },
    }),

    [`${prefix}-priority`]: tool({
      description:
        "Change account rotation priority (list order). Higher priority is " +
        "preferred earlier when the sticky active account is not usable. " +
        "direction: up | down | top, or set absolute priority number.",
      args: {
        ...sel,
        direction: schema
          .enum(["up", "down", "top"])
          .optional()
          .describe("move one step up/down or to top of the queue"),
        priority: schema
          .number()
          .int()
          .optional()
          .describe("absolute priority value (higher = earlier)"),
      },
      async execute(args) {
        const account = target(args);
        if (args.priority !== undefined) {
          await view.setPriority(account.accountId, args.priority);
        } else if (args.direction === "top") {
          await view.moveToFront(account.accountId);
        } else if (args.direction === "up" || args.direction === "down") {
          await view.movePriority(account.accountId, args.direction);
        } else {
          return (
            `${prefix}-priority needs direction=up|down|top or priority=<int>. ` +
            "Example: direction=up index=2"
          );
        }
        const list = view.list();
        const idx = list.findIndex((a) => a.accountId === account.accountId);
        return (
          `Priority updated for ${shortId(account.accountId)}: ` +
          `now list #${idx}. Order is rotation preference after sticky active fails.`
        );
      },
    }),

    [`${prefix}-remove`]: tool({
      description:
        `Remove one ${brand} account from the pool by index or id. ` +
        "Requires confirm=true (destructive; OAuth credentials cannot be recovered).",
      args: {
        ...sel,
        confirm: schema
          .boolean()
          .optional()
          .describe(
            "must be true to delete; omit/false is a no-op with guidance",
          ),
      },
      async execute(args) {
        if (args.confirm !== true) {
          return (
            `${prefix}-remove requires confirm=true. ` +
            "Removing deletes OAuth credentials and cannot be undone. " +
            `Re-run as: ${prefix}-remove index=<N> confirm=true  (or id=<prefix> confirm=true)`
          );
        }
        const account = target(args);
        await view.remove(account.accountId);
        return `Removed account ${shortId(account.accountId)}.`;
      },
    }),

    [`${prefix}-enable`]: tool({
      description: `Enable a ${brand} account so selection may use it.`,
      args: sel,
      async execute(args) {
        const account = target(args);
        await view.setEnabled(account.accountId, true);
        return `Enabled account ${shortId(account.accountId)}.`;
      },
    }),

    [`${prefix}-disable`]: tool({
      description: `Disable a ${brand} account so selection skips it.`,
      args: sel,
      async execute(args) {
        const account = target(args);
        await view.setEnabled(account.accountId, false);
        return `Disabled account ${shortId(account.accountId)}.`;
      },
    }),

    [`${prefix}-label`]: tool({
      description: `Set (or clear) a friendly label on a ${brand} account. Omit \`label\` to clear.`,
      args: {
        ...sel,
        label: schema
          .string()
          .optional()
          .describe("label text; omit or empty to clear"),
      },
      async execute(args) {
        const account = target(args);
        const label =
          args.label && args.label.length > 0 ? args.label : undefined;
        await view.setLabel(account.accountId, label);
        return label
          ? `Set label of ${shortId(account.accountId)} to "${label}".`
          : `Cleared label of ${shortId(account.accountId)}.`;
      },
    }),

    [`${prefix}-tag`]: tool({
      description:
        `Replace the tags on a ${brand} account with a comma-separated list. ` +
        "Pass an empty string to clear all tags.",
      args: {
        ...sel,
        tags: schema
          .string()
          .describe("comma-separated tags, e.g. 'work, primary'"),
      },
      async execute(args) {
        const account = target(args);
        const tags = args.tags
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        await view.setTags(account.accountId, tags);
        return tags.length > 0
          ? `Set tags of ${shortId(account.accountId)} to [${tags.join(", ")}].`
          : `Cleared tags of ${shortId(account.accountId)}.`;
      },
    }),

    [`${prefix}-note`]: tool({
      description: `Set (or clear) a free-form note on a ${brand} account. Omit \`note\` to clear.`,
      args: {
        ...sel,
        note: schema.string().optional().describe("note text; omit to clear"),
      },
      async execute(args) {
        const account = target(args);
        const note =
          args.note && args.note.length > 0 ? args.note : undefined;
        await view.setNote(account.accountId, note);
        return note
          ? `Set note on ${shortId(account.accountId)}.`
          : `Cleared note on ${shortId(account.accountId)}.`;
      },
    }),

    [`${prefix}-refresh`]: tool({
      description:
        `Force a token refresh for a ${brand} account (bypasses the fast path). ` +
        "Reports success or failure without ever printing token values.",
      args: sel,
      async execute(args) {
        const account = target(args);
        try {
          await view.ensureFreshToken(account.accountId, true);
          return `Refreshed tokens for ${shortId(account.accountId)}.`;
        } catch (err) {
          return `Failed to refresh ${shortId(account.accountId)}: ${
            (err as Error).message
          }`;
        }
      },
    }),

    [`${prefix}-health`]: tool({
      description:
        `Check health of all ${brand} accounts by validating refresh tokens ` +
        "(force refresh). Reports healthy vs failed without printing tokens.",
      args: {},
      async execute() {
        const accounts = view.list();
        if (accounts.length === 0) {
          return `No ${brand} accounts. Run ${prefix}-add (or opencode auth login) first.`;
        }
        const lines: string[] = [
          `Health check (${accounts.length} account(s)):`,
          "",
        ];
        let ok = 0;
        let bad = 0;
        for (let i = 0; i < accounts.length; i++) {
          const a = accounts[i]!;
          const who = accountDisplayName(a);
          try {
            await view.ensureFreshToken(a.accountId, true);
            lines.push(`  OK   ${i}  ${who}  id=${shortId(a.accountId)}`);
            ok++;
          } catch (err) {
            lines.push(
              `  FAIL ${i}  ${who}  id=${shortId(a.accountId)}  ${(err as Error).message}`,
            );
            bad++;
          }
        }
        lines.push("", `Summary: ${ok} healthy, ${bad} failed.`);
        return lines.join("\n");
      },
    }),

    [`${prefix}-flag`]: tool({
      description:
        `Flag a ${brand} account for removal (marks it prunable by ${prefix}-prune). ` +
        "Does NOT delete anything on its own.",
      args: sel,
      async execute(args) {
        const account = target(args);
        await view.setFlaggedForRemoval(account.accountId, true);
        return `Flagged ${identify(account)} for removal.`;
      },
    }),

    [`${prefix}-unflag`]: tool({
      description: `Clear the removal flag on a ${brand} account.`,
      args: sel,
      async execute(args) {
        const account = target(args);
        await view.setFlaggedForRemoval(account.accountId, false);
        return `Cleared the removal flag on ${identify(account)}.`;
      },
    }),

    [`${prefix}-prune`]: tool({
      description:
        `Bulk-remove ${brand} accounts whose subscription is terminated (dead) or ` +
        "that were manually flagged for removal. DRY-RUN BY DEFAULT: with no " +
        "arguments (or dryRun=true) it only REPORTS what would be pruned and " +
        "deletes nothing. Pass dryRun=false to actually delete (a one-time " +
        "backup is taken first). Quota-exhausted accounts are recoverable and " +
        "are NEVER pruned. Optionally restrict to accounts carrying a given tag.",
      args: {
        dryRun: schema
          .boolean()
          .optional()
          .describe(
            "when true (the default), only report; pass false to actually delete",
          ),
        tag: schema
          .string()
          .optional()
          .describe("only prune accounts whose tags include this tag"),
      },
      async execute(args) {
        const dryRun = args.dryRun ?? true;
        const tag = args.tag && args.tag.length > 0 ? args.tag : undefined;

        let targets = view.prunableAccounts();
        if (tag) targets = targets.filter((a) => a.tags.includes(tag));

        const total = view.list().length;
        if (targets.length === 0) {
          const scope = tag ? ` with tag "${tag}"` : "";
          return `Nothing to prune${scope}: no accounts are dead or flagged for removal. (${total} account(s) in the pool.)`;
        }

        const listing = targets
          .map((a) => `  - ${identify(a)}: ${pruneReason(a)}`)
          .join("\n");

        if (dryRun) {
          const remaining = total - targets.length;
          return (
            `DRY RUN — would prune ${targets.length} of ${total} account(s)` +
            `${tag ? ` (tag "${tag}")` : ""}, leaving ${remaining}:\n` +
            `${listing}\n` +
            `Nothing was deleted. Re-run with dryRun=false to delete.`
          );
        }

        const ids = targets.map((a) => a.accountId);
        const { removed } = await view.pruneAccounts(ids);
        return (
          `Pruned ${removed.length} of ${total} account(s)` +
          `${tag ? ` (tag "${tag}")` : ""}, ${total - removed.length} remaining. ` +
          `A backup was taken before deleting.\n` +
          `${listing}`
        );
      },
    }),

    [`${prefix}-clean-dead`]: tool({
      description:
        `Remove only ${brand} accounts with subscriptionStatus=dead ` +
        "(invalid_grant / terminated). Does NOT remove flagged-only or " +
        "quota-exhausted accounts. DRY-RUN by default; pass dryRun=false to delete.",
      args: {
        dryRun: schema
          .boolean()
          .optional()
          .describe(
            "when true (the default), only report; pass false to actually delete",
          ),
      },
      async execute(args) {
        const dryRun = args.dryRun ?? true;
        const targets = view.deadAccounts();
        const total = view.list().length;
        if (targets.length === 0) {
          return `No dead ${brand} accounts to clean. (${total} account(s) in the pool.)`;
        }
        const listing = targets
          .map((a) => `  - ${identify(a)}: dead (subscription terminated)`)
          .join("\n");
        if (dryRun) {
          return (
            `DRY RUN — would clean ${targets.length} dead account(s), ` +
            `leaving ${total - targets.length}:\n${listing}\n` +
            `Nothing was deleted. Re-run with dryRun=false to delete.`
          );
        }
        const { removed } = await view.cleanDeadAccounts();
        return (
          `Cleaned ${removed.length} dead account(s), ` +
          `${total - removed.length} remaining. Backup taken before deleting.\n` +
          `${listing}`
        );
      },
    }),
  };
}

function buildXaiLimitsTool(view: ProviderAccountView): ToolDefinition {
  const sel = selectorArgs("xai-list");
  const target = (args: { index?: number; id?: string }): AccountMetadata =>
    resolveAccount(view.list(), args);

  return tool({
    description:
      "Show SuperGrok remaining quota: (1) monthly credits % from grok.com " +
      "GetGrokCreditsConfig (same as opencode-bar), (2) API rate-limit " +
      "remaining requests/tokens from x-ratelimit headers. " +
      "probe=true refreshes both (billing + tiny chat). Alias: xai-quota.",
    args: {
      id: sel.id,
      index: sel.index,
      probe: schema
        .boolean()
        .optional()
        .describe(
          "when true, refresh monthly credits (grok.com) and API rate-limit headers",
        ),
    },
    async execute(args) {
      const now = Date.now();
      let accounts = view.list();
      if (accounts.length === 0) {
        return "No xAI accounts. Run xai-add (or opencode auth login) first.";
      }
      if (args.id !== undefined || args.index !== undefined) {
        accounts = [target(args)];
      }
      const doProbe = args.probe === true;
      const active = activeIndex(view);
      const all = view.list();
      const lines: string[] = [
        `SuperGrok quota (${accounts.length} account(s))` +
          `${doProbe ? " [live]" : ""}:`,
        "Sources: grok.com billing %  +  api.x.ai x-ratelimit headers",
        "",
      ];

      for (const a of accounts) {
        const i = all.findIndex((x) => x.accountId === a.accountId);
        const isActive = i === active;
        const marker = isActive ? "★" : " ";
        const who = accountDisplayName(a);
        const activeTag = isActive ? " ★ ACTIVE" : "";
        lines.push(`${marker} [${i}] ${who}${activeTag}  id=${shortId(a.accountId)}`);
        lines.push(`    enabled=${a.enabled}  sub=${a.subscriptionStatus}`);
        if (a.provider === "xai") {
          const plan =
            a.planName ??
            (a.planTier !== undefined ? `tier ${a.planTier}` : "—");
          const lim =
            a.planMonthlyLimit !== undefined
              ? formatPlanLimit(a.planMonthlyLimit)
              : "—";
          const used =
            a.planUsed !== undefined ? formatPlanLimit(a.planUsed) : "—";
          lines.push(`    plan=${plan}  monthly ${used}/${lim}`);
        }

        if (doProbe) {
          try {
            const tokens = await view.ensureFreshToken(a.accountId);
            try {
              if (!a.email) {
                try {
                  const profile = await fetchGrokUserProfile(tokens.accessToken);
                  if (profile.email) {
                    await view.setEmail(a.accountId, profile.email);
                  }
                } catch {
                  // optional
                }
              }
              const jwtPlan = planFromAccessToken(tokens.accessToken);
              await view.recordPlan(a.accountId, {
                planTier: jwtPlan.planTier,
                planName: jwtPlan.planName,
                observedAt: jwtPlan.observedAt,
              });
              const plan = await fetchGrokPlan(tokens.accessToken);
              await view.recordPlan(a.accountId, plan);
            } catch {
              // plan optional
            }

            try {
              const bill = await fetchGrokBillingQuota(tokens.accessToken);
              await view.recordBillingQuota(a.accountId, bill);
            } catch (err) {
              const freshPlan = view.get(a.accountId);
              const derived =
                freshPlan?.provider === "xai"
                  ? deriveRemainingFromPlanUsage(
                      freshPlan.planUsed,
                      freshPlan.planMonthlyLimit,
                    )
                  : undefined;
              if (derived) {
                await view.recordBillingQuota(a.accountId, {
                  monthlyUsedPercent: derived.monthlyUsedPercent,
                  remainingPercent: derived.remainingPercent,
                  resetsAtMs:
                    freshPlan?.provider === "xai"
                      ? freshPlan.planPeriodEndMs
                      : undefined,
                  observedAt: Date.now(),
                });
                lines.push(
                  `    billing probe: FAIL (used plan fallback) ${(err as Error).message}`,
                );
              } else {
                lines.push(
                  `    billing probe: FAIL ${(err as Error).message}`,
                );
              }
            }
            try {
              const snap = await probeAccountRateLimit(tokens.accessToken);
              await view.recordRateLimit(a.accountId, snap);
            } catch (err) {
              lines.push(
                `    API rate-limit probe: FAIL ${(err as Error).message}`,
              );
            }
          } catch (err) {
            lines.push(`    token: FAIL ${(err as Error).message}`);
          }
        }

        const fresh = view.get(a.accountId) ?? a;
        if (fresh.provider === "xai") {
          const derived = deriveRemainingFromPlanUsage(
            fresh.planUsed,
            fresh.planMonthlyLimit,
          );
          const rem =
            fresh.billingRemainingPercent ?? derived?.remainingPercent;
          const usedNum =
            fresh.billingMonthlyUsedPercent ?? derived?.monthlyUsedPercent;
          if (rem !== undefined || usedNum !== undefined) {
            const periodLabel =
              fresh.billingPeriodType === "weekly"
                ? "Weekly limit"
                : fresh.billingPeriodType === "monthly"
                  ? "Monthly limit"
                  : "Credits";
            const used =
              usedNum !== undefined
                ? String(Math.floor(usedNum))
                : rem !== undefined
                  ? String(Math.round(100 - rem))
                  : "?";
            lines.push(
              `    ${periodLabel}: ${used}%` +
                (rem !== undefined ? ` (${rem}% remaining)` : ""),
            );
            {
              const creditResetMs = resolveXaiCreditResetsAtMs(fresh);
              if (creditResetMs !== undefined) {
                lines.push(
                  `    Credits reset: ${formatBillingReset(creditResetMs, now, {
                    periodType: fresh.billingPeriodType,
                  })}`,
                );
              }
            }
            if (
              typeof fresh.planUsed === "number" &&
              typeof fresh.planMonthlyLimit === "number"
            ) {
              lines.push(
                `    allowance: ${formatPlanLimit(fresh.planUsed)} / ${formatPlanLimit(fresh.planMonthlyLimit)}` +
                  (derived
                    ? ` (${Math.round(derived.remainingPercent)}% left)`
                    : ""),
              );
            }
            {
              const planResetMs = resolveXaiPlanResetsAtMs(fresh);
              if (planResetMs !== undefined) {
                lines.push(
                  `    Plan reset: ${formatBillingReset(planResetMs, now)}`,
                );
              }
            }
            if (fresh.billingObservedAt || fresh.planObservedAt) {
              lines.push(
                `    billing@: ${formatAge(
                  fresh.billingObservedAt ?? fresh.planObservedAt,
                  now,
                )}`,
              );
            }
          } else {
            lines.push("    credits:  unknown (run xai-limits --probe)");
          }
        }

        if (
          fresh.rateLimitRemainingRequests !== undefined ||
          fresh.rateLimitRemainingTokens !== undefined
        ) {
          lines.push(
            `    requests: ${formatRemaining(
              fresh.rateLimitRemainingRequests,
              fresh.rateLimitLimitRequests,
            )}`,
          );
          lines.push(
            `    tokens:   ${formatRemaining(
              fresh.rateLimitRemainingTokens,
              fresh.rateLimitLimitTokens,
            )}`,
          );
          if (
            fresh.provider === "xai" &&
            fresh.lastCostInUsdTicks !== undefined
          ) {
            lines.push(
              `    last cost: ${formatCostUsd(fresh.lastCostInUsdTicks)}`,
            );
          }
        } else {
          lines.push(
            "    API RPS/TPM: unknown (probe or use the model once)",
          );
        }

        if (fresh.entitlementBlocked) {
          lines.push("    entitlement: BLOCKED (xAI allowlist gate)");
        }
        if (typeof fresh.quotaResetAt === "number" && fresh.quotaResetAt > now) {
          lines.push(`    exhausted ${formatUntil(fresh.quotaResetAt, now)}`);
        }
        if (
          typeof fresh.coolingDownUntil === "number" &&
          fresh.coolingDownUntil > now
        ) {
          lines.push(
            `    cooldown: ${fresh.cooldownReason ?? "unknown"} ` +
              `${formatUntil(fresh.coolingDownUntil, now)}`,
          );
        }
        lines.push("");
      }
      lines.push(
        "Tip: xai-limits --probe refreshes SuperGrok credits % + API remaining.",
      );
      return lines.join("\n");
    },
  });
}

function buildCodexLimitsTool(view: ProviderAccountView): ToolDefinition {
  const sel = selectorArgs("codex-list");
  const target = (args: { index?: number; id?: string }): AccountMetadata =>
    resolveAccount(view.list(), args);

  return tool({
    description:
      "Show Codex/ChatGPT usage windows: primary + secondary left% " +
      "(100-used), reset times, planType, activeLimit. " +
      "probe=true refreshes via GET .../wham/usage. Alias: codex-quota.",
    args: {
      id: sel.id,
      index: sel.index,
      probe: schema
        .boolean()
        .optional()
        .describe(
          "when true, refresh usage via ChatGPT wham/usage endpoint",
        ),
    },
    async execute(args) {
      const now = Date.now();
      let accounts = view.list();
      if (accounts.length === 0) {
        return "No Codex accounts. Run codex-add (or opencode auth login) first.";
      }
      if (args.id !== undefined || args.index !== undefined) {
        accounts = [target(args)];
      }
      const doProbe = args.probe === true;
      const active = activeIndex(view);
      const all = view.list();
      const lines: string[] = [
        `Codex usage (${accounts.length} account(s))` +
          `${doProbe ? " [live]" : ""}:`,
        "Sources: chatgpt.com/backend-api/wham/usage  +  x-codex-* headers",
        "",
      ];

      for (const a of accounts) {
        const i = all.findIndex((x) => x.accountId === a.accountId);
        const isActive = i === active;
        const marker = isActive ? "★" : " ";
        const who = accountDisplayName(a);
        const activeTag = isActive ? " ★ ACTIVE" : "";
        lines.push(`${marker} [${i}] ${who}${activeTag}  id=${shortId(a.accountId)}`);
        lines.push(`    enabled=${a.enabled}  sub=${a.subscriptionStatus}`);

        if (doProbe) {
          try {
            const tokens = await view.ensureFreshToken(a.accountId);
            const freshMeta = view.get(a.accountId) ?? a;
            try {
              const orgId =
                freshMeta.provider === "codex"
                  ? freshMeta.organizationId
                  : undefined;
              const usage = await fetchCodexUsage(
                tokens.accessToken,
                a.accountId,
                orgId,
              );
              await view.recordUsage(a.accountId, usage);
            } catch (err) {
              lines.push(`    usage probe: FAIL ${(err as Error).message}`);
            }
          } catch (err) {
            lines.push(`    token: FAIL ${(err as Error).message}`);
          }
        }

        const fresh = view.get(a.accountId) ?? a;
        if (fresh.provider === "codex") {
          lines.push(`    planType:  ${fresh.planType ?? "—"}`);
          lines.push(
            formatWindowLine(
              "primary",
              fresh.primaryUsedPercent,
              fresh.primaryWindowMinutes,
              fresh.primaryResetAt,
              now,
            ),
          );
          lines.push(
            formatWindowLine(
              "secondary",
              fresh.secondaryUsedPercent,
              fresh.secondaryWindowMinutes,
              fresh.secondaryResetAt,
              now,
            ),
          );
          lines.push(`    activeLimit: ${fresh.activeLimit ?? "—"}`);
          if (fresh.usageObservedAt) {
            lines.push(
              `    usage@:    ${formatAge(fresh.usageObservedAt, now)}`,
            );
          } else if (!doProbe) {
            lines.push(
              "    tip:       run codex-limits --probe for live windows",
            );
          }
        }

        if (fresh.entitlementBlocked) {
          lines.push("    entitlement: BLOCKED");
        }
        if (typeof fresh.quotaResetAt === "number" && fresh.quotaResetAt > now) {
          lines.push(`    exhausted ${formatUntil(fresh.quotaResetAt, now)}`);
        }
        if (
          typeof fresh.coolingDownUntil === "number" &&
          fresh.coolingDownUntil > now
        ) {
          lines.push(
            `    cooldown: ${fresh.cooldownReason ?? "unknown"} ` +
              `${formatUntil(fresh.coolingDownUntil, now)}`,
          );
        }
        lines.push("");
      }
      lines.push(
        "Tip: codex-limits --probe refreshes primary/secondary usage windows.",
      );
      return lines.join("\n");
    },
  });
}

function buildCodexImportTool(view: ProviderAccountView): ToolDefinition {
  return tool({
    description:
      "Import one or more ChatGPT/Codex OAuth accounts from JSON " +
      "(9router bulk-import shape or Codex CLI auth.json). " +
      "refreshToken is required. Prefer --file over pasting tokens into chat.",
    args: {
      file: schema.string().optional().describe("Path to a JSON file (preferred)"),
      json: schema
        .string()
        .optional()
        .describe("Raw JSON string when file path is unavailable"),
    },
    async execute(args) {
      const file =
        typeof args.file === "string" && args.file.trim()
          ? args.file.trim()
          : undefined;
      const json =
        typeof args.json === "string" && args.json.trim()
          ? args.json.trim()
          : undefined;
      if (!file && !json) {
        return [
          "codex-import needs file or json.",
          "",
          "Preferred:",
          "  op-codex import --file ./accounts.json",
          "  op-codex import --file ~/.codex/auth.json",
          "",
          "JSON must include accessToken + refreshToken (or snake_case / tokens{}).",
        ].join("\n");
      }
      const {
        importAccountsFromJsonFile,
        importAccountsFromJsonText,
      } = await import("../providers/codex/auth/import-json.js");
      const result = file
        ? await importAccountsFromJsonFile(view, file)
        : await importAccountsFromJsonText(view, json!);
      const lines = result.results.map((row) => {
        if (row.ok) {
          const who = row.email ?? row.accountId.slice(0, 12);
          return row.outcome === "added"
            ? `[${row.index}] added ${who}`
            : `[${row.index}] updated ${who}`;
        }
        return `[${row.index}] failed: ${row.error}`;
      });
      lines.push(
        "",
        `Import done · ${result.success} ok · ${result.failed} failed`,
      );
      return lines.join("\n");
    },
  });
}

/** xAI SuperGrok agent/CLI tools (provider-scoped). */
export function buildXaiTools(
  manager: AccountManager,
): Record<string, ToolDefinition> {
  const view = manager.providerView("xai");
  const shared = buildSharedTools(
    view,
    "xai",
    "xAI",
    "No xAI accounts. Run `opencode auth login` and pick a SuperGrok OAuth method to add one.",
    (n) =>
      [
        `Add SuperGrok account (pool ${n}/${XAI_MAX}):`,
        "",
        "Recommended:",
        "  op-xai tui          → press +  (device OAuth inside TUI)",
        "  op-xai add          → device OAuth in terminal",
        "  op-xai add --browser",
        "  op-ai --provider xai add",
        "",
        "Or via OpenCode:",
        "  opencode auth login → xai-multi → SuperGrok OAuth",
        "",
        "Re-login of an existing account refreshes its tokens.",
        "Then: xai-list / xai-switch / xai-label / xai-health / xai-limits",
      ].join("\n"),
  );
  return {
    ...shared,
    "xai-limits": buildXaiLimitsTool(view),
  };
}

/** Codex/ChatGPT agent/CLI tools (provider-scoped). Includes codex-import. */
export function buildCodexTools(
  manager: AccountManager,
): Record<string, ToolDefinition> {
  const view = manager.providerView("codex");
  const shared = buildSharedTools(
    view,
    "codex",
    "Codex",
    "No Codex accounts. Run `opencode auth login` and pick a Codex OAuth method to add one.",
    (n) =>
      [
        `Add Codex account (pool ${n}/${CODEX_MAX}):`,
        "",
        "Recommended:",
        "  op-codex tui          → press a  (device OAuth inside TUI)",
        "  op-codex add          → device OAuth in terminal",
        "  op-codex add --browser",
        "  op-ai --provider codex add",
        "",
        "JSON import (9router bulk format / Codex ~/.codex/auth.json):",
        "  op-codex import --file ./accounts.json",
        "  op-codex import --file ~/.codex/auth.json",
        "  Requires accessToken + refreshToken (access-only is rejected).",
        "",
        "Or via OpenCode:",
        "  opencode auth login → codex-multi → Codex OAuth",
        "",
        "Re-login / re-import of an existing account refreshes its tokens.",
        "Then: codex-list / codex-switch / codex-label / codex-health / codex-limits",
      ].join("\n"),
  );
  return {
    ...shared,
    "codex-import": buildCodexImportTool(view),
    "codex-limits": buildCodexLimitsTool(view),
  };
}

function buildKiroLimitsTool(view: ProviderAccountView): ToolDefinition {
  return tool({
    description:
      "Show Kiro usage limits (used/limit) for accounts in the pool. " +
      "Pass --probe to refresh from AWS getUsageLimits.",
    args: {
      probe: schema
        .boolean()
        .optional()
        .describe("when true, refresh usage via getUsageLimits"),
      index: schema.number().int().optional(),
      id: schema.string().optional(),
    },
    async execute(args) {
      const accounts = view.list();
      if (accounts.length === 0) {
        return "No Kiro accounts. Run `op-kiro add` (IDC device) or `op-kiro import`.";
      }
      const wantProbe = args.probe === true;
      const lines: string[] = ["Kiro usage limits:"];
      const targets =
        args.index !== undefined || args.id
          ? [resolveAccount(accounts, args)]
          : accounts;
      for (const a of targets) {
        if (a.provider !== "kiro") continue;
        let used = a.usedCount;
        let limit = a.limitCount;
        let email = a.email;
        if (wantProbe) {
          try {
            const tokens = await view.ensureFreshToken(a.accountId);
            const { fetchKiroUsageLimits } = await import(
              "../providers/kiro/request/usage.js"
            );
            const snap = await fetchKiroUsageLimits(a, tokens.accessToken);
            await view.recordKiroUsage(a.accountId, snap);
            used = snap.usedCount ?? used;
            limit = snap.limitCount ?? limit;
            email = snap.email ?? email;
          } catch (err) {
            lines.push(
              `  ${accountDisplayName(a)}  probe failed: ${(err as Error).message}`,
            );
            continue;
          }
        }
        const who = accountDisplayName(a);
        const usage =
          typeof used === "number" && typeof limit === "number" && limit > 0
            ? `${used}/${limit} (${Math.max(0, Math.round(100 - (used / limit) * 100))}% left)`
            : "unknown";
        lines.push(
          `  ${who}  auth=${a.authMethod ?? "—"}  region=${a.region ?? "—"}  usage=${usage}` +
            (email ? `  email=${email}` : ""),
        );
      }
      lines.push("", "Tip: kiro-limits --probe refreshes used/limit from AWS.");
      return lines.join("\n");
    },
  });
}

function buildKiroImportTool(view: ProviderAccountView): ToolDefinition {
  return tool({
    description:
      "Import Kiro accounts from JSON credentials, API key (ksk_*), " +
      "kiro-cli SQLite DB, or legacy plugin DB. Prefer --file over pasting secrets.",
    args: {
      file: schema.string().optional().describe("Path to JSON credentials file"),
      json: schema.string().optional().describe("Raw JSON credentials"),
      apiKey: schema
        .string()
        .optional()
        .describe("Kiro API key starting with ksk_"),
      region: schema.string().optional().describe("Region for api-key import"),
      kiroCli: schema
        .boolean()
        .optional()
        .describe("Import from default kiro-cli SQLite DB"),
      kiroCliPath: schema
        .string()
        .optional()
        .describe("Path to kiro-cli data.sqlite3"),
      legacyDb: schema
        .string()
        .optional()
        .describe("Path to legacy opencode-kiro-auth SQLite DB"),
      exportJson: schema
        .string()
        .optional()
        .describe("Kiro Account Manager export JSON text"),
      skipValidate: schema
        .boolean()
        .optional()
        .describe("Skip live refresh validation on JSON import"),
    },
    async execute(args) {
      const results: string[] = [];
      let ok = 0;
      let failed = 0;
      const upsert = async (
        candidate: AccountMetadata,
        label: string,
      ): Promise<void> => {
        try {
          const outcome = await view.upsertFromOAuth(candidate);
          ok++;
          results.push(
            `[ok] ${outcome} ${accountDisplayName(candidate)} (${label})`,
          );
        } catch (err) {
          failed++;
          results.push(`[fail] ${label}: ${(err as Error).message}`);
        }
      };

      const apiKey =
        typeof args.apiKey === "string" && args.apiKey.trim()
          ? args.apiKey.trim()
          : undefined;
      const file =
        typeof args.file === "string" && args.file.trim()
          ? args.file.trim()
          : undefined;
      const json =
        typeof args.json === "string" && args.json.trim()
          ? args.json.trim()
          : undefined;
      const kiroCliPath =
        typeof args.kiroCliPath === "string" && args.kiroCliPath.trim()
          ? args.kiroCliPath.trim()
          : undefined;
      const legacyDb =
        typeof args.legacyDb === "string" && args.legacyDb.trim()
          ? args.legacyDb.trim()
          : undefined;
      const exportJson =
        typeof args.exportJson === "string" && args.exportJson.trim()
          ? args.exportJson.trim()
          : undefined;
      const wantKiroCli = args.kiroCli === true || Boolean(kiroCliPath);

      if (
        !apiKey &&
        !file &&
        !json &&
        !exportJson &&
        !wantKiroCli &&
        !legacyDb
      ) {
        return [
          "kiro-import needs one of: file, json, exportJson, apiKey, kiroCli, legacyDb.",
          "",
          "Examples:",
          "  op-kiro import --file ./kiro-creds.json",
          "  op-kiro import --api-key ksk_… --region us-east-1",
          "  op-kiro import --export-json '{\"accounts\":[...]}'",
          "  op-kiro import --kiro-cli",
          "  op-kiro import --legacy-db ~/.config/opencode/kiro.db",
        ].join("\n");
      }

      if (apiKey) {
        const { buildApiKeyCandidate } = await import(
          "../providers/kiro/auth/api-key.js"
        );
        const region =
          typeof args.region === "string" ? args.region : undefined;
        await upsert(buildApiKeyCandidate(apiKey, region), "api-key");
      }

      if (file || json) {
        const { normalizeCredentialCandidates } = await import(
          "../providers/kiro/auth/credentials-import.js"
        );
        try {
          let payload: unknown;
          if (file) {
            const { readFile } = await import("node:fs/promises");
            payload = JSON.parse(await readFile(file, "utf8"));
          } else {
            payload = JSON.parse(json!);
          }
          const candidates = await normalizeCredentialCandidates(payload);
          for (const c of candidates) {
            await upsert(c, "json");
          }
        } catch (err) {
          failed++;
          results.push(`[fail] json: ${(err as Error).message}`);
        }
      }

      if (exportJson) {
        const { importAccountManagerExport } = await import(
          "../providers/kiro/auth/login.js"
        );
        try {
          const candidates = await importAccountManagerExport(exportJson, {
            validateRefresh: args.skipValidate !== true,
          });
          for (const c of candidates) await upsert(c, "export");
        } catch (err) {
          failed++;
          results.push(`[fail] export: ${(err as Error).message}`);
        }
      }

      if (wantKiroCli) {
        const { readKiroCliCandidates, defaultKiroCliDbPath } = await import(
          "../providers/kiro/auth/kiro-cli-import.js"
        );
        try {
          const { candidates, warnings } = await readKiroCliCandidates(
            kiroCliPath ?? defaultKiroCliDbPath(),
          );
          for (const w of warnings) results.push(`[warn] kiro-cli: ${w}`);
          for (const c of candidates) await upsert(c, "kiro-cli");
        } catch (err) {
          failed++;
          results.push(`[fail] kiro-cli: ${(err as Error).message}`);
        }
      }

      if (legacyDb) {
        const { readLegacyKiroDbCandidates } = await import(
          "../providers/kiro/auth/legacy-db-import.js"
        );
        try {
          const { candidates, warnings } =
            await readLegacyKiroDbCandidates(legacyDb);
          for (const w of warnings) results.push(`[warn] legacy-db: ${w}`);
          for (const c of candidates) await upsert(c, "legacy-db");
        } catch (err) {
          failed++;
          results.push(`[fail] legacy-db: ${(err as Error).message}`);
        }
      }

      results.push("", `Import done · ${ok} ok · ${failed} failed`);
      return results.join("\n");
    },
  });
}

export function buildKiroTools(
  manager: AccountManager,
): Record<string, ToolDefinition> {
  const view = manager.providerView("kiro");
  const shared = buildSharedTools(
    view,
    "kiro",
    "Kiro",
    "No Kiro accounts. Run `op-kiro add` (IDC device) or `op-kiro import`.",
    (n) =>
      [
        `Add Kiro account (pool ${n}/${KIRO_MAX}):`,
        "",
        "Recommended:",
        "  op-kiro tui            → press a  (IDC device OAuth inside TUI)",
        "  op-kiro add            → IDC device OAuth in terminal",
        "  op-kiro import --file ./creds.json",
        "  op-kiro import --api-key ksk_…",
        "  op-kiro import --kiro-cli",
        "",
        "Or via OpenCode:",
        "  opencode auth login → kiro-multi",
        "",
        "Then: kiro-list / kiro-switch / kiro-label / kiro-health / kiro-limits",
      ].join("\n"),
  );
  return {
    ...shared,
    "kiro-import": buildKiroImportTool(view),
    "kiro-limits": buildKiroLimitsTool(view),
  };
}

export function buildTools(manager: AccountManager): {
  xai: Record<string, ToolDefinition>;
  codex: Record<string, ToolDefinition>;
  kiro: Record<string, ToolDefinition>;
  all: Record<string, ToolDefinition>;
} {
  const xai = buildXaiTools(manager);
  const codex = buildCodexTools(manager);
  const kiro = buildKiroTools(manager);
  return { xai, codex, kiro, all: { ...xai, ...codex, ...kiro } };
}
