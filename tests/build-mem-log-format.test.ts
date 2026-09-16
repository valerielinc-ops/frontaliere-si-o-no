import { afterEach, describe, expect, it, vi } from 'vitest';
import { logBuildMem } from '../build-plugins/shared/buildMemLog';

describe('logBuildMem dettagliato', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mantiene il prefisso memoria e appende cardinalità diagnostiche', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logBuildMem(
      'jobsSeoPages:test',
      { writes: new Map([['job', 'html']]), _pendingFlushes: new Set() },
      { validJobs: 3, jobHtmlCacheEntries: 2 },
    );

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(
      /^\x1b\[35m\[mem\]\x1b\[0m jobsSeoPages:test heapUsed=\d+MB \(gcFreed=-?\d+MB\) external=\d+MB arrayBuffers=\d+MB rss=\d+MB pendingWrites=1 inflightFlushes=0 validJobs=3 jobHtmlCacheEntries=2$/,
    );
  });
  it('salta il GC forzato quando forceGc è false, senza cambiare il formato', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const gc = vi.fn();
    const g = globalThis as { gc?: unknown };
    const previous = g.gc;
    g.gc = gc;
    try {
      logBuildMem('jobsSeoPages:test', undefined, { validJobs: 1 }, { forceGc: false });
      expect(gc).not.toHaveBeenCalled();
      logBuildMem('jobsSeoPages:test', undefined, { validJobs: 1 });
      expect(gc).toHaveBeenCalled();
    } finally {
      g.gc = previous;
    }
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0][0])).toMatch(/^\x1b\[35m\[mem\]\x1b\[0m jobsSeoPages:test heapUsed=\d+MB \(gcFreed=-?\d+MB\)/);
  });
});
