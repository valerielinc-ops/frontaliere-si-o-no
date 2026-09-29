import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  extractKispiSgDetailDescription,
  fetchAllKispiSgJobs,
  KISPI_SG_FABRICATED_DESCRIPTION_RE,
  matchKispiSgJob,
} from '../../scripts/lib/kispi-sg-job-parser.mjs';

// Issue 5253: a keyword-window scraper over the whole page matched «Aufgaben»
// twice, cut sections at 1500 chars or at the next heading word, capped the
// result at 8 fragments and could run into the og:description meta tag. The
// ad is the `.job-detail` block of the oks.ch vacancy page (real page,
// minimised; contact card anonymised).
describe('Ostschweizer Kinderspital detail description', () => {
  const html = readFileSync(resolve(__dirname, '..', 'fixtures', 'kispi-sg', 'detail-praktikum-pflege.html'), 'utf8');
  const text = extractKispiSgDetailDescription(html);

  it('reads the intro and every heading block once, lists as bullets', () => {
    expect(text.startsWith('Wir suchen jeweils per 1. Februar und per 1. August Praktikantinnen')).toBe(true);
    expect(text.match(/Ihre Aufgaben/g)).toHaveLength(1);
    expect(text).toContain('Ihre Aufgaben\n• Sie führen einfache pflegerische Tätigkeiten');
    expect(text).toContain('• Sie unterstützen das Team durch die Erledigung verschiedener Aufgaben im Praxisalltag');
    expect(text).toContain('Ihr Profil\n• Sie möchten einen vertieften Einblick');
    expect(text).toContain('Wir bieten Ihnen\n• Verantwortung');
    expect(text).toContain('Ihr Arbeitsbereich\nFür eine Ausbildung in einem Pflegeberuf');
  });

  it('leaves out the apply button, contact card and page metadata', () => {
    expect(text).not.toMatch(/jetzt bewerben|Ansprechperson|Kontakt|og:description|<|>/);
  });

  it('returns empty when the page has no job-detail block', () => {
    expect(extractKispiSgDetailDescription('<html><body><p>Seite nicht gefunden</p></body></html>')).toBe('');
  });

  it('merges on the Pimcore-derived id, not on the URL that moved to oks.ch', () => {
    expect(matchKispiSgJob({ id: 'kispi-sg-f71361122f0c', url: 'https://www.oks.ch/de/stellen/x-1247' }))
      .toBe(matchKispiSgJob({ id: 'kispi-sg-f71361122f0c', url: 'https://recruitingapp-2979.umantis.com/Vacancies/376/Application/CheckLogin/1?lang=ger' }));
  });
});

// Issue 5253: a posting whose ad cannot be read used to get the listing
// teaser at any length, or a description the crawler wrote («<Titel> beim
// Ostschweizer Kinderspital in St. Gallen (9006, SG), Schweiz.» + «• Standort»
// + «• Bewerbung über das Karriereportal …»). Only source text above the
// 50-word floor is published now. Real listing page cut to two cards.
describe('Ostschweizer Kinderspital — only the source text', () => {
  const fixture = (name: string) => readFileSync(resolve(__dirname, '..', 'fixtures', 'kispi-sg', name), 'utf8');
  afterEach(() => vi.unstubAllGlobals());

  it('publishes the ad, and nothing for a posting whose ad cannot be read', async () => {
    const listing = fixture('listing-stellen.html');
    const detail = fixture('detail-praktikum-pflege.html');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url) === 'https://www.oks.ch/stellen') return new Response(listing, { status: 200 });
      if (String(url).endsWith('-1247')) return new Response(detail, { status: 200 });
      return new Response('not found', { status: 404 });
    }));
    const jobs = await fetchAllKispiSgJobs();
    const byId = new Map(jobs.map((job: any) => [job.url.match(/-(\d+)$/)[1], job]));
    const intern: any = byId.get('1247');
    expect(intern.description).toBe(extractKispiSgDetailDescription(detail));
    expect(intern.slug).toBe('praktikant-in-pflege-und-betreuung-80-100-befristet-fur-6-12-monate-kispi-sg-st-gallen');
    // 3028: the 16-word listing teaser is under the floor.
    const phd: any = byId.get('3028');
    expect(phd.description).toBe('');
    expect(phd.slug).toBe('phd-student-in-medicine-100-kispi-sg-st-gallen');
    for (const job of jobs) expect(job.description).not.toMatch(KISPI_SG_FABRICATED_DESCRIPTION_RE);
  });
});
