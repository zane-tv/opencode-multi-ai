import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { logger } from "./core/logger.js";
import { defaultStoragePath } from "./core/paths.js";
import {
  AccountStorageSchema,
  CodexAccountMetadataSchema,
  LegacyCodexAccountStorageSchema,
  LegacyXaiAccountStorageSchema,
  XaiAccountMetadataSchema,
  type AccountMetadata,
  type AccountStorage,
  type CodexAccountMetadata,
  type LegacyCodexAccountStorage,
  type LegacyXaiAccountStorage,
  type XaiAccountMetadata,
} from "./core/schemas.js";
import {
  loadAccounts,
  withCrossProcessTransaction,
} from "./core/storage.js";

/**
 * One-shot legacy → unified v2 migration.
 *
 * Reads multi-xai-accounts.json (v1) and/or multi-codex-accounts.json (v1)
 * into multi-ai-accounts.json (v2). Idempotent: never clobbers existing v2
 * accounts for a provider that is already present. Legacy files are preserved
 * as .bak COPIES (original left in place; existing .bak is never overwritten).
 *
 * Write order: atomic v2 write under the unified-file lock, THEN best-effort
 * .bak copies. Mode 0600 on every new file.
 *
 * Truth table:
 * - neither legacy → no-op
 * - only one legacy → migrate that one
 * - both legacy, no v2 → merge into v2
 * - one malformed + one valid → migrate valid, warn
 * - v2 already has a provider → skip that provider (never clobber)
 * - v2 missing a provider + legacy present → import missing provider only
 * - run twice → second no-op
 * - write v2 atomically BEFORE touching legacy bak
 */

export type MigrateResult = {
  ran: boolean;
  reason: string;
  xaiImported: number;
  codexImported: number;
  warnings: string[];
};

/** Concurrent single-flight per unified path (two plugin entries / loads). */
const migrateInFlight = new Map<string, Promise<MigrateResult>>();

export function legacyXaiPath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-xai-accounts.json",
  );
}

export function legacyCodexPath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-codex-accounts.json",
  );
}

export function unifiedPath(override?: string): string {
  return override ?? defaultStoragePath();
}

function emptyResult(
  reason: string,
  warnings: string[] = [],
): MigrateResult {
  return {
    ran: false,
    reason,
    xaiImported: 0,
    codexImported: 0,
    warnings,
  };
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(
  file: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string } | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { ok: false, error: `read failed: ${(err as Error).message}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
}

type LegacyRead<T> =
  | { kind: "missing" }
  | { kind: "malformed"; error: string }
  | { kind: "ok"; data: T };

async function readLegacyXai(
  file: string,
): Promise<LegacyRead<LegacyXaiAccountStorage>> {
  const raw = await readJsonFile(file);
  if (raw === null) return { kind: "missing" };
  if (!raw.ok) return { kind: "malformed", error: raw.error };
  const parsed = LegacyXaiAccountStorageSchema.safeParse(raw.value);
  if (!parsed.success) {
    return {
      kind: "malformed",
      error: `schema validation failed: ${parsed.error.message}`,
    };
  }
  return { kind: "ok", data: parsed.data };
}

async function readLegacyCodex(
  file: string,
): Promise<LegacyRead<LegacyCodexAccountStorage>> {
  const raw = await readJsonFile(file);
  if (raw === null) return { kind: "missing" };
  if (!raw.ok) return { kind: "malformed", error: raw.error };
  const parsed = LegacyCodexAccountStorageSchema.safeParse(raw.value);
  if (!parsed.success) {
    return {
      kind: "malformed",
      error: `schema validation failed: ${parsed.error.message}`,
    };
  }
  return { kind: "ok", data: parsed.data };
}

function convertXaiAccount(
  legacy: LegacyXaiAccountStorage["accounts"][number],
): XaiAccountMetadata {
  return XaiAccountMetadataSchema.parse({
    provider: "xai" as const,
    ...legacy,
  });
}

function convertCodexAccount(
  legacy: LegacyCodexAccountStorage["accounts"][number],
): CodexAccountMetadata {
  return CodexAccountMetadataSchema.parse({
    provider: "codex" as const,
    ...legacy,
  });
}

function stickyFromActiveIndex(
  accounts: ReadonlyArray<{ accountId: string }>,
  activeIndex: number,
): string | undefined {
  if (!Number.isInteger(activeIndex)) return undefined;
  const account = accounts[activeIndex];
  return account?.accountId;
}

function providerPresent(
  storage: AccountStorage,
  provider: "xai" | "codex",
): boolean {
  return storage.accounts.some((account) => account.provider === provider);
}

async function copyLegacyBak(
  legacyFile: string,
  warnings: string[],
): Promise<void> {
  const bak = `${legacyFile}.bak`;
  if (await pathExists(bak)) {
    logger.debug(`migrate: leaving existing bak untouched: ${bak}`);
    return;
  }
  try {
    await fs.copyFile(legacyFile, bak);
    await fs.chmod(bak, 0o600);
    logger.debug(`migrate: wrote bak ${bak}`);
  } catch (err) {
    const msg = `failed to write bak for ${legacyFile}: ${(err as Error).message}`;
    warnings.push(msg);
    logger.warn(msg);
  }
}

type ImportPlan = {
  xai: LegacyXaiAccountStorage | null;
  codex: LegacyCodexAccountStorage | null;
};

function applyImport(
  storage: AccountStorage,
  plan: ImportPlan,
): { xaiImported: number; codexImported: number } {
  let xaiImported = 0;
  let codexImported = 0;

  if (
    plan.xai &&
    plan.xai.accounts.length > 0 &&
    !providerPresent(storage, "xai")
  ) {
    const converted: AccountMetadata[] = plan.xai.accounts.map(convertXaiAccount);
    storage.accounts.push(...converted);
    xaiImported = converted.length;
    const sticky = stickyFromActiveIndex(plan.xai.accounts, plan.xai.activeIndex);
    if (sticky !== undefined) storage.sticky.xai = sticky;
  }

  if (
    plan.codex &&
    plan.codex.accounts.length > 0 &&
    !providerPresent(storage, "codex")
  ) {
    const converted: AccountMetadata[] = plan.codex.accounts.map(
      convertCodexAccount,
    );
    storage.accounts.push(...converted);
    codexImported = converted.length;
    const sticky = stickyFromActiveIndex(
      plan.codex.accounts,
      plan.codex.activeIndex,
    );
    if (sticky !== undefined) storage.sticky.codex = sticky;
  }

  AccountStorageSchema.parse(storage);
  return { xaiImported, codexImported };
}

/**
 * Resolve legacy file paths. When the unified target is a non-default path
 * (tests / CLI overrides) and the caller did not pass explicit legacy paths,
 * skip real ~/.config discovery so hermetic stores stay hermetic.
 */
function resolveLegacyPaths(opts?: {
  unifiedPath?: string;
  xaiPath?: string;
  codexPath?: string;
}): { xai: string; codex: string } | null {
  const target = unifiedPath(opts?.unifiedPath);
  const hasExplicitLegacy =
    opts?.xaiPath !== undefined || opts?.codexPath !== undefined;
  if (hasExplicitLegacy) {
    return {
      xai: opts?.xaiPath ?? legacyXaiPath(),
      codex: opts?.codexPath ?? legacyCodexPath(),
    };
  }
  if (target !== defaultStoragePath()) {
    return null;
  }
  return { xai: legacyXaiPath(), codex: legacyCodexPath() };
}

async function doMigrate(opts?: {
  unifiedPath?: string;
  xaiPath?: string;
  codexPath?: string;
}): Promise<MigrateResult> {
  const target = unifiedPath(opts?.unifiedPath);
  const legacy = resolveLegacyPaths(opts);
  if (!legacy) {
    return emptyResult("no-legacy-custom-path");
  }
  const xaiFile = legacy.xai;
  const codexFile = legacy.codex;
  const warnings: string[] = [];

  const [xaiRead, codexRead] = await Promise.all([
    readLegacyXai(xaiFile),
    readLegacyCodex(codexFile),
  ]);

  if (xaiRead.kind === "malformed") {
    const msg = `legacy xai store malformed (${xaiFile}): ${xaiRead.error}`;
    warnings.push(msg);
    logger.warn(msg);
  }
  if (codexRead.kind === "malformed") {
    const msg = `legacy codex store malformed (${codexFile}): ${codexRead.error}`;
    warnings.push(msg);
    logger.warn(msg);
  }

  if (xaiRead.kind === "missing" && codexRead.kind === "missing") {
    return emptyResult("no-legacy", warnings);
  }

  const xaiData = xaiRead.kind === "ok" ? xaiRead.data : null;
  const codexData = codexRead.kind === "ok" ? codexRead.data : null;

  if (!xaiData && !codexData) {
    return emptyResult("legacy-malformed", warnings);
  }

  if (await pathExists(target)) {
    const existing = await loadAccounts(target);
    const needXai =
      Boolean(xaiData && xaiData.accounts.length > 0) &&
      !providerPresent(existing, "xai");
    const needCodex =
      Boolean(codexData && codexData.accounts.length > 0) &&
      !providerPresent(existing, "codex");
    if (!needXai && !needCodex) {
      return emptyResult("v2-exists", warnings);
    }
  }

  const plan: ImportPlan = { xai: xaiData, codex: codexData };

  type TxResult = {
    xaiImported: number;
    codexImported: number;
    importedXaiSlice: boolean;
    importedCodexSlice: boolean;
  };

  const tx = await withCrossProcessTransaction<TxResult>((storage) => {
    const beforeXai = providerPresent(storage, "xai");
    const beforeCodex = providerPresent(storage, "codex");
    const counts = applyImport(storage, plan);
    return {
      xaiImported: counts.xaiImported,
      codexImported: counts.codexImported,
      importedXaiSlice:
        Boolean(plan.xai && plan.xai.accounts.length > 0) && !beforeXai,
      importedCodexSlice:
        Boolean(plan.codex && plan.codex.accounts.length > 0) && !beforeCodex,
    };
  }, target);

  const ran = tx.importedXaiSlice || tx.importedCodexSlice;
  if (!ran) {
    return {
      ran: false,
      reason: "v2-exists",
      xaiImported: 0,
      codexImported: 0,
      warnings,
    };
  }

  if (tx.importedXaiSlice && xaiData) {
    await copyLegacyBak(xaiFile, warnings);
  }
  if (tx.importedCodexSlice && codexData) {
    await copyLegacyBak(codexFile, warnings);
  }

  logger.debug(
    `migrate: wrote v2 at ${target} (xai=${tx.xaiImported}, codex=${tx.codexImported})`,
  );

  return {
    ran: true,
    reason: "migrated",
    xaiImported: tx.xaiImported,
    codexImported: tx.codexImported,
    warnings,
  };
}

/**
 * Run under the unified-file lock when writing.
 * Idempotent. Non-destructive: legacy files become .bak copies (original left
 * in place; existing .bak is never overwritten).
 */
export async function migrateAccountsIfNeeded(opts?: {
  unifiedPath?: string;
  xaiPath?: string;
  codexPath?: string;
}): Promise<MigrateResult> {
  const key = unifiedPath(opts?.unifiedPath);
  const existing = migrateInFlight.get(key);
  if (existing) return existing;

  const pending = doMigrate(opts).finally(() => {
    if (migrateInFlight.get(key) === pending) {
      migrateInFlight.delete(key);
    }
  });
  migrateInFlight.set(key, pending);
  return pending;
}

/** Test-only: clear the in-flight map between cases if needed. */
export function __resetMigrateInFlightForTest(): void {
  migrateInFlight.clear();
}
