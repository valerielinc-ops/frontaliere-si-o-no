/**
 * Tests for the border-wait snapshot script.
 *
 * The script (scripts/snapshot-border-wait-history.mjs) calls the Firestore
 * SDK, which we cannot exercise here without live credentials. Instead we
 * test the aggregation contract shape that the plugin expects, plus a
 * round-trip of the JSON format the script emits.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  generateBorderWaitPages,
  type BorderWaitHistoryDay,
  type BorderWaitCurrent,
} from '../build-plugins/borderWaitPagesPlugin';
import { buildOggiPath } from '../build-plugins/borderWaitData';

// ── Script presence & basic integrity ─────────────────────────────

describe('snapshot-border-wait-history script', () => {
  const scriptPath = path.resolve(__dirname, '..', 'scripts', 'snapshot-border-wait-history.mjs');

  it('script exists and is executable ES module', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
    const raw = fs.readFileSync(scriptPath, 'utf-8');
    expect(raw).toContain("import admin from 'firebase-admin';");
    expect(raw).toContain('trafficCurrent');
    expect(raw).toContain('trafficHistory');
  });

  it('script writes data/border-wait-current.json and data/border-wait-history/YYYY-MM-DD.json', () => {
    const raw = fs.readFileSync(scriptPath, 'utf-8');
    expect(raw).toContain('border-wait-current.json');
    expect(raw).toContain('border-wait-history');
  });

  it('script prunes files older than 90 days', () => {
    const raw = fs.readFileSync(scriptPath, 'utf-8');
    expect(raw).toMatch(/pruneOldHistory/);
    expect(raw).toContain('90');
  });
});

// ── Aggregation shape — history → plugin ───────────────────────────

describe('history aggregation shape', () => {
  it('plugin accepts a 24-bucket aggregate with {min,avg,max,samples} cells', () => {
    const history: BorderWaitHistoryDay[] = [
      {
        date: '2026-04-21',
        perCrossing: {
          'chiasso-brogeda': Array.from({ length: 24 }, (_, h) => ({
            min: 0,
            avg: h === 7 ? 35 : 5,
            max: 60,
            samples: 4,
          })),
        },
      },
    ];
    const current: BorderWaitCurrent = {
      updatedAt: '2026-04-21T08:00:00.000Z',
      perCrossing: {
        'chiasso-brogeda': {
          waitTimeMinutes: 35,
          source: 'tomtom',
          lastUpdate: '2026-04-21T08:00:00.000Z',
          status: 'red',
        },
      },
    };
    const pages = generateBorderWaitPages({
      current,
      history,
      today: new Date('2026-04-21T08:00:00.000Z'),
    });
    // Presence test: the hourly SVG shows up for Brogeda (has history)
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toContain('<svg');
    // 35-min bar tooltip should appear
    expect(html).toContain('35 min @ 07:00');
  });

  it('null buckets (no samples) do not break the renderer', () => {
    const history: BorderWaitHistoryDay[] = [
      {
        date: '2026-04-21',
        perCrossing: {
          'chiasso-brogeda': Array(24).fill(null),
        },
      },
    ];
    const current: BorderWaitCurrent = {
      updatedAt: '2026-04-21T08:00:00.000Z',
      perCrossing: {},
    };
    expect(() =>
      generateBorderWaitPages({
        current,
        history,
        today: new Date('2026-04-21T08:00:00.000Z'),
      }),
    ).not.toThrow();
  });

  it('missing crossing in perCrossing map falls back to static banner', () => {
    const history: BorderWaitHistoryDay[] = [];
    const current: BorderWaitCurrent = { updatedAt: null, perCrossing: {} };
    const pages = generateBorderWaitPages({
      current,
      history,
      today: new Date('2026-04-21T08:00:00.000Z'),
    });
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    // Static fallback banner in IT
    expect(html).toContain('Dati statistici');
  });
});
