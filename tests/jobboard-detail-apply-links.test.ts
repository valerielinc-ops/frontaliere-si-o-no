import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'components/community/JobBoard.tsx'),
  'utf-8',
);

// The rendered (live) job-detail path begins at the unique 12-col grid; the
// dead `if (hybridLayoutEnabled)` block sits before it. Asserting against this
// slice prevents a false-green where a required element exists ONLY in the dead
// hybrid block (the regression that broke sponsored in-house apply: #candidatura
// + PublisherApplyForm were trapped in the disabled hybrid layout).
const livePath = source.slice(source.indexOf('grid grid-cols-1 lg:grid-cols-12'));

describe('job detail header apply actions', () => {
  it('keeps both the header logo and title as apply CTAs', () => {
    expect(source).toContain('job_board_apply_header_logo');
    expect(source).toContain('job_board_apply_header_title');
    expect(source).toContain("aria-label={`${t('jobBoard.apply')} ${selectedJob.company}`}");
  });

  it.each(['logo', 'title'])('routes the header %s through the shared apply handler without an external-link bypass', (surface) => {
    const block = livePath.match(new RegExp(`<button\\s+type="button"\\s+onClick=\\{\\(\\) => handleApply\\(selectedJob, 'job_board_apply_header_${surface}'\\)\\}[\\s\\S]*?</button>`))?.[0];
    expect(block).toBeDefined();
    expect(block).not.toMatch(/\b(?:href|target|onAuxClick)=/);
    // Native buttons also activate via keyboard; the browser cannot offer
    // "open link in a new tab" to skip the shared application flow.
    expect(source).not.toContain("href={isInHouseApply ? '#candidatura' : applyUrl}");
    expect(source).toContain("mode === 'in_house' || mode === 'forward_email'");
    expect(source).toContain("document.getElementById('candidatura')?.scrollIntoView");
  });

  it('mounts the in-house apply form (#candidatura) in the LIVE detail path, not only the dead hybrid block', () => {
    expect(livePath).toContain('id="candidatura"');
    expect(livePath).toContain('<PublisherApplyForm');
    expect(livePath).toContain('{isInHouseApply && (');
  });
});
