/**
 * An LRU (Least Recently Used) cache from scratch.
 *
 * A real cache can't grow forever — memory is finite. So a cache has a MAX
 * SIZE, and when it's full and a new key arrives, it must EVICT something. The
 * eviction policy decides what to drop. Common ones:
 *
 *   - LRU  (Least Recently Used)  → drop whatever hasn't been touched longest.
 *   - LFU  (Least Frequently Used)→ drop whatever is accessed least often.
 *   - FIFO (First In First Out)   → drop the oldest inserted, ignoring use.
 *
 * LRU is the default in most systems (Redis `allkeys-lru`, HTTP caches, CPUs)
 * because "recently used → likely used again soon" holds remarkably often.
 *
 * The trick: how do you evict the least-recently-used key in O(1)? A plain Map
 * in JavaScript already remembers INSERTION order. If, on every access, we
 * delete the key and re-set it, it jumps to the "most recently used" end. Then
 * the FIRST key in the Map is always the least-recently-used one to evict.
 */

import { log } from "../lib/log.ts";

export class LRUCache<K, V> {
  private store = new Map<K, V>();
  private evictions = 0;
  private capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    if (!this.store.has(key)) return undefined;
    // Touch: move this key to the most-recently-used end.
    const value = this.store.get(key)!;
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    // If it exists, delete first so re-inserting moves it to the MRU end.
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);

    // Over capacity? Evict the least-recently-used = the first Map entry.
    if (this.store.size > this.capacity) {
      const lruKey = this.store.keys().next().value as K;
      this.store.delete(lruKey);
      this.evictions++;
      log(`   ✗ evicted "${String(lruKey)}" (least recently used)`);
    }
  }

  /** Current keys, from least- to most-recently-used. */
  keys(): K[] {
    return [...this.store.keys()];
  }

  stats() {
    return { size: this.store.size, capacity: this.capacity, evictions: this.evictions };
  }
}
