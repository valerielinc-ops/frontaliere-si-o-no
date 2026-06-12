import { describe, expect, it } from 'vitest';

// Import order MATTERS and is part of the regression being locked:
// `jobBoardCommuterContext` is evaluated FIRST, mirroring the bundle
// evaluation order of the deploy build that crashed on main (run
// 27401576244, post #1938). With CALC_HREF defined inside
// jobBoardCommuterContext, cantonSeoProse's `import { CALC_HREF }` read an
// uninitialized binding through the jobBoardCommuterContext ↔
// cantonSeoProse cycle → `CALCULATOR_HREF` undefined →
// `TypeError: Cannot read properties of undefined (reading 'it')` in
// buildSlotCopy at closeBundle. CALC_HREF now lives in the dependency-free
// `calcHref.ts` leaf module, making the cycle impossible by construction.
import { CALC_HREF } from '../build-plugins/shared/jobBoardCommuterContext';
import { renderCantonSeoProse } from '../build-plugins/shared/cantonSeoProse';

describe('cantonSeoProse ↔ jobBoardCommuterContext cycle', () => {
  it('CALC_HREF is initialized when jobBoardCommuterContext evaluates first', () => {
    expect(CALC_HREF).toBeDefined();
    expect(CALC_HREF.it).toBe('/calcola-stipendio/');
    expect(CALC_HREF.fr).toBe('/fr/calculer-salaire/');
  });

  it('renderCantonSeoProse renders the calculator cross-link (no undefined table)', () => {
    const html = renderCantonSeoProse({
      locale: 'it',
      cantonDisplay: 'Ticino',
      slot: 'canton-hub',
    });
    expect(html).toContain(CALC_HREF.it);
  });
});
