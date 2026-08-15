/**
 * Phase 13 — CACHE AVALANCHE & "THE DATABASE MUST SURVIVE LOSING THE CACHE."
 *
 * Run with:  node "src/phase13/cache-down-resilience.ts"
 *
 * THE PROBLEM: the cache goes cold all at once — a FLUSHALL, a node restart, a
 * mass TTL expiry, a lost replica. In that instant the hit rate drops to zero
 * and EVERY request becomes a miss. All of that traffic — the full, unfiltered
 * request rate the cache was absorbing — lands on the database simultaneously.
 * The cache was a dam holding back a reservoir; the dam just vanished.
 *
 * A database is not infinitely parallel. It can serve up to some CONCURRENCY
 * CAPACITY C of simultaneous queries within its latency SLA. Push past C and
 * queries queue, locks contend, context-switching thrashes, latency explodes,
 * and *goodput* (queries completed within SLA) COLLAPSES — often to zero. This
 * is a metastable failure (cf. phase 5's retry storm): once the DB is buried it
 * can't even serve the trickle of queries that would let the cache refill, so
 * it stays down. A cold cache became a full database outage.
 *
 * Two protections keep the DB alive under an uncached flood — and, crucially,
 * let it RECOVER:
 *
 *   1. CONCURRENCY LIMITER (a semaphore): cap in-flight DB queries at ~C. Admit
 *      what the DB can actually serve; SHED the rest immediately (fail fast).
 *      Bounded load means the DB stays healthy and its goodput refills the cache,
 *      which shrinks the miss rate, which shrinks the load — a recovery spiral.
 *
 *   2. CIRCUIT BREAKER: when the dependency itself is failing (timeouts cross a
 *      threshold), OPEN the circuit and fail fast — serve a typed error or stale
 *      value instantly instead of letting callers pile up on a dying DB. After a
 *      cooldown, HALF-OPEN sends one probe; success CLOSES it, failure re-opens.
 *
 * Plus CACHE WARMING / STAGGERED TTLs so you never hit the cold-start cliff in
 * the first place. The limiter converts "overload everything → total outage"
 * into "serve what you can, shed the rest → survivable + recoverable." The
 * breaker adds fail-fast so a sick dependency doesn't drag its callers down too.
 *
 * MONEY QUOTE: a cold cache must not become a DB outage — cap in-flight DB work
 * with a concurrency limiter and shed the rest with a circuit breaker, so the
 * database serves what it can and recovers instead of collapsing under the full
 * uncached load.
 */

import { log } from "../lib/log.ts";

// ─── Seeded PRNG (mulberry32) — deterministic runs, no Date.now() in logic ──
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

const pad = (n: number | string, w: number) => String(n).padStart(w);
const pct = (n: number) => (n * 100).toFixed(0) + "%";

// ─── The database: a hard concurrency capacity, beyond which goodput collapses ─
//
// serveWave(n) models one round's worth of `n` queries hitting the DB *at once*.
// Up to `capacity` they all complete within SLA. Past capacity the DB thrashes:
// the further past C we push, the lower the effective goodput — until, under a
// true flood, it drops to zero and the DB is stuck down. `healthy=false` models
// a lost node / failing dependency (every query times out regardless of load).
class Database {
  inFlight = 0;
  peakInFlight = 0;
  healthy = true;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  serveWave(n: number): { goodput: number; failed: number; collapsed: boolean } {
    this.inFlight = n;
    if (n > this.peakInFlight) this.peakInFlight = n;
    if (!this.healthy) return { goodput: 0, failed: n, collapsed: false };
    if (n <= this.capacity) return { goodput: n, failed: 0, collapsed: false };
    // Overloaded: throughput falls off as fast as we overshoot capacity.
    const goodput = Math.max(0, this.capacity - (n - this.capacity));
    return { goodput, failed: n - goodput, collapsed: goodput === 0 };
  }
}

// ─── Concurrency limiter: a non-blocking semaphore that FAILS FAST when full ─
// tryAcquire() returns false instead of queueing — shedding beats piling up.
class Semaphore {
  private inUse = 0;
  private readonly limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  tryAcquire(): boolean {
    if (this.inUse < this.limit) {
      this.inUse++;
      return true;
    }
    return false;
  }
  release(): void {
    if (this.inUse > 0) this.inUse--;
  }
}

// ─── Circuit breaker: open on repeated failure, half-open probe, close on success ─
type BreakerState = "closed" | "open" | "half-open";
class CircuitBreaker {
  state: BreakerState = "closed";
  private failures = 0;
  private openedAt = -Infinity;
  private readonly failThreshold: number;
  private readonly cooldownRounds: number;
  constructor(failThreshold: number, cooldownRounds: number) {
    this.failThreshold = failThreshold;
    this.cooldownRounds = cooldownRounds;
  }

  // Should a call be allowed through right now (round drives "time")?
  allows(round: number): boolean {
    if (this.state === "open") {
      if (round - this.openedAt >= this.cooldownRounds) {
        this.state = "half-open"; // let exactly one probe through
        return true;
      }
      return false; // fail fast — do not touch the sick dependency
    }
    return true; // closed or half-open (probe)
  }
  onSuccess(): void {
    if (this.state === "half-open") this.state = "closed";
    this.failures = 0;
  }
  onFailure(round: number): void {
    if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = round;
      this.failures = 0;
      return;
    }
    if (++this.failures >= this.failThreshold) {
      this.state = "open";
      this.openedAt = round;
    }
  }
}

// ─── Shared knobs for the avalanche demo ──────────────────────────────────────
const CAPACITY = 60; // DB can serve 60 simultaneous queries within SLA
const REQUESTS_PER_ROUND = 400; // the wave that used to be absorbed by the cache
const KEYSPACE = 300; // working set of hot keys
const ROUNDS = 12;
const SEED = 0xc0ffee;

interface RoundStats {
  round: number;
  hits: number;
  dbLoad: number; // in-flight DB queries this round
  goodput: number; // queries the DB completed within SLA
  shed: number; // requests failed fast by the limiter/breaker
  successRate: number; // fraction of the wave served (cache hit OR DB goodput)
  cached: number; // distinct keys now warm in cache
}

// One round of traffic. `protectedMode` toggles the limiter + breaker in front.
function runRound(
  protectedMode: boolean,
  db: Database,
  sem: Semaphore,
  breaker: CircuitBreaker,
  cache: Set<number>,
  round: number,
  rng: () => number,
): RoundStats {
  let hits = 0;
  let shed = 0;
  const admitted: number[] = [];

  for (let i = 0; i < REQUESTS_PER_ROUND; i++) {
    const key = Math.floor(rng() * KEYSPACE);
    if (cache.has(key)) {
      hits++;
      continue;
    }
    // Cache miss → this request needs the database.
    if (protectedMode) {
      if (!breaker.allows(round) || !sem.tryAcquire()) {
        shed++; // fail fast — bounded load, no pile-up
        continue;
      }
      admitted.push(key);
    } else {
      admitted.push(key); // NAIVE: every miss stampedes the DB, unbounded
    }
  }

  const res = db.serveWave(admitted.length);
  if (protectedMode) for (let i = 0; i < admitted.length; i++) sem.release();

  // Successful (goodput) queries warm the cache; failures teach the breaker.
  for (let i = 0; i < res.goodput; i++) cache.add(admitted[i]);
  if (protectedMode) {
    if (res.goodput > 0) breaker.onSuccess();
    if (res.failed > 0) breaker.onFailure(round);
  }

  const served = hits + res.goodput;
  return {
    round,
    hits,
    dbLoad: admitted.length,
    goodput: res.goodput,
    shed,
    successRate: served / REQUESTS_PER_ROUND,
    cached: cache.size,
  };
}

function header(): void {
  log(
    `   ${pad("round", 5)} │ ${pad("DB in-flight/cap", 16)} │ ${pad("goodput", 7)} │ ${pad("shed", 5)} │ ${pad("cache", 5)} │ success`,
  );
}
function row(s: RoundStats, cap: number): void {
  const overloaded = s.dbLoad > cap;
  const flag = overloaded ? "  💥 OVERLOADED" : s.successRate >= 0.95 ? "  ✓ recovered" : "";
  log(
    `   ${pad(s.round, 5)} │ ${pad(`${s.dbLoad}/${cap}`, 16)} │ ${pad(s.goodput, 7)} │ ${pad(s.shed, 5)} │ ${pad(s.cached, 5)} │ ${pad(pct(s.successRate), 4)}${flag}`,
  );
}

function avalancheDemo(): void {
  log("═══ 1. NAIVE — cache just went cold, every miss hits the DB directly ═══");
  log(`   Cache flushed. ${REQUESTS_PER_ROUND} req/round, DB capacity ${CAPACITY} concurrent queries.`);
  header();
  {
    const db = new Database(CAPACITY);
    const cache = new Set<number>(); // cold
    const sem = new Semaphore(CAPACITY); // unused in naive
    const breaker = new CircuitBreaker(3, 2); // unused in naive
    const rng = mulberry32(SEED);
    for (let r = 1; r <= ROUNDS; r++) {
      row(runRound(false, db, sem, breaker, cache, r, rng), CAPACITY);
    }
    log(`   → The full ${REQUESTS_PER_ROUND}-wide wave slams the DB every round. In-flight`);
    log(`     (${REQUESTS_PER_ROUND}) dwarfs capacity (${CAPACITY}) → goodput collapses to 0. Nothing gets`);
    log("     cached, so the miss rate never falls: the DB is stuck down. 0% served. 💀");
  }

  log("");
  log("═══ 2. PROTECTED — concurrency limiter (cap in-flight) + circuit breaker ═══");
  log(`   Same flood, but a semaphore admits ≤${CAPACITY} DB queries and sheds the rest fast.`);
  header();
  {
    const db = new Database(CAPACITY);
    const cache = new Set<number>(); // equally cold
    const sem = new Semaphore(CAPACITY);
    const breaker = new CircuitBreaker(3, 2);
    const rng = mulberry32(SEED); // same seed → same traffic, fair comparison
    let recoveredAt = 0;
    for (let r = 1; r <= ROUNDS; r++) {
      const s = runRound(true, db, sem, breaker, cache, r, rng);
      row(s, CAPACITY);
      if (!recoveredAt && s.successRate >= 0.95) recoveredAt = r;
    }
    log(`   → DB in-flight never exceeds capacity (peak ${db.peakInFlight} ≤ ${CAPACITY}) — it stays HEALTHY.`);
    log("     A bounded slice is shed fast each round (fail-fast, not pile-up), and every");
    log("     served DB query warms the cache — so the miss rate falls, the shed count");
    log(`     drops, and success climbs back to ~100% by round ${recoveredAt}. Bounded load ⇒ recovery.`);
    log(`     Circuit breaker stayed ${breaker.state.toUpperCase()}: the limiter kept the DB from ever failing.`);
  }
}

// ─── 3. Circuit breaker demo: a genuinely SICK dependency (node loss) ────────
// The limiter handles *overload*; the breaker handles a dependency that is
// *failing*. Here the DB loses a node for a stretch and times out every query.
function breakerDemo(): void {
  log("");
  log("═══ 3. CIRCUIT BREAKER — the dependency itself fails (lost DB node) ═══");
  log("   DB is unhealthy rounds 3–7 (every query times out), then recovers.");
  log("   Without a breaker, callers keep dialing a dead DB → pile-up. With one,");
  log("   they fail fast and give the DB room to come back.");
  log(`   ${pad("round", 5)} │ ${pad("DB", 9)} │ ${pad("breaker", 10)} │ ${pad("DB calls", 8)} │ served-fast`);

  const REQS = 40; // below capacity — so a HEALTHY DB always succeeds here;
  //                  the only failures come from the DB being down, not overload.
  const breaker = new CircuitBreaker(2, 2); // open after 2 failures, probe after 2 rounds
  const db = new Database(CAPACITY);
  for (let r = 1; r <= 12; r++) {
    db.healthy = !(r >= 3 && r <= 7);
    let dbCalls = 0;
    let failedFast = 0;
    // One representative call per round drives the breaker's state machine;
    // the rest of the wave follows the same verdict (allowed → DB, else shed).
    const allowed = breaker.allows(r);
    const verdict = breaker.state; // decision-time state: closed / half-open / open
    if (allowed) {
      dbCalls = REQS; // the wave reaches the DB
      const res = db.serveWave(REQS);
      if (res.failed > 0) breaker.onFailure(r);
      else breaker.onSuccess();
    } else {
      failedFast = REQS; // shed instantly with a typed error / stale value
    }
    const dbTag = db.healthy ? "up  " : "DOWN";
    log(
      `   ${pad(r, 5)} │ ${pad(dbTag, 9)} │ ${pad(verdict, 10)} │ ${pad(dbCalls, 8)} │ ${pad(failedFast, 4)}`,
    );
  }
  log("   → Once failures cross the threshold the breaker OPENS: DB calls drop to 0,");
  log("     callers fail fast instead of piling onto a dead DB. After the cooldown a");
  log("     HALF-OPEN probe tests the water; when the DB is back the probe succeeds and");
  log("     the breaker CLOSES. Fail-fast is what stops one sick dependency cascading.");
}

function main(): void {
  avalancheDemo();
  breakerDemo();

  log("");
  log("═══ Takeaways ═══");
  log("   • A cold cache (flush / restart / mass TTL expiry / node loss) turns the");
  log("     FULL request rate loose on the DB at once. The DB has a finite concurrency");
  log("     capacity; past it, goodput collapses and it stays down — a metastable outage.");
  log("   • CONCURRENCY LIMITER (semaphore): cap in-flight DB queries at ~capacity, shed");
  log("     the rest fast. Overload-everything→total-outage becomes serve-what-you-can→");
  log("     survivable. Bounded load lets goodput refill the cache and the system RECOVER.");
  log("   • CIRCUIT BREAKER: when the DB is *failing*, open and fail fast (typed error /");
  log("     stale value) so callers don't pile up; half-open probes let it heal, then close.");
  log("   • Prevent the cliff too: CACHE WARMING (pre-load hot keys before taking traffic)");
  log("     and STAGGERED/JITTERED TTLs so keys don't all expire in the same instant.");
  log("   • The database must survive losing the cache. Design the miss path for the day");
  log("     the hit rate is zero — that day will come.");

  process.exit(0);
}

main();
