/**
 * Regression guard for the SECTOR_HUB_SLUG sibling bug class across
 * build-plugins/** (issue #3608 item 2 sibling audit): every hand-authored
 * `Record<Locale, Record<Key, string>>` slug table that feeds a canonical/
 * indexed URL carries a TypeScript type that would reject a missing entry
 * at compile time, but `vite build` transpiles via esbuild with no `tsc`
 * pass, so a missing entry silently ships and renders a literal
 * "undefined" segment into the URL.
 *
 * Two things are covered here:
 *  1. The shared generic checker (build-plugins/shared/localeTableCompleteness.ts)
 *     behaves correctly in isolation (missing key / undefined / empty-string
 *     value / fully-populated table).
 *  2. localeTableCompletenessPlugin (build-plugins/localeTableCompletenessPlugin.ts)
 *     actually wires the real production tables — HUB_SLUG_BY_LOCALE,
 *     NURSING_LANDING_SLUGS, HEALTH_PREMIUM_CANTON_SLUG,
 *     HEALTH_PREMIUM_AGE_SLUG, FUEL_SECTION_SLUG, PROFESSION_SLUGS — into
 *     its closeBundle() hook, and that hook does not throw against the real
 *     data (i.e. today's tables are actually complete, and a future
 *     incomplete edit to any one of them would fail the build via this
 *     same plugin).
 */
import { describe, expect, it } from 'vitest';
import {
  assertLocaleTablesComplete,
  findMissingLocaleTableEntries,
} from '../build-plugins/shared/localeTableCompleteness';
import { localeTableCompletenessPlugin } from '../build-plugins/localeTableCompletenessPlugin';

type Table = Record<'it' | 'en', Record<'a' | 'b', string>>;

describe('findMissingLocaleTableEntries', () => {
  it('reports nothing for a fully-populated table', () => {
    const complete: Table = { it: { a: 'x', b: 'y' }, en: { a: 'x', b: 'y' } };
    const missing = findMissingLocaleTableEntries([['T', complete]], ['it', 'en'], ['a', 'b']);
    expect(missing).toEqual([]);
  });

  it('flags a missing key, an undefined value, and an empty-string value by table.locale.key label', () => {
    const incomplete = {
      it: { a: 'x', b: '' }, // empty string
      en: { a: 'x' }, // 'b' missing entirely
    } as unknown as Table;
    const missing = findMissingLocaleTableEntries([['T', incomplete]], ['it', 'en'], ['a', 'b']);
    expect(missing.sort()).toEqual(['T.en.b', 'T.it.b'].sort());
  });

  it('flags an entire missing locale across every key', () => {
    const incomplete = { it: { a: 'x', b: 'y' } } as unknown as Table;
    const missing = findMissingLocaleTableEntries([['T', incomplete]], ['it', 'en'], ['a', 'b']);
    expect(missing.sort()).toEqual(['T.en.a', 'T.en.b'].sort());
  });

  it('checks multiple tables independently in a single call', () => {
    const t1 = { it: { a: 'x', b: 'y' }, en: { a: 'x', b: 'y' } } as unknown as Table;
    const t2 = { it: { a: 'x', b: '' }, en: { a: 'x', b: 'y' } } as unknown as Table;
    const missing = findMissingLocaleTableEntries(
      [
        ['T1', t1],
        ['T2', t2],
      ],
      ['it', 'en'],
      ['a', 'b'],
    );
    expect(missing).toEqual(['T2.it.b']);
  });
});

describe('assertLocaleTablesComplete', () => {
  it('does not throw for a fully-populated table', () => {
    const complete: Table = { it: { a: 'x', b: 'y' }, en: { a: 'x', b: 'y' } };
    expect(() => assertLocaleTablesComplete('T', [['T', complete]], ['it', 'en'], ['a', 'b'])).not.toThrow();
  });

  it('throws with the label and the missing entry list when incomplete', () => {
    const incomplete = { it: { a: 'x', b: 'y' }, en: { a: 'x' } } as unknown as Table;
    expect(() => assertLocaleTablesComplete('T', [['T', incomplete]], ['it', 'en'], ['a', 'b'])).toThrow(
      /\[T\].*T\.en\.b/s,
    );
  });
});

describe('localeTableCompletenessPlugin — issue #3608 item 2 sibling fix', () => {
  it('is a build-only closeBundle plugin (matches the buildIdPlugin.ts convention)', () => {
    const plugin = localeTableCompletenessPlugin();
    expect(plugin.name).toBe('locale-table-completeness');
    expect(plugin.apply).toBe('build');
    expect(typeof plugin.closeBundle).toBe('function');
  });

  it('does not throw against the real production tables (seoHubsData, nursingLandingsData, healthPremiumsData x2, fuelDailyData, professionLandingsData)', async () => {
    const plugin = localeTableCompletenessPlugin();
    // closeBundle is typed loosely by Vite's Plugin type; invoke with no args
    // the way Rollup does for a hook with no parameters.
    const hook = plugin.closeBundle as (() => void | Promise<void>) | undefined;
    expect(hook).toBeTypeOf('function');
    await expect(Promise.resolve(hook!())).resolves.not.toThrow();
  });
});
