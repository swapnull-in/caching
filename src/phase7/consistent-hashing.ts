/**
 * Phase 7 — DISTRIBUTED CACHE: consistent hashing + virtual nodes (from scratch).
 *
 * Run with:  npm run phase7
 *
 * One cache node isn't enough — you shard data across many (this is how
 * Memcached/Redis Cluster scale). The question: given a key, WHICH node holds it?
 *
 * NAIVE answer — node = hash(key) % N — works until N changes. Add or lose ONE
 * node and almost EVERY key maps somewhere new: a near-total cache miss storm
 * that stampedes your database. Unacceptable in production.
 *
 * CONSISTENT HASHING fixes this. Place both nodes and keys on a circular hash
 * ring (0 … 2^32). A key belongs to the first node found clockwise. Now adding
 * or removing a node only moves the keys in ONE arc — about 1/N of them — not all.
 *
 * VIRTUAL NODES: give each physical node many points on the ring (e.g. 100), so
 * load spreads evenly and no single node owns a huge arc by bad luck.
 *
 * The demo proves the difference by counting how many keys REMAP when a node is
 * added — naive (~all) vs consistent (~1/N).
 */

import { log } from "../lib/log.ts";

/** Fast, deterministic 32-bit hash: FNV-1a + a murmur3-style finalizer for
 *  strong avalanche (so near-identical strings like "node-A#0"/"node-B#0"
 *  scatter across the ring instead of clustering). */
function hash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Finalizer — mixes the bits so distribution is near-uniform.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

class ConsistentHashRing {
  private ring: { hash: number; node: string }[] = []; // kept sorted by hash
  private vnodes: number;

  constructor(vnodes = 100) {
    this.vnodes = vnodes;
  }

  addNode(node: string) {
    for (let v = 0; v < this.vnodes; v++) {
      this.ring.push({ hash: hash32(`${node}#${v}`), node });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  removeNode(node: string) {
    this.ring = this.ring.filter((e) => e.node !== node);
  }

  /** First node clockwise from the key's hash (wrapping around the ring). */
  getNode(key: string): string {
    const h = hash32(key);
    // Binary search for the first ring entry with hash >= h.
    let lo = 0, hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo % this.ring.length; // wrap
    return this.ring[idx].node;
  }
}

function main() {
  const keys = Array.from({ length: 10_000 }, (_, i) => `key:${i}`);

  // ─── NAIVE modulo hashing ────────────────────────────────────────────────
  log("═══ Naive  node = hash(key) % N ═══");
  const naive = (n: number) => (key: string) => hash32(key) % n;
  {
    const before = naive(4);
    const after = naive(5); // added a 5th node
    let moved = 0;
    for (const k of keys) if (before(k) !== after(k)) moved++;
    log(`   added a node (4 → 5): ${moved}/${keys.length} keys remapped ` +
        `(${((moved / keys.length) * 100).toFixed(1)}%)  💥 cache-wide miss storm`);
  }

  // ─── CONSISTENT hashing ──────────────────────────────────────────────────
  log("");
  log("═══ Consistent hashing (100 virtual nodes each) ═══");
  {
    const ring = new ConsistentHashRing(100);
    for (const n of ["node-A", "node-B", "node-C", "node-D"]) ring.addNode(n);

    const before = new Map(keys.map((k) => [k, ring.getNode(k)]));

    // Show load distribution across the 4 nodes.
    const dist = new Map<string, number>();
    for (const n of before.values()) dist.set(n, (dist.get(n) ?? 0) + 1);
    log(`   load spread: ${[...dist.entries()].map(([n, c]) => `${n}=${c}`).join(", ")}`);

    ring.addNode("node-E"); // add a 5th node
    let moved = 0;
    for (const k of keys) if (ring.getNode(k) !== before.get(k)) moved++;
    log(`   added a node (4 → 5): ${moved}/${keys.length} keys remapped ` +
        `(${((moved / keys.length) * 100).toFixed(1)}%)  ✓ only ~1/5 moved`);

    // Removing a node only affects that node's keys.
    const before2 = new Map(keys.map((k) => [k, ring.getNode(k)]));
    ring.removeNode("node-C");
    let movedOnRemove = 0;
    for (const k of keys) if (ring.getNode(k) !== before2.get(k)) movedOnRemove++;
    log(`   removed node-C (5 → 4): ${movedOnRemove}/${keys.length} keys remapped ` +
        `(${((movedOnRemove / keys.length) * 100).toFixed(1)}%)  ✓ only node-C's keys moved`);
  }

  log("");
  log("That gap — remap EVERYTHING vs remap 1/N — is why every real distributed");
  log("cache uses consistent hashing (or rendezvous hashing). Virtual nodes keep");
  log("the arcs even so no node gets overloaded. Next layer up: replicate each");
  log("key to the next node(s) clockwise so one node's death doesn't lose its data.");

  process.exit(0);
}

main();
