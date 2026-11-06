/**
 * forceGc() — the build's forced collection must actually return pages to the OS.
 *
 * The defect this guards against (#5899) is not "GC is missing". Bare `gc()` was
 * called at nine sites and it ran a real major collection every time, so heapUsed
 * dropped and every log line looked right. What it never did was hand the freed
 * pages back to the operating system — and the build memory guard samples RSS.
 *
 * So the assertions here are deliberately about the SHAPE OF THE CALL, not about
 * whether a collection happened: a test that only checked "gc was invoked" is
 * exactly the test that would have passed throughout the outage.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { forceGc, gcReturnsPagesToOs, resetGcProbe } from '../build-plugins/shared/forceGc';

type GcHolder = { gc?: unknown };

const originalGc = (globalThis as GcHolder).gc;

afterEach(() => {
  if (originalGc === undefined) delete (globalThis as GcHolder).gc;
  else (globalThis as GcHolder).gc = originalGc;
  resetGcProbe();
});

describe('forceGc', () => {
  it('asks for the memory-reduction pass, not a bare collection', () => {
    const gc = vi.fn();
    (globalThis as GcHolder).gc = gc;

    expect(forceGc()).toBe(true);

    expect(gc).toHaveBeenCalledTimes(1);
    // The whole point: `flavor: 'last-resort'` is what triggers V8's
    // memory-reduction pass. A call without it frees the heap and leaves RSS
    // pinned, which is the bug.
    expect(gc).toHaveBeenCalledWith({ execution: 'sync', flavor: 'last-resort', type: 'major' });
    expect(gcReturnsPagesToOs()).toBe(true);
  });

  it('falls back to the bare form when V8 cannot parse the options object', () => {
    const gc = vi.fn((options?: unknown) => {
      if (options !== undefined) throw new TypeError('Invalid argument');
    });
    (globalThis as GcHolder).gc = gc;

    expect(forceGc()).toBe(true);

    expect(gc).toHaveBeenNthCalledWith(1, { execution: 'sync', flavor: 'last-resort', type: 'major' });
    expect(gc).toHaveBeenNthCalledWith(2);
    expect(gcReturnsPagesToOs()).toBe(false);
  });

  it('probes once per process, not once per plugin', () => {
    const gc = vi.fn((options?: unknown) => {
      if (options !== undefined) throw new TypeError('Invalid argument');
    });
    (globalThis as GcHolder).gc = gc;

    forceGc();
    gc.mockClear();
    forceGc();
    forceGc();

    // Two further calls, each going straight to the bare form — no repeated
    // throw/catch. A per-call probe would cost an exception at every one of the
    // ~62 profiled plugins.
    expect(gc).toHaveBeenCalledTimes(2);
    expect(gc).toHaveBeenNthCalledWith(1);
    expect(gc).toHaveBeenNthCalledWith(2);
  });

  it('no-ops without --expose-gc so local builds are unaffected', () => {
    delete (globalThis as GcHolder).gc;
    expect(forceGc()).toBe(false);
    expect(gcReturnsPagesToOs()).toBe(false);
  });

  it('the real runtime supports the options form', () => {
    // Guards the silent-degradation path: if a Node/V8 upgrade ever stopped
    // parsing the options object, every call site would quietly fall back to the
    // behaviour that caused #5899 and nothing else would say so. Skipped rather
    // than failed when the suite itself runs without --expose-gc, since that is
    // a property of how vitest was invoked, not of the code under test.
    if (typeof (globalThis as GcHolder).gc !== 'function') {
      expect(forceGc()).toBe(false);
      return;
    }
    expect(forceGc()).toBe(true);
    expect(gcReturnsPagesToOs()).toBe(true);
  });
});
