import { describe, expect, it } from 'vitest';
// IMPORTANT: import BOTH modules of the former cycle. jobBoardCommuterContext
// imports renderCantonSeoProse from cantonSeoProse; until the CALC_HREF table
// moved to the leaf module shared/calcHref.ts, cantonSeoProse imported it BACK
// from jobBoardCommuterContext — a circular import that froze the module-level
// `CALCULATOR_HREF` alias to undefined and crashed the FULL build on main
// (`TypeError: Cannot read properties of undefined (reading 'it')`, deploy run
// 27401576244 — the PR gate never executes this path, only the post-merge
// build does). This test renders the actual prose so any future re-cycle
// fails HERE, pre-merge.
import { renderCantonSeoProse, type CantonSeoLocale } from '@/build-plugins/shared/cantonSeoProse';
import { CALC_HREF } from '@/build-plugins/shared/jobBoardCommuterContext';
import { CALC_HREF as LEAF_CALC_HREF } from '@/build-plugins/shared/calcHref';

const LOCALES: CantonSeoLocale[] = ['it', 'en', 'de', 'fr'];

describe('canton SEO prose calculator cross-link (anti import-cycle guard)', () => {
  it('CALC_HREF re-export stays wired to the leaf module', () => {
    expect(CALC_HREF).toBe(LEAF_CALC_HREF);
    expect(CALC_HREF.it).toBe('/calcola-stipendio/');
  });

  it.each(LOCALES)('renders the %s canton prose with the calculator href and no undefined', (locale) => {
    const html = renderCantonSeoProse({
      locale,
      cantonDisplay: 'Zurigo',
      slot: 'canton-hub',
    });
    expect(html).toContain(`href="${LEAF_CALC_HREF[locale]}"`);
    // The cycle bug surfaced as `href="undefined"` / a TypeError before the
    // render even completed — both shapes must never reappear.
    expect(html).not.toContain('undefined');
  });
});
