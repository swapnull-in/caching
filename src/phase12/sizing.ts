/**
 * Phase 12 — SIZING A CACHE: the back-of-envelope math you produce ON DEMAND.
 *
 * Run with:  node "src/phase12/sizing.ts"
 *
 * A Staff-level design interview isn't graded on whether your arithmetic is
 * perfect — it's graded on whether you REACH FOR THE RIGHT FORMULA without
 * being prompted. "How big should this cache be?" is not a vibe; it's three
 * napkin equations you should be able to write from memory:
 *
 *   1. DB LOAD SHED — how much traffic the cache keeps OFF the database:
 *          dbQPS = totalQPS × (1 − hitRatio)
 *      This is NONLINEAR. Going 95% → 99% doesn't shave off a little — it
 *      sheds ~5× more DB load (5,000 → 1,000 qps). 99% → 99.9% sheds another
 *      10×. The last few points of hit rate carry the most protection value,
 *      which is exactly why teams obsess over them.
 *
 *   2. MEMORY — how much RAM the hot set needs (NOT the whole dataset):
 *          bytes ≈ hotItems × avgItemBytes × (1+overhead) × replicas × (1+headroom)
 *      You size for the WORKING SET (the hot subset that's actually reused),
 *      inflate for per-entry overhead (key string + metadata + pointers +
 *      allocator slack), multiply by replicas, and leave headroom so you're
 *      not running at 100% (evictions thrash, fragmentation bites).
 *
 *   3. AVG LATENCY — what a typical read actually costs end-to-end:
 *          avg = hit × cacheLat + (1−hit) × dbLat
 *      A 1ms cache in front of a 50ms DB is a huge win, but the MISS term
 *      dominates the average until the hit rate gets very high — one 50ms miss
 *      drowns out fifty 1ms hits.
 *
 * MONEY QUOTE: cache sizing is a formula, not a guess — DB load = QPS×(1−hit)
 * is nonlinear (95→99% sheds 5× more), you size memory for the WORKING SET ×
 * overhead × replicas × headroom, and average latency is hit×cache + miss×DB.
 * State the formula, then plug numbers.
 */

import { log } from "../lib/log.ts";

// ─── The three (four) pure functions — this is what you'd write on the board ──

/** DB queries per second that the cache does NOT absorb. */
function dbQPS(totalQPS: number, hitRatio: number): number {
  return totalQPS * (1 - hitRatio);
}

/**
 * Bytes of RAM to provision for the hot set.
 *   hotItems      — WORKING SET size (hot subset), not the whole dataset
 *   avgItemBytes  — average serialized value size
 *   overheadFactor — per-entry overhead (key + metadata + pointers + slack), e.g. 0.30 = +30%
 *   replicas      — copies for HA / read fan-out
 *   headroom      — spare capacity so you don't run at 100%, e.g. 0.30 = +30%
 */
function memoryBytes(
  hotItems: number,
  avgItemBytes: number,
  overheadFactor: number,
  replicas: number,
  headroom: number,
): number {
  return hotItems * avgItemBytes * (1 + overheadFactor) * replicas * (1 + headroom);
}

/** Average read latency across hits and misses. */
function avgLatency(hitRatio: number, cacheLatMs: number, dbLatMs: number): number {
  return hitRatio * cacheLatMs + (1 - hitRatio) * dbLatMs;
}

/** Rough node count to hold a memory footprint, given per-node usable capacity. */
function nodeCount(totalGiB: number, perNodeGiB: number): number {
  return Math.ceil(totalGiB / perNodeGiB);
}

// ─── Formatting helpers (presentation only — no logic, fully deterministic) ───

const GiB = 1024 ** 3;
const pad = (s: string | number, w: number) => String(s).padStart(w);
const int = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (r: number) => (r * 100).toFixed(r >= 0.999 ? 1 : 0) + "%";

function main() {
  log("Interviewers grade the METHOD (did you reach for the formula?), not the");
  log("arithmetic. So for each quantity: state the formula, THEN plug numbers.");
  log("");

  // ─── 1. DB LOAD SHED ────────────────────────────────────────────────────
  log("═══ 1. DB LOAD SHED — how much traffic never reaches the database ═══");
  log("FORMULA:  dbQPS = totalQPS × (1 − hitRatio)");
  const totalQPS = 100_000;
  log(`Plugging totalQPS = ${int(totalQPS)}:`);
  log("");
  log(`   ${pad("hitRatio", 9)} │ ${pad("cache absorbs", 14)} │ ${pad("DB sees (qps)", 14)} │ vs previous`);
  log(`   ${"─".repeat(9)}─┼─${"─".repeat(14)}─┼─${"─".repeat(14)}─┼────────────`);
  const ratios = [0.5, 0.8, 0.9, 0.95, 0.99, 0.999];
  let prevDb = 0;
  for (const r of ratios) {
    const db = dbQPS(totalQPS, r);
    const absorbed = totalQPS - db;
    const factor = prevDb === 0 ? "—" : `${(prevDb / db).toFixed(1)}× fewer`;
    log(`   ${pad(pct(r), 9)} │ ${pad(int(absorbed), 14)} │ ${pad(int(db), 14)} │ ${factor}`);
    prevDb = db;
  }
  log("");
  log("   ↑ NONLINEAR: 95% → 99% cuts DB load ~5× (5,000 → 1,000 qps);");
  log("     99% → 99.9% cuts it another ~10× (1,000 → 100 qps). The LAST few");
  log("     percent of hit rate carry the most load-shedding value.");
  log("");

  // ─── 2. MEMORY ──────────────────────────────────────────────────────────
  log("═══ 2. MEMORY — size the WORKING SET, not the whole dataset ═══");
  log("FORMULA:  bytes ≈ hotItems × avgItemBytes × (1+overhead) × replicas × (1+headroom)");
  const hotItems = 50_000_000;      // hot subset actually being reused
  const avgItemBytes = 2 * 1024;    // 2 KB per value
  const overhead = 0.30;            // key + metadata + pointers + allocator slack
  const replicas = 2;               // HA / read fan-out
  const headroom = 0.30;            // don't run at 100%
  log(
    `Plugging hotItems = ${int(hotItems)}, avgItem = 2 KB, overhead = ${pct(overhead)}, ` +
    `replicas = ${replicas}, headroom = ${pct(headroom)}:`,
  );
  log("");
  const raw = hotItems * avgItemBytes;
  const withOverhead = raw * (1 + overhead);
  const withReplicas = withOverhead * replicas;
  const total = memoryBytes(hotItems, avgItemBytes, overhead, replicas, headroom);
  const g = (b: number) => (b / GiB).toFixed(1) + " GiB";
  log(`   ${pad("raw hot data", 22)} = 50M × 2 KB${pad("", 10)} = ${g(raw)}`);
  log(`   ${pad("× (1 + overhead 0.30)", 22)} = per-entry overhead ${pad("", 0)}= ${g(withOverhead)}`);
  log(`   ${pad("× replicas (2)", 22)} = HA / read fan-out${pad("", 3)}= ${g(withReplicas)}`);
  log(`   ${pad("× (1 + headroom 0.30)", 22)} = spare capacity ${pad("", 5)}= ${g(total)}   ← PROVISION THIS`);
  log("");
  log("   Note: it's the HOT SUBSET you size for. If the full dataset is 5B rows");
  log("   but only 50M are hot, you buy RAM for 50M — the rest lives in the DB.");
  log("");

  // ─── 3. AVG LATENCY ─────────────────────────────────────────────────────
  log("═══ 3. AVG LATENCY — the miss term dominates until hit rate is very high ═══");
  log("FORMULA:  avg = hitRatio × cacheLat + (1 − hitRatio) × dbLat");
  const cacheLat = 1;   // ms
  const dbLat = 50;     // ms
  log(`Plugging cacheLat = ${cacheLat}ms, dbLat = ${dbLat}ms:`);
  log("");
  log(`   ${pad("hitRatio", 9)} │ ${pad("hit term", 10)} │ ${pad("miss term", 10)} │ ${pad("avg latency", 12)}`);
  log(`   ${"─".repeat(9)}─┼─${"─".repeat(10)}─┼─${"─".repeat(10)}─┼─${"─".repeat(12)}`);
  for (const r of ratios) {
    const hitTerm = r * cacheLat;
    const missTerm = (1 - r) * dbLat;
    const avg = avgLatency(r, cacheLat, dbLat);
    log(
      `   ${pad(pct(r), 9)} │ ${pad(hitTerm.toFixed(2) + "ms", 10)} │ ` +
      `${pad(missTerm.toFixed(2) + "ms", 10)} │ ${pad(avg.toFixed(2) + "ms", 12)}`,
    );
  }
  log("");
  log("   ↑ At 50% hit rate the average is 25.5ms — barely better than the raw DB,");
  log("     because that single 50ms miss term drowns out the 1ms hits. Only near");
  log("     99%+ does the average collapse toward the 1ms cache latency.");
  log("");

  // ─── 4. NODE COUNT ──────────────────────────────────────────────────────
  log("═══ 4. NODE COUNT — turn the memory footprint into a cluster ═══");
  log("FORMULA:  nodes = ceil(totalGiB / perNodeGiB)");
  const perNodeGiB = 64;
  const totalGiB = total / GiB;
  const nodes = nodeCount(totalGiB, perNodeGiB);
  log(`Plugging totalGiB = ${totalGiB.toFixed(1)}, perNodeGiB = ${perNodeGiB}:`);
  log(`   nodes = ceil(${totalGiB.toFixed(1)} / ${perNodeGiB}) = ${nodes} nodes`);
  log("");
  log(`   Then sanity-check QPS: at ${int(totalQPS)} total qps across ${nodes} nodes that's`);
  log(`   ~${int(totalQPS / nodes)} qps/node — trivial for an in-memory store (100k+/node),`);
  log("   so here you're MEMORY-bound, not CPU/QPS-bound. Always state which bound wins.");
  log("");

  // ─── Takeaways ──────────────────────────────────────────────────────────
  log("═══ Takeaways ═══");
  log("• DB load = QPS×(1−hit) is NONLINEAR — 95→99% sheds ~5× more, 99→99.9% another ~10×.");
  log("• Size memory for the WORKING SET × (1+overhead) × replicas × (1+headroom).");
  log("• Avg latency = hit×cache + miss×DB — the miss term dominates until hit rate is high.");
  log("• Convert bytes → nodes with ceil(total/perNode), then check whether you're");
  log("  memory-bound or QPS-bound. State the formula, THEN plug numbers.");

  process.exit(0);
}

main();
