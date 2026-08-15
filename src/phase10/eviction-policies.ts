/**
 * Phase 10 — THE EVICTION FAMILY beyond LRU: FIFO, LFU, LRU, and W-TinyLFU.
 *
 * Run with:  node "src/phase10/eviction-policies.ts"
 *
 * Phase 2 taught LRU: "recently used → probably wanted again." It's the default
 * almost everywhere (Redis `allkeys-lru`, HTTP caches, CPUs) because that bet is
 * usually right. But LRU has a famous failure mode, and there's a whole family
 * of policies that trade off differently. Same job — pick a victim when the cache
 * is full — different bet about WHICH key you'll want next:
 *
 *   - FIFO (First In First Out) → evict the oldest INSERTED key, ignore use.
 *       Simple, cache-friendly, but blind: it drops hot keys just for being old.
 *
 *   - LRU  (Least Recently Used) → evict the key untouched longest.
 *       Great on recency-heavy traffic. FATAL FLAW: SCANS. A one-pass sweep over
 *       many unique keys (a backup, an analytics query, `SELECT *`) marches every
 *       fresh key to the "most recently used" end and pushes your hot set out the
 *       bottom. The cache fills with keys you'll never read again. This is LRU's
 *       "scan vulnerability," and it's why LRU alone isn't enough.
 *
 *   - LFU  (Least Frequently Used) → evict the key accessed the FEWEST times.
 *       Immune to scans (a scan key has frequency 1; your hot keys have hundreds).
 *       But two problems: (a) CACHE POLLUTION / no aging — a key that was hot
 *       last hour keeps its huge count and refuses to leave long after it went
 *       cold ("LFU never forgets"); and (b) a genuinely-new hot key can't get in,
 *       because everything already resident has a higher historical count.
 *
 *   - W-TinyLFU → the modern answer, shipped by Caffeine (Java), and the design
 *       behind many production caches. It keeps an LRU-ish main cache for recency
 *       PLUS a tiny frequency sketch (a count-min sketch, aged periodically) used
 *       for ADMISSION: when the cache is full and a new candidate wants in, it is
 *       admitted ONLY IF its estimated frequency beats the victim it would evict.
 *       A one-hit-wonder scan key has frequency ~1, loses to your hot set, and is
 *       simply NOT ADMITTED — so the scan bounces off the door instead of flushing
 *       the cache. A small recency "window" still lets genuinely-new keys in, and
 *       periodic halving of the sketch ("aging") lets yesterday's hot keys fade.
 *
 * (Aside: real Redis LRU/LFU are APPROXIMATE — it samples a handful of keys and
 *  evicts the worst of the sample rather than scanning everything, trading a
 *  little accuracy for O(1). We build the exact versions here to see the policy.)
 *
 * MONEY QUOTE: LRU bets on recency and a scan defeats it; LFU bets on frequency
 * and never forgets; W-TinyLFU admits by frequency so a one-pass scan can't evict
 * the hot set — which is why Caffeine and modern caches ship it.
 */

import { log } from "../lib/log.ts";

// ─── A cache is anything that answers get/set and reports its hit rate ─────────
interface Cache {
  readonly name: string;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  hitRate(): number;
  resetStats(): void;
}

// ─── FIFO: evict the oldest INSERTED key, ignoring how often it's used ─────────
class FIFOCache implements Cache {
  readonly name = "FIFO";
  private store = new Map<string, string>(); // Map keeps insertion order
  private hits = 0;
  private gets = 0;
  private capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: string): string | undefined {
    this.gets++;
    if (this.store.has(key)) {
      this.hits++;
      return this.store.get(key);
    }
    return undefined;
  }

  set(key: string, value: string): void {
    if (this.store.has(key)) {
      this.store.set(key, value); // update in place — do NOT reorder (that's the point)
      return;
    }
    this.store.set(key, value);
    if (this.store.size > this.capacity) {
      const oldest = this.store.keys().next().value as string; // first inserted
      this.store.delete(oldest);
    }
  }

  hitRate(): number {
    return this.gets ? this.hits / this.gets : 0;
  }
  resetStats(): void {
    this.hits = this.gets = 0;
  }
}

// ─── LRU: evict least-recently-used (the phase-2 Map trick) ────────────────────
class LRUCache implements Cache {
  readonly name = "LRU";
  private store = new Map<string, string>();
  private hits = 0;
  private gets = 0;
  private capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: string): string | undefined {
    this.gets++;
    if (!this.store.has(key)) return undefined;
    this.hits++;
    // Touch: delete + re-set moves the key to the most-recently-used end.
    const v = this.store.get(key)!;
    this.store.delete(key);
    this.store.set(key, v);
    return v;
  }

  set(key: string, value: string): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
    if (this.store.size > this.capacity) {
      const lru = this.store.keys().next().value as string; // least recently used
      this.store.delete(lru);
    }
  }

  hitRate(): number {
    return this.gets ? this.hits / this.gets : 0;
  }
  resetStats(): void {
    this.hits = this.gets = 0;
  }
}

// ─── LFU: evict least-frequently-used (min access count; ties → oldest) ────────
class LFUCache implements Cache {
  readonly name = "LFU";
  private store = new Map<string, string>();
  private freq = new Map<string, number>();
  private hits = 0;
  private gets = 0;
  private capacity: number;
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: string): string | undefined {
    this.gets++;
    if (!this.store.has(key)) return undefined;
    this.hits++;
    this.freq.set(key, (this.freq.get(key) ?? 0) + 1); // count every access
    return this.store.get(key);
  }

  set(key: string, value: string): void {
    if (this.store.has(key)) {
      this.store.set(key, value);
      return;
    }
    if (this.store.size >= this.capacity) {
      // Victim = minimum frequency; tie broken by oldest insertion (Map order).
      let victim: string | undefined;
      let min = Infinity;
      for (const k of this.store.keys()) {
        const f = this.freq.get(k) ?? 0;
        if (f < min) {
          min = f;
          victim = k;
        }
      }
      if (victim !== undefined) {
        this.store.delete(victim);
        this.freq.delete(victim); // NOTE: forgetting on eviction; real LFU keeps a sketch
      }
    }
    this.store.set(key, value);
    this.freq.set(key, this.freq.get(key) ?? 1); // fresh key starts at 1
  }

  hitRate(): number {
    return this.gets ? this.hits / this.gets : 0;
  }
  resetStats(): void {
    this.hits = this.gets = 0;
  }
}

// ─── A small, real count-min sketch: frequency estimates in fixed memory ───────
// Four hash rows; estimate(key) = min over rows (min cancels most collisions).
// Every `sampleSize` increments we HALVE all counters ("aging") so old heat fades
// — this is what stops W-TinyLFU from becoming LFU-that-never-forgets.
class CountMinSketch {
  private readonly depth = 4;
  private readonly width: number;
  private table: Uint32Array;
  private additions = 0;
  private readonly seeds = [0x9e3779b1, 0x85ebca77, 0xc2b2ae3d, 0x27d4eb2f];
  private sampleSize: number;
  constructor(width: number, sampleSize: number) {
    this.width = width;
    this.sampleSize = sampleSize;
    this.table = new Uint32Array(width * this.depth);
  }

  private hash(key: string, seed: number): number {
    let h = seed >>> 0; // FNV-1a-ish, seeded
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % this.width;
  }

  increment(key: string): void {
    for (let r = 0; r < this.depth; r++) {
      this.table[r * this.width + this.hash(key, this.seeds[r])]++;
    }
    if (++this.additions >= this.sampleSize) this.reset();
  }

  estimate(key: string): number {
    let m = Infinity;
    for (let r = 0; r < this.depth; r++) {
      m = Math.min(m, this.table[r * this.width + this.hash(key, this.seeds[r])]);
    }
    return m;
  }

  private reset(): void {
    for (let i = 0; i < this.table.length; i++) this.table[i] >>= 1; // halve = age
    this.additions >>= 1;
  }
}

// ─── W-TinyLFU: a recency window + LRU main cache gated by frequency admission ─
class WTinyLFUCache implements Cache {
  readonly name = "W-TinyLFU";
  private window = new Map<string, string>(); // small recency window (~10%)
  private main = new Map<string, string>(); // the protected bulk of the cache
  private readonly windowCap: number;
  private readonly mainCap: number;
  private sketch: CountMinSketch;
  private hits = 0;
  private gets = 0;

  constructor(capacity: number) {
    this.windowCap = Math.max(1, Math.round(capacity * 0.1));
    this.mainCap = capacity - this.windowCap;
    // Sketch width ~ generous vs. capacity; age often enough to stay adaptive.
    this.sketch = new CountMinSketch(128, capacity * 32);
  }

  get(key: string): string | undefined {
    this.gets++;
    this.sketch.increment(key); // record frequency of EVERY access, hit or miss
    if (this.window.has(key)) {
      this.hits++;
      const v = this.window.get(key)!;
      this.window.delete(key);
      this.window.set(key, v); // LRU touch within window
      return v;
    }
    if (this.main.has(key)) {
      this.hits++;
      const v = this.main.get(key)!;
      this.main.delete(key);
      this.main.set(key, v); // LRU touch within main
      return v;
    }
    return undefined;
  }

  set(key: string, value: string): void {
    if (this.window.has(key)) {
      this.window.set(key, value);
      return;
    }
    if (this.main.has(key)) {
      this.main.set(key, value);
      return;
    }
    // New keys always land in the recency window first.
    this.window.set(key, value);
    if (this.window.size <= this.windowCap) return;

    // Window overflowed: its LRU key becomes a CANDIDATE for the main cache.
    const candKey = this.window.keys().next().value as string;
    const candVal = this.window.get(candKey)!;
    this.window.delete(candKey);

    if (this.main.size < this.mainCap) {
      this.main.set(candKey, candVal); // room to spare — no contest yet
      return;
    }

    // Main is full: TinyLFU ADMISSION. Candidate must out-rank the victim it
    // would evict, or it is rejected and the incumbent survives. THIS is the
    // door a one-pass scan key (frequency ~1) cannot get through.
    const victimKey = this.main.keys().next().value as string; // main's LRU
    if (this.sketch.estimate(candKey) > this.sketch.estimate(victimKey)) {
      this.main.delete(victimKey);
      this.main.set(candKey, candVal); // admitted: it earned its place
    }
    // else: candidate dropped. The hot incumbent stays put.
  }

  hitRate(): number {
    return this.gets ? this.hits / this.gets : 0;
  }
  resetStats(): void {
    this.hits = this.gets = 0;
  }
}

// ─── Deterministic PRNG (mulberry32) so every run reproduces exactly ───────────
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Workload harness: read-through (on a miss, load the value) ────────────────
function makeCaches(capacity: number): Cache[] {
  return [
    new FIFOCache(capacity),
    new LRUCache(capacity),
    new LFUCache(capacity),
    new WTinyLFUCache(capacity),
  ];
}

function warm(cache: Cache, seq: string[]): void {
  for (const k of seq) if (cache.get(k) === undefined) cache.set(k, k);
}

function measure(cache: Cache, seq: string[]): number {
  cache.resetStats(); // count hits only over the measured phase
  for (const k of seq) if (cache.get(k) === undefined) cache.set(k, k);
  return cache.hitRate();
}

function printTable(caches: Cache[], rates: number[]): void {
  log(`   ${"Policy".padEnd(11)} Hit rate`);
  log(`   ${"─".repeat(11)} ────────`);
  caches.forEach((c, i) => {
    const bar = "█".repeat(Math.round(rates[i] * 20));
    log(`   ${c.name.padEnd(11)} ${(rates[i] * 100).toFixed(1).padStart(5)}%  ${bar}`);
  });
}

// ─── Workload 1: SKEWED (Zipf-ish) — a few hot keys dominate the traffic ───────
function buildZipfWorkload(): string[] {
  const rng = mulberry32(0xca11ab1e); // fixed seed → reproducible
  const universe = Array.from({ length: 60 }, (_, i) => `k${i}`);
  const s = 1.0; // Zipf exponent
  const weights = universe.map((_, i) => 1 / Math.pow(i + 1, s));
  const total = weights.reduce((a, b) => a + b, 0);
  const cum: number[] = [];
  let acc = 0;
  for (const w of weights) {
    acc += w / total;
    cum.push(acc);
  }
  const seq: string[] = [];
  for (let n = 0; n < 4000; n++) {
    const r = rng();
    let idx = cum.findIndex((c) => r <= c);
    if (idx < 0) idx = universe.length - 1;
    seq.push(universe[idx]);
  }
  return seq;
}

// ─── Workload 2: SCAN + hot-set — a stable hot set flushed by a one-pass scan ──
// Warm-up teaches every cache the hot set. Then bursts of UNIQUE scan keys
// (each burst larger than the whole cache) are interleaved with hot rounds.
function buildScanWorkload(): { warmUp: string[]; measured: string[]; hotFraction: number } {
  const hot = Array.from({ length: 8 }, (_, i) => `h${i}`);
  const scan = Array.from({ length: 300 }, (_, i) => `s${i}`);
  const burst = 16; // >= capacity, so a single burst can flush an LRU cache

  const warmUp: string[] = [];
  for (let round = 0; round < 40; round++) for (const h of hot) warmUp.push(h);

  const measured: string[] = [];
  let hotAccesses = 0;
  let si = 0;
  while (si < scan.length) {
    for (let b = 0; b < burst && si < scan.length; b++) measured.push(scan[si++]);
    for (const h of hot) {
      measured.push(h);
      hotAccesses++;
    }
  }
  return { warmUp, measured, hotFraction: hotAccesses / measured.length };
}

function main() {
  const CAP = 16;

  log("═══ Workload 1 — SKEWED (Zipf): a few hot keys carry most traffic ═══");
  log(`   capacity=${CAP}, 60-key universe, 4000 accesses, Zipf s=1.0 (seeded)`);
  const zipf = buildZipfWorkload();
  const skewCaches = makeCaches(CAP);
  const skewRates = skewCaches.map((c) => measure(c, zipf));
  printTable(skewCaches, skewRates);
  log("");
  log("   Read: FIFO is worst — it evicts hot keys just for being OLD. LRU is");
  log("   decent (hot keys stay recent). LFU and W-TinyLFU win — they keep what's");
  log("   frequently used, which is exactly the hot set under a skewed load.");

  log("");
  log("═══ Workload 2 — SCAN + hot-set: a long one-pass scan hits a stable hot set ═══");
  const { warmUp, measured, hotFraction } = buildScanWorkload();
  log(`   capacity=${CAP}, 8 hot keys pre-warmed, 300 unique scan keys in bursts of 16`);
  log(`   (hot accesses are ${(hotFraction * 100).toFixed(0)}% of the measured stream — the rest is scan)`);
  const scanCaches = makeCaches(CAP);
  const scanRates = scanCaches.map((c) => {
    warm(c, warmUp); // establish the hot set (and W-TinyLFU's frequencies)
    return measure(c, measured);
  });
  printTable(scanCaches, scanRates);
  log("");
  log("   Read: the scan WRECKS FIFO and LRU — each 16-key burst flushes the whole");
  log("   cache, so every hot access that follows misses. LFU and W-TinyLFU refuse");
  log("   to admit frequency-1 scan keys over the hot set, so the hot set survives.");
  log("   W-TinyLFU is the one that ALSO kept LRU's recency edge (see workload 1) —");
  log("   frequency admission + a recency window + aging is why Caffeine ships it.");

  log("");
  log("═══ Takeaways ═══");
  log("   • FIFO ignores use — cheap, but evicts hot keys for the crime of being old.");
  log("   • LRU bets on recency; a one-pass SCAN marches fresh keys in and evicts the");
  log("     hot set. This scan-vulnerability is LRU's defining weakness.");
  log("   • LFU bets on frequency — scan-proof — but never forgets: stale hot keys");
  log("     linger, and new hot keys struggle to displace old high-count residents.");
  log("   • W-TinyLFU admits a candidate only if its estimated frequency beats the");
  log("     victim's, so a scan can't evict the hot set; a small window keeps recency");
  log("     and periodic sketch-aging lets yesterday's heat fade. The modern default.");
  log("   • In practice Redis approximates LRU/LFU by SAMPLING a few keys per eviction");
  log("     (not an exact global scan) — near-optimal victims at O(1) cost.");

  process.exit(0);
}

main();
