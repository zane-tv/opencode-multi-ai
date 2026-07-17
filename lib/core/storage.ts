import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { AUTH_FETCH_TIMEOUT_MS, defaultStoragePath } from "./paths.js";
import { logger } from "./logger.js";
import {
  AccountStorageSchema,
  AccountStorageV2Schema,
  type AccountStorage,
  type AccountStorageV2,
} from "./schemas.js";

/**
 * Unified multi-provider account pool persistence.
 *
 * - Atomic writes (tmp file + rename) so a crash never leaves a truncated file.
 * - chmod 600 so refresh tokens are not world-readable.
 * - Never touches OpenCode's own `auth.json`.
 * - Ported from opencode-multi-codex hardened storage (stale-lock reclaim with
 *   `.break` guard + identity fence). Schema is v3 (`sticky` map, not
 *   `activeIndex`).
 */

function emptyStorage(): AccountStorage {
  return { version: 3, accounts: [], sticky: {} };
}

export function migrateV2ToV3(v2: AccountStorageV2): AccountStorage {
  return {
    version: 3,
    accounts: v2.accounts,
    sticky: { ...v2.sticky },
  };
}

function resolvePath(p?: string): string {
  return p ?? defaultStoragePath();
}

/** Number of timestamped backups to keep; older ones are pruned. */
const MAX_BACKUPS = 10;

type AccountStoreDocument = {
  readonly json: unknown;
};

async function readAccountStore(
  file: string,
): Promise<AccountStoreDocument | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  try {
    const json: unknown = JSON.parse(text);
    return { json };
  } catch (err) {
    throw new Error(
      `account store at ${file} is not valid JSON: ${(err as Error).message}`,
    );
  }
}

function validationError(file: string, message: string): Error {
  return new Error(`account store at ${file} failed validation: ${message}`);
}

async function backupV2AccountStore(file: string): Promise<void> {
  const backup = `${file}.v2.bak`;
  await fs.copyFile(file, backup);
  await fs.chmod(backup, 0o600);
  logger.debug(`backed up v2 account store to ${backup}`);
}

async function loadAccountsUnderLock(file: string): Promise<AccountStorage> {
  const document = await readAccountStore(file);
  if (!document) return emptyStorage();

  const current = AccountStorageSchema.safeParse(document.json);
  if (current.success) return current.data;

  const previous = AccountStorageV2Schema.safeParse(document.json);
  if (!previous.success) {
    throw validationError(file, current.error.message);
  }

  const migrated = AccountStorageSchema.parse(migrateV2ToV3(previous.data));
  await backupV2AccountStore(file);
  await saveAccounts(migrated, file);
  return migrated;
}

export async function upgradeAccountsStorageIfNeeded(
  p?: string,
): Promise<void> {
  const file = resolvePath(p);
  const document = await readAccountStore(file);
  if (!document) return;
  if (!AccountStorageV2Schema.safeParse(document.json).success) return;

  await withAccountStoreLock(file, () => loadAccountsUnderLock(file));
}

/**
 * Load and validate the account pool. Returns an empty pool if the file does
 * not exist. Throws a clear error if the file is present but invalid.
 */
export async function loadAccounts(p?: string): Promise<AccountStorage> {
  const file = resolvePath(p);
  const document = await readAccountStore(file);
  if (!document) {
    logger.debug(`no account store at ${file}; returning empty pool`);
    return emptyStorage();
  }

  const current = AccountStorageSchema.safeParse(document.json);
  if (current.success) return current.data;

  if (AccountStorageV2Schema.safeParse(document.json).success) {
    return withAccountStoreLock(file, () => loadAccountsUnderLock(file));
  }

  throw validationError(file, current.error.message);
}

/**
 * Best-effort fsync of a directory so a rename is durable. Some platforms /
 * filesystems reject directory fsync (EINVAL/EPERM) — those are ignored.
 */
async function fsyncDir(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") {
      logger.debug(`dir fsync of ${dir} failed (ignored): ${(err as Error).message}`);
    }
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Atomically persist the account pool. Writes to a unique per-writer tmp file,
 * fsyncs it, then renames over the target and chmods the result to 0600. The
 * parent directory is fsynced (best-effort) so the rename is durable. Creates
 * the parent directory if needed.
 */
export async function saveAccounts(
  storage: AccountStorage,
  p?: string,
): Promise<void> {
  // Validate before writing so we never persist a malformed pool.
  const data = AccountStorageSchema.parse(storage);
  const file = resolvePath(p);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });

  // Unique tmp name so concurrent writers (e.g. another process) do not collide
  // on a shared `${file}.tmp`.
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  const body = `${JSON.stringify(data, null, 2)}\n`;

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, "w", 0o600);
    await handle.writeFile(body);
    // fsync the data before rename so a crash cannot leave a rotated refresh
    // token only in the page cache.
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
  }

  await fs.rename(tmp, file);
  // Ensure perms even if the file pre-existed with looser perms.
  await fs.chmod(file, 0o600);
  // Best-effort: make the rename itself durable.
  await fsyncDir(dir);
  logger.debug(`saved ${data.accounts.length} account(s) to ${file}`);
}

/**
 * Prune old `${base}.bak-*` backups, keeping only the newest MAX_BACKUPS.
 */
async function pruneBackups(file: string): Promise<void> {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const prefix = `${base}.bak-`;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  const backups = entries.filter((e) => e.startsWith(prefix)).sort();
  const excess = backups.length - MAX_BACKUPS;
  if (excess <= 0) return;
  // Sorted ascending; the timestamp-prefixed suffix means oldest sort first.
  for (const old of backups.slice(0, excess)) {
    await fs.rm(path.join(dir, old)).catch(() => {});
  }
}

/**
 * Copy the current store to a timestamped `${path}.bak-<ts>-<rand>` backup.
 * Returns the backup path, or null if there was nothing to back up. Keeps only
 * the newest MAX_BACKUPS backups. The random suffix avoids ms collisions when
 * backups are taken in quick succession.
 */
export async function backupAccounts(p?: string): Promise<string | null> {
  const file = resolvePath(p);
  const stamp = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const backup = `${file}.bak-${stamp}`;
  try {
    await fs.copyFile(file, backup);
    await fs.chmod(backup, 0o600);
    logger.debug(`backed up account store to ${backup}`);
    await pruneBackups(file);
    return backup;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Serialize storage mutations in-process to avoid concurrent write races.
 * A simple promise chain keyed by resolved path is sufficient here.
 */
const txChains = new Map<string, Promise<unknown>>();

/**
 * Chain `run` onto the per-path in-process transaction chain so that two
 * transactions in the SAME process never interleave. Returns the run's result.
 * Both in-process (`withStorageTransaction`) and cross-process
 * (`withCrossProcessTransaction`) transactions share this chain.
 *
 * INVARIANT: a transaction body must NEVER start another transaction on the
 * same path — nesting would enqueue the inner tx behind the outer one that is
 * still awaiting it, deadlocking the chain (and, for the cross-process wrapper,
 * self-blocking on the file lock it already holds). Callbacks that need to
 * persist must call `saveAccounts` directly (as the cross-process wrapper and
 * the manager's refresh persist callback both do), not re-enter a transaction.
 */
function chainOnPath<T>(file: string, run: () => Promise<T>): Promise<T> {
  const prev = txChains.get(file) ?? Promise.resolve();
  // Chain regardless of whether the previous tx succeeded.
  const next = prev.then(run, run);
  txChains.set(
    file,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * Read → mutate → save under a per-path serialized chain. The callback
 * receives the (mutable) loaded storage and may mutate it in place and/or
 * return a replacement storage object. Returns whatever the callback returns.
 */
export async function withStorageTransaction<T>(
  fn: (storage: AccountStorage) => T | Promise<T>,
  p?: string,
): Promise<T> {
  const file = resolvePath(p);
  return chainOnPath(file, async () => {
    const storage = await loadAccounts(file);
    const result = await fn(storage);
    await saveAccounts(storage, file);
    return result;
  });
}

/**
 * Cross-process advisory lock (the B-2 fix).
 *
 * `withStorageTransaction` serializes writers WITHIN one process. But two
 * OpenCode processes share the same on-disk pool file: if both "load → refresh
 * → save", they each rotate the same refresh token and all but the last write
 * bricks the account. This wrapper takes an on-disk advisory lock so that the
 * whole load-modify-save critical section is exclusive ACROSS processes, and it
 * re-reads the latest tokens from disk under the lock before writing — so it can
 * never clobber a refresh token another process just rotated.
 */

/** Advisory lockfile suffix. */
const LOCK_SUFFIX = ".lock";

/**
 * A lockfile older than this is considered stale and may be reclaimed.
 *
 * MUST be greater than AUTH_FETCH_TIMEOUT_MS: a legitimate refresh holds the
 * lock across a ~30s network grant. If a shorter staleness window let another
 * process break a live lock mid-refresh, both processes would then refresh the
 * SAME refresh token — the exact double-rotation brick this lock exists to
 * prevent. 60s > 30s + margin.
 */
export const STALE_LOCK_MS = 60_000;

/**
 * Upper bound on how long we wait to acquire the lock before throwing. The
 * caller surfaces a failure as a 503; we never proceed without the lock on a
 * refresh path.
 */
const ACQUIRE_TIMEOUT_MS = 90_000;

/**
 * Resolve the acquisition timeout at call time. Defaults to ACQUIRE_TIMEOUT_MS;
 * an operator (or a test) may lower it via MULTI_AI_LOCK_TIMEOUT_MS, with
 * fallbacks to the legacy MULTI_XAI_ / MULTI_CODEX_ prefixes. Read per call
 * (not at module load) so the override applies without re-importing.
 */
function acquireTimeoutMs(): number {
  const raw =
    process.env.MULTI_AI_LOCK_TIMEOUT_MS ??
    process.env.MULTI_XAI_LOCK_TIMEOUT_MS ??
    process.env.MULTI_CODEX_LOCK_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : ACQUIRE_TIMEOUT_MS;
}

/** Poll backoff bounds while waiting for the lock. */
const ACQUIRE_POLL_MIN_MS = 25;
const ACQUIRE_POLL_MAX_MS = 250;

// Guard the STALE_LOCK_MS invariant at module load so a future edit that drops
// it below the auth fetch timeout fails loudly rather than silently reintroducing
// the double-rotation brick.
if (STALE_LOCK_MS <= AUTH_FETCH_TIMEOUT_MS) {
  throw new Error(
    `STALE_LOCK_MS (${STALE_LOCK_MS}) must exceed AUTH_FETCH_TIMEOUT_MS (${AUTH_FETCH_TIMEOUT_MS}) or a live refresh lock could be broken mid-grant`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Shape written into the lockfile for diagnostics + ownership fencing. */
interface LockRecord {
  pid: number;
  /** Epoch ms when the lock was acquired (used for reclaim double-check). */
  at: number;
  /** Random token identifying THIS acquisition; the fencing owner id. */
  owner: string;
}

/**
 * Try once to atomically create the lockfile, writing `owner` into it. Returns
 * true on success, false if it already exists (EEXIST). Other errors propagate.
 *
 * `fs.open(..., "wx")` is atomic create-or-fail on local filesystems (where the
 * store lives: ~/.config/opencode). It is NOT reliably atomic on classic NFSv2,
 * but that is not a supported location for the store.
 */
async function tryCreateLock(
  lockPath: string,
  owner: string,
): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    // "wx" fails with EEXIST if the file already exists — atomic acquire.
    handle = await fs.open(lockPath, "wx", 0o600);
    const record: LockRecord = { pid: process.pid, at: Date.now(), owner };
    await handle.writeFile(JSON.stringify(record));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function parseLockRecord(text: string): LockRecord | null {
  try {
    const parsed = JSON.parse(text) as Partial<LockRecord>;
    if (typeof parsed.owner !== "string") return null;
    return {
      pid: typeof parsed.pid === "number" ? parsed.pid : -1,
      at: typeof parsed.at === "number" ? parsed.at : 0,
      owner: parsed.owner,
    };
  } catch {
    return null;
  }
}

/** Read + parse the lockfile record, or null if absent/unparseable. */
async function readLockRecord(lockPath: string): Promise<LockRecord | null> {
  try {
    return parseLockRecord(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function readLockRecordSync(lockPath: string): LockRecord | null {
  try {
    return parseLockRecord(fsSync.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

interface LockIdentity {
  ino: number;
  owner: string;
  pid: number;
  at: number;
}

interface ObservedLock {
  identity: LockIdentity;
  mtimeAge: number;
}

function lockIdentity(
  ino: number,
  record: LockRecord | null,
): LockIdentity | null {
  if (!record) return null;
  return { ino, owner: record.owner, pid: record.pid, at: record.at };
}

function sameLockIdentity(
  actual: LockIdentity | null,
  expected: LockIdentity,
): boolean {
  return (
    actual?.ino === expected.ino &&
    actual.owner === expected.owner &&
    actual.pid === expected.pid &&
    actual.at === expected.at
  );
}

type ReclaimTestStage =
  | "after-stale-observed"
  | "after-guard-acquired"
  | "guard-held"
  | "primary-not-stale"
  | "before-delete";
type ReclaimTestHook = (stage: ReclaimTestStage) => void | Promise<void>;
let reclaimTestHook: ReclaimTestHook | undefined;

export function __setReclaimTestHookForTest(
  hook: ReclaimTestHook | undefined,
): void {
  reclaimTestHook = hook;
}

function observeStaleLock(lockPath: string): ObservedLock | null {
  let stat: fsSync.Stats;
  try {
    stat = fsSync.statSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  const now = Date.now();
  const mtimeAge = now - stat.mtimeMs;
  if (mtimeAge <= STALE_LOCK_MS) return null;

  const record = readLockRecordSync(lockPath);
  if (!record || now - record.at <= STALE_LOCK_MS) return null;

  const identity = lockIdentity(stat.ino, record);
  return identity ? { identity, mtimeAge } : null;
}

function acquireBreakGuard(guardPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | undefined;
    try {
      descriptor = fsSync.openSync(guardPath, "wx", 0o600);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (attempt === 1) return false;
    } finally {
      if (descriptor !== undefined) fsSync.closeSync(descriptor);
    }

    let guardStat: fsSync.Stats;
    try {
      guardStat = fsSync.statSync(guardPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    if (Date.now() - guardStat.mtimeMs <= STALE_LOCK_MS) return false;

    // The reclaimer that created this guard did not finish within the stale
    // window. Remove the orphan and make exactly one more atomic create attempt.
    fsSync.rmSync(guardPath, { force: true });
  }
  return false;
}

/**
 * If the lockfile is stale, serialize reclamation through a secondary
 * `${lockPath}.break` lock, revalidate the primary lock under that guard, and
 * directly delete it only if an immediate identity recheck still matches.
 * The primary lock is never renamed or moved. Returns true if the stale lock
 * was reclaimed.
 *
 * Staleness requires BOTH signals to agree, to defend against clock/mtime skew:
 *   - the filesystem mtime is older than STALE_LOCK_MS, AND
 *   - the recorded `at` timestamp inside the lockfile is older than
 *     STALE_LOCK_MS.
 * Only when both say the lock is old do we attempt to claim it. A lockfile we
 * cannot parse is left alone because its recorded age cannot be established.
 */
async function reclaimIfStale(lockPath: string): Promise<boolean> {
  if (!observeStaleLock(lockPath)) {
    if (reclaimTestHook) await reclaimTestHook("primary-not-stale");
    return false;
  }
  if (reclaimTestHook) await reclaimTestHook("after-stale-observed");

  const guardPath = `${lockPath}.break`;
  if (!acquireBreakGuard(guardPath)) {
    if (reclaimTestHook) await reclaimTestHook("guard-held");
    return false;
  }

  try {
    if (reclaimTestHook) await reclaimTestHook("after-guard-acquired");

    // Re-read both stale signals from scratch while all other reclaimers are
    // excluded. A fresh replacement at the primary path is never touched.
    const observed = observeStaleLock(lockPath);
    if (!observed) {
      if (reclaimTestHook) await reclaimTestHook("primary-not-stale");
      return false;
    }

    let currentStat: fsSync.Stats;
    try {
      currentStat = fsSync.statSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    const currentIdentity = lockIdentity(
      currentStat.ino,
      readLockRecordSync(lockPath),
    );
    if (!sameLockIdentity(currentIdentity, observed.identity)) return false;

    if (reclaimTestHook) await reclaimTestHook("before-delete");
    fsSync.rmSync(lockPath, { force: true });
    logger.debug(
      `reclaimed stale lock ${lockPath} (mtime age ${Math.round(observed.mtimeAge)}ms > ${STALE_LOCK_MS}ms)`,
    );
    return true;
  } finally {
    fsSync.rmSync(guardPath, { force: true });
  }
}

/**
 * Acquire the on-disk advisory lock, or throw if it cannot within the bound.
 * Returns the owner token this acquisition wrote; the caller MUST pass it to
 * releaseLock so a reclaimed-then-reacquired lock is never deleted by us.
 */
async function acquireLock(lockPath: string): Promise<string> {
  const owner = crypto.randomBytes(16).toString("hex");
  const timeout = acquireTimeoutMs();
  const deadline = Date.now() + timeout;
  let backoff = ACQUIRE_POLL_MIN_MS;
  for (;;) {
    if (await tryCreateLock(lockPath, owner)) return owner;
    // Held by someone else — reclaim if the holder died and left it stale.
    if (await reclaimIfStale(lockPath)) {
      // Retry immediately after a reclaim.
      if (await tryCreateLock(lockPath, owner)) return owner;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `could not acquire account store lock ${lockPath} within ${timeout}ms`,
      );
    }
    await delay(backoff);
    backoff = Math.min(backoff * 2, ACQUIRE_POLL_MAX_MS);
  }
}

/**
 * Release the on-disk advisory lock, but ONLY if we still own it (the lockfile's
 * owner token matches the one this acquisition wrote). If it does not match, a
 * long stall let another holder reclaim the lock and re-acquire it; deleting it
 * now would free a live lock held by someone else (a cascade brick), so we log
 * and leave it alone.
 */
async function releaseLock(lockPath: string, owner: string): Promise<void> {
  const record = await readLockRecord(lockPath);
  if (!record) {
    // Already gone (reclaimed + not yet re-taken, or vanished) — nothing to do.
    return;
  }
  if (record.owner !== owner) {
    logger.warn(
      `not releasing lock ${lockPath}: owner mismatch (a concurrent holder reclaimed it); leaving it for the current owner`,
    );
    return;
  }
  await fs.rm(lockPath, { force: true }).catch((err) => {
    logger.warn(`failed to release lock ${lockPath}: ${(err as Error).message}`);
  });
}

/**
 * Read → mutate → save under BOTH the in-process chain AND a cross-process
 * advisory lock. The callback receives storage freshly loaded from disk UNDER
 * the lock, may mutate it in place and/or return a replacement, and its return
 * value is passed through.
 *
 * Ordering: chain in-process → acquire lock → loadAccounts (fresh, under lock)
 * → await fn → saveAccounts → release lock (in finally). Because storage is
 * re-read under the lock right before the save, this can never clobber a
 * refresh token another process rotated while we were waiting for the lock.
 */
export async function withCrossProcessTransaction<T>(
  fn: (storage: AccountStorage) => T | Promise<T>,
  p?: string,
): Promise<T> {
  const file = resolvePath(p);
  return withAccountStoreLock(file, async () => {
    const storage = await loadAccountsUnderLock(file);
    const result = await fn(storage);
    await saveAccounts(storage, file);
    return result;
  });
}

async function withAccountStoreLock<T>(
  file: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = `${file}${LOCK_SUFFIX}`;
  // Compose with the in-process chain so a single process serializes its own
  // transactions and never contends with itself for the file lock.
  return chainOnPath(file, async () => {
    const owner = await acquireLock(lockPath);
    try {
      return await fn();
    } finally {
      await releaseLock(lockPath, owner);
    }
  });
}
