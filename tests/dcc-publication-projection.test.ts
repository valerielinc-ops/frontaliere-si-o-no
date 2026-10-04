import { describe, expect, it } from 'vitest';
import { dedupeByIdentityPreservingMarks, mergeBaselinePublicationEvidence } from '../scripts/lib/job-mark-persistence.mjs';
import { buildAssembledJobIdentity } from '../scripts/lib/job-identity.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import { buildJobPostingSchema } from '../build-plugins/shared/jobPostingSchema';
import { buildLocaleJob, buildLocaleJobSlim } from '../build-plugins/shared/slimJobIndex';

const now = new Date();
const publication = new Date(now.getTime() - 5 * 86400000).toISOString();
const observed = new Date(now.getTime() - 86400000).toISOString();
const base = {
  id: 'dcc-publication-projection', slug: 'dcc-publication-projection',
  url: 'https://source.example/jobs/dcc-publication-projection',
  title: 'Software Engineer', company: 'Example SA', location: 'Lugano',
  sourceLang: 'en', description: 'Develop and maintain software for our engineering team.',
  crawledAt: observed, firstSeenAt: observed,
};

describe('DCC publication evidence through public projections and schema', () => {
  it.each([
    ['legacy', { postedDate: publication }, null],
    ['unknown', { postedDate: publication, postingDateSource: 'unknown' }, null],
    ['invalid-reported', { postedDate: '2025-02-30', postingDateSource: 'reported' }, null],
    ['reported', { postedDate: publication, postingDateSource: 'reported' }, publication],
  ] as const)('preserves %s semantics after actual merge and localization', (_kind, source, expected) => {
    const [merged] = mergePreserveLocaleData([], [{ ...base, ...source }]);
    expect(merged.crawledAt).toBe(observed);
    expect(merged.firstSeenAt).toBe(observed);
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const detail = buildLocaleJob(merged, locale);
      const index = buildLocaleJobSlim(detail);
      for (const projected of [detail, index]) {
        expect(projected.postingDateSource).toBe(expected ? 'reported' : 'unknown');
        const schema = buildJobPostingSchema(projected, { locale, now, url: 'https://frontaliereticino.ch/jobs/dcc-publication-projection/' });
        if (expected) expect(schema?.datePosted).toBe(expected);
        else expect(schema).toBeNull();
      }
    }
  });
  it.each([false, true])('merges cross-slice evidence before projection (reversed=%s)', reverse => {
    const [reported] = mergePreserveLocaleData([], [{ ...base, postedDate: publication, postingDateSource: 'reported' }]);
    const legacy = { ...base, postedDate: observed, title: 'Fresh source title', needsRetranslation: true };
    const tagged = [
      { job: reported, assembledAt: publication },
      { job: legacy, assembledAt: observed },
    ];
    const { winners } = dedupeByIdentityPreservingMarks(reverse ? tagged.reverse() : tagged, buildAssembledJobIdentity);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ title: legacy.title, needsRetranslation: true, postingDateSource: 'reported', postedDate: publication, datePosted: publication });
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const detail = buildLocaleJob(winners[0], locale);
      for (const projected of [detail, buildLocaleJobSlim(detail)]) {
        expect(buildJobPostingSchema(projected, { locale, now, url: base.url })?.datePosted).toBe(publication);
      }
    }
  });

  it.each([false, true])('does not let an unmarked slice replace unknown evidence (reversed=%s)', reverse => {
    const [unknown] = mergePreserveLocaleData([], [{ ...base }]);
    const tagged = [
      { job: unknown, assembledAt: publication },
      { job: { ...base, postedDate: observed, datePosted: observed }, assembledAt: observed },
    ];
    const { winners } = dedupeByIdentityPreservingMarks(reverse ? tagged.reverse() : tagged, buildAssembledJobIdentity);
    expect(winners[0]).toMatchObject({ postingDateSource: 'unknown', postedDate: '', datePosted: '' });
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const detail = buildLocaleJob(winners[0], locale);
      for (const projected of [detail, buildLocaleJobSlim(detail)]) {
        expect(buildJobPostingSchema(projected, { locale, now, url: base.url })).toBeNull();
      }
    }
  });

  it('does not transfer publication between different identities sharing a slug', () => {
    const { winners } = dedupeByIdentityPreservingMarks([
      { job: { ...base, id: 'reported-role', postingDateSource: 'reported', postedDate: publication }, assembledAt: publication },
      { job: { ...base, id: 'different-role', url: 'https://source.example/jobs/different-role', postedDate: observed }, assembledAt: observed },
    ], buildAssembledJobIdentity);
    expect(winners).toHaveLength(2);
    expect(winners.find((job: typeof base) => job.id === 'different-role')).toMatchObject({ postingDateSource: 'unknown', postedDate: '', datePosted: '' });
    expect(winners.find((job: typeof base) => job.id === 'reported-role')).toMatchObject({ postingDateSource: 'reported', postedDate: publication });
  });

  it('keeps slice precedence and real baseline evidence, while normalizing unrelated baseline legacy', () => {
    const [unknown] = mergePreserveLocaleData([], [{ ...base, title: 'Current slice title' }]);
    const merged = mergeBaselinePublicationEvidence([
      { ...base, postingDateSource: 'reported', postedDate: publication },
      { ...base, id: 'different-role', url: 'https://source.example/jobs/different-role', postedDate: observed },
    ], [unknown], buildAssembledJobIdentity);
    expect(merged).toHaveLength(2);
    const source = merged.find((job: typeof base) => job.id === base.id);
    const different = merged.find((job: typeof base) => job.id === 'different-role');
    expect(source).toMatchObject({ title: 'Current slice title', postingDateSource: 'reported', postedDate: publication });
    expect(different).toMatchObject({ postingDateSource: 'unknown', postedDate: '', datePosted: '' });
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      for (const [job, expected] of [[source, publication], [different, null]] as const) {
        const detail = buildLocaleJob(job, locale);
        for (const projected of [detail, buildLocaleJobSlim(detail)]) {
          const schema = buildJobPostingSchema(projected, { locale, now, url: base.url });
          if (expected) expect(schema?.datePosted).toBe(expected);
          else expect(schema).toBeNull();
        }
      }
    }
  });

});
