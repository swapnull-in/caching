# Learn Caching in TypeScript

A hands-on, runnable project for understanding caching at a Staff/EM level —
from building a cache **from scratch** to the failure modes and distributed
designs that interviews (and production) actually turn on.

Every phase is a small script you can run and read. No build step: modern Node
runs the TypeScript directly.

> Built to match a Staff-level study path. The through-line: **a cache is a bet
> that the past predicts the future.** Every caching decision is one of four:
> **pattern**, **staleness budget (TTL + invalidation)**, **failure plan**
> (stampede / hot key / cold start), and **the cache-vs-DB consistency race**.

## Prerequisites

- **Node.js 22+** (uses native `.ts` execution)
- **Redis** on `localhost:6379` for Phase 3 (`redis-cli ping` → `PONG`)
  ```bash
  # macOS:   brew install redis && brew services start redis
  # Docker:  docker run -d -p 6379:6379 redis
  ```

## Setup

```bash
npm install
```

## The lessons

Run in order. Each prints a timestamped log so you can watch hits, misses,
evictions, stampedes, and races happen.

| Command | What you learn | Maps to |
|---|---|---|
| `npm run phase1` | A cache **from scratch** — hit/miss, TTL expiry, hit-rate | why cache |
| `npm run phase2` | **Eviction** — an LRU cache built from scratch | LRU vs LFU |
| `npm run phase3` | **Redis cache-aside** — the shared, distributed cache | patterns |
| `npm run phase4` | **Write patterns** — cache-aside vs write-through vs write-back + failure modes | patterns |
| `npm run phase5` | **Cache stampede** + 3 fixes: single-flight, jittered TTL, stale-while-revalidate | the "interview meat" |
| `npm run phase6` | **The consistency race** — why "update DB, delete cache" still serves stale, + fixes; penetration | consistency |
| `npm run phase7` | **Distributed cache** — consistent hashing + virtual nodes, from scratch | building a cache |
| `npm run phase8` | **Hot keys** — the celebrity problem; near-cache & replication for hot reads, sharded counters for hot writes | scaling |
| `npm run phase9` | **Probabilistic early expiration (XFetch)** — the lock-free stampede fix that spreads recomputes | the "interview meat" |
| `npm run phase10` | **Eviction family** — FIFO/LRU/LFU vs **W-TinyLFU**; why a scan wrecks LRU but not admission | eviction |
| `npm run phase11` | **Cache penetration** — a real bloom filter + short-TTL negative caching (read-after-create gotcha) | the "interview meat" |
| `npm run phase12` | **Sizing** — DB-load = QPS×(1−hit) nonlinearity, memory & latency formulas | capacity math |
| `npm run phase13` | **Cache-down resilience** — concurrency limiter + circuit breaker so the DB survives a cold cache | fault tolerance |

Read `src/phase1/cache.ts` and `src/phase2/lru.ts` first — they're the whole
engines in a few dozen commented lines each.

## What each phase proves (the money quotes)

- **Phase 5** — a naive cache turns 50 concurrent misses into **50 DB calls**;
  single-flight coalesces them into **1**. That's a cache causing vs. preventing
  an outage.
- **Phase 6** — reproduces, deterministically, a cache that ends up **stale
  forever** even though the write "deleted" the key — then shows the versioning
  fix rejecting the stale write.
- **Phase 7** — adding a node remaps **~80%** of keys with naive `hash % N`, but
  only **~22%** with consistent hashing. That gap is why every real distributed
  cache uses it.

## The four decisions, mapped to phases

| Decision | Where |
|---|---|
| **Pattern** (aside / through / back) | Phases 3, 4 |
| **Staleness budget** (TTL + invalidation) | Phases 1, 6 |
| **Failure plan** (stampede, hot key, penetration) | Phases 5, 6 |
| **Consistency race** (cache vs DB) | Phase 6 |
| **Scaling out** (sharding, node churn) | Phase 7 |

## Interactive Cache Lab

Every phase is also a live instrument in the browser — watch the hit rate climb,
run a scan that wrecks LRU but not W-TinyLFU, fire 50 requests at an expired key,
step the stale-read race, flood a bloom filter, and drag the sizing knobs.

```bash
npm run web        # serves web/index.html at http://localhost:8080 (no deps)
```

One self-contained static page (self-hosted fonts), grouped by tier. To host it on
**Cloudflare Pages**: connect this repo in the dashboard with build output `web`
(auto-deploys on push), or run `npx wrangler login` then `npm run deploy`.

## Project layout

```
src/
  lib/log.ts                     shared timestamped logger
  phase1/  cache from scratch (TTL, hit/miss)
  phase2/  LRU eviction from scratch
  phase3/  Redis cache-aside
  phase4/  write patterns (through / back)
  phase5/  stampede + the three fixes
  phase6/  the consistency race + penetration
  phase7/  consistent hashing (distributed cache)
  phase8/  hot keys — near-cache, replication, sharded counters
  phase9/  probabilistic early expiration (XFetch)
  phase10/ eviction family — FIFO/LRU/LFU/W-TinyLFU
  phase11/ penetration — bloom filter + negative caching
  phase12/ sizing math (DB load, memory, latency)
  phase13/ cache-down resilience — limiter + circuit breaker
```

## License

MIT — use it, fork it, learn from it.
