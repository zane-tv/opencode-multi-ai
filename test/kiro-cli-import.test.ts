import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "libsql";
import { afterEach, describe, expect, it } from "vitest";

import { readKiroCliCandidates } from "../lib/providers/kiro/auth/kiro-cli-import.js";
import { readSqliteQuery } from "../lib/providers/kiro/auth/sqlite-reader.js";

const tempDirectories: string[] = [];

async function createKiroCliDatabase(
  populate: (db: InstanceType<typeof Database>) => void,
): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "kiro cli#import-"),
  );
  tempDirectories.push(directory);
  const dbPath = path.join(directory, "data.sqlite3");
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB NOT NULL);
    `);
    populate(db);
  } finally {
    db.close();
  }
  return dbPath;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Kiro CLI SQLite import", () => {
  it("opens fixture databases read-only", async () => {
    const dbPath = await createKiroCliDatabase((db) => {
      db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
        "existing",
        "value",
      );
    });

    await expect(
      readSqliteQuery(
        dbPath,
        "INSERT INTO auth_kv (key, value) VALUES (?, ?)",
        ["write-attempt", "value"],
      ),
    ).rejects.toThrow();

    const source = new Database(dbPath);
    try {
      const rows = source.prepare("SELECT COUNT(*) AS count FROM auth_kv").all() as Array<{
        count: number;
      }>;
      expect(rows[0]?.count).toBe(1);
    } finally {
      source.close();
    }
  });

  it("imports the current odic JSON layout with independent service and OIDC regions", async () => {
    const dbPath = await createKiroCliDatabase((db) => {
      db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
        "kirocli:odic:token",
        JSON.stringify({
          access_token: "fake-access-token",
          refresh_token: "fake-refresh-token",
          expires_at: "2026-01-02T03:04:05.123456789Z",
          region: "eu-west-1",
          start_url: "https://token.example.test/start",
          email: "kiro@example.test",
        }),
      );
      db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
        "kirocli:odic:device-registration",
        JSON.stringify({
          client_id: "fake-client-id",
          client_secret: "fake-client-secret",
          region: "us-west-2",
        }),
      );
      db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run(
        "api.codewhisperer.profile",
        Buffer.from(
          JSON.stringify({
            arn: "arn:aws:codewhisperer:eu-central-1:123456789012:profile/test",
            profile_name: "test-profile",
          }),
          "utf8",
        ),
      );
      db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run(
        "auth.idc.region",
        JSON.stringify("ap-southeast-1"),
      );
      db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run(
        "auth.idc.start-url",
        JSON.stringify("https://state.example.test/start"),
      );
    });

    const { candidates, warnings } = await readKiroCliCandidates(dbPath);

    expect(warnings).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      authMethod: "idc",
      refreshToken: "fake-refresh-token",
      accessToken: "fake-access-token",
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      region: "eu-central-1",
      oidcRegion: "us-west-2",
      profileArn:
        "arn:aws:codewhisperer:eu-central-1:123456789012:profile/test",
      startUrl: "https://token.example.test/start",
      email: "kiro@example.test",
      expiresAt: Date.UTC(2026, 0, 2, 3, 4, 5, 123),
      credentialSource: "kiro-cli",
    });
  });

  it("keeps the flat auth_kv layout valid", async () => {
    const dbPath = await createKiroCliDatabase((db) => {
      const insert = db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)");
      insert.run("refreshToken", "flat-refresh-token");
      insert.run("accessToken", "flat-access-token");
      insert.run("clientId", "flat-client-id");
      insert.run("clientSecret", "flat-client-secret");
      insert.run("region", "eu-west-1");
      insert.run("email", "flat@example.test");
      db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run(
        "api.codewhisperer.profile",
        "arn:aws:codewhisperer:us-east-1:123456789012:profile/flat",
      );
    });

    const { candidates, warnings } = await readKiroCliCandidates(dbPath);

    expect(warnings).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      authMethod: "idc",
      refreshToken: "flat-refresh-token",
      accessToken: "flat-access-token",
      clientId: "flat-client-id",
      clientSecret: "flat-client-secret",
      region: "eu-west-1",
      oidcRegion: "eu-west-1",
      email: "flat@example.test",
      credentialSource: "kiro-cli",
    });
  });

  it("treats social tokens as desktop credentials despite stale IDC registration", async () => {
    const dbPath = await createKiroCliDatabase((db) => {
      db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
        "kirocli:social:token",
        JSON.stringify({
          access_token: "social-access-token",
          refresh_token: "social-refresh-token",
          region: "ap-northeast-1",
        }),
      );
      db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
        "kirocli:odic:device-registration",
        JSON.stringify({
          client_id: "stale-client-id",
          client_secret: "stale-client-secret",
          region: "us-east-1",
        }),
      );
    });

    const { candidates, warnings } = await readKiroCliCandidates(dbPath);

    expect(warnings).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      authMethod: "desktop",
      refreshToken: "social-refresh-token",
      accessToken: "social-access-token",
      region: "ap-northeast-1",
      credentialSource: "kiro-cli",
    });
    expect(candidates[0].clientId).toBeUndefined();
  });

  it("skips unsupported GovCloud profile and OIDC regions", async () => {
    const dbPath = await createKiroCliDatabase((db) => {
      db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
        "kirocli:odic:token",
        JSON.stringify({
          refresh_token: "fake-refresh-token",
        }),
      );
      db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
        "kirocli:odic:device-registration",
        JSON.stringify({
          client_id: "fake-client-id",
          client_secret: "fake-client-secret",
          region: "us-gov-west-1",
        }),
      );
      db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run(
        "api.codewhisperer.profile",
        JSON.stringify({
          arn: "arn:aws-us-gov:codewhisperer:us-gov-west-1:123456789012:profile/test",
        }),
      );
    });

    const { candidates, warnings } = await readKiroCliCandidates(dbPath);

    expect(candidates).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /unsupported kiro service region: us-gov-west-1; oidc region: us-gov-west-1/i,
    );
  });

  it("skips a social credential with an unsupported profile ARN region", async () => {
    const dbPath = await createKiroCliDatabase((db) => {
      db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
        "kirocli:social:token",
        JSON.stringify({
          refresh_token: "social-refresh-token",
          region: "us-east-1",
          profile_arn:
            "arn:aws-us-gov:codewhisperer:us-gov-west-1:123456789012:profile/test",
        }),
      );
    });

    const { candidates, warnings } = await readKiroCliCandidates(dbPath);

    expect(candidates).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /unsupported kiro profile arn region: us-gov-west-1/i,
    );
    expect(warnings.join("\n")).not.toContain("social-refresh-token");
  });

  it("discards malformed optional profile and start URL values", async () => {
    const dbPath = await createKiroCliDatabase((db) => {
      db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)").run(
        "kirocli:social:token",
        JSON.stringify({
          refresh_token: "social-refresh-token",
          profileArn: "not-an-arn",
          startUrl: "not-a-url",
        }),
      );
      const insertState = db.prepare(
        "INSERT INTO state (key, value) VALUES (?, ?)",
      );
      insertState.run(
        "api.codewhisperer.profile",
        JSON.stringify({ arn: "not-an-arn" }),
      );
      insertState.run("auth.idc.region", "[]");
      insertState.run("auth.idc.start-url", JSON.stringify("not-a-url"));
    });

    const { candidates, warnings } = await readKiroCliCandidates(dbPath);

    expect(warnings).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      authMethod: "desktop",
      refreshToken: "social-refresh-token",
      region: "us-east-1",
    });
    expect(candidates[0].profileArn).toBeUndefined();
    expect(candidates[0].startUrl).toBeUndefined();
  });
});
