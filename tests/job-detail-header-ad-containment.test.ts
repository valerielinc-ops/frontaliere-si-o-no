import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  JOB_DETAIL_HEADER_CONTENT_RESERVE_CLASS,
  JOB_DETAIL_METADATA_RESERVE_1_CLASS,
  JOB_DETAIL_METADATA_RESERVE_2_CLASS,
} from '@/components/community/jobDetailHeaderGeometry';
import {
  JOB_DETAIL_HEADER_CONTENT_CLASS,
  JobDetailMetadataRow,
} from '@/components/community/JobDetailPresentation';

const jobBoardSource = readFileSync(
  resolve(__dirname, '..', 'components', 'community', 'JobBoard.tsx'),
  'utf8',
);
const jobDetailPresentationSource = readFileSync(
  resolve(__dirname, '..', 'components', 'community', 'JobDetailPresentation.tsx'),
  'utf8',
);
const skeletonsSource = readFileSync(
  resolve(__dirname, '..', 'components', 'shared', 'Skeletons.tsx'),
  'utf8',
);
const jobExpiredViewSource = readFileSync(
  resolve(__dirname, '..', 'components', 'community', 'JobExpiredView.tsx'),
  'utf8',
);
const jobOrphanViewSource = readFileSync(
  resolve(__dirname, '..', 'components', 'community', 'JobOrphanView.tsx'),
  'utf8',
);

describe('job detail header Auto Ads containment', () => {
  it('keeps injected Auto Ads out of all shared job-detail headers', () => {
    expect(jobBoardSource).toMatch(/<JobDetailHeaderCard data-no-auto-ads="inside">/);
    expect(jobExpiredViewSource).toMatch(/<JobDetailHeaderCard data-no-auto-ads="inside">/);
    expect(jobOrphanViewSource).toMatch(/<JobDetailHeaderCard data-no-auto-ads="inside"/);
    expect(jobDetailPresentationSource).toContain(
      "rounded-3xl border border-edge bg-gradient-to-br from-info-subtle via-surface to-success-subtle p-4 sm:p-6",
    );
    expect(jobDetailPresentationSource).toContain('data-job-detail-header');
  });

  it('does not opt the whole job-detail page out of Auto Ads', () => {
    expect(jobBoardSource).not.toMatch(/<main[^>]*data-no-auto-ads/);
  });
});

// CLS (issue 20412): the header card has no static markup (build-plugins emit
// none), so its height came only from content and moved the whole body at
// hydration. The geometry is reserved per breakpoint and shared with the skeleton.
describe('job detail header reserved geometry', () => {
  const minHeights = (cls: string) => Object.fromEntries(
    cls.split(' ').filter((c) => c.includes('min-h-[')).map((c) => {
      const m = c.match(/^(?:(sm|md):)?min-h-\[(\d+)px\]$/);
      return [m?.[1] ?? 'base', Number(m?.[2])];
    }),
  );

  it('reserves a content row per breakpoint covering title lines + subtitle', () => {
    const h = minHeights(JOB_DETAIL_HEADER_CONTENT_RESERVE_CLASS);
    // below sm: 2 title lines (2 x 25) + subtitle (4 + 44 touch target)
    expect(h.base).toBe(2 * 25 + 4 + 44);
    // sm: the 80px logo frame is the floor (one 30px title line + 48 = 78)
    expect(h.sm).toBe(80);
    // md: one 37.5px title line + 48 subtitle, rounded to the line box
    expect(h.md).toBeGreaterThanOrEqual(86);
    expect(h.md).toBeLessThanOrEqual(96);
    expect(JOB_DETAIL_HEADER_CONTENT_CLASS).toContain(JOB_DETAIL_HEADER_CONTENT_RESERVE_CLASS);
  });

  it('reserves pill rows: one 24px row, or two wrapped rows below sm', () => {
    expect(minHeights(JOB_DETAIL_METADATA_RESERVE_1_CLASS).base).toBe(24);
    const two = minHeights(JOB_DETAIL_METADATA_RESERVE_2_CLASS);
    expect(two.base).toBe(24 + 8 + 24);
    expect(two.sm).toBe(24);
  });

  it('the metadata row applies the reserve without stretching wrapped lines', () => {
    const one = JobDetailMetadataRow({ children: null }) as { props: { className: string } };
    const two = JobDetailMetadataRow({ children: null, reserveRows: 2 }) as { props: { className: string } };
    expect(one.props.className).toContain(JOB_DETAIL_METADATA_RESERVE_1_CLASS);
    expect(two.props.className).toContain(JOB_DETAIL_METADATA_RESERVE_2_CLASS);
    expect(two.props.className).toContain('content-start');
  });

  it('the live job header asks for two pill rows and the skeleton paints the same box', () => {
    expect(jobBoardSource).toMatch(/<JobDetailMetadataRow reserveRows=\{2\}>/);
    expect(skeletonsSource).toContain('JOB_DETAIL_HEADER_CONTENT_RESERVE_CLASS');
    expect(skeletonsSource).toContain('JOB_DETAIL_METADATA_RESERVE_2_CLASS');
    expect(skeletonsSource).toContain('p-4 sm:p-6');
  });
});
