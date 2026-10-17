import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectDescriptionFixTasks,
  descriptionFixConcurrency,
  runDescriptionFixPool,
} from '../scripts/fix-untranslated-descriptions.mjs';

// Phase 2e translated one description at a time, so Codex only ever grouped
// that description's own lines: 4.9 texts per call against 7.4 in phase 2b
// (run 38686616395, 2026-10-15). With the lane up it now keeps several
// descriptions in flight; without it the free providers keep the old pace.

afterEach(() => {
  vi.unstubAllEnvs();
});

const laneUp = { lanePresent: true, stopReason: null };

describe('descriptionFixConcurrency', () => {
  it('two descriptions per Codex lane while the lane is up', () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '3');
    expect(descriptionFixConcurrency(laneUp)).toBe(6);
  });

  it('one at a time without the lane, or once it stopped (budget, quota, failures)', () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '3');
    expect(descriptionFixConcurrency({ lanePresent: false, stopReason: null })).toBe(1);
    expect(descriptionFixConcurrency({ lanePresent: true, stopReason: 'quota esaurita (quota/rate-limit)' })).toBe(1);
    expect(descriptionFixConcurrency(undefined)).toBe(1);
  });

  it('an explicit cap wins, within bounds', () => {
    vi.stubEnv('FREE_TRANSLATE_CODEX_LANES', '3');
    vi.stubEnv('UNTRANSLATED_DESCRIPTION_FIX_CONCURRENCY', '4');
    expect(descriptionFixConcurrency(laneUp)).toBe(4);
    vi.stubEnv('UNTRANSLATED_DESCRIPTION_FIX_CONCURRENCY', '99');
    expect(descriptionFixConcurrency(laneUp)).toBe(8);
  });
});

describe('runDescriptionFixPool', () => {
  const deferredWorker = () => {
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const worker = async (task: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(task);
      active -= 1;
    };
    return { worker, stats: () => ({ peak, order }) };
  };

  it('keeps at most `limit()` tasks in flight and runs them all', async () => {
    const { worker, stats } = deferredWorker();
    const outcome = await runDescriptionFixPool([1, 2, 3, 4, 5, 6, 7], worker, { limit: () => 3 });
    expect(outcome).toBe('done');
    expect(stats().peak).toBe(3);
    expect([...stats().order].sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('reads the limit before every start: it drops to 1 when Codex stops', async () => {
    const { worker, stats } = deferredWorker();
    let started = 0;
    await runDescriptionFixPool([1, 2, 3, 4, 5, 6], async (task: number) => { started += 1; await worker(task); }, {
      limit: () => (started >= 3 ? 1 : 3),
    });
    expect(stats().order).toHaveLength(6);
  });

  it('never starts more than --max allows, counting tasks in flight', async () => {
    const { worker, stats } = deferredWorker();
    let done = 0;
    await runDescriptionFixPool([1, 2, 3, 4, 5], async (task: number) => { await worker(task); done += 1; }, {
      limit: () => 4,
      roomFor: (inFlight: number) => done + inFlight < 2,
    });
    expect(stats().order).toHaveLength(2);
  });

  it('stops at the deadline and reports it', async () => {
    const { worker, stats } = deferredWorker();
    let checks = 0;
    const outcome = await runDescriptionFixPool([1, 2, 3, 4], worker, {
      limit: () => 1,
      budgetOk: () => { checks += 1; return checks <= 2; },
    });
    expect(outcome).toBe('deadline');
    expect(stats().order.length).toBeLessThan(4);
  });
});

describe('collectDescriptionFixTasks', () => {
  const source = 'Wir suchen eine erfahrene Fachperson für unser Team in Lugano, mit Freude an der Arbeit und Sinn für Qualität im Alltag.';
  it('collects only non-source locales still holding a copy of the source', () => {
    const job = {
      sourceLang: 'de',
      description: source,
      descriptionByLocale: { de: source, it: source, en: 'We are looking for an experienced specialist for our team in Lugano.', fr: '' },
    };
    expect(collectDescriptionFixTasks([job]).map((task: { locale: string }) => task.locale)).toEqual(['it']);
  });

  it('uses the source-locale slot when the legacy description differs', () => {
    const sourceSlot = source.replace(/ /g, '\n  ');
    const job = {
      sourceLang: 'de',
      description: `${source} legacy representation`,
      descriptionByLocale: { de: sourceSlot, it: sourceSlot, en: 'Translated English description.', fr: '' },
    };
    const tasks = collectDescriptionFixTasks([job]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ locale: 'it', sourceDesc: sourceSlot });
  });

  it('skips sources shorter than 120 characters', () => {
    const short = 'Kurzer Text.';
    expect(collectDescriptionFixTasks([{ sourceLang: 'de', description: short, descriptionByLocale: { it: short } }])).toEqual([]);
  });
});

describe('collectDescriptionFixTasks groups the slots by language pair', () => {
  const source = 'Wir suchen eine erfahrene Fachperson für unser Team in Lugano, mit Freude an der Arbeit und Sinn für Qualität im Alltag.';
  const job = (n: number) => ({
    id: `j${n}`,
    sourceLang: 'de',
    description: `${source} (${n})`,
    descriptionByLocale: { de: `${source} (${n})`, it: `${source} (${n})`, en: `${source} (${n})`, fr: `${source} (${n})` },
  });

  it('keeps the slots of one pair together, in job order', () => {
    const tasks = collectDescriptionFixTasks([job(1), job(2), job(3)]);
    expect(tasks.map((task: { job: { id: string }; locale: string }) => `${task.locale}:${task.job.id}`)).toEqual([
      'it:j1', 'it:j2', 'it:j3',
      'en:j1', 'en:j2', 'en:j3',
      'fr:j1', 'fr:j2', 'fr:j3',
    ]);
  });
});

describe('runDescriptionFixPool reports the slots really in flight', () => {
  it('two tasks at limit 1 peak at 1 (review of PR 13661)', async () => {
    let peak = 0;
    await runDescriptionFixPool([1, 2], async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }, {
      limit: () => descriptionFixConcurrency({ lanePresent: false }),
      onStart: (inFlight: number) => { peak = Math.max(peak, inFlight); },
    });
    expect(peak).toBe(1);
  });

  it('peaks at the limit when there is work for it', async () => {
    let peak = 0;
    await runDescriptionFixPool([1, 2, 3, 4, 5], async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }, {
      limit: () => 3,
      onStart: (inFlight: number) => { peak = Math.max(peak, inFlight); },
    });
    expect(peak).toBe(3);
  });
});
