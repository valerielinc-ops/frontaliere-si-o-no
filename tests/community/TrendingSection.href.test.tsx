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
import { render } from '@testing-library/react';
import TrendingSection from '@/components/community/TrendingSection';

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
      /trendingJobs=\{trendingJobs\.map\([\s\S]*?href:\s*[^}]*buildPath\(/,
    );
  });
});
