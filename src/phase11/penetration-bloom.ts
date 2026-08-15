/**
 * Phase 11 — CACHE PENETRATION: the requests a cache can't help with.
 *
 * Run with:  node "src/phase11/penetration-bloom.ts"
 *
 * ─── The blind spot ───────────────────────────────────────────────────────
 * A cache accelerates keys that EXIST. Look up a real user, miss once, fill the
 * cache, and every repeat is free. But a request for a key that does NOT exist
 * can never be a cache hit — there is nothing to cache. So it misses, falls
 * through to "load from DB", the DB says "not found", and… the next identical
 * request does the exact same thing. The cache protects nothing.
 *
 * This is CACHE PENETRATION. It shows up as:
 *   • an attack — someone fires random/incrementing IDs (`/user/999999999`) that
 *     will never exist, and every one is a guaranteed DB hit. The cache is bypassed
 *     by construction; your DB takes the full flood.
 *   • an accident — a client scans an ID range, or a bug requests deleted rows.
 * The study reference calls this out explicitly as one of the named cache
 * failure modes (alongside stampede/avalanche and hotspot invalidation).
 *
 * TWO FIXES THAT COMPOSE:
 *
 *   1. BLOOM FILTER — a space-efficient PROBABILISTIC set of "keys that exist".
 *      A bit array of size m + k hash functions. `mightContain(key)`:
 *        • returns FALSE  → the key is DEFINITELY absent  → short-circuit, skip the DB.
 *        • returns TRUE   → the key is PROBABLY present    → do the real lookup.
 *      No false negatives (absent means absent), a tunable false-positive rate
 *      (a few "probably present" that turn out absent — you just pay one extra DB
 *      check for those). Catch: a plain bloom can't handle DELETES — you can't
 *      unset a bit without maybe clearing another key's bit; that needs a
 *      *counting* bloom (per-slot counters) instead.
 *
 *   2. NEGATIVE CACHING — when a lookup does reach the DB and finds nothing, cache
 *      a short-TTL "MISS" tombstone. Repeats of that same missing key hit the
 *      tombstone, not the DB, bounding repeat-miss cost. Catch: READ-AFTER-CREATE
 *      staleness — if the key is created right after you cached its negative, it
 *      stays invisible until the tombstone expires. So keep the negative TTL short
 *      and/or delete the tombstone on create.
 *
 * The bloom stops the never-existed flood cheaply; negative caching absorbs the
 * residual (false positives + first-time real misses). Use both.
 *
 * MONEY QUOTE: a cache only accelerates keys that exist — penetration by
 * nonexistent keys needs a bloom filter to short-circuit "definitely absent"
 * and short-TTL negative caching for the rest, minding read-after-create staleness.
 */

import { log } from "../lib/log.ts";

// ─── Deterministic PRNG (mulberry32, fixed seed) ──────────────────────────
// No Math.random / Date.now in logic: same run, same numbers, every time.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── A REAL bloom filter ──────────────────────────────────────────────────
// Bit array of m bits, k hash probes per key. Three cheap, independent string
// hashes: FNV-1a and two variants (djb2, sdbm). mightContain never lies about
// absence (no false negatives); it may say "probably" for an absent key.
class BloomFilter {
  private readonly bits: Uint8Array;
  private readonly m: number;
  private readonly k: number;
  constructor(m: number, k: number) {
    this.m = m;
    this.k = k;
    this.bits = new Uint8Array(m);
  }

  // FNV-1a — the base hash.
  private fnv1a(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  // djb2 — variant #2.
  private djb2(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
    return h >>> 0;
  }
  // sdbm — variant #3.
  private sdbm(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (s.charCodeAt(i) + Math.imul(h, 65599)) | 0;
    return h >>> 0;
  }

  // Kirsch–Mitzenmacher: derive k probe positions from two base hashes,
  // g_i(key) = (h1 + i*h2) mod m. Cheap, and the third hash strengthens h2.
  private *slots(key: string): Generator<number> {
    const h1 = this.fnv1a(key);
    const h2 = (this.djb2(key) ^ this.sdbm(key)) >>> 0;
    for (let i = 0; i < this.k; i++) {
      yield ((h1 + Math.imul(i, h2)) >>> 0) % this.m;
    }
  }

  add(key: string): void {
    for (const slot of this.slots(key)) this.bits[slot] = 1;
  }

  // false → definitely absent. true → probably present (maybe a false positive).
  mightContain(key: string): boolean {
    for (const slot of this.slots(key)) {
      if (this.bits[slot] === 0) return false;
    }
    return true;
  }

  // Fraction of bits set — a live signal of how "full" the filter is.
  fillRatio(): number {
    let set = 0;
    for (let i = 0; i < this.m; i++) if (this.bits[i]) set++;
    return set / this.m;
  }
}

// ─── A tiny Database we can watch get hammered ────────────────────────────
class Database {
  queryCount = 0;
  private readonly rows: Set<string>;
  constructor(existingKeys: string[]) {
    this.rows = new Set(existingKeys);
  }
  // Every call counts as one DB hit — this is the number we're trying to shrink.
  get(key: string): string | null {
    this.queryCount++;
    return this.rows.has(key) ? `row:${key}` : null;
  }
  // Simulate a row being created later (for the read-after-create demo).
  insert(key: string): void {
    this.rows.add(key);
  }
}

// ─── A cache with support for negative (tombstone) entries ────────────────
// TTL is measured in TICKS, not wall-clock — a counter we advance by hand so
// expiry is deterministic. A tombstone is stored as the sentinel MISS.
const MISS = Symbol("negative-cache-tombstone");
type Entry = { value: string | typeof MISS; expiresAtTick: number };

class Cache {
  private readonly map = new Map<string, Entry>();
  private readonly now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }

  get(key: string): Entry["value"] | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() >= e.expiresAtTick) {
      this.map.delete(key); // lazily expire
      return undefined;
    }
    return e.value;
  }
  set(key: string, value: string, ttlTicks: number): void {
    this.map.set(key, { value, expiresAtTick: this.now() + ttlTicks });
  }
  setNegative(key: string, ttlTicks: number): void {
    this.map.set(key, { value: MISS, expiresAtTick: this.now() + ttlTicks });
  }
}

// ─── Scenario setup (shared, deterministic) ───────────────────────────────
const rand = mulberry32(0x5eed_1234); // fixed seed → repeatable bogus keys
const EXISTING = Array.from({ length: 1000 }, (_, i) => `user:${1000 + i}`);
const N_BOGUS = 500;

// Bogus keys are IDs far outside the real range — they will never exist.
// Generated from the seeded PRNG so the run is identical every time.
function makeBogusKeys(n: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = 9_000_000 + Math.floor(rand() * 1_000_000);
    keys.push(`user:${id}`);
  }
  return keys;
}

async function main() {
  const bogus = makeBogusKeys(N_BOGUS);

  // ═══════════════════════════════════════════════════════════════════════
  log("═══ 1. PENETRATION: bogus keys blow straight through a plain cache ═══");
  {
    const db = new Database(EXISTING);
    const cache = new Cache(() => tick);
    let tick = 0;

    // Plain cache-aside: check cache, on miss hit DB, cache positive results.
    // A non-existent key is NEVER cacheable → every request is a DB hit.
    function get(key: string): string | null {
      const cached = cache.get(key);
      if (cached !== undefined) return cached === MISS ? null : cached;
      const row = db.get(key); // ← the DB gets hit here, every time
      if (row !== null) cache.set(key, row, 100);
      return row;
    }

    for (const key of bogus) get(key); // fire the flood once…
    for (const key of bogus) get(key); // …and again: still all misses

    log(`   fired ${N_BOGUS} bogus keys x2 rounds = ${N_BOGUS * 2} requests`);
    log(`   → DB queries: ${db.queryCount}  💥 (every single request reached the DB)`);
    log("   the cache accelerated NOTHING — you can't cache what doesn't exist.");
    void tick;
  }

  // ═══════════════════════════════════════════════════════════════════════
  log("");
  log("═══ 2. BLOOM GUARD: short-circuit 'definitely absent' before the DB ═══");
  {
    const db = new Database(EXISTING);
    const cache = new Cache(() => tick);
    let tick = 0;

    // Size the filter for ~1% target FPR at 1000 keys:
    //   m ≈ -n*ln(p)/(ln2)^2 ≈ 9585 bits,  k ≈ (m/n)*ln2 ≈ 7 probes.
    const bloom = new BloomFilter(9600, 7);
    for (const key of EXISTING) bloom.add(key); // preload all real keys

    let shortCircuited = 0;
    let falsePositives = 0;

    function get(key: string): string | null {
      const cached = cache.get(key);
      if (cached !== undefined) return cached === MISS ? null : cached;
      if (!bloom.mightContain(key)) {
        shortCircuited++; // definitely absent → never touch the DB
        return null;
      }
      const row = db.get(key); // only reached by real keys + false positives
      if (row === null) falsePositives++; // bloom said "probably", DB said "no"
      else cache.set(key, row, 100);
      return row;
    }

    for (const key of bogus) get(key);
    for (const key of bogus) get(key);

    const fpr = falsePositives / (N_BOGUS * 2);
    log(`   preloaded bloom with ${EXISTING.length} real keys — fill ratio ${(bloom.fillRatio() * 100).toFixed(1)}%`);
    log(`   fired the same ${N_BOGUS * 2} bogus requests through the bloom guard:`);
    log(`   → short-circuited (definitely absent): ${shortCircuited}`);
    log(`   → false positives that still reached the DB: ${falsePositives}`);
    log(`   → DB queries: ${db.queryCount}  ✓ (down from ${N_BOGUS * 2})`);
    log(`   measured false-positive rate: ${(fpr * 100).toFixed(2)}%  (the residual leak)`);
    log("   note: a plain bloom can't handle DELETES — clearing a bit may erase");
    log("   another key's membership. Deletes need a COUNTING bloom (per-slot counts).");
    void tick;
  }

  // ═══════════════════════════════════════════════════════════════════════
  log("");
  log("═══ 3. NEGATIVE CACHE: tombstone the misses that do slip through ═══");
  {
    let tick = 0;
    const db = new Database(EXISTING);
    const cache = new Cache(() => tick);
    const NEG_TTL = 5; // ticks — deliberately SHORT (read-after-create safety)

    // Bloom left OUT here on purpose to isolate negative caching. In production
    // you'd run both: bloom first, negative cache for false positives + real misses.
    function get(key: string): string | null {
      const cached = cache.get(key);
      if (cached !== undefined) return cached === MISS ? null : cached;
      const row = db.get(key);
      if (row === null) cache.setNegative(key, NEG_TTL); // tombstone the miss
      else cache.set(key, row, 100);
      return row;
    }

    // Repeatedly hit ONE missing key. First call hits the DB and tombstones it;
    // subsequent calls (within TTL) hit the tombstone, not the DB.
    const key = bogus[0];
    for (let i = 0; i < 10; i++) get(key); // tick never advances → all within TTL
    log(`   hammered one missing key 10x → DB queries: ${db.queryCount}  ✓ (only the first)`);

    // ── READ-AFTER-CREATE gotcha ──────────────────────────────────────────
    log("");
    log("   read-after-create gotcha:");
    const before = db.queryCount;
    db.insert(key); // the row is created RIGHT AFTER we tombstoned it
    const stillMissing = get(key); // tombstone still valid → returns stale "absent"
    log(`     created the row, then read it back: ${stillMissing === null ? "null ❌ (invisible!)" : stillMissing}`);
    log(`     (served the stale tombstone, DB not consulted: +${db.queryCount - before} queries)`);

    // Fix: advance past the short TTL (or delete the tombstone on create).
    tick += NEG_TTL; // negative entry expires
    const nowVisible = get(key);
    log(`     after negative TTL expires (${NEG_TTL} ticks): ${nowVisible}  ✓ visible again`);
    log("     → keep negative TTL SHORT and/or invalidate the tombstone on create.");
  }

  // ═══════════════════════════════════════════════════════════════════════
  log("");
  log("═══ Takeaways ═══");
  log("   • A cache only accelerates keys that EXIST; nonexistent keys penetrate");
  log("     straight to the DB — the named 'cache penetration' failure mode.");
  log("   • BLOOM FILTER = space-efficient probabilistic set membership. No false");
  log("     negatives (absent is trustworthy); false positives just cost one extra");
  log("     DB check. Preload existing keys → 'definitely absent' short-circuits.");
  log("   • Plain bloom can't delete — use a COUNTING bloom if keys disappear.");
  log("   • NEGATIVE CACHING bounds repeat-miss cost with short-TTL tombstones,");
  log("     but watch READ-AFTER-CREATE staleness — keep TTL short / invalidate on create.");
  log("   • They COMPOSE: bloom stops the flood, negative cache absorbs the residual.");
  log("");
  log("   Money quote: a cache only accelerates keys that exist — penetration by");
  log("   nonexistent keys needs a bloom filter to short-circuit \"definitely absent\"");
  log("   and short-TTL negative caching for the rest, minding read-after-create staleness.");

  process.exit(0);
}

main();
