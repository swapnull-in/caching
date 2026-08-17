/** Drill data — mined from Core Course/03-caching.md. Loaded by index.html's Drill panel. */
window.DRILL = {
  module: "Module 03 — Caching",
  source: "Core Course/03-caching.md",
  cheats: [
    "Layers (push hits toward the user): browser (0 ms) → CDN edge (1–20 ms) → L1 in-process Caffeine (µs) → L2 Redis (sub-ms) → DB buffer pool (µs) → disk (5–20 ms). Staleness <b>compounds</b> down the chain.",
    "Browser: <code>no-cache</code> HTML + content-hashed <code>immutable</code> assets = infinite cache + instant invalidation. <code>no-cache</code> ≠ no-store; ETag → 304.",
    "CDN: pull (lazy) vs push (pre-warm); <b>surrogate keys</b> enable targeted purge of dynamic content; shield POPs prevent origin avalanche; never edge-cache personalized responses without <code>private</code>/<code>Vary</code>.",
    "Patterns: cache-aside = default (<b>fails safe</b>). Write-through = read-after-write (pair with read-through). Write-back = lowest write latency, <b>data-loss risk</b> (counters). Write-around = write-heavy, avoids pollution. <b>Segment data by class and assign patterns.</b>",
    "Eviction: LRU default; LFU for stable skew; <b>W-TinyLFU</b> (Caffeine) beats LRU on skewed/scan workloads via its admission filter. Redis: <code>allkeys-lru/lfu</code> for a pure cache — <code>volatile-*</code> only evicts keys that have a TTL.",
    "Write consistency chain: <b>delete don't update → DB-first then delete → TTL backstop → double-delete or versioned keys for the race → leases / CDC at scale</b>. State the bounded-staleness contract; never claim strong consistency with the DB.",
    "Stampede: single-flight/per-key lock + <b>probabilistic early expiration</b> + <b>stale-while-revalidate</b>. Cold start is the worst case (no stale value to serve) → warm the cache + ramp traffic.",
    "Hot keys: hot <em>reads</em> → L1 local tier (self-selects the hot keys); hot <em>writes</em> → sharded counters. More cache nodes don't fix one hot slot.",
    "Penetration: negative caching with a <b>short</b> TTL + bloom filter of existing keys + input validation.",
    "Avalanche: <b>TTL jitter</b> (±10–20%) + DB concurrency limiter / circuit breaker + cache HA + warming. Stampede = one key; avalanche = many at once.",
    "Redis vs Memcached: Redis = data structures, persistence, HA, scripting — the default. Memcached = simple, multithreaded, pure cache. Avoid O(N) commands (<code>KEYS</code>) — the single-threaded core blocks. <b>Redlock is not safe for correctness</b> — use fencing tokens.",
    "Sizing: <code>DB_QPS = QPS × (1 − hit)</code>. Backend load ∝ <b>miss rate</b>: 95%→99% hit = 5× DB reduction. Provision working_set × overhead × replicas × headroom — and size the DB to survive cache-down."
  ],
  cards: [
    {
      topic: "invalidation",
      q: "Why is delete preferred over update when invalidating the cache on a write?",
      a: "Updating the cache is vulnerable to write-write interleaving — a slow writer's SET lands after a newer one and the cache is stale indefinitely; it also caches values that may never be read. Deleting leaves no stale value behind: the next read reloads fresh from the DB. The canonical order is DB-first then delete, so a concurrent reader can't repopulate from old DB state. A narrow read-miss-straddling-a-write race remains — handle it with a TTL backstop plus double-delete or versioned keys."
    },
    {
      topic: "stampede",
      q: "Walk me through cache stampede and how you'd prevent it.",
      a: "A hot key expires (or the cache restarts cold) and thousands of concurrent requests all miss and hit the DB with the same query. Layer the fixes: single-flight per-key lock (one recompute, with a lock TTL so a dead holder can't wedge the key), probabilistic early expiration (each reader randomly recomputes as TTL nears, so one refreshes early and the herd never synchronizes — no locks), and stale-while-revalidate (serve stale, refresh async, nobody blocks). The worst case is cold start with no stale value — that needs warming, a gradual traffic ramp, and a DB concurrency limiter."
    },
    {
      topic: "avalanche",
      q: "Stampede vs avalanche — what's the difference, and the fixes?",
      a: "Stampede is one hot key expiring — fix with single-flight, probabilistic early expiry, or stale-while-revalidate. Avalanche is mass simultaneous expiry or total cache failure — fix with TTL jitter so expirations spread, staggered population, cache HA/replicas, and a DB circuit breaker or concurrency limiter. Both ultimately require the database to degrade gracefully, not collapse, when the cache can't shield it."
    },
    {
      topic: "hot keys",
      q: "A celebrity's profile gets 90% of reads to one key — how do you handle it?",
      a: "That key hashes to a single node, so adding cache nodes doesn't help — the load lives on one slot. For hot reads, add an L1 in-process cache (Caffeine, short TTL) on every app server: it auto-selects exactly the hot keys and the distributed node barely sees them; alternatively replicate the key as celebrity:1..N and read a random replica. For hot writes (one shared counter), use sharded counters — write to counter:shard:{rand}, sum on read — or write-back aggregation. Distinguishing hot reads from hot writes is the key insight."
    },
    {
      topic: "consistency",
      q: "How do you keep cache and DB consistent? Can they be strongly consistent?",
      a: "You can't cheaply make two systems strongly consistent — offer bounded eventual consistency and state the contract: stale up to TTL T, with a sub-second race window under concurrent writes. The robust scheme: delete not update, DB-first then delete, with a jittered TTL backstop. For the residual read-write race, use double-delete (delete again after a short delay) or versioned keys (old version is simply never read). At extreme scale: CDC-driven invalidation from the binlog (catches every writer, including out-of-band jobs) or Facebook-style leases (an invalidation voids the lease, so a slow reader's stale SET is rejected — solving stale-set and stampede together)."
    },
    {
      topic: "engine choice",
      q: "Redis or Memcached for a session/object cache, and why?",
      a: "Redis is the modern default because you almost always end up wanting data structures (ZSET rate limiters, queues), persistence (AOF everysec, ≤1 s loss), replication/HA, or atomic Lua — and one engine is less to operate. Memcached is defensible only for a pure ephemeral string cache at extreme multithreaded throughput with zero ops surface. Raise unprompted: Redis's single-threaded core means avoid O(N) commands like KEYS on the hot path (use SCAN), and never use Redlock for correctness-critical locking — under GC pauses and clock skew it can grant a lock twice; use fencing tokens."
    },
    {
      topic: "penetration",
      q: "Someone queries random non-existent IDs — what happens, and how do you defend?",
      a: "Every request misses the cache and the DB (nothing exists to cache), so the cache provides zero protection and the DB takes the full load — a viable DoS vector. Defend in layers: input validation to cheaply reject malformed or out-of-range IDs, a bloom filter of existing keys to short-circuit definitely-absent lookups, and short-TTL negative caching (tombstones) so repeated lookups for the same missing key hit the cache. Keep the negative TTL short or you serve 'not found' after the key is created — the read-after-create gotcha."
    },
    {
      topic: "sizing",
      q: "200k read QPS at a 90% hit rate — what's the DB load, and what does 99% buy you?",
      a: "DB QPS = 200,000 × (1 − 0.90) = 20,000; at 99% it's 2,000 — a 10× reduction from a 9-point hit-rate gain, because backend load is proportional to the miss rate (10% → 1% is 10×). The metric to optimize is 1 − hit_ratio, and gains compound near the top of the curve. Still size the DB to survive a cache-down (0% hit) scenario at a safe-degraded level behind a concurrency limiter."
    },
    {
      topic: "write-back",
      q: "When would you use write-back, and what's the risk?",
      a: "Write-back (write to cache, ack, async-flush to DB) gives the lowest write latency and coalesces writes — ideal for high-volume counters (views, impressions) the DB couldn't absorb directly. The risk is durability: un-flushed writes vanish if the cache node dies. Use it only where bounded loss is acceptable and quantify it — 'up to N seconds of counter loss on a crash' — or back the buffer with something durable (Redis AOF, Kafka/WAL). If loss is unacceptable, you don't use write-back; that's the line."
    },
    {
      topic: "why cache",
      q: "Why cache at all instead of just scaling the database?",
      a: "RAM (~100 ns) is about five orders of magnitude faster than a raw disk read (~10 ms), and far cheaper to scale for reads than sharding a primary. Caches exploit temporal and Pareto (80/20) locality — a small hot set serves most traffic — so the DB can be sized for writes plus misses only. The trade is bounded staleness and a new failure mode (the cache as a hard dependency), so state the win and the cost in the same breath: the p99 and DB-QPS numbers, the staleness contract, and a degradation plan for cache failure."
    },
    {
      topic: "cache down",
      q: "What happens when Redis goes down — walk me through it.",
      a: "The cache is a capacity tier with a failure budget, so the system must degrade, not collapse. With cache-aside, reads fall through to the DB — but a cold cache at full traffic is a stampede, so keep a concurrency limiter / circuit breaker between app and DB that caps in-flight queries; excess requests fail fast or serve degraded responses. A small L1 in-process tier keeps the hottest keys serving locally, and on recovery you warm gradually and ramp traffic rather than slamming a cold cluster. Critically, the DB was sized for the cache-down case, not just the happy path."
    },
    {
      topic: "altitude",
      q: "20 minutes left after layers and patterns — where do you spend it, and what do you skip?",
      a: "Spend it on the risk crux: cache-DB consistency under concurrent writes, stampede (including the cold-start variant), and hot keys — that's where designs actually fail and where judgment shows. Explicitly skip re-explaining ETags, LRU mechanics, and the full Redis-vs-Memcached table — those are name-and-move-on basics, and lingering signals you think the easy parts are the interesting parts. State what you're not building — no CDC, no leases — until a requirement triggers it."
    },
    {
      topic: "justify cache",
      q: "You said 'use a cache here' — convince me you're not just pattern-matching.",
      a: "A cache is only justified if the trace shows the read path is the bottleneck and the data is skewed and staleness-tolerant. If DB CPU is fine or the buffer pool is undersized, fix the cheaper layer first — higher ROI, no new consistency problem. If reads are the bottleneck with Pareto skew: cache-aside + Redis, stating the bounded-staleness contract and the cache-down degradation plan in the same breath. If the workload is uniform with no hot set, say 'no cache' — the willingness to say no is the actual signal."
    }
  ]
};
