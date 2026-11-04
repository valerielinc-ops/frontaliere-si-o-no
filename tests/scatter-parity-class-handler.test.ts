import { describe, expect, it } from 'vitest';
import {
  applyAssembledToSliceJob,
  diagnoseScatterParity,
  scatterParityClassHandler,
} from '../scripts/scatter-jobs-to-slices.mjs';

const baseJob = () => ({
  id: 'job-1',
  url: 'https://example.test/jobs/1',
  slugByLocale: { it: 'job-1' },
  titleByLocale: { it: 'Titolo' },
  descriptionByLocale: { it: 'Descrizione' },
});

describe('scatter parity class handling', () => {
  it('keeps a marker-only write out of the unknown class', () => {
    const sliceJob = baseJob();
    const assembled = { ...baseJob(), needsRetranslation: true };
    const projectedJob = applyAssembledToSliceJob(sliceJob, assembled).job;

    expect(scatterParityClassHandler({ sliceJob, projectedJob })).toEqual({
      classes: ['retranslation'],
      changes: {
        retranslation: { before: false, after: true },
      },
    });

    const report = diagnoseScatterParity(
      [assembled],
      [{ file: 'fixture.json', jobs: [sliceJob] }],
    );
    expect(report.pendingWrites).toMatchObject({
      total: 1,
      byClass: { retranslation: 1 },
      examples: [{ classes: ['retranslation'], changes: {
        retranslation: { before: false, after: true },
      } }],
    });
  });
});
