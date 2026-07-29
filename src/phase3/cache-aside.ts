/**
 * Phase 3 — Redis as a real distributed cache (the "cache-aside" pattern).
 *
 * Run with:  npm run phase3   (needs Redis on localhost:6379)
 *
 * Phases 1–2 cached inside ONE process's memory. That breaks down in the real
 * world: run 5 copies of your API and you get 5 separate caches (low hit rate,
 * and they disagree). The fix is a SHARED cache every instance talks to —
 * that's what Redis is used for more than anything else.
 *
 * The dominant pattern is CACHE-ASIDE (a.k.a. lazy loading):
 *
 *   read(key):
 *     value = redis.get(key)
 *     if value exists:  return it                     # HIT
 *     value = db.query(key)                           # MISS → hit the DB
 *     redis.set(key, value, EX ttl)                   # populate for next time
 *     return value
 *
 * "Aside" = the cache sits to the SIDE of the DB; your app coordinates them.
 * The app owns the logic, so it's simple and resilient (if Redis is down, you
 * just always miss and hit the DB — degraded, not broken).
 */

import Redis from "ioredis";
import { log } from "../lib/log.ts";

const redis = new Redis();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A pretend slow database (e.g. a complex SQL join): 150ms per query.
let dbQueries = 0;
async function queryProductFromDb(id: number) {
  dbQueries++;
  await sleep(150);
  return { id, name: `Product ${id}`, price: id * 10 };
}

const keyFor = (id: number) => `product:${id}`;

// Cache-aside read.
async function getProduct(id: number) {
  const key = keyFor(id);

  const cached = await redis.get(key);
  if (cached !== null) {
    log(`   HIT  ${key}`);
    return JSON.parse(cached);
  }

  log(`   MISS ${key} → querying DB`);
  const product = await queryProductFromDb(id);
  // Store as JSON with a 60-second TTL. TTL is your safety net against staleness.
  await redis.set(key, JSON.stringify(product), "EX", 60);
  return product;
}

// On a WRITE, invalidate (or update) the cache so readers don't see stale data.
async function updateProductPrice(id: number, price: number) {
  log(`   UPDATE product ${id} price=${price} → deleting cache key`);
  // (write to DB would go here)
  await redis.del(keyFor(id)); // simplest correct choice: invalidate; next read repopulates
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await fn();
  log(`   ${label} took ${Date.now() - t}ms`);
  return r;
}

async function main() {
  // Start clean.
  const existing = await redis.keys("product:*");
  if (existing.length) await redis.del(...existing);

  log("═══ First read of product 1: MISS (slow — hits the DB) ═══");
  await timed("read", () => getProduct(1));

  log("");
  log("═══ Next 3 reads: HITs (fast — served from Redis) ═══");
  for (let i = 0; i < 3; i++) await timed("read", () => getProduct(1));

  log("");
  log("═══ A write invalidates the cache; the next read repopulates ═══");
  await updateProductPrice(1, 999);
  await timed("read after invalidation", () => getProduct(1)); // MISS again
  await timed("read", () => getProduct(1)); // HIT again

  log("");
  log(`Total DB queries: ${dbQueries} (for ${6} reads). Every HIT skipped a 150ms`);
  log("query and — crucially — this cache is SHARED, so every server instance and");
  log("every process benefits from the same populated keys.");
  log("");
  log("Peek in Redis yourself:  redis-cli get product:1   |   redis-cli ttl product:1");

  redis.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Phase 3 error:", err.message, "\nIs Redis running? redis-cli ping");
  process.exit(1);
});
