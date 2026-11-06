import { describe, expect, it } from 'vitest';

import { classifyUnresolvedCoveragePath } from '../scripts/ingest-gsc-coverage-404s';

describe('FU-2026-10-21-003 GSC coverage path classification', () => {
  it('strips query and fragment before classifying a source-backed utility route', () => {
    expect(classifyUnresolvedCoveragePath('https://frontaliereticino.ch/contattaci?utm_source=gsc#footer'))
      .toMatchObject({
        kind: 'compat',
        path: '/contattaci',
        canonicalPath: '/contattaci/',
      });
  });
});
