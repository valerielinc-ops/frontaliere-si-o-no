/**
 * Unit tests for `buildListItemJobPosting` — the helper that embeds a full
 * JobPosting inside an ItemList ListItem on job LIST pages (editorial
 * landings + per-canton city/sector/company hubs).
 */
import { describe, it, expect } from 'vitest';
import {
  buildListItemJobPosting,
  LIST_ITEM_DESCRIPTION_CAP,
} from '../../build-plugins/shared/jobPostingListItem';

const OPTS = {
  locale: 'it',
  url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/infermiere-lugano-eoc/',
  baseUrl: 'https://frontaliereticino.ch',
};

describe('buildListItemJobPosting', () => {
  it('returns a @context-stripped JobPosting with the mandatory fields for a valid job', () => {
    const jp = buildListItemJobPosting(
      {
        title: 'Infermiere',
        company: 'EOC',
        city: 'Lugano',
        canton: 'TI',
        datePosted: '2026-06-10',
        salaryMin: 70000,
        salaryMax: 90000,
        url: OPTS.url,
      },
      OPTS,
    );
    expect(jp).not.toBeNull();
    // No @context (the parent ItemList script declares it once).
    expect(jp).not.toHaveProperty('@context');
    expect(jp!['@type']).toBe('JobPosting');
    expect(jp!.title).toBe('Infermiere');
    expect((jp!.hiringOrganization as any)?.name).toBe('EOC');
    expect(jp!.datePosted).toBeTruthy();
    expect(jp!.employmentType).toBeTruthy();
    expect((jp!.jobLocation as any)?.address?.addressCountry).toBe('CH');
    expect((jp!.baseSalary as any)?.value?.minValue).toBeGreaterThan(0);
  });

  it('caps the description to keep list-page JSON-LD light', () => {
    const longDesc = 'A'.repeat(4000);
    const jp = buildListItemJobPosting(
      {
        title: 'Sviluppatore',
        company: 'ACME',
        city: 'Bellinzona',
        canton: 'TI',
        datePosted: '2026-06-10',
        description: longDesc,
        salaryMin: 80000,
        salaryMax: 100000,
        url: OPTS.url,
      },
      OPTS,
    );
    expect(jp).not.toBeNull();
    expect(typeof jp!.description).toBe('string');
    // capped slice + a single ellipsis char.
    expect((jp!.description as string).length).toBeLessThanOrEqual(LIST_ITEM_DESCRIPTION_CAP + 1);
  });

  it('does not leave a lone surrogate when the cap lands mid-emoji (regression: "Truncated Unicode character")', () => {
    // Reproduces the live bug: a JobPosting description whose char-300 boundary
    // fell between the two halves of 🤝 (U+1F91D), emitting a lone \uD83E that
    // Google rejected as "Dati strutturati non analizzabili / Carattere Unicode
    // troncato" and that broke parsing of the whole <script> block.
    const head = 'Lass uns «zämä erfolgrich» sein. '.padEnd(LIST_ITEM_DESCRIPTION_CAP - 1, 'x');
    const description = `${head}\u{1F91D} mehr Text der weit über die Grenze hinausgeht.`;
    const jp = buildListItemJobPosting(
      {
        title: 'Verkäufer',
        company: 'Migros',
        city: 'Herisau',
        canton: 'AR',
        datePosted: '2026-05-26',
        description,
        salaryMin: 65000,
        salaryMax: 98500,
        url: OPTS.url,
      },
      OPTS,
    );
    expect(jp).not.toBeNull();
    const out = jp!.description as string;
    // No unpaired surrogate anywhere in the emitted description.
    const hasLoneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out);
    expect(hasLoneSurrogate).toBe(false);
    // The serialized JSON-LD round-trips cleanly.
    expect(() => JSON.parse(JSON.stringify({ description: out }))).not.toThrow();
  });

  it('never throws on sparse input (returns null or a builder-defaulted JobPosting)', () => {
    // The builder fills heavy defaults, so sparse input usually still yields a
    // valid schema; the contract that matters is that the helper NEVER throws
    // (so one bad job can't break the build) — it returns null only if the
    // builder itself throws.
    let result: Record<string, unknown> | null = null;
    expect(() => {
      result = buildListItemJobPosting({}, OPTS);
    }).not.toThrow();
    expect(result === null || (result as Record<string, unknown>)['@type'] === 'JobPosting').toBe(true);
  });
});
