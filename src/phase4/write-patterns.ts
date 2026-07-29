/**
 * Phase 4 — WRITE PATTERNS: cache-aside vs write-through vs write-back.
 *
 * Run with:  npm run phase4
 *
 * Reading through a cache is easy. WRITING is where the design decisions — and
 * the failure modes interviewers probe — live. Three strategies:
 *
 *   CACHE-ASIDE (write):  write DB, then INVALIDATE the cache key.
 *     + simple, cache never holds a value the DB doesn't
 *     - next read is a miss (has to repopulate); a race can still serve stale
 *
 *   WRITE-THROUGH:        write cache AND DB synchronously, together.
 *     + cache is always warm and consistent with the DB
 *     - every write pays the DB latency; you cache things that may never be read
 *
 *   WRITE-BACK (write-behind): write cache now, flush to DB later (async/batched).
 *     + fastest writes; absorbs write bursts; coalesces repeated writes
 *     - **if the cache dies before the flush, those writes are GONE** — you
 *       traded durability for speed. Never do this for money/orders.
 *
 * The demo runs all three against a mock DB (with latency) and then crashes the
 * write-back cache mid-flight to show exactly what you lose.
 */

import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A mock database with write latency and a durable store we can inspect. */
class MockDb {
  private data = new Map<string, number>();
  public writeCount = 0;
  async write(key: string, value: number) {
    await sleep(100); // DB writes are slow
    this.data.set(key, value);
    this.writeCount++;
  }
  read(key: string) {
    return this.data.get(key);
  }
}

async function main() {
  // ─── CACHE-ASIDE ───────────────────────────────────────────────────────
  log("═══ CACHE-ASIDE: write DB, invalidate cache ═══");
  {
    const db = new MockDb();
    const cache = new Map<string, number>();
    cache.set("balance", 100); // warm

    async function write(key: string, value: number) {
      await db.write(key, value);
      cache.delete(key); // invalidate — next read repopulates from DB
      log(`   wrote ${key}=${value} to DB, invalidated cache`);
    }
    await write("balance", 150);
    log(`   cache now: ${cache.has("balance") ? "warm" : "empty (next read = miss)"}, db=${db.read("balance")}`);
  }

  // ─── WRITE-THROUGH ─────────────────────────────────────────────────────
  log("");
  log("═══ WRITE-THROUGH: write cache + DB together (always consistent) ═══");
  {
    const db = new MockDb();
    const cache = new Map<string, number>();
    async function write(key: string, value: number) {
      cache.set(key, value); // cache updated...
      await db.write(key, value); // ...and DB, synchronously
      log(`   wrote ${key}=${value} to BOTH cache and DB`);
    }
    const t = Date.now();
    await write("balance", 200);
    log(`   cache=${cache.get("balance")}, db=${db.read("balance")} — consistent. Write took ${Date.now() - t}ms (paid DB latency).`);
  }

  // ─── WRITE-BACK + its failure mode ─────────────────────────────────────
  log("");
  log("═══ WRITE-BACK: write cache now, flush to DB later (fast, but risky) ═══");
  {
    const db = new MockDb();
    const cache = new Map<string, number>();
    const dirty = new Set<string>(); // keys written to cache but not yet in DB

    function write(key: string, value: number) {
      cache.set(key, value); // instant — no DB wait
      dirty.add(key);
      log(`   wrote ${key}=${value} to cache only (dirty). Returned immediately.`);
    }
    async function flush() {
      for (const key of dirty) await db.write(key, cache.get(key)!);
      dirty.clear();
    }

    const t = Date.now();
    write("balance", 300);
    write("balance", 350); // coalesced — DB never sees 300
    write("views", 1);
    log(`   3 writes returned in ${Date.now() - t}ms (no DB latency). DB not touched yet.`);

    log("   💥 CACHE CRASHES before the flush runs...");
    // (flush never happens)
    log(`   → DB still has: balance=${db.read("balance") ?? "NOTHING"}, views=${db.read("views") ?? "NOTHING"}`);
    log("   → Everything in the dirty set is LOST. That's the write-back bargain.");

    log("   (In the happy path, flush() would have persisted balance=350, views=1.)");
    await flush(); // show it works when it does run
    log(`   after a successful flush: balance=${db.read("balance")}, views=${db.read("views")}`);
  }

  log("");
  log("Rule of thumb: cache-aside by default; write-through when reads must never");
  log("miss after a write; write-back ONLY for loss-tolerant, high-write data");
  log("(counters, metrics, view counts) — never for orders, payments, balances.");

  process.exit(0);
}

main();
