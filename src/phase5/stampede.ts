/**
 * Phase 5 — CACHE STAMPEDE (thundering herd) and its three fixes.
 *
 * Run with:  npm run phase5
 *
 * THE PROBLEM: a popular key expires. In the same instant, 1,000 in-flight
 * requests all check the cache, all MISS, and all hammer the database at once
 * to recompute the same value. The cache — the thing meant to PROTECT the DB —
 * just aimed a firehose at it. This is a "stampede" / "thundering herd", and
 * it's how caches cause outages instead of preventing them.
 *
 * Three standard fixes (know when each applies — that's the interview):
 *
 *   1. SINGLE-FLIGHT (request coalescing): let ONE request recompute; everyone
 *      else waits for and shares that one result. Best for a single hot key.
 *
 *   2. JITTERED TTL: never expire many keys at the same instant. Add randomness
 *      to each TTL so expirations spread out. Prevents the correlated-expiry
 *      version of this problem (a.k.a. "avalanche" when whole cache expires together).
 *
 *   3. STALE-WHILE-REVALIDATE (SWR): keep serving the slightly-stale value while
 *      ONE background task refreshes it. Nobody ever waits on a miss. Best when
 *      a little staleness is acceptable (most read-heavy pages).
 *
 * The demo shows the naive stampede, then fix #1 and #3 in action.
 */

import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dbCalls = 0;
async function expensiveQuery(): Promise<string> {
  dbCalls++;
  await sleep(200); // expensive recomputation
  return "the-value";
}

// ─── NAIVE: 50 concurrent misses → 50 DB calls ────────────────────────────
async function naive() {
  dbCalls = 0;
  let cache: string | null = null; // pretend it just expired (null)

  async function get() {
    if (cache !== null) return cache;
    const v = await expensiveQuery(); // everyone who misses calls this
    cache = v;
    return v;
  }

  await Promise.all(Array.from({ length: 50 }, () => get()));
  log(`   NAIVE: 50 concurrent requests → ${dbCalls} DB calls  💥 (the stampede)`);
}

// ─── FIX 1: SINGLE-FLIGHT — coalesce concurrent misses into one call ──────
async function singleFlight() {
  dbCalls = 0;
  let cache: string | null = null;
  let inFlight: Promise<string> | null = null; // the shared recompute promise

  async function get(): Promise<string> {
    if (cache !== null) return cache;
    // If someone is already recomputing, await THEIR promise instead of starting our own.
    if (inFlight) return inFlight;
    inFlight = expensiveQuery().then((v) => {
      cache = v;
      inFlight = null;
      return v;
    });
    return inFlight;
  }

  await Promise.all(Array.from({ length: 50 }, () => get()));
  log(`   SINGLE-FLIGHT: 50 concurrent requests → ${dbCalls} DB call  ✓ (herd coalesced)`);
}

// ─── FIX 3: STALE-WHILE-REVALIDATE — serve stale, refresh in the background ─
async function staleWhileRevalidate() {
  dbCalls = 0;
  let value = "old-value";
  let softExpiredAt = Date.now() - 1; // already soft-expired
  let refreshing = false;

  async function get(): Promise<string> {
    const isStale = Date.now() > softExpiredAt;
    if (isStale && !refreshing) {
      // Kick off ONE background refresh; do NOT await it — return stale now.
      refreshing = true;
      expensiveQuery().then((v) => {
        value = v;
        softExpiredAt = Date.now() + 5_000;
        refreshing = false;
      });
    }
    return value; // nobody ever blocks on a miss
  }

  const results = await Promise.all(Array.from({ length: 50 }, () => get()));
  log(`   STALE-WHILE-REVALIDATE: 50 requests served instantly as "${results[0]}" (stale),`);
  log(`      with ${dbCalls} background refresh in flight — zero user-facing latency.`);
  await sleep(250);
  log(`      after refresh completes, cache holds: "${value}"`);
}

// ─── FIX 2: JITTERED TTL (illustration) ───────────────────────────────────
function jitteredTtl() {
  const base = 60_000;
  const ttls = Array.from({ length: 5 }, () => base + Math.floor(Math.random() * 10_000));
  log(`   JITTERED TTL: base 60s → ${ttls.map((t) => (t / 1000).toFixed(1) + "s").join(", ")}`);
  log("      spreading expiry times so keys don't all expire (and stampede) together.");
}

async function main() {
  log("═══ The problem ═══");
  await naive();
  log("");
  log("═══ Fix 1 — single-flight (best for one hot key) ═══");
  await singleFlight();
  log("");
  log("═══ Fix 2 — jittered TTL (prevents correlated expiry / avalanche) ═══");
  jitteredTtl();
  log("");
  log("═══ Fix 3 — stale-while-revalidate (best when slight staleness is OK) ═══");
  await staleWhileRevalidate();
  log("");
  log("Pick by shape: one hot key under contention → single-flight; many keys");
  log("expiring together → jitter; read-heavy page that tolerates staleness → SWR.");
  process.exit(0);
}

main();
