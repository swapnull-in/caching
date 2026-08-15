/**
 * Phase 8 — HOT KEYS: the celebrity problem (and why hot-READ ≠ hot-WRITE).
 *
 * Run with:  node "src/phase8/hot-keys.ts"
 *
 * THE PROBLEM: traffic is never uniform. One key — a celebrity's profile, a
 * flash-sale item, a viral tweet's like-count — takes a wildly disproportionate
 * share of requests. In a sharded cache, every key maps to ONE node (that's how
 * sharding works). So one popular key means one node eats the whole firehose
 * while the others idle. That node's CPU/network saturates, its p99 explodes,
 * and it takes down keys that merely had the bad luck to live on the same shard.
 * That's a HOT KEY, a.k.a. the "celebrity problem" or a hotspot.
 *
 * This is DISTINCT from Phase 5's stampede. Stampede = many requests miss the
 * SAME key at the SAME instant (thundering herd on expiry) — a timing problem.
 * A hot key is a herd that never lets up — a DISTRIBUTION problem. Even with a
 * perfectly warm cache and zero misses, one shard is still melting.
 *
 * STEP 0 — SPOT IT: hotspots hide in aggregate dashboards (total QPS looks
 * fine). You find them with KEY-LEVEL metrics: per-key request counters, a
 * "heavy hitters" / top-K sketch (e.g. Count-Min + a min-heap), or Redis's
 * own `--hotkeys` sampling. If one key is >>1/Nshards of traffic, it's hot.
 *
 * THE KEY INSIGHT: the fix depends on the DIRECTION of the heat.
 *
 *   HOT READS (everyone reading one value) — spread or tier the READ:
 *     1. NEAR-CACHE (L1 in front of shared L2): each app server keeps a tiny
 *        local copy. The first read per server hits L2; the rest hit local RAM.
 *        L2 QPS for the hot key collapses from N reads → ~one-per-app-server.
 *        Trade: L1 coherence — a short TTL means brief staleness across servers.
 *     2. KEY REPLICATION / FAN-OUT: store the SAME value under N suffixed keys
 *        (hot:1..hot:N) so they hash to different shards; each read picks a
 *        random replica. Load spreads ~N× off the single hot shard. Trade:
 *        N× the memory and N× the writes to keep replicas in sync.
 *
 *   HOT WRITES (everyone incrementing one counter) — you CANNOT cache your way
 *   out. A near-cache doesn't help writes, and replicating a value you're
 *   constantly mutating just multiplies the write problem.
 *     3. SHARDED COUNTERS: one counter key serializes every increment on one
 *        node — that node's single-key throughput is your ceiling. Split it into
 *        N shard-counters; each write increments a RANDOM shard (contention ÷ N);
 *        a read SUMS all N shards. Trade: reads now cost N reads + a sum, and the
 *        total is eventually-consistent across shards.
 *
 * MONEY QUOTE: a hot key hotspots one shard; the fix depends on direction —
 * near-cache or replicate the value for hot READS, shard the counter for hot
 * WRITES. One global key that every request touches is an architectural smell.
 *
 * (This is the "failure plan → hot key" branch of the README's four decisions:
 * pattern · staleness budget · failure plan · cache-vs-DB consistency race.)
 */

import { log } from "../lib/log.ts";

// ─── Deterministic PRNG so every run is identical (no Math.random/Date.now) ──
// mulberry32: tiny, fast, fixed-seed → reproducible demos.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xC0FFEE);
const randInt = (n: number) => Math.floor(rand() * n); // [0, n)

// ─── A sharded shared cache (the L2). Every key hashes to exactly ONE shard, ──
// ─── so we can watch per-shard load and see a single key create a hotspot. ───
class ShardedCache {
  shardHits: number[];
  private numShards: number;
  private store = new Map<string, string>();
  private served = new Map<string, number>(); // per-key request counter (heavy-hitter metric)

  constructor(numShards: number) {
    this.numShards = numShards;
    this.shardHits = new Array(numShards).fill(0);
  }

  // djb2-ish hash → which shard owns this key.
  private shardOf(key: string): number {
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    return Math.abs(h) % this.numShards;
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
  }

  get(key: string): string | undefined {
    this.shardHits[this.shardOf(key)]++;
    this.served.set(key, (this.served.get(key) ?? 0) + 1);
    return this.store.get(key);
  }

  incr(key: string): void {
    this.shardHits[this.shardOf(key)]++;
    this.served.set(key, (this.served.get(key) ?? 0) + 1);
    this.store.set(key, String(Number(this.store.get(key) ?? "0") + 1));
  }

  read(key: string): string {
    return this.store.get(key) ?? "0";
  }

  keyQps(key: string): number {
    return this.served.get(key) ?? 0;
  }

  // The "heavy hitters" view: which key is disproportionately hot?
  topKey(): { key: string; count: number } {
    let best = { key: "", count: -1 };
    for (const [key, count] of this.served) if (count > best.count) best = { key, count };
    return best;
  }

  hottestShard(): { shard: number; count: number } {
    let best = { shard: -1, count: -1 };
    this.shardHits.forEach((count, shard) => {
      if (count > best.count) best = { shard, count };
    });
    return best;
  }

  resetCounters(): void {
    this.shardHits.fill(0);
    this.served.clear();
  }
}

const NUM_SHARDS = 8;
const NUM_APP_SERVERS = 4;
const BURST = 10_000; // reads (or writes) aimed at one key
const HOT_KEY = "profile:celebrity";

// ─── STEP 0 — identify the hot key from key-level metrics ────────────────────
function spotTheHotKey() {
  const l2 = new ShardedCache(NUM_SHARDS);
  l2.set(HOT_KEY, "…");
  for (let i = 0; i < 200; i++) l2.set(`profile:user:${i}`, "…");

  // Realistic skew: the celebrity gets ~90% of reads, 200 normal users share the rest.
  for (let i = 0; i < BURST; i++) {
    if (rand() < 0.9) l2.get(HOT_KEY);
    else l2.get(`profile:user:${randInt(200)}`);
  }

  const top = l2.topKey();
  const hot = l2.hottestShard();
  const fairShare = (BURST / NUM_SHARDS) | 0;
  log(`   heavy-hitters (top-K): "${top.key}" = ${top.count} reqs (${((top.count / BURST) * 100).toFixed(0)}% of ALL traffic)`);
  log(`   per-shard load: [${l2.shardHits.join(", ")}]`);
  log(`   shard ${hot.shard} is carrying ${hot.count} reqs vs a fair share of ~${fairShare} → HOTSPOT 🔥`);
  log(`   aggregate QPS looked fine; only key-level metrics exposed the celebrity.`);
}

// ─── HOT READ, FIX 1 — near-cache (L1 in front of shared L2) ─────────────────
// Each app server has a tiny L1. First read per server pulls from L2 and caches
// locally; every subsequent read on that server is a local hit. L2 sees at most
// one request per app server (per TTL window), not the whole burst.
function nearCache() {
  const l2 = new ShardedCache(NUM_SHARDS);
  l2.set(HOT_KEY, "celebrity-v1");
  l2.resetCounters();

  // One L1 map per app server.
  const l1: Array<Map<string, string>> = Array.from({ length: NUM_APP_SERVERS }, () => new Map());

  function readVia(server: number, key: string): string {
    const local = l1[server].get(key);
    if (local !== undefined) return local; // L1 hit — never touches L2
    const value = l2.get(key)!; // L1 miss — go to shared L2 once, then cache it
    l1[server].set(key, value);
    return value;
  }

  // Same 10k-read burst, but each request lands on a random app server.
  for (let i = 0; i < BURST; i++) readVia(randInt(NUM_APP_SERVERS), HOT_KEY);

  log(`   ${BURST} reads across ${NUM_APP_SERVERS} app servers, each with its own L1.`);
  log(`   L2 QPS for the hot key: ${l2.keyQps(HOT_KEY)} (≈ one warm-up per app server) — down from ${BURST}. ✓`);
  log(`   the hot shard barely notices; the burst is absorbed in local RAM.`);
  log(`   TRADE: L1 coherence — with an L1 TTL, servers can serve briefly-stale copies.`);
}

// ─── HOT READ, FIX 2 — key replication / fan-out ─────────────────────────────
// Replicate the value under N suffixed keys that hash to different shards. Each
// read routes to a random replica, so the burst spreads across N shards.
function keyReplication() {
  const REPLICAS = NUM_SHARDS; // fan out roughly one replica per shard
  const single = new ShardedCache(NUM_SHARDS);
  const replicated = new ShardedCache(NUM_SHARDS);

  single.set(HOT_KEY, "celebrity-v1");
  for (let r = 0; r < REPLICAS; r++) replicated.set(`${HOT_KEY}#${r}`, "celebrity-v1");
  single.resetCounters();
  replicated.resetCounters();

  for (let i = 0; i < BURST; i++) {
    single.get(HOT_KEY); // baseline: always the same key → same shard
    replicated.get(`${HOT_KEY}#${randInt(REPLICAS)}`); // pick a random replica
  }

  const before = single.hottestShard();
  const after = replicated.hottestShard();
  log(`   WITHOUT replication: hottest shard = ${before.count} reqs on shard ${before.shard} (all ${BURST} on one shard).`);
  log(`   WITH ${REPLICAS} replicas: per-shard load = [${replicated.shardHits.join(", ")}]`);
  log(`   hottest shard now = ${after.count} reqs → ~${(before.count / after.count).toFixed(1)}× lighter. ✓`);
  log(`   TRADE: ${REPLICAS}× memory + every write must fan out to all ${REPLICAS} replicas.`);
}

// ─── HOT WRITE, FIX 3 — sharded counters ─────────────────────────────────────
// A single counter key serializes every increment on one node. Split it into N
// shard-counters; each increment hits a RANDOM shard (contention ÷ N); a read
// SUMS all N shards.
function shardedCounters() {
  const N = NUM_SHARDS;
  const single = new ShardedCache(NUM_SHARDS);
  const sharded = new ShardedCache(NUM_SHARDS);

  const SINGLE_KEY = "likes:viral-post";
  single.set(SINGLE_KEY, "0");
  for (let s = 0; s < N; s++) sharded.set(`${SINGLE_KEY}#${s}`, "0");
  single.resetCounters();
  sharded.resetCounters();

  // A write burst: everyone likes the same post.
  for (let i = 0; i < BURST; i++) {
    single.incr(SINGLE_KEY); // all writes serialize on one shard
    sharded.incr(`${SINGLE_KEY}#${randInt(N)}`); // spread writes across N shards
  }

  const before = single.hottestShard();
  const after = sharded.hottestShard();

  // Read path: single key = one read; sharded counter = SUM of all N shards.
  let total = 0;
  for (let s = 0; s < N; s++) total += Number(sharded.read(`${SINGLE_KEY}#${s}`));

  log(`   SINGLE counter: all ${BURST} increments hit one shard (${before.count} writes on shard ${before.shard}) → throughput ceiling.`);
  log(`   ${N} SHARDED counters: writes spread = [${sharded.shardHits.join(", ")}]`);
  log(`   busiest write shard now = ${after.count} → contention ÷ ~${(before.count / after.count).toFixed(1)}. ✓`);
  log(`   READ cost: sum ${N} shard-keys → total = ${total} (matches ${BURST}). That's the trade.`);
  log(`   Note: near-cache/replication would NOT fix this — you cannot cache a value everyone mutates.`);
}

function main() {
  log("═══ Step 0 — spot the hot key (aggregate dashboards hide it) ═══");
  spotTheHotKey();
  log("");
  log("═══ HOT READ · Fix 1 — near-cache (L1 in front of shared L2) ═══");
  nearCache();
  log("");
  log("═══ HOT READ · Fix 2 — key replication / fan-out across shards ═══");
  keyReplication();
  log("");
  log("═══ HOT WRITE · Fix 3 — sharded counters (writes can't be cached) ═══");
  shardedCounters();
  log("");
  log("Takeaways:");
  log("  • A hot key is a DISTRIBUTION problem (one shard melts), distinct from");
  log("    Phase 5's stampede, which is a TIMING problem (herd on expiry).");
  log("  • Find hot keys with KEY-LEVEL metrics / heavy-hitters — totals look fine.");
  log("  • Direction decides the tool: hot READS → near-cache or replicate the value;");
  log("    hot WRITES → shard the counter. They are DIFFERENT fixes, not interchangeable.");
  log("  • One global key every request touches is an architectural smell — design it out.");
  process.exit(0);
}

main();
