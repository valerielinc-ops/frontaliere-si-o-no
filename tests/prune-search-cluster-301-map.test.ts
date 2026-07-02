import { describe, expect, it } from 'vitest';

import { AGGREGATE_KEY } from '@/build-plugins/shared/cantonResolvers.mjs';
import { LOCALE_CONFIG, sectionRoot } from '@/scripts/build-search-cluster-301-map.mjs';
import {
  isSpecificClusterTarget,
  pruneStaleEntries,
} from '@/scripts/prune-search-cluster-301-map.mjs';
import searchClusterMapFile from '@/data/search-cluster-301-map.json';

// Derive real "specific" target shapes from the exported building blocks instead
// of hardcoding guessed slugs, so this test can't drift from the generator's own
// definition of what a "specific" target looks like.
const itRoot = sectionRoot('it', AGGREGATE_KEY);
const itPrefix = LOCALE_CONFIG.it.searchPrefix;
const LIVE_TARGET = `${itRoot}/${itPrefix}-infermiera-lugano/`;
const STALE_TARGET = `${itRoot}/${itPrefix}-ruolo-rimosso-comune/`;
const BOARD_TARGET = '/cerca-lavoro-ticino/';

describe('isSpecificClusterTarget (issue #2918 item 3)', () => {
  it('recognizes the national cluster hub target shape built from real exported helpers', () => {
    expect(isSpecificClusterTarget(LIVE_TARGET)).toBe(true);
  });

  it('recognizes at least one real "specific" target per locale from the live map fixture', () => {
    const map = (searchClusterMapFile as { map: Record<string, string> }).map;
    const specificTargets = Object.values(map).filter((t) => isSpecificClusterTarget(t));
    expect(specificTargets.length, 'expected at least one specific target in the map fixture').toBeGreaterThan(0);
  });

  it('does NOT flag a canton/national board or per-city job page as specific', () => {
    const map = (searchClusterMapFile as { map: Record<string, string> }).map;
    // Non-cluster-page target: no locale's searchPrefix appears right after its
    // national-aggregate root — a plain canton/national board or per-city page.
    const board = Object.values(map).find((t) => !isSpecificClusterTarget(t));
    expect(board, 'expected at least one non-specific (board/city) target in the map fixture').toBeTruthy();
    if (board) expect(isSpecificClusterTarget(board)).toBe(false);
    expect(isSpecificClusterTarget(BOARD_TARGET)).toBe(false);
  });
});

describe('pruneStaleEntries (issue #2918 item 3)', () => {
  it('drops only "specific" entries whose target is missing from the live cluster set', () => {
    const mapData = {
      counts: { specific: 2, total: 3, byLocale: { it: 3, en: 0, de: 0, fr: 0 } },
      map: {
        '/cerca-lavoro-ticino/ricerca-infermiera-lugano/': LIVE_TARGET,
        '/cerca-lavoro-ticino/ricerca-ruolo-rimosso-comune/': STALE_TARGET,
        '/cerca-lavoro-ticino/ricerca-fallback/': BOARD_TARGET,
      },
    };
    const live = new Set([LIVE_TARGET]); // STALE_TARGET deliberately absent

    const { kept, dropped, counts } = pruneStaleEntries(mapData, live);

    expect(Object.keys(kept).sort()).toEqual([
      '/cerca-lavoro-ticino/ricerca-fallback/',
      '/cerca-lavoro-ticino/ricerca-infermiera-lugano/',
    ]);
    expect(dropped).toEqual([['/cerca-lavoro-ticino/ricerca-ruolo-rimosso-comune/', STALE_TARGET]]);
    expect(counts.total).toBe(2);
    expect(counts.specific).toBe(1); // was 2, one specific target pruned
    expect(counts.byLocale.it).toBe(2);
  });

  it('never prunes a board/city target even when it is absent from the live cluster-sitemap set', () => {
    const mapData = { counts: {}, map: { '/legacy/': BOARD_TARGET } };
    const { kept, dropped } = pruneStaleEntries(mapData, new Set()); // empty live set
    expect(kept).toEqual({ '/legacy/': BOARD_TARGET });
    expect(dropped).toEqual([]);
  });

  it('is a no-op when every specific target is still live', () => {
    const mapData = {
      counts: { specific: 1, total: 1, byLocale: { it: 1, en: 0, de: 0, fr: 0 } },
      map: { '/cerca-lavoro-ticino/ricerca-infermiera-lugano/': LIVE_TARGET },
    };
    const { kept, dropped } = pruneStaleEntries(mapData, new Set([LIVE_TARGET]));
    expect(dropped).toEqual([]);
    expect(kept).toEqual(mapData.map);
  });

  it('tolerates a missing/malformed map field by treating it as empty rather than throwing', () => {
    const { kept, dropped } = pruneStaleEntries({ counts: {} } as never, new Set());
    expect(kept).toEqual({});
    expect(dropped).toEqual([]);
  });
});
