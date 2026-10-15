import { describe, expect, it } from 'vitest';
import {
  BORDER_WAIT_LOCALES,
  buildOggiPath,
} from '../../build-plugins/borderWaitData';
import {
  generateBorderWaitPages,
  type BorderWaitCurrent,
  type BorderWaitHistoryDay,
} from '../../build-plugins/borderWaitPagesPlugin';
import { extractVisibleText } from '../../scripts/audit-text-html-ratio.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const CROSSING = 'st-luzisteig' as const;

describe('border-wait leaf text-to-HTML ratio', () => {
  it('keeps chart-bearing leaves above the production 10% floor in every locale', () => {
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);

    const history: BorderWaitHistoryDay[] = Array.from({ length: 7 }, (_, index) => ({
      date: new Date(today.getTime() - index * DAY_MS).toISOString().slice(0, 10),
      perCrossing: {
        [CROSSING]: Array.from({ length: 24 }, (_, hour) => ({
          min: 4 + (hour % 3),
          avg: 6 + (hour % 4),
          max: 9 + (hour % 5),
          samples: 1,
        })),
      },
    }));
    const current: BorderWaitCurrent = {
      updatedAt: today.toISOString(),
      perCrossing: {
        [CROSSING]: {
          waitTimeMinutes: 8,
          source: 'tomtom',
          lastUpdate: today.toISOString(),
          status: 'yellow',
        },
      },
    };

    const pages = generateBorderWaitPages({ current, history, today });
    const offenders = BORDER_WAIT_LOCALES.flatMap((locale) => {
      const route = buildOggiPath(locale, CROSSING);
      const html = pages[route];
      const ratio = Buffer.byteLength(extractVisibleText(html), 'utf8')
        / Buffer.byteLength(html, 'utf8')
        * 100;
      return ratio <= 10 ? [{ route, ratio }] : [];
    });

    expect(offenders).toEqual([]);
  }, 120_000);
});
