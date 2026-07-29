/**
 * A tiny cache built from scratch — to show what a cache actually IS before
 * reaching for Redis.
 *
 * A cache is just a fast key→value store that sits in FRONT of something slow
 * (a database, an API, an expensive computation). The whole game is:
 *
 *   1. HIT   — the value is already in the cache → return it instantly.
 *   2. MISS  — it isn't → do the slow work, STORE the result, then return it.
 *   3. TTL   — entries expire after a "time to live" so you don't serve stale
 *              data forever. (Caching's hardest question is "when to expire?")
 *
 * The only reason a cache helps: reads massively outnumber writes, and the same
 * keys get read over and over. A cache turns repeated slow work into one slow
 * read + many fast ones.
 */

import { log } from "../lib/log.ts";

interface Entry<V> {
  value: V;
  /** Epoch ms after which this entry is stale, or null for "never expires". */
  expiresAt: number | null;
}

export class Cache<K, V> {
  private store = new Map<K, Entry<V>>();
  private hits = 0;
  private misses = 0;
  private defaultTtlMs: number | null;

  constructor(defaultTtlMs: number | null = null) {
    this.defaultTtlMs = defaultTtlMs;
  }

  /** Read a key. Returns undefined on a miss OR an expired entry. */
  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    // Lazy expiration: we only notice an entry is stale when we look at it.
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      log(`   (expired "${String(key)}" on read)`);
      return undefined;
    }
    this.hits++;
    return entry.value;
  }

  /** Store a key. Optional per-key ttl overrides the default. */
  set(key: K, value: V, ttlMs: number | null = this.defaultTtlMs): void {
    const expiresAt = ttlMs === null ? null : Date.now() + ttlMs;
    this.store.set(key, { value, expiresAt });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  /**
   * The pattern you'll use 90% of the time: "give me this key; if it's not
   * cached, run this function to produce it, cache it, and return it."
   * This is "cache-aside" / "read-through" in one helper.
   */
  async getOrLoad(key: K, loader: () => Promise<V>, ttlMs = this.defaultTtlMs): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) {
      log(`   HIT  "${String(key)}"`);
      return cached;
    }
    log(`   MISS "${String(key)}" → loading...`);
    const value = await loader();
    this.set(key, value, ttlMs);
    return value;
  }

  stats() {
    const total = this.hits + this.misses;
    const rate = total === 0 ? 0 : (this.hits / total) * 100;
    return { hits: this.hits, misses: this.misses, hitRate: `${rate.toFixed(1)}%`, size: this.store.size };
  }
}
