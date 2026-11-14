import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';

import {
  _resetJobsSeoPagesSignalForTests,
  registerJobsSeoPagesProducer,
  shouldAwaitJobsSeoPagesFlushed,
} from '../../build-plugins/shared/buildSignals';

describe('sitemap alias jobs barrier', () => {
  afterEach(() => {
    _resetJobsSeoPagesSignalForTests();
  });

  it('does not wait for the omitted jobs producer in FAST_BUILD', () => {
    registerJobsSeoPagesProducer();
    expect(shouldAwaitJobsSeoPagesFlushed(true)).toBe(false);
  });

  it('does not wait when no jobs producer is registered', () => {
    expect(shouldAwaitJobsSeoPagesFlushed(false)).toBe(false);
  });

  it('keeps the jobs barrier for complete builds with a registered producer', () => {
    registerJobsSeoPagesProducer();
    expect(shouldAwaitJobsSeoPagesFlushed(false)).toBe(true);
  });

  it('checks dist only after constructing and awaiting the existing producer barriers', () => {
    const source = fs.readFileSync(
      new URL('../../build-plugins/sitemapAliasPlugin.ts', import.meta.url),
      'utf8',
    );
    const handlerStart = source.indexOf('async handler() {');
    expect(handlerStart).toBeGreaterThan(-1);
    const reconcileStart = source.indexOf('await reconcileFinalSitemapsWithDist', handlerStart);
    expect(reconcileStart).toBeGreaterThan(handlerStart);
    const handler = source.slice(handlerStart, reconcileStart);

    const barrierVector = handler.indexOf(
      'const buildSignals: Promise<void>[] = process.env.FAST_BUILD',
    );
    const jobsBarrier = handler.indexOf(
      'if (shouldAwaitJobsSeoPagesFlushed()) buildSignals.push(jobsSeoPagesFlushed);',
    );
    const waitForBarriers = handler.indexOf('await Promise.all(buildSignals);');
    const distCheck = handler.indexOf('if (!fs.existsSync(distDir)) return;');

    expect(barrierVector).toBeGreaterThan(-1);
    expect(handler).toContain('? []\n          : [staticPagesFlushed, fuelDailyPagesFlushed]');
    expect(jobsBarrier).toBeGreaterThan(barrierVector);
    expect(waitForBarriers).toBeGreaterThan(jobsBarrier);
    expect(distCheck).toBeGreaterThan(waitForBarriers);
  });
});
