#!/usr/bin/env bun
import { importAntigravityFrom9Router } from "../lib/providers/antigravity/auth/import-9router.js";
import { getAccountManager } from "../lib/core/accounts.js";

async function main() {
  console.log("🔍 Scanning 9Router Antigravity accounts from ~/.n9router/db.json...");

  const manager = getAccountManager();
  await manager.load();

  try {
    const res = await importAntigravityFrom9Router({ manager });
    console.log(`\n✅ Import completed:`);
    console.log(`   - Total in 9Router: ${res.totalIn9Router}`);
    console.log(`   - Newly imported:   ${res.imported}`);
    console.log(`   - Skipped (exist):  ${res.skipped}`);

    if (res.errors.length > 0) {
      console.log(`   - Errors encountered: ${res.errors.length}`);
      for (const err of res.errors) console.error(`     ⚠️ ${err}`);
    }

    const allAg = manager.list("antigravity");
    console.log(`\n🎉 Current Antigravity pool has ${allAg.length} account(s):`);
    for (const acc of allAg) {
      console.log(`   • ${acc.email || acc.accountId} (priority: ${acc.priority}, status: ${acc.subscriptionStatus})`);
    }

    const sticky = manager.sticky("antigravity");
    console.log(`\n📌 Active Sticky Account: ${sticky || "None (will select on first turn)"}`);
  } catch (err) {
    console.error(`❌ Failed to import: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
