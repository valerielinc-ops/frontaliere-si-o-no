// Bench-only preload (`node --import`): freezes the JS wall clock at
// BENCH_FROZEN_CLOCK_MS so every variant of one deploy-matrix-experiment run
// sees the same "now". Without it, variants that run hours apart (the bench
// serialises legs) diverge on time-derived bytes — `generatedAt` stamps,
// expiry windows, relative ages — and `hash_variants` reports differences
// that no flag caused (run 40078311664: 2692 mismatches, base vs new).
//
// Only `Date.now()` and argument-less `new Date()` / `Date()` are frozen.
// `performance.now()`, `process.hrtime()` and timers stay real, so durations
// and timeouts based on them keep working. Never loaded by deploy.yml.
// A Proxy over the real constructor (not a subclass) keeps `Date.prototype`
// and therefore `instanceof Date` intact for dates made before the patch or by
// native code (fs.Stats mtime).
const raw = process.env.BENCH_FROZEN_CLOCK_MS || '';
if (/^\d{10,16}$/.test(raw)) {
  const frozen = Number(raw);
  const RealDate = Date;
  const now = () => frozen;
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [frozen] : args, newTarget);
    },
    // `Date()` called as a function returns a string for "now".
    apply() {
      return new RealDate(frozen).toString();
    },
    get(target, prop, receiver) {
      if (prop === 'now') return now;
      return Reflect.get(target, prop, receiver);
    },
  });
}
