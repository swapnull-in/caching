/**
 * Phase 1 demo — run with:  npm run phase1
 *
 * We put a cache in front of a deliberately SLOW "database" and watch:
 *   - the first read miss (slow), repeat reads hit (instant),
 *   - a TTL expiry turning a hit back into a miss,
 *   - the hit-rate climbing as reads repeat.
 */

import { Cache } from "./cache.ts";
import { log } from "../lib/log.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A pretend slow database: 200ms per lookup.
let dbCalls = 0;
async function slowDbGetUser(id: number): Promise<{ id: number; name: string }> {
  dbCalls++;
  await sleep(200);
  return { id, name: `User ${id}` };
}

async function main() {
  // Cache with a 1-second default TTL.
  const cache = new Cache<number, { id: number; name: string }>(1_000);

  const readUser = (id: number) => cache.getOrLoad(id, () => slowDbGetUser(id));

  log("═══ First reads: all misses (slow, hit the DB) ═══");
  let t = Date.now();
  await readUser(1);
  await readUser(2);
  await readUser(1); // already cached from above
  log(`elapsed: ${Date.now() - t}ms, db calls so far: ${dbCalls}`);

  log("");
  log("═══ Repeat reads: all hits (instant, no DB) ═══");
  t = Date.now();
  for (let i = 0; i < 5; i++) await readUser(1);
  for (let i = 0; i < 5; i++) await readUser(2);
  log(`elapsed: ${Date.now() - t}ms, db calls so far: ${dbCalls}  ← DB was NOT touched`);

  log("");
  log("═══ Wait for the 1s TTL to expire, then read again ═══");
  await sleep(1_100);
  t = Date.now();
  await readUser(1); // expired → miss → slow again
  log(`elapsed: ${Date.now() - t}ms, db calls so far: ${dbCalls}`);

  log("");
  log("final stats:", cache.stats());
  log(`Without the cache, ${cache.stats().hits + cache.stats().misses} reads would have been ` +
      `${(cache.stats().hits + cache.stats().misses)} DB calls (${(cache.stats().hits + cache.stats().misses) * 200}ms).`);
  log(`With it: only ${dbCalls} DB calls. That's the whole point of a cache.`);

  process.exit(0);
}

main();
