/** Timestamped logging so you can watch caches hit, miss, and expire in real time. */
export function log(...args: unknown[]): void {
  const t = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.log(`[${t}]`, ...args);
}
