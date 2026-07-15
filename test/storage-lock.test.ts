import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  STALE_LOCK_MS,
  loadAccounts,
  saveAccounts,
  withCrossProcessTransaction,
} from "../lib/core/storage.js";
import type { AccountStorage, CodexAccountMetadata } from "../lib/core/schemas.js";

function tmpStorePath(): string {
  return path.join(
    os.tmpdir(),
    `multi-ai-lock-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
}

function seedStorage(): AccountStorage {
  return {
    version: 2,
    accounts: [],
    sticky: {},
  };
}

function makeCodexAccount(
  overrides: Partial<CodexAccountMetadata> = {},
): CodexAccountMetadata {
  return {
    provider: "codex",
    accountId: "acct-1",
    tags: [],
    refreshToken: "rt-original",
    enabled: true,
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "unknown",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    ...overrides,
  };
}

function lockOwner(text: string): string {
  const parsed: unknown = JSON.parse(text);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("owner" in parsed) ||
    typeof parsed.owner !== "string"
  ) {
    throw new Error("lock record has no owner");
  }
  return parsed.owner;
}

interface TestSignal {
  readonly promise: Promise<void>;
  resolve(): void;
}

function testSignal(): TestSignal {
  let resolve = (): void => {
    throw new Error("test signal was not initialized");
  };
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function backdateBeyondStaleWindow(filePath: string): Promise<void> {
  const old = new Date(Date.now() - (STALE_LOCK_MS + 5_000));
  await fs.utimes(filePath, old, old);
}

async function writeStaleLock(lockPath: string): Promise<void> {
  await fs.writeFile(
    lockPath,
    JSON.stringify({ pid: 999999, at: 0, owner: "stale-owner" }),
  );
  await backdateBeyondStaleWindow(lockPath);
}

let storePath: string;

beforeEach(async () => {
  storePath = tmpStorePath();
  await saveAccounts(seedStorage(), storePath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.MULTI_AI_LOCK_TIMEOUT_MS;
  delete process.env.MULTI_XAI_LOCK_TIMEOUT_MS;
  delete process.env.MULTI_CODEX_LOCK_TIMEOUT_MS;
  // Clean the store, its lock, and any tmp/backup siblings.
  const dir = path.dirname(storePath);
  const base = path.basename(storePath);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.startsWith(base))
      .map((e) => fs.rm(path.join(dir, e), { force: true }).catch(() => {})),
  );
});

describe("withCrossProcessTransaction", () => {
  it("serializes overlapping transactions (mutual exclusion, no interleave)", async () => {
    const events: string[] = [];

    const tx = (label: string) =>
      withCrossProcessTransaction(async (storage) => {
        events.push(`${label}:enter`);
        // Yield so a naive implementation would interleave here.
        await new Promise((r) => setTimeout(r, 20));
        events.push(`${label}:exit`);
        return storage;
      }, storePath);

    await Promise.all([tx("A"), tx("B")]);

    // Whichever ran first must fully finish before the other enters.
    const first = events[0].split(":")[0];
    const second = first === "A" ? "B" : "A";
    expect(events).toEqual([
      `${first}:enter`,
      `${first}:exit`,
      `${second}:enter`,
      `${second}:exit`,
    ]);
  });

  it("re-reads latest state from disk under the lock before writing", async () => {
    // Simulate another writer rotating a value on disk while our tx callback
    // has NOT yet run. Because the tx loads fresh under the lock, it sees it.
    await withCrossProcessTransaction((storage) => {
      storage.accounts.push(makeCodexAccount());
    }, storePath);

    const seen: string[] = [];
    await withCrossProcessTransaction((storage) => {
      seen.push(storage.accounts[0].refreshToken);
    }, storePath);

    expect(seen).toEqual(["rt-original"]);
  });

  it("reclaims a stale lock older than STALE_LOCK_MS", async () => {
    const lockPath = `${storePath}.lock`;
    await writeStaleLock(lockPath);

    // Should reclaim and complete rather than block until the acquire bound.
    let ran = false;
    await withCrossProcessTransaction(() => {
      ran = true;
    }, storePath);
    expect(ran).toBe(true);

    // Lock released after the tx.
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes two stale-lock reclaimers with the break guard", async () => {
    const lockPath = `${storePath}.lock`;
    await writeStaleLock(lockPath);

    // Separate module instances model processes with independent transaction
    // chains while the test-only hooks force the exact cross-process schedule.
    vi.resetModules();
    const firstStorage = await import("../lib/core/storage.js");
    vi.resetModules();
    const secondStorage = await import("../lib/core/storage.js");

    const guardHeld = testSignal();
    const releaseGuard = testSignal();
    const loserSawGuard = testSignal();
    let staleDeleteAttempts = 0;

    firstStorage.__setReclaimTestHookForTest(async (stage) => {
      if (stage === "after-guard-acquired") {
        guardHeld.resolve();
        await releaseGuard.promise;
      }
      if (stage === "before-delete") staleDeleteAttempts += 1;
    });
    secondStorage.__setReclaimTestHookForTest((stage) => {
      if (stage === "guard-held") loserSawGuard.resolve();
      if (stage === "before-delete") staleDeleteAttempts += 1;
    });

    const firstEntered = testSignal();
    const releaseFirst = testSignal();
    const events: string[] = [];
    let activeSections = 0;
    let maximumActiveSections = 0;
    const enter = (label: string): void => {
      activeSections += 1;
      maximumActiveSections = Math.max(maximumActiveSections, activeSections);
      events.push(`${label}:enter`);
    };
    const exit = (label: string): void => {
      events.push(`${label}:exit`);
      activeSections -= 1;
    };

    const first = firstStorage.withCrossProcessTransaction(async () => {
      enter("R1");
      firstEntered.resolve();
      await releaseFirst.promise;
      exit("R1");
    }, storePath);
    await guardHeld.promise;

    const second = secondStorage.withCrossProcessTransaction(() => {
      enter("R2");
      exit("R2");
    }, storePath);

    await loserSawGuard.promise;
    expect(staleDeleteAttempts).toBe(0);
    releaseGuard.resolve();
    await firstEntered.promise;

    expect(staleDeleteAttempts).toBe(1);
    expect(events).toEqual(["R1:enter"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(["R1:enter", "R1:exit", "R2:enter", "R2:exit"]);
    expect(maximumActiveSections).toBe(1);
  });

  it("does not delete A's fresh lock when delayed reclaimer B revalidates", async () => {
    const lockPath = `${storePath}.lock`;
    await writeStaleLock(lockPath);

    vi.resetModules();
    const reclaimerStorage = await import("../lib/core/storage.js");
    vi.resetModules();
    const plainAcquirerStorage = await import("../lib/core/storage.js");

    const staleObserved = testSignal();
    const installFreshLock = testSignal();
    const freshRejected = testSignal();
    const finishFreshRecheck = testSignal();
    const plainAcquirerBlocked = testSignal();
    const contenderBlocked = testSignal();
    const firstEntered = testSignal();
    const secondEntered = testSignal();
    const releaseFirst = testSignal();
    let observedInitialStale = false;
    let rejectedFreshLock = false;
    let staleDeleteAttempts = 0;
    let activeSections = 0;
    let maximumActiveSections = 0;
    const events: string[] = [];

    reclaimerStorage.__setReclaimTestHookForTest(async (stage) => {
      if (stage === "after-stale-observed" && !observedInitialStale) {
        observedInitialStale = true;
        staleObserved.resolve();
        await installFreshLock.promise;
      }
      if (stage === "primary-not-stale" && !rejectedFreshLock) {
        rejectedFreshLock = true;
        freshRejected.resolve();
        await finishFreshRecheck.promise;
      }
      if (stage === "primary-not-stale" && activeSections === 1) {
        contenderBlocked.resolve();
      }
      if (stage === "before-delete") staleDeleteAttempts += 1;
    });
    plainAcquirerStorage.__setReclaimTestHookForTest((stage) => {
      if (stage === "primary-not-stale") {
        plainAcquirerBlocked.resolve();
        if (activeSections === 1) contenderBlocked.resolve();
      }
      if (stage === "before-delete") staleDeleteAttempts += 1;
    });

    const enter = (label: string): void => {
      activeSections += 1;
      maximumActiveSections = Math.max(maximumActiveSections, activeSections);
      events.push(`${label}:enter`);
      if (events.filter((event) => event.endsWith(":enter")).length === 1) {
        firstEntered.resolve();
      } else {
        secondEntered.resolve();
      }
    };
    const exit = (label: string): void => {
      events.push(`${label}:exit`);
      activeSections -= 1;
    };
    const run = async (
      label: string,
      storageModule: typeof reclaimerStorage,
    ): Promise<void> => {
      await storageModule.withCrossProcessTransaction(async () => {
        enter(label);
        if (activeSections === 1 && events.length === 1) {
          await releaseFirst.promise;
        }
        exit(label);
      }, storePath);
    };

    const reclaimer = run("B", reclaimerStorage);
    await staleObserved.promise;

    const freshRecord = JSON.stringify({
      pid: 1001,
      at: Date.now(),
      owner: "fresh-owner-A",
    });
    await fs.rm(lockPath, { force: true });
    await fs.writeFile(lockPath, freshRecord);
    installFreshLock.resolve();
    await freshRejected.promise;

    expect(await fs.readFile(lockPath, "utf8")).toBe(freshRecord);
    expect(lockOwner(await fs.readFile(lockPath, "utf8"))).toBe("fresh-owner-A");
    expect(staleDeleteAttempts).toBe(0);

    const plainAcquirer = run("C", plainAcquirerStorage);
    await plainAcquirerBlocked.promise;
    expect(events).toEqual([]);
    expect(await fs.readFile(lockPath, "utf8")).toBe(freshRecord);

    finishFreshRecheck.resolve();
    await fs.rm(lockPath, { force: true });
    await firstEntered.promise;

    const contentionOutcome = await Promise.race([
      contenderBlocked.promise.then(() => "blocked"),
      secondEntered.promise.then(() => "overlap"),
    ]);
    expect(contentionOutcome).toBe("blocked");
    expect(maximumActiveSections).toBe(1);

    releaseFirst.resolve();
    await Promise.all([reclaimer, plainAcquirer]);

    expect(maximumActiveSections).toBe(1);
    expect(staleDeleteAttempts).toBe(0);
    expect(events).toHaveLength(4);
  });

  it("removes a stale break guard and reclaims the stale primary lock", async () => {
    const lockPath = `${storePath}.lock`;
    const guardPath = `${lockPath}.break`;
    await writeStaleLock(lockPath);
    await fs.writeFile(guardPath, "orphaned reclaimer");
    await backdateBeyondStaleWindow(guardPath);

    let ran = false;
    await withCrossProcessTransaction(() => {
      ran = true;
    }, storePath);

    expect(ran).toBe(true);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(guardPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws when the lock cannot be acquired within the bound", async () => {
    process.env.MULTI_AI_LOCK_TIMEOUT_MS = "200";
    const lockPath = `${storePath}.lock`;
    // A FRESH foreign lock (recent mtime) is not stale, so it will not be
    // reclaimed within the tiny bound → acquisition must throw.
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, at: Date.now() }));

    await expect(
      withCrossProcessTransaction(() => {
        /* should never run */
      }, storePath),
    ).rejects.toThrow(/could not acquire/i);

    // Clean up the foreign lock we planted.
    await fs.rm(lockPath, { force: true });
  });

  it("honors legacy MULTI_CODEX_LOCK_TIMEOUT_MS when MULTI_AI is unset", async () => {
    process.env.MULTI_CODEX_LOCK_TIMEOUT_MS = "200";
    const lockPath = `${storePath}.lock`;
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, at: Date.now() }));

    await expect(
      withCrossProcessTransaction(() => {
        /* should never run */
      }, storePath),
    ).rejects.toThrow(/could not acquire/i);

    await fs.rm(lockPath, { force: true });
  });

  it("releases the lock even when the callback throws", async () => {
    const lockPath = `${storePath}.lock`;
    await expect(
      withCrossProcessTransaction(() => {
        throw new Error("boom");
      }, storePath),
    ).rejects.toThrow("boom");

    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });

    // The lock is free: a subsequent tx acquires without issue.
    let ran = false;
    await withCrossProcessTransaction(() => {
      ran = true;
    }, storePath);
    expect(ran).toBe(true);
  });

  it("does NOT delete another holder's lock on release (owner-token mismatch)", async () => {
    const lockPath = `${storePath}.lock`;

    // Inside the tx callback we simulate a concurrent process reclaiming the
    // lock: overwrite the lockfile with a DIFFERENT owner token. When our tx
    // then releases, it must see the mismatch and leave the foreign lock alone
    // (deleting it would free a live lock held by someone else — a cascade).
    await withCrossProcessTransaction(async () => {
      await fs.writeFile(
        lockPath,
        JSON.stringify({ pid: 999999, at: Date.now(), owner: "someone-else" }),
      );
    }, storePath);

    // The foreign lock must still be present with the other owner's token.
    const text = await fs.readFile(lockPath, "utf8");
    expect(JSON.parse(text).owner).toBe("someone-else");

    // Clean up the foreign lock we planted.
    await fs.rm(lockPath, { force: true });
  });

  it("persists the callback's mutation to disk", async () => {
    await withCrossProcessTransaction((storage) => {
      storage.accounts.push(
        makeCodexAccount({
          accountId: "persist-check",
          refreshToken: "rt",
        }),
      );
    }, storePath);

    const onDisk = await loadAccounts(storePath);
    expect(onDisk.accounts.map((a) => a.accountId)).toEqual(["persist-check"]);
    expect(onDisk.version).toBe(2);
  });
});
