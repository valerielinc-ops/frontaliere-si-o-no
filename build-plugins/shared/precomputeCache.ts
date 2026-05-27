// build-plugins/shared/precomputeCache.ts
//
// Bounded Map-like cache for the L1 precompute pattern in build plugins.
//
// Pattern: per-iteration expressions that depend only on low-cardinality
// keys (locale, canton, sector, locale×canton…) are cached BEFORE the
// emission loop and looked up O(1) inside it. Saves O(N×K) string
// allocations where N is page count (~70k for jobsSeoPages soft-landings)
// and K is the per-iteration template-literal complexity.
//
// The cap guards against accidental high-cardinality keys (e.g. an emitter
// hashing per-job slug or per-company name). If the cap is exceeded the
// cache throws — fail loud rather than blow memory silently.
//
// Vincolo N1 in the L1+L2+L3 design.

export interface PrecomputeCacheOptions {
  /** Human-readable name for error messages and telemetry. */
  name: string;
  /** Max number of entries. Default 5000 — fits all realistic
   *  (locale × canton), (locale × sector), and (locale × canton × sector)
   *  combinations with comfortable headroom. */
  maxSize?: number;
}

export class PrecomputeCache<V> {
  private readonly map = new Map<string, V>();
  private readonly maxSize: number;
  private readonly name: string;

  constructor(opts: PrecomputeCacheOptions) {
    this.name = opts.name;
    this.maxSize = opts.maxSize ?? 5000;
  }

  /**
   * Look up `key` in the cache. If absent, call `compute()`, cache the
   * result, and return it. Throws if adding a new entry would exceed
   * maxSize — this is intentional and signals the caller is using a
   * higher-cardinality key than the cache was designed for.
   */
  getOrCompute(key: string, compute: () => V): V {
    const cached = this.map.get(key);
    if (cached !== undefined) return cached;
    if (this.map.size >= this.maxSize) {
      throw new Error(
        `precomputeCache[${this.name}] exceeded maxSize=${this.maxSize} on key="${key}". ` +
        `Either raise the cap (if the cardinality is genuinely bounded) or ` +
        `move the per-iteration work back into the loop.`,
      );
    }
    const value = compute();
    this.map.set(key, value);
    return value;
  }

  /** Strict get — returns undefined if missing. */
  get(key: string): V | undefined {
    return this.map.get(key);
  }

  /** Strict set — throws on cap overflow, like getOrCompute. */
  set(key: string, value: V): void {
    if (!this.map.has(key) && this.map.size >= this.maxSize) {
      throw new Error(
        `precomputeCache[${this.name}] exceeded maxSize=${this.maxSize} on key="${key}".`,
      );
    }
    this.map.set(key, value);
  }

  has(key: string): boolean { return this.map.has(key); }
  get size(): number { return this.map.size; }

  /** For debugging / telemetry. */
  stats(): { name: string; size: number; maxSize: number } {
    return { name: this.name, size: this.map.size, maxSize: this.maxSize };
  }
}
