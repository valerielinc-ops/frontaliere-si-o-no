import { describe, expect, it } from 'vitest';
import {
  activeJobSeedJson,
  replaceActiveJobPostingDates,
  replaceActiveJobSeed,
} from '../build-plugins/shared/activeJobPostingReuse.mjs';
import { inlineScriptJson } from '../build-plugins/shared/inlineJsonScript';

const wrap = (record: Record<string, unknown>) =>
  `<script type="application/ld+json">${inlineScriptJson(record)}</script>`;

describe('active JobPosting cache rewrite', () => {
  it('refreshes the active page seed without changing surrounding bytes', () => {
    const cached = '<main><script>window.__JOB_SEED__={"crawledAt":"old"};</script></main>';
    const expected = '<main><script>window.__JOB_SEED__={"crawledAt":"new"};</script></main>';

    expect(activeJobSeedJson(cached)).toBe('{"crawledAt":"old"}');
    expect(replaceActiveJobSeed(cached, '{"crawledAt":"new"}')).toBe(expected);
  });

  it('fails closed when cached or current seed JSON is malformed', () => {
    expect(() => activeJobSeedJson('<script>window.__JOB_SEED__={bad};</script>'))
      .toThrow('malformed window.__JOB_SEED__ JSON');
    expect(() => replaceActiveJobSeed(
      '<script>window.__JOB_SEED__={};</script>',
      '{bad}',
    )).toThrow('malformed window.__JOB_SEED__ JSON');
  });

  it('matches a fresh render when the source has no crawledAt', () => {
    const cachedRecord = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Bilingual service assistant',
      datePosted: '2026-10-01',
      validThrough: '2026-10-31T00:00:00.000Z',
      crawledAt: '2026-10-14T10:00:00.000Z',
    };
    const expectedRecord = { ...cachedRecord };
    expectedRecord.datePosted = '2026-10-02';
    expectedRecord.validThrough = '2026-11-01T00:00:00.000Z';
    delete expectedRecord.crawledAt;

    const actual = replaceActiveJobPostingDates(
      wrap(cachedRecord),
      '2026-10-02',
      '2026-11-01T00:00:00.000Z',
      null,
      undefined,
      inlineScriptJson,
    );

    expect(actual).toBe(wrap(expectedRecord));
  });

  it('keeps the safety fallback when a current heartbeat has no cached field', () => {
    const cachedRecord = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      datePosted: '2026-10-01',
      validThrough: '2026-10-31T00:00:00.000Z',
    };

    expect(() => replaceActiveJobPostingDates(
      wrap(cachedRecord),
      '2026-10-02',
      '2026-11-01T00:00:00.000Z',
      '2026-10-15T10:00:00.000Z',
      undefined,
      inlineScriptJson,
    )).toThrow('missing JobPosting JSON-LD field: crawledAt');
  });

  it('inserts a newly available validThrough in the full-render property order', () => {
    const cachedRecord = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      datePosted: '2026-10-01',
      crawledAt: '2026-10-14T10:00:00.000Z',
    };
    const expectedRecord = {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      datePosted: '2026-10-02',
      validThrough: '2026-11-01T00:00:00.000Z',
    };

    const actual = replaceActiveJobPostingDates(
      wrap(cachedRecord),
      '2026-10-02',
      '2026-11-01T00:00:00.000Z',
      null,
      undefined,
      inlineScriptJson,
    );

    expect(actual).toBe(wrap(expectedRecord));
  });
});
