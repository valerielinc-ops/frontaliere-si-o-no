/**
 * Unit tests for the shared SPA-matching job card renderer used by every
 * SEO landing-page plugin (sector / recency / orphan-query / employer hub).
 */

import { describe, expect, it } from 'vitest';
import {
  renderJobCardHtml,
  renderJobCardListHtml,
  localizedContract,
  relativePostedLabel,
  isJobNew,
  escHtml,
  titleCaseLocalityIfLowercase,
  type JobCardJob,
} from '../../build-plugins/shared/jobCardHtml';
import { AD_SLOTS } from '../../services/adsenseSlots';

const FIXED_NOW = new Date('2026-05-01T12:00:00Z');

const baseJob: JobCardJob = {
  title: 'Full Stack .Net Sviluppatore',
  company: 'ALTEN Switzerland',
  companyKey: 'alten-switzerland',
  location: 'Ticino',
  canton: 'TI',
  contract: 'full-time',
  salaryMin: 72000,
  salaryMax: 97000,
  postedDate: '2026-03-07',
};

describe('jobCardHtml — escHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escHtml('<a href="x">"&"</a>')).toBe(
      '&lt;a href=&quot;x&quot;&gt;&quot;&amp;&quot;&lt;/a&gt;',
    );
  });

  it('coerces nullish to empty string', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });
});

describe('jobCardHtml — localizedContract', () => {
  it('returns the IT label for full-time', () => {
    expect(localizedContract('full-time', 'it')).toBe('Tempo pieno');
  });

  it('returns the DE label for part-time', () => {
    expect(localizedContract('part-time', 'de')).toBe('Teilzeit');
  });

  it('falls back to "other" label for unknown contract types', () => {
    expect(localizedContract('seasonal', 'fr')).toBe('Autre');
  });

  it('returns empty string for empty input (renders no chip)', () => {
    expect(localizedContract('', 'it')).toBe('');
    expect(localizedContract(undefined, 'it')).toBe('');
  });
});

describe('jobCardHtml — relativePostedLabel', () => {
  it('says "Oggi" when posted today', () => {
    expect(relativePostedLabel('2026-05-01', 'it', FIXED_NOW)).toBe('Oggi');
  });

  it('says "1 day ago" when posted yesterday (en)', () => {
    expect(relativePostedLabel('2026-04-30', 'en', FIXED_NOW)).toBe('1 day ago');
  });

  it('uses German plural for older posts', () => {
    expect(relativePostedLabel('2026-04-25', 'de', FIXED_NOW)).toBe('vor 6 Tagen');
  });

  it('falls back to ISO date past 60 days', () => {
    expect(relativePostedLabel('2026-01-15', 'fr', FIXED_NOW)).toBe('2026-01-15');
  });

  it('returns empty for empty / invalid date', () => {
    expect(relativePostedLabel('', 'it', FIXED_NOW)).toBe('');
    expect(relativePostedLabel('not-a-date', 'it', FIXED_NOW)).toBe('');
  });
});

describe('jobCardHtml — isJobNew', () => {
  it('flags posts from the last 7 days as new', () => {
    expect(isJobNew('2026-04-26', FIXED_NOW)).toBe(true);
    expect(isJobNew('2026-05-01', FIXED_NOW)).toBe(true);
  });

  it('does not flag older posts', () => {
    expect(isJobNew('2026-04-23', FIXED_NOW)).toBe(false);
  });

  it('returns false for empty / invalid', () => {
    expect(isJobNew('', FIXED_NOW)).toBe(false);
    expect(isJobNew('garbage', FIXED_NOW)).toBe(false);
  });
});

describe('jobCardHtml — titleCaseLocalityIfLowercase', () => {
  it('title-cases all-lowercase localities (spaces, dots, hyphens, apostrophes)', () => {
    expect(titleCaseLocalityIfLowercase('quartino')).toBe('Quartino');
    expect(titleCaseLocalityIfLowercase('castel san pietro')).toBe('Castel San Pietro');
    expect(titleCaseLocalityIfLowercase('s. antonino')).toBe('S. Antonino');
    expect(titleCaseLocalityIfLowercase("sant'antonino")).toBe("Sant'Antonino");
    expect(titleCaseLocalityIfLowercase('lugano-besso')).toBe('Lugano-Besso');
  });

  it('leaves strings containing any uppercase letter untouched', () => {
    expect(titleCaseLocalityIfLowercase('Lugano')).toBe('Lugano');
    expect(titleCaseLocalityIfLowercase('SUPSI / DTI')).toBe('SUPSI / DTI');
    expect(titleCaseLocalityIfLowercase('S. Antonino')).toBe('S. Antonino');
    expect(titleCaseLocalityIfLowercase('McKinsey Campus')).toBe('McKinsey Campus');
  });

  it('handles empty input', () => {
    expect(titleCaseLocalityIfLowercase('')).toBe('');
  });

  it('applies to both the subtitle and the location chip at render time', () => {
    const html = renderJobCardHtml(
      { ...baseJob, location: 'quartino' },
      { href: '/x/', locale: 'it' },
    );
    expect(html).toContain('Quartino');
    expect(html).not.toContain('quartino');
  });
});

describe('jobCardHtml — renderJobCardHtml', () => {
  it('renders an article with the .jc-card atom (Tailwind tokens applied via @apply in index.css)', () => {
    const html = renderJobCardHtml(baseJob, {
      href: '/cerca-lavoro-ticino/full-stack-net-sviluppatore-alten-switzerland-ticino/',
      locale: 'it',
    });
    // Post 5e715f73e6 refactor: `rounded-xl border p-3 sm:p-4` +
    // `border-edge bg-surface/50 hover:border-accent-border` ship via the
    // `.jc-card` atom in `index.css` (@layer components).
    expect(html.startsWith('<article class="jc-card')).toBe(true);
    expect(html).toContain('Full Stack .Net Sviluppatore');
    expect(html).toContain('ALTEN Switzerland');
    // Salary chip
    expect(html).toContain('CHF 72k – 97k');
    // Contract chip in IT
    expect(html).toContain('Tempo pieno');
    // Map pin SVG
    expect(html).toContain('lucide-map-pin');
    // Clock SVG with posted-date data attribute
    expect(html).toContain('data-posted="2026-03-07"');
    // Anchor link points to the supplied href
    expect(html).toContain(
      'href="/cerca-lavoro-ticino/full-stack-net-sviluppatore-alten-switzerland-ticino/"',
    );
  });

  it('renders the featured warning palette when job.featured is true', () => {
    const featured = { ...baseJob, featured: true };
    const html = renderJobCardHtml(featured, { href: '/x/', locale: 'it' });
    // Featured palette ships via the `.jc-card-fea` modifier atom (which
    // `@apply`s `border-warning-border bg-warning-subtle hover:border-warning`).
    expect(html).toContain('jc-card-fea');
    expect(html).toContain('lucide-star');
  });

  it('omits the salary chip when min/max are missing or invalid', () => {
    const noSalary: JobCardJob = { ...baseJob, salaryMin: 0, salaryMax: 0 };
    const html = renderJobCardHtml(noSalary, { href: '/x/', locale: 'en' });
    expect(html).not.toContain('CHF');
    expect(html).not.toContain('lucide-banknote');
  });

  it('uses the currency-neutral banknote icon (not the euro glyph) on the salary chip', () => {
    const html = renderJobCardHtml(baseJob, { href: '/x/', locale: 'it' });
    expect(html).toContain('lucide-banknote');
    expect(html).toContain('#i-jc-bkn');
    expect(html).not.toContain('lucide-euro');
    expect(html).not.toContain('i-jc-eur');
  });

  it('appends the per-locale estimate suffix when salarySource is "estimated"', () => {
    const estimated: JobCardJob = { ...baseJob, salarySource: 'estimated' };
    const it_ = renderJobCardHtml(estimated, { href: '/x/', locale: 'it' });
    expect(it_).toContain('CHF 72k – 97k (stima)');
    const en = renderJobCardHtml(estimated, { href: '/x/', locale: 'en' });
    expect(en).toContain('CHF 72k – 97k (est.)');
    const de = renderJobCardHtml(estimated, { href: '/x/', locale: 'de' });
    expect(de).toContain('CHF 72k – 97k (Schätzung)');
    const fr = renderJobCardHtml(estimated, { href: '/x/', locale: 'fr' });
    expect(fr).toContain('CHF 72k – 97k (est.)');
  });

  it('renders no estimate suffix for reported/existing salarySource', () => {
    for (const salarySource of ['reported', 'existing'] as const) {
      const html = renderJobCardHtml(
        { ...baseJob, salarySource },
        { href: '/x/', locale: 'it' },
      );
      expect(html).toContain('CHF 72k – 97k<');
      expect(html).not.toContain('(stima)');
    }
  });

  it('is byte-identical to the legacy output when salarySource is absent', () => {
    const legacy = renderJobCardHtml(baseJob, { href: '/x/', locale: 'it' });
    expect(legacy).toContain('CHF 72k – 97k<');
    expect(legacy).not.toContain('(stima)');
    // Same record with the flag set differs ONLY by the suffix.
    const flagged = renderJobCardHtml(
      { ...baseJob, salarySource: 'estimated' },
      { href: '/x/', locale: 'it' },
    );
    expect(flagged.replace(' (stima)', '')).toBe(legacy);
  });

  it('escapes user-supplied strings to prevent XSS', () => {
    const evil: JobCardJob = {
      ...baseJob,
      title: '<script>alert(1)</script>',
      company: 'Evil & Co "Pwn"',
    };
    const html = renderJobCardHtml(evil, { href: '/x/', locale: 'it' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Evil &amp; Co &quot;Pwn&quot;');
  });

  it('uses titleByLocale[locale] when provided', () => {
    const localized: JobCardJob = {
      ...baseJob,
      titleByLocale: { en: 'Full Stack .Net Developer' },
    };
    const html = renderJobCardHtml(localized, { href: '/x/', locale: 'en' });
    expect(html).toContain('Full Stack .Net Developer');
    expect(html).not.toContain('Sviluppatore');
  });

  it('respects the linkifyLocation callback for hub linking', () => {
    const customLinkify = (raw: string) =>
      `<a href="/hub/${encodeURIComponent(raw.toLowerCase())}/">${raw}</a>`;
    const html = renderJobCardHtml(baseJob, {
      href: '/x/',
      locale: 'it',
      linkifyLocation: customLinkify,
    });
    expect(html).toContain('<a href="/hub/ticino/">Ticino</a>');
  });

  it('renders the "Nuovo" / "New" badge for posts within 7 days', () => {
    // Build a "3 days ago" date relative to the test-run clock so the
    // assertion is deterministic regardless of when CI runs it.
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000)
      .toISOString()
      .slice(0, 10);
    const fresh = { ...baseJob, postedDate: threeDaysAgo };
    const html = renderJobCardHtml(fresh, { href: '/x/', locale: 'it' });
    // Posted within 7 days renders a "Nuovo" badge AND a posted-time chip.
    expect(html).toContain('lucide-clock');
    expect(html).toContain('Nuovo');
  });

  it('uses the explicit logoUrl override when provided', () => {
    const html = renderJobCardHtml(baseJob, {
      href: '/x/',
      locale: 'it',
      logoUrl: '/images/brands/alten-switzerland.png',
    });
    expect(html).toContain('src="/images/brands/alten-switzerland.png"');
  });
});

describe('jobCardHtml — renderJobCardListHtml', () => {
  it('returns the empty-state HTML when items is empty', () => {
    const html = renderJobCardListHtml([], {
      locale: 'it',
      emptyStateHtml: '<p>nessuna offerta</p>',
    });
    expect(html).toBe('<p>nessuna offerta</p>');
  });

  it('returns empty string when no items and no fallback', () => {
    expect(renderJobCardListHtml([], { locale: 'it' })).toBe('');
  });

  it('wraps cards in role=list <ul> with <li> children', () => {
    const html = renderJobCardListHtml(
      [
        { job: baseJob, href: '/a/' },
        { job: { ...baseJob, title: 'Second job' }, href: '/b/' },
      ],
      { locale: 'it' },
    );
    // PR #640 prepends JOB_CARD_ICON_SYMBOLS once per list before <ul> for SVG sprite dedup;
    // that block now also carries the inline `jcLF` logo-fallback <script>
    // (externalised from per-card `onerror`). Accept both as an optional
    // prefix so the <ul role="list"> shape is what matters.
    expect(html).toMatch(/^(?:<svg[^>]*>.*?<\/svg>(?:<script>.*?<\/script>)?)?<ul role="list" class="/s);
    expect(html).toContain('<li><article');
    // Two <article> elements, one per job
    const articleCount = (html.match(/<article /g) || []).length;
    expect(articleCount).toBe(2);
  });

  it('honours the ulClassName override', () => {
    const html = renderJobCardListHtml(
      [{ job: baseJob, href: '/a/' }],
      { locale: 'it', ulClassName: 'flex flex-col gap-4' },
    );
    expect(html).toContain('class="flex flex-col gap-4"');
  });
});

describe('jobCardHtml — renderJobCardListHtml in-feed ads', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({
    job: { ...baseJob, title: `Job ${i}` },
    href: `/j${i}/`,
  }));

  it('injects a single responsive in-feed ad after every 3rd card by default', () => {
    const html = renderJobCardListHtml(items, { locale: 'it' });
    // 7 cards → ads after card 3 and 6 (never after the last) → 2 ad items.
    const adItems = (html.match(/<li class="ft-infeed-ad/g) || []).length;
    expect(adItems).toBe(2);
    // exactly ONE <ins> per ad point (no dual device-split) so the static
    // loader's push-per-ins stays aligned with the trailing multiplex.
    const insCount = (html.match(/class="adsbygoogle"/g) || []).length;
    expect(insCount).toBe(2);
    // responsive DISPLAY unit (adapts per device), full-width-responsive.
    expect(html).toContain(AD_SLOTS.JOBLIST_INFEED_DESKTOP.slot);
    expect(html).toContain('data-full-width-responsive="true"');
  });

  it('never places an in-feed ad after the last card', () => {
    const html = renderJobCardListHtml(items.slice(0, 3), { locale: 'it' });
    expect(html).not.toContain('ft-infeed-ad');
  });

  it.each([1, 2])('keeps a short %i-card sector result block ad-free', (count) => {
    const html = renderJobCardListHtml(items.slice(0, count), { locale: 'it' });
    expect(html).not.toContain('ft-infeed-ad');
  });

  it('can be disabled via interleaveInfeedAds:false', () => {
    const html = renderJobCardListHtml(items, {
      locale: 'it',
      interleaveInfeedAds: false,
    });
    expect(html).not.toContain('ft-infeed-ad');
  });

  it('preserves absolute ad cadence when a list is split into result blocks', () => {
    const lead = renderJobCardListHtml(items.slice(0, 3), {
      locale: 'it',
      hasFollowingItems: true,
    });
    const tail = renderJobCardListHtml(items.slice(3), {
      locale: 'it',
      positionOffset: 3,
    });

    // The first block still owns the position-3 ad because more results follow;
    // the second block continues at absolute positions 4..7 and owns position 6.
    expect((lead.match(/<li class="ft-infeed-ad/g) || []).length).toBe(1);
    expect((tail.match(/<li class="ft-infeed-ad/g) || []).length).toBe(1);
  });

  it('caps in-feed ads per list to avoid ad-density violations on long lists', () => {
    // 50 cards: every-3 would place 16 ads (pos 3..48), but the cap is 12.
    const many = Array.from({ length: 50 }, (_, i) => ({
      job: { ...baseJob, title: `Job ${i}` },
      href: `/j${i}/`,
    }));
    const html = renderJobCardListHtml(many, { locale: 'it' });
    const adItems = (html.match(/<li class="ft-infeed-ad/g) || []).length;
    expect(adItems).toBe(12);
  });
});
