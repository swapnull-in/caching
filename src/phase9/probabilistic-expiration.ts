/**
 * Phase 9 — PROBABILISTIC EARLY EXPIRATION (XFetch): the lock-free stampede fix.
 *
 * Run with:  node "src/phase9/probabilistic-expiration.ts"
 *
 * Phase 5 gave three answers to the cache stampede (thundering herd):
 *   1. SINGLE-FLIGHT — one request recomputes, the rest wait on its promise.
 *   2. JITTERED TTL  — spread expiry times so keys don't all die at once.
 *   3. STALE-WHILE-REVALIDATE — serve stale, refresh once in the background.
 * This is the elegant FOURTH answer, and it needs no lock and no coordination.
 *
 * THE INSIGHT: a hard TTL is a CLIFF. The value is fresh, fresh, fresh... then
 * at one exact instant it's dead, and every concurrent reader misses in the same
 * instant and stampedes the recompute together. Single-flight fixes this by
 * serializing the herd behind a lock. But what if no request ever had to wait at
 * a locked door — because the herd simply never formed?
 *
 * XFetch (Vattani, Chierichetti, Lowenstein — "Optimal Probabilistic Cache
 * Stampede Prevention", VLDB 2015) does exactly that. On every read of a
 * near-expiry key, the reader flips a weighted coin. If it wins, it refreshes
 * the value EARLY — a little before the TTL cliff. The coin is rigged so that:
 *
 *     refresh early  ⇔   now - delta * beta * ln(rand())  >=  expiry
 *
 *   • delta = the MEASURED recompute time (how long this value took to rebuild).
 *   • beta  = eagerness knob, >= 1. Higher beta ⇒ refresh earlier / more often.
 *   • rand() in (0,1]  ⇒  ln(rand()) < 0, so the middle term is a POSITIVE
 *     random slice of delta added onto `now`, nudging it toward `expiry`.
 *
 * Rearranged, the per-read refresh probability is a clean exponential:
 *
 *     P(refresh) = exp( -(expiry - now) / (delta * beta) )
 *
 * Far from expiry the gap is large ⇒ P ≈ 0 (nobody refreshes early, no waste).
 * As `now` creeps toward `expiry` the gap shrinks ⇒ P rises smoothly toward 1.
 * Expensive values (big delta) start refreshing sooner — they're worth protecting
 * earliest. With many readers per tick, SOME single lucky reader wins the coin
 * a few ticks BEFORE the cliff, refreshes, and pushes `expiry` forward. Now every
 * other reader sees a fresh value and a large gap again ⇒ the herd never gathers.
 *
 * WHY THIS BEATS A PLAIN LOCK / SINGLE-FLIGHT:
 *   - No lock, no shared in-flight promise, no serialized wait. Nobody blocks.
 *   - No coordination: each reader decides ALONE with local math + one random draw.
 *   - The recompute happens BEFORE expiry, so there is never a miss to stampede.
 *     Single-flight still lets the value die, then makes the herd queue up; XFetch
 *     refreshes ahead of death so the miss (and the queue) simply don't occur.
 *   - It COMPOSES with the phase-5 tools: add jitter so many keys' cliffs aren't
 *     aligned, keep single-flight as a belt-and-suspenders cap, and let SWR serve
 *     the (still-fresh) value with zero latency while XFetch refreshes it early.
 *
 * MONEY QUOTE: probabilistic early expiration turns the synchronized TTL cliff
 * into a smooth, self-organizing early refresh — one lucky request recomputes
 * ahead of expiry, so the herd never forms, with no lock and no coordination.
 */

import { log } from "../lib/log.ts";

// ─── Seeded PRNG (mulberry32) so every run is byte-for-byte reproducible ──────
// Randomness is intrinsic to XFetch, so we pin the seed instead of Math.random,
// and we drive "time" with an explicit tick counter (never Date.now()).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // [0, 1)
  };
}
// XFetch needs rand() in (0,1] so ln() is finite; shift [0,1) → (0,1].
const rand01 = (rng: () => number) => 1 - rng();

// ─── Workload knobs (all in abstract "ticks", no wall-clock) ─────────────────
const TICKS = 30; // how long we watch the hot key
const READERS_PER_TICK = 10; // concurrent readers hammering one hot key each tick
const TTL = 10; // hard time-to-live: value set at t → expires at t + TTL
const DELTA = 2; // measured recompute cost of THIS value (in ticks)
const BETA = 1; // eagerness; >= 1. Higher ⇒ refresh earlier. We show a sweep too.

type TickCounts = { perTick: number[]; total: number };

/** Pretty per-tick bar so the SHAPE of the recompute load is obvious at a glance. */
function renderPerTick(counts: number[]): void {
  counts.forEach((c, t) => {
    if (c === 0) return; // only print ticks that actually recomputed
    const bar = "█".repeat(c);
    log(`   t=${String(t).padStart(2)}  recomputes=${String(c).padStart(2)}  ${bar}`);
  });
}

// ─── STRATEGY A: HARD TTL — the synchronized cliff ───────────────────────────
// Every reader within a tick sees the SAME cache state (they're concurrent). The
// instant `now >= expiry`, the whole tick's readers miss together and every one
// of them recomputes → a spike exactly at the cliff. Classic thundering herd.
function runHardTtl(): TickCounts {
  const perTick = new Array(TICKS).fill(0);
  let total = 0;
  let expiry = TTL; // value freshly written at t=0

  for (let now = 0; now < TICKS; now++) {
    let recomputesThisTick = 0;
    const expired = now >= expiry; // decided ONCE per tick → all readers agree
    for (let r = 0; r < READERS_PER_TICK; r++) {
      if (expired) recomputesThisTick++; // every concurrent miss hits the DB
    }
    if (expired) expiry = now + TTL; // value rebuilt, cliff moves to the next TTL
    perTick[now] = recomputesThisTick;
    total += recomputesThisTick;
  }
  return { perTick, total };
}

// ─── STRATEGY B: XFETCH — probabilistic early refresh ────────────────────────
// Same workload, but each read draws its own coin. The first reader whose coin
// wins refreshes EARLY and pushes `expiry` forward; everyone after sees a fresh
// value + a wide gap, so the probability collapses and no herd assembles.
function runXFetch(beta: number, seed: number): TickCounts {
  const rng = mulberry32(seed);
  const perTick = new Array(TICKS).fill(0);
  let total = 0;
  let expiry = TTL; // value freshly written at t=0
  let delta = DELTA; // measured recompute time of the last rebuild

  for (let now = 0; now < TICKS; now++) {
    let recomputesThisTick = 0;
    for (let r = 0; r < READERS_PER_TICK; r++) {
      // The XFetch rule, straight from the paper:
      //   refresh early if  now - delta * beta * ln(rand())  >=  expiry
      const trigger = now - delta * beta * Math.log(rand01(rng));
      if (trigger >= expiry) {
        recomputesThisTick++;
        delta = DELTA; // we just measured the recompute again (constant here)
        expiry = now + TTL; // refreshed ahead of the cliff → gap reopens for the rest
      }
      // else: value still fresh, serve it with zero work. No lock, no wait.
    }
    perTick[now] = recomputesThisTick;
    total += recomputesThisTick;
  }
  return { perTick, total };
}

async function main() {
  log("═══ One hot key, 10 concurrent readers per tick, hard TTL = 10 ═══");
  log(`   ${READERS_PER_TICK} readers/tick × ${TICKS} ticks. Value recompute cost delta=${DELTA}.`);
  log("");

  log("═══ Strategy A — HARD TTL: the synchronized stampede ═══");
  const hard = runHardTtl();
  renderPerTick(hard.perTick);
  log(`   → total recomputes: ${hard.total}  💥 (whole herd fires at each cliff: t=10, t=20)`);
  log("");

  log("═══ Strategy B — XFETCH (beta=1): self-organizing early refresh ═══");
  const xfetch = runXFetch(BETA, 42);
  renderPerTick(xfetch.perTick);
  log(`   → total recomputes: ${xfetch.total}  ✓ (a lone reader refreshes early — no spike)`);
  log("");

  log("═══ How beta tunes eagerness (same seed, same workload) ═══");
  for (const beta of [0.5, 1, 2, 4]) {
    const run = runXFetch(beta, 42);
    const firstRefresh = run.perTick.findIndex((c) => c > 0);
    log(
      `   beta=${beta.toString().padStart(3)}  total recomputes=${String(run.total).padStart(2)}` +
        `  first refresh at t=${firstRefresh}  (higher beta ⇒ refresh earlier / more often)`,
    );
  }
  log("");

  log("═══ Takeaways ═══");
  log(`   • Hard TTL fired ${hard.total} recomputes in synchronized spikes at the cliffs;`);
  log(`     XFetch fired ${xfetch.total}, spread out as single early refreshes — same freshness,`);
  log("     no thundering herd. The value is never actually allowed to go stale.");
  log("   • P(refresh) = exp(-(expiry-now)/(delta*beta)): ~0 far out, rising to 1 at the");
  log("     cliff. Expensive values (big delta) start protecting themselves earliest.");
  log("   • Beats a plain lock/single-flight: no lock, no shared promise, no serialized");
  log("     wait — each reader decides alone with local math + one random draw, and the");
  log("     refresh lands BEFORE expiry so there's never a miss for the herd to pile onto.");
  log("   • Composes with phase 5: jitter de-aligns many keys' cliffs, SWR serves the");
  log("     fresh value at zero latency, single-flight stays as a belt-and-suspenders cap.");
  log("   • The other three answers live in phase 5 (single-flight / jitter / SWR).");
  process.exit(0);
}

main();
