// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  collapseDuplicateRouteEntries,
  localeRouteKeys,
} from '../scripts/lib/expired-jobs-archive.mjs';

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

describe('collapseDuplicateRouteEntries', () => {
  it('re-runs distinct-route repair after collapsing archive history', () => {
    const entries = [
      {
        companyKey: 'c',
        sourceIdentity: 'url:0',
        slug: 's0',
        previousSlugs: ['r7'],
        previousSlugsByLocale: { it: ['r2', 'r8', 'r10', 'r11', 'r13', 'r15', 'r16', 'r17', 'r18', 'r19'] },
        expiredAt: daysAgo(0),
      },
      {
        companyKey: 'c',
        sourceIdentity: 'url:1',
        slug: 's1',
        previousSlugs: ['r7', 'r19'],
        previousSlugsByLocale: {
          it: ['r4', 'r6', 'r11', 'r15', 'r16', 'r20', 'r21', 'r23'],
          en: ['r7', 'r11'],
        },
        expiredAt: daysAgo(1),
      },
      {
        companyKey: 'c',
        sourceIdentity: 'url:2',
        slug: 's2',
        previousSlugs: ['r2'],
        expiredAt: daysAgo(2),
      },
    ];

    const first = collapseDuplicateRouteEntries(structuredClone(entries), { source: 'test/fixed-point' });
    const second = collapseDuplicateRouteEntries(first.entries, { source: 'test/fixed-point-second-pass' });
    const routes = first.entries.flatMap((entry) => [...localeRouteKeys(entry)]);

    expect(first.repairedRoutes).toBeGreaterThan(0);
    expect(new Set(routes).size).toBe(routes.length);
    expect(second.collapsed).toBe(0);
    expect(second.repairedRoutes).toBe(0);
  });
});
