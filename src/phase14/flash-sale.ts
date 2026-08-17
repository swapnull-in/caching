/**
 * Phase 14 — FLASH-SALE INVENTORY: N BUYERS RACE FOR S UNITS. SELL EXACTLY S.
 *
 * Run with:  node "src/phase14/flash-sale.ts"
 *
 * THE PROBLEM in one line: N buyers race for S units — sell exactly S: never
 * OVERSELL (an order without stock), never UNDERSELL (stock stranded in
 * abandoned carts), and tell the other N−S buyers the truth fast.
 *
 * Two different bugs hide inside "two users bought the last one":
 *   - DUPLICATION — one intent delivered twice (retry, double-tap) → dedup it
 *     with an idempotency key. NOT this phase.
 *   - CONTENTION — many intents, few items → must NOT be deduped; serialize
 *     the allocation instead. THIS phase.
 *
 * THE BUG (TOCTOU — time-of-check to time-of-use): read the stock, see it's
 * > 0, then decrement. Between your read and your write, 999 other buyers did
 * the same read and saw the same "5 left." Everyone's check passes; everyone
 * writes; you sold 1,000 of the 5 you had. Reading first IS the bug.
 *
 * THE FIX is one atomic conditional write — the condition lives INSIDE the
 * write, so there is no gap to race through:
 *
 *     UPDATE inventory SET stock = stock - 1
 *     WHERE item_id = :id AND stock >= 1;   -- rows_affected = 0 → honest "sold out"
 *
 * Exactness cuts BOTH ways. Oversell is fixed by atomicity; UNDERSELL comes
 * from stock leaks: reservations before payment must carry a TTL, an expiry
 * sweeper returns abandoned holds to the pool, and every release is idempotent
 * BY RESERVATION ID (never "+1 blindly," or a retried release double-credits).
 * A reconciliation job continuously checks the accounting identity:
 *     initial_stock = confirmed_orders + live_reservations + available
 *
 * WHEN THE ROW MELTS — the flash-sale escalation ladder (P-14):
 *   Rung 1: conditional write in the DB — the row lock serializes. Fine at
 *           1k/sec; a meltdown at 500k/sec on drop morning.
 *   Rung 2: ATOMIC COUNTER IN REDIS as the gate (Lua: if stock > 0 then DECR),
 *           DB as truth behind it. The counter admits at most S winners;
 *           losers bounce in µs WITHOUT touching the DB.
 *   Rung 3: single-writer queue — all requests for item X into one partition,
 *           one consumer allocates in arrival order (fair FIFO, async UX).
 *   Rung 4: pre-minted tokens — S purchase tokens issued up front (lottery /
 *           queue position); checkout requires a token. The standard answer
 *           for sneaker drops and ticketing.
 * Rungs 2–4 all implement the same idea: MOVE THE DECISION EARLIER AND OFF
 * THE HOT ROW. The DB row stops being where the race resolves and becomes
 * where the result is durably recorded. Naming that inversion is the senior move.
 *
 * MONEY QUOTE: the cart is a wish, the hold is a promise with a TTL, and the
 * conditional decrement is the contract — serialize the decrement, not the
 * users, and the moment stock hits zero push the sold-out bit to the edge so
 * a million people stop asking an expensive question.
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

const fmt = (n: number) => n.toLocaleString("en-US");

// ─── 1. The naive store: separate read and write, a gap in between ──────────
//
// get() and set() each cross a "network round trip" (one microtask). That gap
// between the check and the write is exactly where every concurrent buyer's
// stale read lives — the TOCTOU window, made visible.
class NaiveStore {
  private stock: number;

  constructor(initialStock: number) {
    this.stock = initialStock;
  }

  async get(): Promise<number> {
    await Promise.resolve(); // the round trip to the store
    return this.stock;
  }

  async set(value: number): Promise<void> {
    await Promise.resolve(); // another round trip
    this.stock = value;
  }

  peek(): number {
    return this.stock;
  }
}

// The naive buyer: SELECT the stock, check it, then write the decrement.
// "I will not SELECT the stock and then decrement it" — this is what happens
// when you do.
async function naiveBuyer(store: NaiveStore): Promise<boolean> {
  const stock = await store.get(); // CHECK  (time of check)
  if (stock > 0) {
    await store.set(stock - 1); //    ACT    (time of use — stale by now)
    return true; // "congrats, you got one!" ...did you?
  }
  return false;
}

// ─── 2. The atomic store: check-and-decrement is ONE indivisible step ───────
//
// This models Redis Lua `if stock > 0 then DECR` / SQL's conditional UPDATE:
// the store itself evaluates the condition and applies the write with nothing
// interleaving between them. rows_affected = 0 → false → honest "sold out".
class AtomicStore {
  private stock: number;

  constructor(initialStock: number) {
    this.stock = initialStock;
  }

  // UPDATE ... SET stock = stock - 1 WHERE stock >= 1  — as one operation.
  tryDecrement(): boolean {
    if (this.stock > 0) {
      this.stock--;
      return true;
    }
    return false;
  }

  peek(): number {
    return this.stock;
  }
}

async function atomicBuyer(store: AtomicStore): Promise<boolean> {
  // The buyer still arrives over the network — but the DECISION is a single
  // atomic operation inside the store. No read-then-write gap exists.
  await Promise.resolve();
  return store.tryDecrement();
}

// ─── 3. Reservations with TTL: reserve → pay → confirm, leaks swept back ────
//
// Holding stock before payment must never UNDERSELL the drop: every hold
// carries a TTL, the sweeper returns expired holds to the pool, and release
// is idempotent by reservation ID. Time is a logical clock (ticks), not wall
// time — deterministic.
type ReservationState = "live" | "confirmed" | "released";

interface Reservation {
  id: string;
  buyer: string;
  expiresAt: number; // logical tick
  state: ReservationState;
}

class ReservationStore {
  private available: number;
  private readonly initialStock: number;
  private readonly ttl: number;
  private readonly reservations: Map<string, Reservation>;
  private nextId: number;

  constructor(initialStock: number, ttl: number) {
    this.available = initialStock;
    this.initialStock = initialStock;
    this.ttl = ttl;
    this.reservations = new Map();
    this.nextId = 1;
  }

  // Atomic conditional decrement of AVAILABLE + create the hold, one step.
  reserve(buyer: string, now: number): string | null {
    if (this.available <= 0) return null; // honest sold-out at checkout entry
    this.available--;
    const id = `res-${this.nextId++}`;
    this.reservations.set(id, { id, buyer, expiresAt: now + this.ttl, state: "live" });
    return id;
  }

  // Payment captured within the TTL → the hold becomes a confirmed order.
  confirm(id: string, now: number): boolean {
    const r = this.reservations.get(id);
    if (!r || r.state !== "live" || now >= r.expiresAt) return false;
    r.state = "confirmed";
    return true;
  }

  // Compensation path: release the RESERVATION, not "+1 blindly." Flipping
  // the state gates the credit, so a retried release is a no-op — idempotent.
  release(id: string): boolean {
    const r = this.reservations.get(id);
    if (!r || r.state !== "live") return false; // already confirmed/released → no double-credit
    r.state = "released";
    this.available++;
    return true;
  }

  // The expiry sweeper: abandoned carts hand their units back to the pool.
  sweep(now: number): number {
    let returned = 0;
    for (const r of this.reservations.values()) {
      if (r.state === "live" && now >= r.expiresAt) {
        r.state = "released";
        this.available++;
        returned++;
      }
    }
    return returned;
  }

  stats(): { available: number; live: number; confirmed: number } {
    let live = 0;
    let confirmed = 0;
    for (const r of this.reservations.values()) {
      if (r.state === "live") live++;
      if (r.state === "confirmed") confirmed++;
    }
    return { available: this.available, live, confirmed };
  }

  // The reconciliation identity: any drift is a leak or a phantom.
  identityHolds(): boolean {
    const s = this.stats();
    return this.initialStock === s.confirmed + s.live + s.available;
  }
}

// ─── Demo 1 & 2: 1,000 buyers, 5 units, same second ─────────────────────────
const RACE_UNITS = 5;
const RACE_BUYERS = 1_000;

async function overselDemo(): Promise<void> {
  log("═══ 1. NAIVE read-check-write — 1,000 buyers, 5 units, same second ═══");
  log(`   Every buyer: SELECT stock → if > 0 → write stock-1. Watch the gap.`);
  const store = new NaiveStore(RACE_UNITS);
  const results = await Promise.all(
    Array.from({ length: RACE_BUYERS }, () => naiveBuyer(store)),
  );
  const orders = results.filter(Boolean).length;
  const oversold = orders - RACE_UNITS;
  log(`   Units for sale:   ${fmt(RACE_UNITS)}`);
  log(`   Orders accepted:  ${fmt(orders)}   💥 OVERSOLD by ${fmt(oversold)}`);
  log(`   Stock counter:    ${fmt(store.peek())}  (negative — the counter is fiction)`);
  log(`   → All ${fmt(RACE_BUYERS)} buyers read "stock = ${RACE_UNITS}" before ANY write landed. Every`);
  log("     check passed on a stale read — the TOCTOU window swallowed the drop.");
  log("     Reading first is the bug: the check must live INSIDE the write.");
}

async function atomicDemo(): Promise<void> {
  log("");
  log("═══ 2. ATOMIC conditional decrement — same 1,000 buyers, same 5 units ═══");
  log(`   One indivisible op: if stock > 0 then DECR (Lua / conditional UPDATE).`);
  const store = new AtomicStore(RACE_UNITS);
  const results = await Promise.all(
    Array.from({ length: RACE_BUYERS }, () => atomicBuyer(store)),
  );
  const orders = results.filter(Boolean).length;
  const soldOut = results.length - orders;
  log(`   Units for sale:   ${fmt(RACE_UNITS)}`);
  log(`   Orders accepted:  ${fmt(orders)}   ✓ exactly ${RACE_UNITS} — oversell structurally impossible`);
  log(`   Honest sold-outs: ${fmt(soldOut)}  (rows_affected = 0, one round trip)`);
  log(`   Stock counter:    ${fmt(store.peek())}`);
  log("   → The store serializes the decrement; there is no check-then-act gap");
  log("     to race through. 5 succeed, 995 get the truth fast.");
}

// ─── Demo 3: reservations with TTL — never undersell either ─────────────────
function reservationDemo(): void {
  log("");
  log("═══ 3. RESERVATION with TTL — reserve → pay → confirm; leaks swept back ═══");
  const UNITS = 10;
  const TTL = 5; // logical ticks — a hold is a promise WITH AN EXPIRY
  const PAYERS = 6; // buyers who actually pay
  const store = new ReservationStore(UNITS, TTL);
  const rng = mulberry32(0xd201);

  // t=0: ten buyers enter checkout — each gets a hold. Pool is now empty.
  let now = 0;
  const held: string[] = [];
  for (let i = 1; i <= UNITS; i++) {
    const id = store.reserve(`buyer-${i}`, now);
    if (id) held.push(id);
  }
  let s = store.stats();
  log(`   t=${now}: ${held.length} buyers entered checkout → ${held.length} holds (TTL ${TTL} ticks).`);
  log(`        available=${s.available} live=${s.live} confirmed=${s.confirmed} │ identity: ${store.identityHolds() ? "✓ holds" : "✗ DRIFT"}`);
  log(`        buyer-11 tries to reserve → ${store.reserve("buyer-11", now) === null ? '"sold out" (honest, at checkout entry — before card entry, before hope)' : "got one?!"}`);

  // t=2: 6 of the 10 pay inside the TTL; a deterministic shuffle picks which.
  now = 2;
  const shuffled = [...held].sort(() => rng() - 0.5);
  const paid = shuffled.slice(0, PAYERS);
  for (const id of paid) store.confirm(id, now);
  s = store.stats();
  log(`   t=${now}: ${PAYERS} buyers paid → confirmed. ${UNITS - PAYERS} carts sit abandoned (no payment).`);
  log(`        available=${s.available} live=${s.live} confirmed=${s.confirmed} │ identity: ${store.identityHolds() ? "✓ holds" : "✗ DRIFT"}`);

  // One payment fails → compensation releases the RESERVATION (idempotent).
  const failedPayment = paid[0];
  store.release(failedPayment); // wait — it was already confirmed, so this no-ops
  const cancelled = shuffled[PAYERS]; // a live hold whose payment failed
  const first = store.release(cancelled);
  const retry = store.release(cancelled); // network retry of the same release
  log(`   t=${now}: one payment failed → release(${cancelled}): ${first ? "credited +1" : "no-op"};`);
  log(`        the RETRY of that release: ${retry ? "credited AGAIN (bug!)" : "no-op — idempotent by reservation ID, no double-credit"}`);

  // t=6: TTL passed — the sweeper returns the abandoned holds to the pool.
  now = 6;
  const returned = store.sweep(now);
  s = store.stats();
  log(`   t=${now}: sweeper ran → ${returned} expired holds returned to the pool.`);
  log(`        available=${s.available} live=${s.live} confirmed=${s.confirmed} │ identity: ${store.identityHolds() ? "✓ holds" : "✗ DRIFT"}`);

  // The waitlist converts losers into the restock's first customers.
  const late = store.reserve("waitlist-buyer", now);
  const lateOk = late !== null && store.confirm(late, now + 1);
  s = store.stats();
  log(`   t=${now}: waitlist-buyer (turned away at t=0) reserves → ${lateOk ? "✓ pays, confirmed" : "✗"} — no unit stranded.`);
  log(`        available=${s.available} live=${s.live} confirmed=${s.confirmed} │ identity: ${store.identityHolds() ? "✓ holds" : "✗ DRIFT"}`);
  log("   → Without the TTL + sweeper, 3 dead holds would have \"sold out\" a drop");
  log("     that shipped only 60% of stock — the UNDERSELL bug. The identity");
  log("     initial = confirmed + live + available catches any drift mechanically.");
}

// ─── Demo 4: the Redis gate — 1,000,000 buyers, 10,000 units ────────────────
//
// Rung 2 of the ladder. A conditional write serializes on the row lock: fine
// at 1k/sec, a meltdown at 500k/sec on drop morning. Put an atomic counter in
// front (Lua: if stock > 0 then DECR): it admits at most S winners; the other
// N−S bounce in µs without touching the DB. The DB stops being where the race
// resolves and becomes where the result is durably recorded.
const SALE_UNITS = 10_000;
const SALE_BUYERS = 1_000_000;

function gateDemo(): void {
  log("");
  log(`═══ 4. THE HOT ROW MELTS — ${fmt(SALE_BUYERS)} buyers, ${fmt(SALE_UNITS)} units, one drop ═══`);
  log("   Rung 1 (conditional write in the DB) is CORRECT but every buyer still");
  log(`   queues on one row lock: ${fmt(SALE_BUYERS)} transactions serialize on the hot row.`);
  log("   Rung 2: atomic counter in Redis as the GATE, DB as truth behind it.");

  const gate = new AtomicStore(SALE_UNITS); // the Redis counter (Lua DECR)
  let dbTransactions = 0; // durable txns the DB actually runs
  let winners = 0;
  let bouncedAtGate = 0;

  for (let i = 0; i < SALE_BUYERS; i++) {
    if (gate.tryDecrement()) {
      winners++;
      dbTransactions++; // only winners proceed to the durable allocate txn
    } else {
      bouncedAtGate++; // losers bounce in µs — the DB never hears from them
    }
  }

  log(`   Winners admitted by the gate:  ${fmt(winners)}  ✓ exactly ${fmt(SALE_UNITS)} — never one more`);
  log(`   Losers bounced at the gate:    ${fmt(bouncedAtGate)}  (honest sold-out in µs)`);
  log(`   DB transactions — rung 1:      ${fmt(SALE_BUYERS)}  (every buyer hits the hot row)`);
  log(`   DB transactions — rung 2:      ${fmt(dbTransactions)}  (${((dbTransactions / SALE_BUYERS) * 100).toFixed(0)}% of the herd — 100× fewer)`);
  log("   → The decision moved EARLIER and OFF THE HOT ROW. Cost: two systems —");
  log("     reconcile counter vs DB; if Redis dies, rebuild the counter from the DB.");
  log("   → Still too hot? Rung 3: single-writer queue (one partition, one consumer,");
  log("     fair FIFO). Rung 4: pre-mint the 10k purchase tokens by lottery — the");
  log("     sale becomes 10k calm purchases. Same inversion, moved even earlier.");
}

async function main(): Promise<void> {
  await overselDemo();
  await atomicDemo();
  reservationDemo();
  gateDemo();

  log("");
  log("═══ Takeaways ═══");
  log("   • Contention ≠ duplication: dedup a retried intent (idempotency key), but");
  log("     SERIALIZE competing intents — and compose both in one transaction.");
  log("   • Never read-then-write stock. The invariant is ONE atomic conditional");
  log("     decrement (UPDATE ... WHERE stock >= qty / Lua if stock > 0 then DECR):");
  log("     the condition lives inside the write, so oversell is structurally impossible.");
  log("   • Never undersell either: holds carry a TTL, a sweeper returns expired holds,");
  log("     releases are idempotent BY RESERVATION ID, and a reconciliation job checks");
  log("     initial = confirmed + live_reservations + available continuously.");
  log("   • Hot row melting? Move the decision earlier and off the row: Redis gate →");
  log("     single-writer queue → pre-minted tokens. The DB becomes where the result");
  log("     is recorded, not where the race resolves.");
  log("   • The cart is a wish (holds nothing — a free hold is a bot's favorite API);");
  log("     the hold is a promise with a TTL (starts at checkout entry, where intent");
  log("     is proven); the conditional decrement is the contract. And when stock hits");
  log("     zero, push the sold-out bit to the edge — it's the cheapest bit in the");
  log("     system, and it stops a million people asking an expensive question.");

  process.exit(0);
}

await main();
