import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { guardCompleteGa4Report } from '../../scripts/lib/ga4-refresh-guard.mjs';

describe('GA4 refresh completeness guard', () => {
  it('scarta le righe parziali e mantiene la fonte non valida', () => {
    const guarded = guardCompleteGa4Report({
      rows: [{ path: '/partial/' }],
      reportedRows: 2,
      complete: false,
    });

    expect(guarded.rows).toEqual([]);
    expect(guarded.accepted).toBe(false);
    expect(guarded.source).toMatchObject({ ok: false, complete: false, reportedRows: 2 });
  });

  it.each([
    'scripts/refresh-indexed-cluster-urls.mjs',
    'scripts/refresh-noslash-keep.mjs',
  ])('%s non ingerisce un report non completo', (file) => {
    const source = readFileSync(resolve(file), 'utf8');
    expect(source).toContain('guardCompleteGa4Report');
    expect(source).toMatch(/if \(!guarded\.accepted\)/);
    expect(source).toMatch(/sources\.ga4 = guarded\.source/);
  });
});
