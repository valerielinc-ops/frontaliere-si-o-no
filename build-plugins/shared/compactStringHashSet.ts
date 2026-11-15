/**
 * A memory-bounded occupancy set for strings where false positives are safe.
 *
 * The caller uses membership to decide whether a new value needs a stable
 * disambiguator. Treating two different strings with the same 32-bit hash as
 * already occupied can therefore only add an unnecessary disambiguator; it
 * can never allow an exact duplicate through. Keeping the hashes in a typed
 * array avoids retaining the original (often 60+ character) strings for every
 * emitted page.
 */
export class CompactStringHashSet {
  private slots = new Uint32Array(1024);
  private count = 0;

  get size(): number {
    return this.count;
  }

  has(value: string): boolean {
    if (this.slots.length === 0) return false;
    const hash = compactStringHash(value);
    const mask = this.slots.length - 1;
    let index = hash & mask;
    for (;;) {
      const slot = this.slots[index];
      if (slot === 0) return false;
      if (slot === hash) return true;
      index = (index + 1) & mask;
    }
  }

  add(value: string): boolean {
    const hash = compactStringHash(value);
    if (this.hasHash(hash)) return false;
    if ((this.count + 1) * 10 >= this.slots.length * 7) this.resize();
    this.insertHash(hash);
    this.count++;
    return true;
  }

  clear(): void {
    // Drop the backing store as well as its contents. The title registry is
    // intentionally released before the next large build phase.
    this.slots = new Uint32Array(0);
    this.count = 0;
  }

  private hasHash(hash: number): boolean {
    if (this.slots.length === 0) return false;
    const mask = this.slots.length - 1;
    let index = hash & mask;
    for (;;) {
      const slot = this.slots[index];
      if (slot === 0) return false;
      if (slot === hash) return true;
      index = (index + 1) & mask;
    }
  }

  private insertHash(hash: number): void {
    const mask = this.slots.length - 1;
    let index = hash & mask;
    while (this.slots[index] !== 0) index = (index + 1) & mask;
    this.slots[index] = hash;
  }

  private resize(): void {
    const previous = this.slots;
    const next = new Uint32Array(previous.length === 0 ? 1024 : previous.length * 2);
    this.slots = next;
    for (const hash of previous) {
      if (hash === 0) continue;
      this.insertHash(hash);
    }
  }
}

/** FNV-1a with zero reserved as the empty-slot marker. */
function compactStringHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash === 0 ? 1 : hash;
}
