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
  type JobCardJob,
} from '../../build-plugins/shared/jobCardHtml';

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

describe('jobCardHtml — renderJobCardHtml', () => {
  it('renders an article with SPA Tailwind classes', () => {
    const html = renderJobCardHtml(baseJob, {
      href: '/cerca-lavoro-ticino/full-stack-net-sviluppatore-alten-switzerland-ticino/',
      locale: 'it',
    });
    expect(html.startsWith('<article class="rounded-xl border p-3 sm:p-4')).toBe(true);
    expect(html).toContain('border-edge bg-surface/50 hover:border-accent-border');
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
    expect(html).toContain('border-warning-border bg-warning-subtle hover:border-warning');
    expect(html).toContain('lucide-star');
  });

  it('omits the salary chip when min/max are missing or invalid', () => {
    const noSalary: JobCardJob = { ...baseJob, salaryMin: 0, salaryMax: 0 };
    const html = renderJobCardHtml(noSalary, { href: '/x/', locale: 'en' });
    expect(html).not.toContain('CHF');
    expect(html).not.toContain('lucide-euro');
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
    expect(html.startsWith('<ul role="list" class="')).toBe(true);
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
