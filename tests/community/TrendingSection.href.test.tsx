/**
 * Regression: TrendingSection ("Popolari nella tua zona") must render
 * locale-aware canonical hrefs computed via buildPath(), NOT the legacy
 * hardcoded `/cerca-lavoro/<slug>` path.
 *
 * The legacy path 404'd (canonical job-board slug is `cerca-lavoro-ticino`),
 * so any user opening a trending job in a new tab (Cmd-click, middle-click)
 * landed on the SPA 404 bridge → home redirect. Search engines also indexed
 * broken job links from the homepage trending strip.
 *
 * Reported: 2026-04-29 by user with screenshot showing
 *   PATH RICHIESTO (ORIGINALE): /cerca-lavoro/apprendistato-...
 *   URL ORA IN BARRA:           https://frontaliereticino.ch/
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import TrendingSection, { selectRecommendationJobs } from '@/components/community/TrendingSection';

const SOURCE = readFileSync(
  resolve(__dirname, '../../components/community/TrendingSection.tsx'),
  'utf8',
);

describe('TrendingSection — source-level guard against legacy hardcoded href', () => {
  it('does not hardcode the legacy singular `/cerca-lavoro/<slug>` path', () => {
    // The canonical IT job-board slug is `cerca-lavoro-ticino`; the singular
    // form is a 404. EN/DE/FR also have their own localized slugs. The fix
    // is to use buildPath() (computed by the parent) — never hardcode here.
    expect(SOURCE).not.toMatch(/`\/cerca-lavoro\/\$\{[^}]+\}`/);
    expect(SOURCE).not.toMatch(/'\/cerca-lavoro\/'/);
    expect(SOURCE).not.toMatch(/"\/cerca-lavoro\/"/);
  });

  it('renders href from the precomputed `href` prop, not a derived slug path', () => {
    expect(SOURCE).toMatch(/href=\{job\.href\b/);
  });
});

describe('TrendingSection — rendered href matches the precomputed canonical URL', () => {
  const baseJob = {
    title: 'Apprendistato Impiegato/a',
    company: 'Swisscom',
    location: 'Balerna',
    addressLocality: 'Balerna',
    category: 'tech',
  };

  it('uses the parent-supplied locale-aware href (IT canonical /cerca-lavoro-ticino/<slug>/)', () => {
    const itHref = '/cerca-lavoro-ticino/apprendistato-impiegato-a-swisscom-balerna/';
    const trendingJobs = [
      { ...baseJob, slug: 'apprendistato-impiegato-a-swisscom-balerna', href: itHref },
      { ...baseJob, slug: 'addetti-servizi-alla-casa-lis-lugano', href: '/cerca-lavoro-ticino/addetti-servizi-alla-casa-lis-lugano/' },
      { ...baseJob, slug: 'concorsi-citta-di-lugano', href: '/cerca-lavoro-ticino/concorsi-citta-di-lugano/' },
    ];

    const { container } = render(
      <TrendingSection
        trendingJobs={trendingJobs}
        popularity={{}}
        onJobClick={() => {}}
        heading="Offerte da esplorare"
        ariaLabel="Offerte da esplorare"
        emptyLabel="Nessuna offerta trovata"
      />,
    );

    const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'));
    expect(anchors.length).toBe(3);
    for (const a of anchors) {
      expect(a.getAttribute('href')).toMatch(/^\/cerca-lavoro-ticino\//);
      expect(a.getAttribute('href')).not.toMatch(/^\/cerca-lavoro\/[^t]/);
    }
    expect(anchors[0].getAttribute('href')).toBe(itHref);
  });

  it('renders `#` when slug+href are missing (no broken /cerca-lavoro/undefined link)', () => {
    const trendingJobs = [
      { ...baseJob, title: 'Apprendistato A' },
      { ...baseJob, title: 'Apprendistato B' },
      { ...baseJob, title: 'Apprendistato C' },
    ];
    const { container } = render(
      <TrendingSection
        trendingJobs={trendingJobs}
        popularity={{}}
        onJobClick={() => {}}
        heading="Offerte da esplorare"
        ariaLabel="Offerte da esplorare"
        emptyLabel="Nessuna offerta trovata"
      />,
    );
    const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href]'));
    for (const a of anchors) {
      expect(a.getAttribute('href')).toBe('#');
    }
  });
});

describe('JobBoard — passes locale-aware href to TrendingSection', () => {
  it('JobBoard.tsx pre-computes `href` via buildPath when wiring trendingJobs', () => {
    const jobBoardSource = readFileSync(
      resolve(__dirname, '../../components/community/JobBoard.tsx'),
      'utf8',
    );
    // Must compute href via buildPath inside the trendingJobs map passed to TrendingSection.
    expect(jobBoardSource).toMatch(
      /trendingJobs=\{recommendationJobs\.map\([\s\S]*?href:\s*[^}]*buildPath\(/,
    );
  });
});


describe('TrendingSection — persistent recommendation slot', () => {
  it('keeps neutral recommendations outside the async personalization flag', () => {
    const source = readFileSync(resolve(__dirname, '../../components/community/JobBoard.tsx'), 'utf8');
    const slot = source.indexOf('<TrendingSection');
    const notices = source.indexOf('{enablePersonalization && ((!newJobsDismissed');
    expect(slot).toBeGreaterThan(0);
    expect(notices).toBeGreaterThan(slot);
    expect(source).toContain('selectRecommendationJobs(filteredJobs, trendingJobs, enablePersonalization)');
    expect(source.slice(slot, notices)).toContain('trendingJobs={recommendationJobs.map');
    expect(source.slice(slot, notices)).toContain('popularity={enablePersonalization ? deferredPopularity : EMPTY_JOB_POPULARITY}');
  });

  it('preserves its intrinsic reservation from loading to sparse data to empty/error', () => {
    const props = {
      heading: 'Offerte da esplorare',
      ariaLabel: 'Offerte da esplorare',
      emptyLabel: 'Caricamento offerte…',
      popularity: {},
      onJobClick: () => {},
    };
    const { container, rerender } = render(<TrendingSection {...props} trendingJobs={[]} />);
    const section = screen.getByRole('region', { name: props.heading });
    const reservation = container.querySelector('[aria-hidden="true"].invisible');
    expect(reservation).not.toBeNull();
    const reservedContent = reservation?.innerHTML;
    expect(screen.getByRole('status').textContent).toBe(props.emptyLabel);
    const job = { title: 'Developer', company: 'Company', location: 'Lugano', category: 'tech', slug: 'developer', href: '/cerca-lavoro-ticino/developer/' };
    rerender(<TrendingSection {...props} trendingJobs={[job]} popularity={{ developer: 12 }} />);
    expect(screen.getByRole('region', { name: props.heading })).toBe(section);
    expect(container.querySelector('[aria-hidden="true"].invisible')?.innerHTML).toBe(reservedContent);
    expect(screen.getByRole('link').getAttribute('href')).toBe(job.href);
    expect(screen.queryByRole('status')).toBeNull();
    // Resolving the flag to false removes popularity metadata, not the useful
    // ordinary job card or its reserved geometry.
    rerender(<TrendingSection {...props} trendingJobs={[job]} />);
    expect(screen.getByRole('region', { name: props.heading })).toBe(section);
    expect(container.querySelector('[aria-hidden="true"].invisible')?.innerHTML).toBe(reservedContent);
    expect(screen.getByRole('link').getAttribute('href')).toBe(job.href);
    expect(screen.queryByText('12 visualizzazioni')).toBeNull();
    rerender(<TrendingSection {...props} trendingJobs={[]} emptyLabel="Nessuna offerta trovata" />);
    expect(screen.getByRole('region', { name: props.heading })).toBe(section);
    expect(container.querySelector('[aria-hidden="true"].invisible')?.innerHTML).toBe(reservedContent);
    expect(screen.getByRole('status').textContent).toBe('Nessuna offerta trovata');
    expect(screen.queryByRole('link')).toBeNull();
  });
});


describe('recommendations obey the current search result set', () => {
  const filtered = ['a', 'b', 'c', 'd', 'e'].map((slug) => ({ slug, title: `Current ${slug}` }));
  it('uses filtered results while disabled, with no popularity data, or without enough matching popular jobs', () => {
    expect(selectRecommendationJobs(filtered, [{ slug: 'outside' }], false)).toEqual(filtered.slice(0, 4));
    expect(selectRecommendationJobs(filtered, [], true)).toEqual(filtered.slice(0, 4));
    expect(selectRecommendationJobs(filtered, [{ slug: 'outside' }, { slug: 'e' }], true)).toEqual(filtered.slice(0, 4));
  });
  it('keeps popularity order only for eligible jobs and uses canonical records', () => {
    const result = selectRecommendationJobs(filtered, [{ slug: 'outside' }, { slug: 'd' }, { slug: 'b' }, { slug: 'a' }], true);
    expect(result).toEqual([filtered[3], filtered[1], filtered[0]]);
    expect(result[0]).toBe(filtered[3]);
  });
  it('preserves empty results and deduplicates canonical slugs', () => {
    expect(selectRecommendationJobs([], [{ slug: 'outside' }], true)).toEqual([]);
    expect(selectRecommendationJobs([filtered[0], filtered[0], filtered[1]], [], false)).toEqual(filtered.slice(0, 2));
  });
});
