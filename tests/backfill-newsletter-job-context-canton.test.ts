import { describe, expect, it } from 'vitest';
import { extractSlugFromSourcePage } from '../scripts/backfill-newsletter-job-context.mjs';

describe('extractSlugFromSourcePage is canton-aware (not TI-only)', () => {
  // Regression: JOB_BOARD_SEGMENTS used to be a 4-entry TI-legacy-only Set,
  // so a subscriber whose last-clicked job link was a non-TI canton page
  // (e.g. /cerca-lavoro-vaud/some-job/) silently lost its geo-preference
  // signal in scripts/send-job-alerts.mjs's clickedJobMeta(). Same bug class
  // as the job-alert/newsletter canton-URL fix — see jobBoardSections.mjs.
  it('extracts the slug for TI legacy job-board URLs (all 4 locales)', () => {
    expect(extractSlugFromSourcePage('/cerca-lavoro-ticino/some-job/')).toBe('some-job');
    expect(extractSlugFromSourcePage('/en/find-jobs-ticino/some-job/')).toBe('some-job');
    expect(extractSlugFromSourcePage('/de/jobs-im-tessin/some-job/')).toBe('some-job');
    expect(extractSlugFromSourcePage('/fr/trouver-emploi-tessin/some-job/')).toBe('some-job');
  });

  it('extracts the slug for non-TI canton job-board URLs', () => {
    expect(extractSlugFromSourcePage('/cerca-lavoro-vaud/some-job/')).toBe('some-job');
    expect(extractSlugFromSourcePage('/en/find-jobs-geneva/some-job/')).toBe('some-job');
    expect(extractSlugFromSourcePage('/de/jobs-in-aargau/some-job/')).toBe('some-job');
    expect(extractSlugFromSourcePage('/de/jobs-in-der-waadt/some-job/')).toBe('some-job');
  });

  it('returns empty string for non-job-board URLs', () => {
    expect(extractSlugFromSourcePage('/preferenze/')).toBe('');
    expect(extractSlugFromSourcePage('')).toBe('');
    expect(extractSlugFromSourcePage(undefined)).toBe('');
  });
});
