/**
 * Regression: a seeded expired page must remain expired after JobBoard hydrates.
 *
 * The static SSG shell can be correct while the live index also contains the
 * same slug. In that collision, the selectedJob branch must yield to the
 * build-seeded expired route or React replaces the page with the old active
 * detail layout.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const jobBoardSource = readFileSync(
 new URL('../../components/community/JobBoard.tsx', import.meta.url),
 'utf8',
);

describe('expired page hydration precedence', () => {
 it('keeps a seeded expired route out of the active selectedJob branch', () => {
  expect(jobBoardSource).toMatch(
   /const isSeededExpiredDetail = Boolean\(\s*initialJobSlug && onSeededDocument\(\) && seededJobMatchesSlug\(initialJobSlug\)/,
  );

  const selectorStart = jobBoardSource.indexOf('const selectedJob = useMemo');
  const selectorEnd = jobBoardSource.indexOf('Profession landing links use', selectorStart);
  expect(selectorStart).toBeGreaterThan(-1);
  expect(selectorEnd).toBeGreaterThan(selectorStart);

  const selector = jobBoardSource.slice(selectorStart, selectorEnd);
  expect(selector).toContain('if (isSeededExpiredDetail) return null;');
  expect(selector).toContain('isSeededExpiredDetail]);');
 });

 it('scopes the expired seed presence check to the document that emitted it', () => {
  expect(jobBoardSource).toContain(
   'const seeded = useMemo(() => hasSeededExpiredData() && onSeededDocument(), [seedPathname]);',
  );
 });
});
