# Study Guide — Caching in TypeScript

This repo is the runnable companion to **Core Course/03-caching.md**. Study loop: run a phase (`npm run phaseN`) and watch the log, then read its source top-to-bottom (the header comments teach the concept), then quiz yourself in the web lab's **Drill** tab (`npm run web`), and finally read the matching module section for the interview-depth version — the staff framing, the decision table, and the failure modes. One phase per sitting beats a binge; the drill cards are built for spaced repetition.

## Phase → module mapping

| Phase | What it builds | Module section | The staff insight |
|---|---|---|---|
| 1 | A cache from scratch — hit/miss, TTL, hit-rate | §1 Why Cache At All | "Never frame a cache as 'free performance'... the number AND the consistency cost together signal seniority." |
| 2 | LRU eviction from scratch (O(1) via Map ordering) | §4 Eviction Policies | "For a cache (not a mixed store), use `allkeys-lru` or `allkeys-lfu` so everything is evictable." |
| 3 | Redis cache-aside — the shared distributed cache | §3.1 Cache-Aside | "It fails safe... the canonical write step is delete, not update. If you can draw that race, you're ahead of most candidates." |
| 4 | Write patterns: aside vs write-through vs write-back | §3.3–3.5, §3.7 Pattern Comparison | "Resist picking one globally — segment by data class... that segmentation *is* the senior answer." |
| 5 | Stampede + 3 fixes: single-flight, jitter, stale-while-revalidate | §5.2 Cache Stampede | "Always mention the cold-start case — that's the stampede with no stale value to fall back on." |
| 6 | The read-write consistency race, deterministically reproduced | §5.6 Cache ↔ DB Consistency | "Delete, don't update; DB-first, then delete; keep a TTL backstop... state the consistency contract you're offering." |
| 7 | Consistent hashing + virtual nodes, from scratch | §2.4 Distributed Cache | "Treat the distributed cache as a capacity tier with a failure budget, not as infallible." |
| 8 | Hot keys: near-cache, replication, sharded counters | §5.3 Hot Keys / Celebrity Problem | "Hot reads → L1 local tier; hot writes → sharded counters. More cache nodes won't help a single hot key." |
| 9 | Probabilistic early expiration (XFetch) | §5.2 (probabilistic recompute) | "It converts a coordination problem into a per-request coin flip — no locks, no coordination." |
| 10 | Eviction family: FIFO/LRU/LFU vs W-TinyLFU under a scan | §4 Eviction Policies | "W-TinyLFU beats LRU meaningfully on skewed workloads because its admission filter resists scan pollution." |
| 11 | Bloom filter + short-TTL negative caching | §5.4 Cache Penetration | "Input validation first, bloom filter for large existence checks, short-TTL negative caching as the catch-all." |
| 12 | Sizing math: DB load, memory, average latency | §7 Sizing a Cache | "Backend load is proportional to the *miss* rate, not the hit rate — 95%→99% is a 5× DB win." |
| 13 | Concurrency limiter + circuit breaker (cache-down survival) | §5.5 Avalanche, §7 (failure sizing) | "The DB must survive losing the cache... a concurrency limiter so a cold cache can't take the DB down." |

## Go deeper

- **Deep Dives/01-redis.md** — the engine every phase leans on: data structures, persistence (RDB/AOF), Cluster hash slots, and why Redlock isn't a correctness lock.
- **Deep Dives/16-pattern-scaling-reads.md** — where caching sits in the full read-scaling toolkit (replicas, denormalization, CDN) and when to reach for which layer.
- **Deep Dives/28-distributed-leaderboard.md** — write-back aggregation and sharded counters (Phases 4 and 8) applied to a real design under hot-write pressure.
- **Deep Dives/25-flash-sale-inventory.md** — the hot-key and stampede problems (Phases 5 and 8) at their most violent, plus why you can't cache correctness-critical inventory.
- **DDIA ch. 5 (Replication)** — replication lag is the hidden term in your staleness budget; explains why double-delete waits past replica lag (Phase 6).
- **DDIA ch. 3 (Storage & Retrieval)** — the DB buffer pool is the cache under your cache; often the highest-ROI fix before Redis exists at all.
