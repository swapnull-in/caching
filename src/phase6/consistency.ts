/**
 * Phase 6 — THE CONSISTENCY RACE (+ penetration), the subtle stuff.
 *
 * Run with:  npm run phase6
 *
 * ─── The read-repair race ────────────────────────────────────────────────
 * Cache-aside's write rule is "write the DB, then delete the cache key". Sounds
 * safe. It isn't, on its own. A read and a write can interleave so the cache
 * ends up holding a STALE value indefinitely (until TTL):
 *
 *   1. Reader misses, reads DB → gets v1 (old). Then it stalls (GC pause, slow net).
 *   2. Writer updates DB to v2, deletes the cache key.
 *   3. Reader wakes up and writes the v1 it read earlier into the cache.
 *   → Cache now serves v1 forever; DB says v2. The delete "happened", but before
 *     the stale write. Deleting the cache did not save you.
 *
 * This is why "just cache it" is dangerous for anything that must be correct.
 * We reproduce the race deterministically, then show the mitigations.
 */

import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // A DB and cache we can inspect. We control timing to force the race.
  const db = new Map<string, string>([["k", "v1"]]);
  const cache = new Map<string, string>(); // empty (cold)

  log("═══ Reproducing the race: cache ends up stale ═══");
  log("   start: db=v1, cache=empty");

  // Reader begins: reads DB (v1), but we PAUSE it before it writes the cache.
  const readValue = db.get("k")!; // step 1: reader reads v1 from DB
  log("   [reader] read v1 from DB, then stalled (not yet written to cache)");

  // Writer runs fully in the gap.
  db.set("k", "v2"); // step 2: writer updates DB
  cache.delete("k"); // step 2: writer deletes cache key (it's already empty)
  log("   [writer] updated DB to v2, deleted cache key");

  // Reader resumes and populates the cache with the stale value it read earlier.
  cache.set("k", readValue); // step 3: reader writes v1 — STALE
  log(`   [reader] resumed, wrote its old read (${readValue}) into cache`);

  log(`   → RESULT: db=${db.get("k")}, cache=${cache.get("k")}  ❌ cache is stale and will stay stale`);

  // ─── Mitigations ────────────────────────────────────────────────────────
  log("");
  log("═══ How real systems bound / fix this ═══");
  log("   1. TTL as a backstop — the stale value self-heals after N seconds.");
  log("      (Doesn't prevent the race, just limits the damage window. Always have it.)");
  log("   2. Delayed double-delete — writer deletes the key, then deletes it AGAIN");
  log("      after a short delay, clearing any stale value a slow reader inserted.");
  log("   3. Versioning / CAS — store {value, version}; a reader only writes the");
  log("      cache if its version is >= what's there, so a stale write is rejected.");
  log("   4. CDC-driven invalidation — a change-data-capture stream from the DB");
  log("      evicts the key, decoupled from app request timing entirely.");

  // Show fix #3 (versioning) rejecting the stale write.
  log("");
  log("   demo of fix #3 (versioned cache rejects the stale write):");
  const vcache = new Map<string, { value: string; version: number }>();
  vcache.set("k", { value: "v2", version: 2 }); // writer populated fresh
  const staleWrite = { value: "v1", version: 1 };
  const current = vcache.get("k");
  if (!current || staleWrite.version > current.version) {
    vcache.set("k", staleWrite);
    log("      wrote stale value (bad)");
  } else {
    log(`      rejected stale write (version ${staleWrite.version} < ${current.version}) ✓ cache stays v2`);
  }

  // ─── Cache penetration ───────────────────────────────────────────────────
  log("");
  log("═══ Bonus: CACHE PENETRATION (a different failure) ═══");
  log("   Attackers (or bugs) request keys that DON'T EXIST. Every one misses the");
  log("   cache and hits the DB — the cache protects nothing. Two fixes:");
  log("     • cache the NEGATIVE result too (store a 'not found' marker with short TTL)");
  log("     • put a Bloom filter in front to reject keys that can't exist, cheaply");

  process.exit(0);
}

main();
