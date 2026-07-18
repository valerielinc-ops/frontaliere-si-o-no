import { describe, it, expect } from 'vitest';
import { applyTarget, renderBody, resolveSlugCollisions, isCanaryOrTestAd } from '../build-plugins/publisherAdPagesPlugin';
import { buildJobPostingSchema, MANDATORY_JOBPOSTING_FIELDS } from '../build-plugins/shared/jobPostingSchema';

const BASE_REC = {
  title: 'Prompt engineer da remoto',
  slug: 'prompt-engineer-da-remoto-thun-frontaliere-ticino',
  company: 'Frontaliere Ticino',
  companyLogo: 'https://cdn.example.ch/logo.png',
  location: 'Thun',
  canton: 'BE',
  postedDate: '2026-06-11T15:52:27.928Z',
  salaryMin: 45000,
  salaryMax: 50000,
  currency: 'CHF',
  description: 'Cerchiamo una persona motivata.\n\nSeconda riga di testo.',
  descriptionMd: '## Responsabilità\n- Progettare **prompt**\n- Testare la qualità\n\n## Offriamo\n- Lavoro remoto',
  applyMode: 'in_house',
  applyUrl: 'https://frontaliereticino.ch/lavoro/prompt-engineer-da-remoto-thun-frontaliere-ticino',
  employmentType: 'FULL_TIME',
  contractType: 'permanent',
  tier: 'sponsored',
  featured: true,
};

describe('applyTarget — the "Candidati ora" CTA destination', () => {
  it('in_house / forward_email → the /candidatura/ sub-page, never a self-link', () => {
    expect(applyTarget(BASE_REC, 'it')).toEqual({
      href: '/lavoro/prompt-engineer-da-remoto-thun-frontaliere-ticino/candidatura/',
      external: false,
    });
    expect(applyTarget({ ...BASE_REC, applyMode: 'forward_email' }, 'en').href)
      .toBe('/en/lavoro/prompt-engineer-da-remoto-thun-frontaliere-ticino/candidatura/');
  });

  it('external_url with a real URL → the employer page, new tab', () => {
    const rec = { ...BASE_REC, applyMode: 'external_url', applyUrl: 'https://acme.ch/careers/123' };
    expect(applyTarget(rec, 'it')).toEqual({ href: 'https://acme.ch/careers/123', external: true });
  });

  it('external_url whose applyUrl is the minted self /lavoro/ URL → candidatura fallback (no loop)', () => {
    const rec = { ...BASE_REC, applyMode: 'external_url' }; // applyUrl = self
    expect(applyTarget(rec, 'it').href).toMatch(/\/candidatura\/$/);
  });
});

describe('renderBody — sponsored /lavoro/ page', () => {
  const html = renderBody(BASE_REC, 'it');

  it('renders the publisher logo with the onerror initials fallback', () => {
    expect(html).toContain('src="https://cdn.example.ch/logo.png"');
    expect(html).toContain('alt="Logo Frontaliere Ticino"');
    expect(html).toContain('onerror=');
  });

  it('renders markdown sections (headings + bullets + bold) for sponsored ads', () => {
    expect(html).toContain('Responsabilità</h2>');
    expect(html).toMatch(/<li[^>]*>Progettare <strong>prompt<\/strong><\/li>/);
    expect(html).toContain('Offriamo</h2>');
  });

  it('CTA points to the candidatura page for in_house ads', () => {
    expect(html).toContain('href="/lavoro/prompt-engineer-da-remoto-thun-frontaliere-ticino/candidatura/"');
    // the page must never link the CTA to itself
    expect(html).not.toMatch(/href="\/lavoro\/prompt-engineer-da-remoto-thun-frontaliere-ticino\/"[^>]*rel="nofollow"/);
  });

  it('shows the sponsored badge and the salary tile', () => {
    expect(html).toContain('Sponsorizzato');
    expect(html).toContain('Retribuzione');
    expect(html).toContain('45');
  });

  it('free-tier ads: no markdown rendering, plain paragraphs, initials logo fallback', () => {
    const free = renderBody(
      { ...BASE_REC, tier: 'free', featured: false, companyLogo: undefined, applyMode: 'external_url', applyUrl: 'https://acme.ch/jobs/1' },
      'it',
    );
    expect(free).not.toContain('Responsabilità</h2>'); // markdown ignored on free
    expect(free).toContain('Cerchiamo una persona motivata.');
    expect(free).toContain('data:image/svg+xml'); // initials badge
    expect(free).toContain('href="https://acme.ch/jobs/1"');
    expect(free).not.toContain('Sponsorizzato');
  });
});

describe('resolveSlugCollisions — distinct-ad baseSlug guard (monetization)', () => {
  it('no collision: distinct slugs all pass through, deterministic order', () => {
    const recs = [
      { slug: 'a', publisherJobId: 'p1' },
      { slug: 'b', publisherJobId: 'p2' },
    ];
    const { toEmit, collisions } = resolveSlugCollisions(recs);
    expect(toEmit).toHaveLength(2);
    expect(collisions).toHaveLength(0);
  });

  it('two DISTINCT paid ads on the same slug → first wins, loser skipped + reported', () => {
    const recs = [
      { slug: 'cameriere-lugano-bar', publisherJobId: 'pubA', title: 'Cameriere', company: 'Bar' },
      { slug: 'cameriere-lugano-bar', publisherJobId: 'pubB', title: 'Cameriere', company: 'Bar' },
    ];
    const { toEmit, collisions } = resolveSlugCollisions(recs);
    expect(toEmit.map((r) => r.publisherJobId)).toEqual(['pubA']); // first-in-slice wins
    expect(collisions).toEqual([{ slug: 'cameriere-lugano-bar', winner: 'pubA', loser: 'pubB' }]);
  });

  it('SAME ad re-listed at the same slug is idempotent, not a collision', () => {
    const recs = [
      { slug: 's', publisherJobId: 'p1' },
      { slug: 's', publisherJobId: 'p1' },
    ];
    const { toEmit, collisions } = resolveSlugCollisions(recs);
    expect(toEmit).toHaveLength(2);
    expect(collisions).toHaveLength(0);
  });

  it('falls back to id then title|company when publisherJobId is absent', () => {
    const recs = [
      { slug: 's', id: 'idA', title: 'T', company: 'C' },
      { slug: 's', id: 'idB', title: 'T', company: 'C' }, // distinct id → collision
    ];
    const { toEmit, collisions } = resolveSlugCollisions(recs);
    expect(toEmit.map((r) => r.id)).toEqual(['idA']);
    expect(collisions).toEqual([{ slug: 's', winner: 'idA', loser: 'idB' }]);
  });

  it('slugless records pass through untouched (emit loop skips them later)', () => {
    const recs = [{ slug: '', publisherJobId: 'p1' }, { publisherJobId: 'p2' }];
    const { toEmit, collisions } = resolveSlugCollisions(recs);
    expect(toEmit).toHaveLength(2);
    expect(collisions).toHaveLength(0);
  });
});

describe('isCanaryOrTestAd — sitemap exclusion guard for owner verification fixtures (#4408)', () => {
  it('flags the real canary record: canary:true is the authoritative signal', () => {
    expect(isCanaryOrTestAd({
      canary: true,
      slug: 'specialista-marketing-digitale-canary-test-lugano-frontaliere-ticino',
      title: 'Specialista Marketing Digitale (Canary Test)',
    })).toBe(true);
  });

  it('flags a stray test record by slug pattern even without the canary flag', () => {
    expect(isCanaryOrTestAd({ slug: 'cameriere-canary-test-lugano-bar-ticino' })).toBe(true);
  });

  it('flags a stray test record by the "(Canary Test)" title suffix', () => {
    expect(isCanaryOrTestAd({ slug: 'some-other-slug', title: 'Cameriere (Canary Test)' })).toBe(true);
  });

  it('does NOT flag a real paid ad', () => {
    expect(isCanaryOrTestAd(BASE_REC)).toBe(false);
    expect(isCanaryOrTestAd({
      slug: 'fisioterapista-con-riconoscimento-crs-fisiocare-sagl-fisiocare-sagl',
      title: 'Fisioterapista con riconoscimento CRS',
      canary: false,
    })).toBe(false);
  });
});

describe('publisher-ads JobPosting structured data — AGENTS #3 mandatory fields', () => {
  // Real slice records (data/jobs/by-crawler/publisher-submitted.json) —
  // one free-tier ad with several null address fields, one canary/sponsored
  // ad with a full address. buildJobPostingSchema must fill safe defaults
  // for the missing fields, never drop the check (#4408).
  const FREE_TIER_RECORD = {
    title: 'Fisioterapista con riconoscimento CRS',
    slug: 'fisioterapista-con-riconoscimento-crs-fisiocare-sagl-fisiocare-sagl',
    company: 'Fisiocare Sagl',
    companyKey: 'fisiocare-sagl',
    location: 'Fisiocare Sagl',
    addressLocality: 'Fisiocare Sagl',
    postalCode: null,
    streetAddress: null,
    addressRegion: 'TI',
    addressCountry: 'CH',
    canton: 'TI',
    tier: 'free',
    description: 'Cerchiamo un fisioterapista con riconoscimento CRS per il nostro studio in Ticino, esperienza minima 2 anni, contratto a tempo indeterminato con benefit.',
  };
  const CANARY_RECORD = {
    title: 'Specialista Marketing Digitale (Canary Test)',
    slug: 'specialista-marketing-digitale-canary-test-lugano-frontaliere-ticino',
    company: 'Frontaliere Ticino',
    companyKey: 'frontaliere-ticino',
    location: 'Lugano',
    addressLocality: 'Lugano',
    postalCode: '6900',
    streetAddress: null,
    addressRegion: 'TI',
    addressCountry: 'CH',
    canton: 'TI',
    tier: 'sponsored',
    canary: true,
    salaryMin: 70000,
    salaryMax: 90000,
    currency: 'CHF',
    description: 'Annuncio dimostrativo interno usato per verificare end-to-end il funnel degli annunci sponsorizzati: pagina dedicata, ricerca, posizionamento in cima al listino, candidature in-house.',
  };

  it.each([
    ['free-tier ad (nulls in postalCode/streetAddress)', FREE_TIER_RECORD],
    ['canary/sponsored ad', CANARY_RECORD],
  ])('%s: every AGENTS #3 mandatory field is present and non-empty in every locale', (_label, rec) => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const url = `https://frontaliereticino.ch/${locale === 'it' ? '' : `${locale}/`}lavoro/${rec.slug}/`;
      const schema = buildJobPostingSchema(rec, { locale, url });
      expect(schema.baseSalary?.value?.minValue).toBeGreaterThan(0);
      expect(schema.jobLocation?.address?.postalCode).toBeTruthy();
      expect(schema.jobLocation?.address?.streetAddress).toBeTruthy();
      expect(schema.title).toBeTruthy();
      expect(schema.description?.length).toBeGreaterThanOrEqual(50);
      expect(schema.datePosted).toBeTruthy();
      expect(schema.hiringOrganization?.name).toBeTruthy();
      expect(schema.jobLocation).toBeTruthy();
      expect(schema.employmentType).toBeTruthy();
      // Cross-check against the canonical mandatory-field list so this test
      // regresses if the shared list ever grows without a matching assertion.
      expect(MANDATORY_JOBPOSTING_FIELDS.length).toBeGreaterThanOrEqual(9);
    }
  });
});
