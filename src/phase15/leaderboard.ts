/**
 * Phase 15 — DISTRIBUTED LEADERBOARD: top-K, "what's MY rank?", and friends.
 *
 * Run with:  node "src/phase15/leaderboard.ts"
 *
 * The canonical prompt: 50M players earn scores continuously; show the top-100,
 * each player's own rank, and a friends leaderboard; reset weekly.
 *
 * THE CRUX: top-N, my-rank, and my-neighbors are THREE DIFFERENT QUERIES with
 * three different costs — and the trap is trying to serve them from one structure:
 *
 *   - TOP-100    → same answer for everyone. One `ZREVRANGE`, cache it for
 *                  seconds; nobody can tell. Cheap.
 *   - MY-RANK    → different answer per player, and it changes on EVERY write
 *                  globally: rank is a GLOBAL PREFIX SUM (how many players score
 *                  above me?). `ZREVRANK` is O(log N) on one node — anywhere
 *                  else it's the actual design problem.
 *   - FRIENDS    → K point lookups of friends' scores (`ZMSCORE`), sort in hand.
 *                  The social graph provides the K; never a server-side global
 *                  structure.
 *
 * THE STRUCTURE: a Redis sorted set (ZSET) is really TWO structures glued
 * together — a hash (member → score, O(1) lookup) plus an ORDERED structure
 * over (score, member) for rank/range queries. Redis uses a skip-list; we use
 * a sorted array + binary search (same O(log N) search; our insert pays an
 * O(N) memmove where the skip-list pays O(log N) pointer surgery — fine for a
 * demo, and the SEMANTICS are identical).
 *
 * THE MEMORY MATH THAT KILLS PREMATURE DISTRIBUTION (the Staff move): 50M
 * players × (~16 B member + 8 B score + ~100 B skiplist/dict overhead) ≈ 6–8 GB
 * — ONE Redis node. 50M players averaging one update/minute ≈ 13K ops/s; a node
 * does ~100K. It fits with headroom. Sharding by player-id makes top-N a
 * scatter-gather and my-rank impossible; sharding by score range turns every
 * distribution shift into a rebalance. The right first answer is refusing to
 * distribute at all — and climbing a ladder ON EVIDENCE:
 *
 *   Rung 1: one sorted set + DB as truth (the ZSET is a rebuildable PROJECTION
 *           — losing Redis is a latency incident, not data loss).
 *   Rung 2: split the reads — top-N from a 5s cache, my-rank from replicas.
 *   Rung 3: billions of entries — BUCKET HISTOGRAM for approximate my-rank
 *           (rank is a prefix sum over ~10K score buckets: tiny, replicable
 *           anywhere, bounded error — product renders "~#4.2M" or "top 8%"),
 *           plus a nightly dense-rank SNAPSHOT for exactness. Live-approximate
 *           for the UI, periodic-exact for anything that pays out.
 *
 * ALSO IN HERE, because they're where the cheap points live:
 *   - Max-wins boards upsert `ZADD GT` (idempotent, retries free); additive
 *     boards increment — NOT idempotent — so dedup by event-id first.
 *   - Ties: composite-encode `score·2²² + (MAX_TS − achieved_at)` so the earlier
 *     achiever ranks higher (mind the 53-bit double mantissa: 22 bits of
 *     timestamp leaves a ~2³¹ score ceiling). And ZREVRANK gives an arbitrary
 *     slot within a tie group — competition rank is `ZCOUNT higher + 1`.
 *   - Resets are KEY SWAPS: key-per-period (`arena:weekly:2026-W33`),
 *     pre-create next period, flip a pointer, TTL the old key. Never
 *     remove-in-place at midnight on your hottest structure.
 *   - Multi-region: partition, don't replicate — regional boards natively; the
 *     "global" board is a MERGE of regional top-K snapshots, labeled as such.
 *
 * MONEY QUOTE: top-N, my-rank, and neighbors are three different queries with
 * three different costs — one sorted set carries 50M players (knowing when NOT
 * to distribute is the Staff move); past that, rank is a prefix sum: buckets
 * make it cheap and approximate, snapshots make it exact and stale, and the
 * product picks per surface. The board is a rebuildable projection; the
 * database is truth.
 */

import { log } from "../lib/log.ts";

// ─── Seeded PRNG (mulberry32) so every run is byte-for-byte reproducible ──────
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── A sorted set (ZSET) from scratch: hash + ordered structure ────────────────
// Redis glues a dict (member → score) to a SKIP-LIST ordered by (score, member).
// We glue a Map to a sorted ARRAY + binary search: identical semantics, same
// O(log N) rank/search; insert/delete pay an O(N) splice instead of the
// skip-list's O(log N) — the demo-grade trade.
interface Entry {
  member: string;
  score: number;
}

class SortedSet {
  private byMember = new Map<string, number>(); // the "dict" half: O(1) ZSCORE
  private sorted: Entry[] = []; // the "skip-list" half: (score asc, member asc)

  /** Redis ordering: score ascending, ties broken by member lexicographic. */
  private static before(aS: number, aM: string, bS: number, bM: string): boolean {
    if (aS !== bS) return aS < bS;
    return aM < bM;
  }

  /** Binary search: first index NOT before (score, member). O(log N). */
  private lowerBound(score: number, member: string): number {
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = this.sorted[mid];
      if (SortedSet.before(e.score, e.member, score, member)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** ZADD [GT]: set member's score; GT = only-if-greater (max-wins, idempotent). */
  zadd(member: string, score: number, mode: "SET" | "GT" = "SET"): boolean {
    const old = this.byMember.get(member);
    if (old !== undefined) {
      if (mode === "GT" && score <= old) return false; // retry-safe: no-op
      if (score === old) return false;
      this.sorted.splice(this.lowerBound(old, member), 1); // remove old position
    }
    this.byMember.set(member, score);
    this.sorted.splice(this.lowerBound(score, member), 0, { member, score });
    return true;
  }

  /** ZINCRBY: additive boards. NOT idempotent — dedup event-ids upstream! */
  zincrby(member: string, delta: number): number {
    const next = (this.byMember.get(member) ?? 0) + delta;
    this.zadd(member, next);
    return next;
  }

  /** ZSCORE: O(1) via the hash half. */
  zscore(member: string): number | undefined {
    return this.byMember.get(member);
  }

  /** ZMSCORE: the friends query — K point reads, sort in hand at the client. */
  zmscore(members: string[]): (number | undefined)[] {
    return members.map((m) => this.byMember.get(m));
  }

  zcard(): number {
    return this.sorted.length;
  }

  /** ZREVRANK: 0-based position from the TOP. O(log N). For tied scores this is
   *  an ARBITRARY slot within the tie group — see competitionRank below. */
  zrevrank(member: string): number | undefined {
    const score = this.byMember.get(member);
    if (score === undefined) return undefined;
    return this.sorted.length - 1 - this.lowerBound(score, member);
  }

  /** ZREVRANGE start..stop (inclusive), highest score first. */
  zrevrange(start: number, stop: number): Entry[] {
    const n = this.sorted.length;
    const out: Entry[] = [];
    for (let r = start; r <= Math.min(stop, n - 1); r++) out.push(this.sorted[n - 1 - r]);
    return out;
  }

  /** ZCOUNT (score, +inf): how many members score STRICTLY higher. O(log N). */
  zcountGreaterThan(score: number): number {
    // First index with entry.score > score  ⇒  everything from there up counts.
    let lo = 0;
    let hi = this.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid].score <= score) lo = mid + 1;
      else hi = mid;
    }
    return this.sorted.length - lo;
  }

  /** COMPETITION rank ("1224"): all ties share the low number. ZCOUNT higher + 1. */
  competitionRank(member: string): number | undefined {
    const score = this.byMember.get(member);
    if (score === undefined) return undefined;
    return this.zcountGreaterThan(score) + 1;
  }

  /** DENSE rank ("1223"): needs DISTINCT-score counting (Redis: a 2nd ZSET of
   *  unique scores; here a linear walk since it's a semantics demo). */
  denseRank(member: string): number | undefined {
    const score = this.byMember.get(member);
    if (score === undefined) return undefined;
    const higher = new Set<number>();
    for (const e of this.sorted) if (e.score > score) higher.add(e.score);
    return higher.size + 1;
  }
}

// ─── Composite tie-break encoding: score high bits, "earliness" low bits ───────
// Equal scores rank by who got there FIRST — deterministically, inside the ZSET
// score itself, no application-side second sort. THE CAVEAT (say it precisely):
// Redis scores are IEEE-754 doubles with a 53-bit mantissa. Giving 22 bits to
// the timestamp leaves 31 bits for the score — a hard ceiling of ~2.1 billion
// (2^31), above which low bits silently lose precision and ranking corrupts.
const TS_BITS = 22;
const TS_MAX = 2 ** TS_BITS - 1; // "minutes into the season" budget

function encodeScore(points: number, achievedAtMinute: number): number {
  // Earlier achievement ⇒ larger low bits ⇒ ranks higher among equal points.
  return points * 2 ** TS_BITS + (TS_MAX - achievedAtMinute);
}
function decodePoints(encoded: number): number {
  return Math.floor(encoded / 2 ** TS_BITS);
}

// ─── Rung 3: the bucket histogram — approximate my-rank as a prefix sum ────────
// Fix ~10K score buckets (we use fewer; same idea). my-rank ≈ Σ counts in higher
// buckets + interpolated position within my own bucket. The whole histogram is
// a few KB — replicate it anywhere, update it from the event stream, answer in
// O(buckets) with error bounded by the bucket's population. Nobody refreshing
// rank #4,231,882 needs the exact number — "~#4.2M" / "top 8%" is the product.
class BucketHistogram {
  private buckets: Uint32Array;
  private readonly width: number;
  private total = 0;

  constructor(maxScore: number, bucketCount: number) {
    this.width = Math.ceil(maxScore / bucketCount);
    this.buckets = new Uint32Array(bucketCount);
  }

  private bucketOf(score: number): number {
    return Math.min(this.buckets.length - 1, Math.floor(score / this.width));
  }

  /** Stream-maintained: on each score change, move one count between buckets. */
  onScore(oldScore: number | undefined, newScore: number): void {
    if (oldScore === undefined) this.total++;
    else this.buckets[this.bucketOf(oldScore)]--;
    this.buckets[this.bucketOf(newScore)]++;
  }

  /** Approximate rank = prefix sum of higher buckets + interpolation in mine. */
  approxRank(score: number): number {
    const b = this.bucketOf(score);
    let higher = 0;
    for (let i = b + 1; i < this.buckets.length; i++) higher += this.buckets[i];
    const bucketTop = (b + 1) * this.width;
    const aboveMeInBucket = this.buckets[b] * ((bucketTop - score) / this.width);
    return Math.max(1, Math.round(higher + aboveMeInBucket));
  }

  approxTopPercent(score: number): number {
    return (this.approxRank(score) / this.total) * 100;
  }

  myBucketPopulation(score: number): number {
    return this.buckets[this.bucketOf(score)];
  }

  bucketWidth(): number {
    return this.width;
  }
}

// ─── The simulated game season ─────────────────────────────────────────────────
const N_PLAYERS = 10_000;
const N_EVENTS = 30_000;
const REGIONS = ["us", "eu", "ap"] as const;

function playerId(i: number): string {
  return `p${String(i).padStart(4, "0")}`;
}
function regionOf(i: number): (typeof REGIONS)[number] {
  return REGIONS[i % REGIONS.length];
}

interface Season {
  global: SortedSet; // rung 1: ONE sorted set (what actually ships first)
  regional: Map<string, SortedSet>; // the multi-region variant, fed in parallel
  histogram: BucketHistogram; // rung 3, fed from the same stream
}

function simulateSeason(): Season {
  const rng = mulberry32(0x5eed_1eaf);
  const global = new SortedSet();
  const regional = new Map<string, SortedSet>(REGIONS.map((r) => [r, new SortedSet()]));
  const histogram = new BucketHistogram(32_768, 128);

  for (let e = 0; e < N_EVENTS; e++) {
    // Zipf-ish player pick: low indices play (and score) far more — a realistic
    // skewed game population, so the board has whales, a fat middle, and a tail.
    const i = Math.min(N_PLAYERS - 1, Math.floor(rng() ** 2.5 * N_PLAYERS));
    const points = 1 + Math.floor(rng() * 60);
    const id = playerId(i);

    const old = global.zscore(id);
    global.zincrby(id, points); // additive board: assume event-ids deduped upstream
    regional.get(regionOf(i))!.zincrby(id, points);
    histogram.onScore(old, (old ?? 0) + points); // projection fed from the SAME stream
  }
  return { global, regional, histogram };
}

// ─── Pretty-printers ───────────────────────────────────────────────────────────
function printBoard(rows: Entry[], startRank = 1): void {
  rows.forEach((e, i) => {
    log(`     #${String(startRank + i).padEnd(3)} ${e.member.padEnd(8)} ${String(e.score).padStart(6)} pts`);
  });
}

function main(): void {
  // ═══ 1 — The structure: a ZSET is a hash + an ordered index, glued ═══════════
  log("═══ 1 — The sorted set itself: ZADD / ZINCRBY / ZREVRANK / ZREVRANGE ═══");
  log("   (Redis: dict + skip-list. Ours: Map + sorted array + binary search —");
  log("    same semantics, same O(log N) rank; insert pays O(N) memmove.)");
  const tiny = new SortedSet();
  tiny.zadd("alice", 120);
  tiny.zadd("bob", 90);
  tiny.zadd("carol", 200);
  tiny.zincrby("bob", 45); // bob: 90 → 135, re-sorted in O(log N) + splice
  tiny.zadd("dave", 150);
  log(`   ZSCORE bob            → ${tiny.zscore("bob")}   (hash half: O(1))`);
  log(`   ZREVRANK bob          → ${tiny.zrevrank("bob")}     (ordered half: O(log N))`);
  log("   ZREVRANGE 0 2 (top-3):");
  printBoard(tiny.zrevrange(0, 2));

  // ═══ 2 — Three queries, three costs (the whole design in one section) ════════
  log("");
  log("═══ 2 — Three queries, three costs: top-N, my-rank, friends ═══");
  log(`   Season: ${N_PLAYERS.toLocaleString()} players, ${N_EVENTS.toLocaleString()} score events (seeded), additive board.`);
  log("   Memory math first — the Staff move: 50M players × (~16B member + 8B");
  log("   score + ~100B overhead) ≈ 6–8 GB, and ~13K ops/s of updates. That is");
  log("   ONE Redis node with replicas. Refuse to distribute; climb on evidence.");
  const season = simulateSeason();
  const { global, histogram } = season;
  log(`   Board built: ZCARD = ${global.zcard().toLocaleString()} players.`);
  log("");
  log("   Query A — TOP-10 (one ZREVRANGE; same answer for everyone → cache it");
  log("   for 5s in front of a replica; it's CS-27's top-K output):");
  printBoard(global.zrevrange(0, 9));

  // A mid-tier player: same board, completely different query shape.
  const midRow = global.zrevrange(4000, 4000)[0];
  const me = midRow.member;
  const myRank = global.zrevrank(me)!;
  log("");
  log(`   Query B — MY-RANK for mid-tier ${me}: ZREVRANK → #${(myRank + 1).toLocaleString()} of ${global.zcard().toLocaleString()}`);
  log("   (O(log N) here — but ONLY because the set lives on one node. Rank is a");
  log("    global prefix sum: it changes on every write, anywhere. This query is");
  log("    the actual design problem; serve it from replicas.)");

  const rngFriends = mulberry32(0xf12e_0d5);
  const friends = Array.from(
    { length: 8 },
    () => playerId(Math.floor(rngFriends() * N_PLAYERS)),
  );
  const friendScores = global.zmscore(friends);
  const friendBoard = friends
    .map((f, i) => ({ member: f, score: friendScores[i] ?? 0 }))
    .concat([{ member: me, score: global.zscore(me)! }])
    .sort((a, b) => b.score - a.score || (a.member < b.member ? -1 : 1));
  log("");
  log(`   Query C — FRIENDS board for ${me}: ZMSCORE 8 ids + sort IN HAND`);
  log("   (the social graph provides the K — never a server-side global structure):");
  printBoard(friendBoard);

  // ═══ 3 — Writes: max-wins is idempotent, additive is not ═════════════════════
  log("");
  log("═══ 3 — Writes & retries: ZADD GT (max-wins) vs ZINCRBY (additive) ═══");
  log("   The DB row is TRUTH; the ZSET is a rebuildable projection fed by the");
  log("   event stream — losing Redis is a latency incident, not data loss.");
  const highScore = new SortedSet();
  highScore.zadd("kai", 800, "GT");
  const retry1 = highScore.zadd("kai", 800, "GT"); // duplicate delivery
  const worse = highScore.zadd("kai", 650, "GT"); // late, lower score
  log(`   Max-wins: ZADD GT kai 800 → ok; retry of 800 → applied=${retry1};`);
  log(`   late lower 650 → applied=${worse}. Score stays ${highScore.zscore("kai")}: retries are FREE.`);
  const points = new SortedSet();
  const seenEvents = new Set<string>();
  const deliver = (eventId: string, member: string, delta: number): void => {
    if (seenEvents.has(eventId)) {
      log(`   Additive: event ${eventId} REPLAYED → deduped (increment is not idempotent)`);
      return;
    }
    seenEvents.add(eventId);
    points.zincrby(member, delta);
  };
  deliver("evt-101", "kai", 50);
  deliver("evt-102", "kai", 25);
  deliver("evt-101", "kai", 50); // at-least-once delivery strikes again
  log(`   kai's points = ${points.zscore("kai")} (75, not 125 — event-id dedup BEFORE the projection).`);

  // ═══ 4 — Ties: composite encoding + competition vs dense rank ════════════════
  log("");
  log("═══ 4 — Tie semantics: who's higher at the same score? ═══");
  const enc = new SortedSet();
  enc.zadd("early", encodeScore(900, 100)); // hit 900 pts at minute 100
  enc.zadd("late", encodeScore(900, 200)); // hit 900 pts at minute 200
  const top = enc.zrevrange(0, 1);
  log("   Composite encode score·2^22 + (MAX_TS − achieved_at): same 900 points —");
  log(`     #1 ${top[0].member} (${decodePoints(top[0].score)} pts)  #2 ${top[1].member} (${decodePoints(top[1].score)} pts) — earlier achiever wins, in the score itself.`);
  log("   CAVEAT: doubles have a 53-bit mantissa; 22 timestamp bits leave a ~2^31");
  log("   score ceiling — budget the split or use member-lexicographic tiebreak.");
  const tied = new SortedSet();
  for (const [m, s] of [["ana", 100], ["ben", 100], ["cat", 100], ["dov", 90]] as const) tied.zadd(m, s);
  log("   Three players at 100, one at 90 — ZREVRANK gives ARBITRARY slots in the tie:");
  log(
    `     ZREVRANK      ana=#${tied.zrevrank("ana")! + 1}  ben=#${tied.zrevrank("ben")! + 1}  cat=#${tied.zrevrank("cat")! + 1}  dov=#${tied.zrevrank("dov")! + 1}   (positions, not ranks)`,
  );
  log(
    `     COMPETITION   ana=#${tied.competitionRank("ana")}  ben=#${tied.competitionRank("ben")}  cat=#${tied.competitionRank("cat")}  dov=#${tied.competitionRank("dov")}   (ZCOUNT higher + 1: ties share #1, next is #4)`,
  );
  log(
    `     DENSE         ana=#${tied.denseRank("ana")}  ben=#${tied.denseRank("ben")}  cat=#${tied.denseRank("cat")}  dov=#${tied.denseRank("dov")}   (distinct scores: next is #2 — a 2nd ZSET of unique scores)`,
  );
  log("   Dense vs competition is a PRODUCT decision — ask, don't assume.");

  // ═══ 5 — The scale rung: bucket-histogram approximate my-rank ════════════════
  log("");
  log("═══ 5 — Rung 3 at a billion players: my-rank from a bucket histogram ═══");
  log("   Rank is a prefix sum. The histogram (here 128 buckets, ~10K in prod) is");
  log("   a few KB, stream-maintained, replicable ANYWHERE — no sorted set needed.");
  const myScore = global.zscore(me)!;
  const exact = global.zrevrank(me)! + 1;
  const approx = histogram.approxRank(myScore);
  const errAbs = Math.abs(approx - exact);
  log(`   ${me} (score ${myScore}):`);
  log(`     exact  rank (ZREVRANK, needs the full ZSET)   → #${exact.toLocaleString()}`);
  log(`     approx rank (Σ higher buckets + interpolation) → ~#${approx.toLocaleString()}`);
  log(
    `     error = ${errAbs} places, bounded by my bucket's population (${histogram.myBucketPopulation(myScore)} players in a width-${histogram.bucketWidth()} bucket)`,
  );
  log(`     product renders: "~#${approx.toLocaleString()} — top ${histogram.approxTopPercent(myScore).toFixed(1)}%" — all anyone reads at that depth.`);
  log("   Pair with a nightly dense-rank SNAPSHOT for exact-as-of; live-approx for");
  log("   the UI, periodic-exact for payouts. NEVER score-range shards (rebalance churn).");

  // ═══ 6 — Multi-region: partition, don't replicate; global top-K = a merge ════
  log("");
  log("═══ 6 — Regional boards + merged global top-K ═══");
  log("   Rank doesn't multi-master: regional boards natively, and the 'global'");
  log("   board is a MERGE of regional top-K snapshots (any global top-10 member");
  log("   must be in its own region's top-10 — merging K per shard is lossless).");
  const perRegion = REGIONS.map((r) => ({ region: r, top: season.regional.get(r)!.zrevrange(0, 9) }));
  for (const { region, top: t } of perRegion) {
    log(`     ${region}: top-3 of its top-10 → ${t.slice(0, 3).map((e) => `${e.member}(${e.score})`).join("  ")}`);
  }
  const merged = perRegion
    .flatMap((p) => p.top)
    .sort((a, b) => b.score - a.score || (a.member < b.member ? -1 : 1))
    .slice(0, 10);
  const truth = global.zrevrange(0, 9);
  const identical = merged.every((e, i) => e.member === truth[i].member && e.score === truth[i].score);
  log("   Global top-10 from the 3-way merge:");
  printBoard(merged);
  log(`   Merge matches the single global ZSET exactly: ${identical} ✓`);
  log("   (Exact real-time global MY-RANK across regions is the push-back answer:");
  log("    offer global-approximate via MERGED HISTOGRAMS — prefix sums add up.)");

  // ═══ 7 — Weekly reset: a key swap, never a mutation storm ════════════════════
  log("");
  log("═══ 7 — Resets: key-per-period + pointer flip + TTL ═══");
  const boards = new Map<string, SortedSet>();
  const ttlAtTick = new Map<string, number>();
  let currentKey = "arena:weekly:2026-W33";
  boards.set(currentKey, new SortedSet());
  boards.get(currentKey)!.zadd("mira", 4200);
  boards.get(currentKey)!.zadd("theo", 3900);
  log(`   tick 0: writes go to ${currentKey}`);
  // Boundary approaches: PRE-CREATE next period's key, then flip a pointer.
  boards.set("arena:weekly:2026-W34", new SortedSet());
  const lastWeek = currentKey;
  currentKey = "arena:weekly:2026-W34";
  ttlAtTick.set(lastWeek, 3); // old key expires after the "last week's results" window
  log(`   tick 1: BOUNDARY — pre-created W34, flipped pointer. Reset = O(1) key swap,`);
  log(`           not a ZREMRANGE storm on the hottest structure at midnight.`);
  boards.get(currentKey)!.zadd("mira", 150); // fresh week, fresh board
  const lastTop = boards.get(lastWeek)!.zrevrange(0, 0)[0];
  log(`   tick 2: last week still queryable for payouts/history → W33 #1 = ${lastTop.member} (${lastTop.score})`);
  for (const [key, expiry] of ttlAtTick) {
    if (expiry <= 3) {
      boards.delete(key);
      log(`   tick 3: TTL fired → ${key} evicted. History window closed.`);
    }
  }
  log(`   Current board (${currentKey}): mira = ${boards.get(currentKey)!.zscore("mira")} pts — everyone starts the week fresh.`);

  // ═══ Takeaways ════════════════════════════════════════════════════════════════
  log("");
  log("═══ Takeaways ═══");
  log("   • Say it first: top-N, my-rank, and neighbors are THREE queries with three");
  log("     costs — cached ZREVRANGE, ZREVRANK-on-one-node, ZMSCORE + sort in hand.");
  log("     Never serve them from one structure's worst case.");
  log("   • Do the memory math before distributing: 50M players ≈ 6–8 GB and 13K");
  log("     ops/s — ONE sorted set with replicas. Knowing when NOT to distribute is");
  log("     the Staff move; design the next rung, don't build it.");
  log("   • Rank is a global prefix sum. Past ~100M players: bucket histogram for");
  log("     approximate-live ('top 8%'), nightly dense-rank snapshot + delta for");
  log("     exact-as-of. Money reads the frozen snapshot, never the live board.");
  log("   • The ZSET is a rebuildable PROJECTION; the DB is truth — Redis dying is a");
  log("     latency incident with a rebuild runbook, not data loss. Max-wins boards");
  log("     use ZADD GT (retry-free); additive boards dedup event-ids first.");
  log("   • Ties are a spec decision: composite-encode score+earliness (53-bit");
  log("     mantissa caveat), and know ZREVRANK ≠ competition rank ≠ dense rank.");
  log("   • Resets are key swaps with TTL'd history; regions are partitions whose");
  log("     top-Ks MERGE losslessly into the global board — never score-range shards.");

  process.exit(0);
}

main();
