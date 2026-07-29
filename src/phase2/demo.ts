/**
 * Phase 2 demo — run with:  npm run phase2
 *
 * A capacity-3 LRU cache. Watch how *accessing* a key protects it from
 * eviction, while untouched keys get dropped when space runs out.
 */

import { LRUCache } from "./lru.ts";
import { log } from "../lib/log.ts";

function main() {
  const cache = new LRUCache<string, number>(3);
  const show = () => log("   order (LRU→MRU):", cache.keys().join(", "));

  log("═══ Fill the cache to capacity (3) ═══");
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  show();

  log("");
  log('═══ Access "a" — it becomes most-recently-used ═══');
  cache.get("a");
  show(); // now: b, c, a

  log("");
  log('═══ Insert "d" — cache is full, so the LRU key ("b") is evicted ═══');
  cache.set("d", 4);
  show(); // now: c, a, d

  log("");
  log('═══ Insert "e" — evicts the new LRU ("c") ═══');
  cache.set("e", 5);
  show(); // now: a, d, e

  log("");
  log("Note: \"a\" survived two evictions purely because we accessed it. That's");
  log("LRU's bet — recently used keys are the ones you'll probably want again.");
  log("");
  log("final stats:", cache.stats());

  process.exit(0);
}

main();
