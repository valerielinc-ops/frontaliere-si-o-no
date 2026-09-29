/**
 * Prospective.ch vacancy text from the rendered directlink page.
 *
 * Audit 2026-09-29 (issue #5253): on 25 Prospective crawlers the published
 * description was the listing payload only — 9-45 % of the rendered vacancy
 * (benefit blocks, "Benefits dieser Stelle", "Lohn", "Weiteres zur Stelle",
 * the employer paragraph are page-only). Fixtures are real detail pages,
 * minimized (scripts/media/repeated cards removed, contact names and numbers
 * replaced).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createProspectiveChParser,
  dropRepostedListings,
  enrichProspectiveJobsFromDetailPages,
  extractProspectiveDetailText,
  prospectiveDetailCoverage,
  selectProspectiveDetailDescription,
} from '../scripts/lib/prospective-ch-job-parser-common.mjs';

const FIXTURES = path.resolve(process.cwd(), 'tests/fixtures/prospective-detail');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

const EQUANS_URL = 'https://ohws.prospective.ch/public/v1/jobs/c67de164-e77f-4385-a86e-3b9858bc1d24';
const EQUANS_TITLE = 'Technicien CVC (H/F)';
// The listing text of the same vacancy (intro + tasks + requirements), as the
// factory builds it from the API payload.
const EQUANS_LISTING = [
  "Placé sous l'autorité directe du Chef de Secteur, vous assurez les prestations de maintenance préventives et correctives sur des installations des installations de ventilation, chauffage et climatisation.",
  'Aufgaben:',
  '• Vous avez en charge la maintenance, le dépannage et les réparations liés aux contrats qui vous sont confiés sur des sites industriels, tertiaires et hôteliers;',
  "• Vous êtes itinérant et intervenez dans le cadre du service d'astreinte;",
  'Anforderungen:',
  '• De formation technique dans le CVC (CFC ou équivalent) ;',
  '• Vous possédez de solides connaissances dans le domaine CVC, aéraulique et hydraulique ;',
].join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('extractProspectiveDetailText', () => {
  it('keeps every vacancy section of an Equans page and drops its chrome', () => {
    const text = extractProspectiveDetailText(fixture('equans-technicien-cvc.html'), {
      title: EQUANS_TITLE,
      listingText: EQUANS_LISTING,
    });
    // Sections the listing carries …
    expect(text).toContain('## Vos missions');
    expect(text).toContain('• Vous avez en charge la maintenance');
    expect(text).toContain('## Ce qui vous caractérise');
    // … and the ones only the page prints.
    expect(text).toContain('## Voici ce que nous vous offrons');
    expect(text).toContain('• Programme de formation interne');
    expect(text).toContain('Diversité des tâches');
    expect(text).toContain('premier prestataire de solutions globales');
    // Chrome: contact card and form, apply button, share links, other vacancies.
    expect(text).not.toContain('Max MUSTER');
    expect(text).not.toContain('Formulaire de contact');
    expect(text).not.toContain('ton message a été envoyé');
    expect(text).not.toContain('POSTULEZ');
    expect(text).not.toMatch(/^LinkedIn$/m);
    expect(text).not.toContain('Autre postes ouverts');
    expect(text).not.toContain('Servicetechniker:in Kälte');
    // The title is the record's title, not a body line.
    expect(text.split('\n')[0]).not.toContain(EQUANS_TITLE);
  });

  it('keeps Claraspital benefit cards and "Über das Claraspital", drops contacts and the application procedure', () => {
    const text = extractProspectiveDetailText(fixture('claraspital-anaesthesiepflege.html'), {
      title: 'Dipl. Expertin / Experte Anästhesiepflege NDS',
    });
    expect(text).toContain('## Ihre Aufgaben');
    expect(text).toContain('## Ihr Profil');
    expect(text).toContain('Jobticket und Subventionen für den öffentlichen Verkehr');
    expect(text).toContain('## Über das Claraspital');
    expect(text).not.toContain('Anna Muster');
    expect(text).not.toContain('Bei Fragen zur Stelle');
    expect(text).not.toContain('Einreichung der Unterlagen');
    expect(text).not.toContain('Job-Abo');
    // Structure survives as markdown bullets.
    expect(text).toMatch(/^• /m);
  });

  it('keeps copy whose class only contains a media word (Livit `videoTextArea` "about" text)', () => {
    const text = extractProspectiveDetailText(fixture('livit-gerant-immeubles.html'), {
      title: "Gérant/e d'immeubles",
    });
    expect(text).toContain("Nous aimons l'immobilier");
    expect(text).toContain('## Tes missions');
    expect(text).not.toContain('Dana Muster');
  });

  it('strips the card colour jobs.admin.ch prints before benefit text and drops similar vacancies', () => {
    const text = extractProspectiveDetailText(fixture('jobs-admin-agroscope.html'), {
      title: 'Administrative/-r Mitarbeiter/-in',
    });
    expect(text).toContain('## Diesen Beitrag können Sie leisten');
    expect(text).toContain('Auf den Punkt gebracht');
    expect(text).toContain('Arbeiten für die Schweiz');
    expect(text).not.toMatch(/#[0-9A-F]{6}/i);
    expect(text).not.toContain('Ähnliche Stellen');
    expect(text).not.toContain('Eva Beispiel');
  });
});

describe('selectProspectiveDetailDescription', () => {
  it('returns the page text when it contains the listing text', () => {
    const html = fixture('equans-technicien-cvc.html');
    const { text, reason } = selectProspectiveDetailDescription(html, {
      title: EQUANS_TITLE,
      listingText: EQUANS_LISTING,
    });
    expect(reason).toBe('');
    expect(prospectiveDetailCoverage(text, EQUANS_LISTING)).toBeGreaterThan(0.9);
    expect(text.length).toBeGreaterThan(EQUANS_LISTING.length * 2);
  });

  it('keeps the listing text when the page is another vacancy', () => {
    const { text, reason } = selectProspectiveDetailDescription(fixture('claraspital-anaesthesiepflege.html'), {
      title: EQUANS_TITLE,
      listingText: EQUANS_LISTING,
    });
    expect(text).toBe('');
    expect(reason).toBe('not-this-vacancy');
  });
});

function htmlResponse(html: string, url: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html;charset=UTF-8' : null) },
    text: async () => html,
  };
}

describe('enrichProspectiveJobsFromDetailPages', () => {
  it('replaces the listing text with the page text, keeps it on 404 / untrusted hosts, fetches a shared page once', async () => {
    const html = fixture('equans-technicien-cvc.html');
    const fetchImpl = vi.fn(async (url: string) => (
      url === EQUANS_URL ? htmlResponse(html, url) : htmlResponse('', url, 404)
    ));
    const job = (url: string) => ({
      url,
      title: EQUANS_TITLE,
      sourceLang: 'fr',
      description: EQUANS_LISTING,
      // Runners that seed every locale with the source text (Agroscope, PwC).
      descriptionByLocale: { fr: EQUANS_LISTING, it: EQUANS_LISTING },
    });
    const enriched = job(EQUANS_URL);
    const sameVacancyOtherCity = job(EQUANS_URL);
    const gone = job('https://ohws.prospective.ch/public/v1/jobs/00000000-0000-0000-0000-000000000000');
    const foreign = job('https://example.org/jobs/1');
    const jobs = [enriched, sameVacancyOtherCity, gone, foreign];

    const result = await enrichProspectiveJobsFromDetailPages(jobs, {
      isTrustedDomain: (url: string) => new URL(url).hostname === 'ohws.prospective.ch',
      fetchImpl,
      delayMs: 0,
    });

    expect(result.used).toBe(2);
    expect(result.fallback).toEqual({ 'http-404': 1, 'untrusted-url': 1 });
    expect(enriched.description).toContain('## Voici ce que nous vous offrons');
    expect(enriched.descriptionByLocale.fr).toBe(enriched.description);
    expect(enriched.descriptionByLocale.it).toBe(enriched.description);
    expect(gone.description).toBe(EQUANS_LISTING);
    expect(foreign.description).toBe(EQUANS_LISTING);
    expect(result.pageDescribed.has(enriched)).toBe(true);
    expect(result.pageDescribed.has(gone)).toBe(false);
    const equansCalls = fetchImpl.mock.calls.filter(([url]) => url === EQUANS_URL);
    expect(equansCalls).toHaveLength(1);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).startsWith('https://example.org'))).toBe(false);
  });
});

describe('enrichProspectiveJobsFromDetailPages — non-HTML answers', () => {
  it('keeps the listing text when the "page" is a JSON body echoing it', async () => {
    const job = {
      url: EQUANS_URL,
      title: EQUANS_TITLE,
      sourceLang: 'fr',
      description: EQUANS_LISTING,
      descriptionByLocale: { fr: EQUANS_LISTING },
    };
    const result = await enrichProspectiveJobsFromDetailPages([job], {
      fetchImpl: async (url: string) => ({
        ok: true,
        status: 200,
        url,
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
        text: async () => JSON.stringify({ jobs: [{ szas: { sza_introduction: EQUANS_LISTING } }] }),
      }),
      delayMs: 0,
    });
    expect(result.fallback).toEqual({ 'not-html': 1 });
    expect(job.description).toBe(EQUANS_LISTING);
  });

  it('fails closed on a 2xx answer that declares no content type, before reading its body', async () => {
    const job = {
      url: EQUANS_URL,
      title: EQUANS_TITLE,
      sourceLang: 'fr',
      description: EQUANS_LISTING,
      descriptionByLocale: { fr: EQUANS_LISTING },
    };
    const text = vi.fn(async () => JSON.stringify({ title: EQUANS_LISTING }));
    const result = await enrichProspectiveJobsFromDetailPages([job], {
      fetchImpl: async (url: string) => ({
        ok: true,
        status: 200,
        url,
        headers: { get: () => '' },
        text,
      }),
      delayMs: 0,
    });
    expect(result.fallback).toEqual({ 'not-html': 1 });
    expect(result.used).toBe(0);
    expect(job.description).toBe(EQUANS_LISTING);
    expect(job.descriptionByLocale.fr).toBe(EQUANS_LISTING);
    expect(text).not.toHaveBeenCalled();
  });
});

describe('dropRepostedListings', () => {
  const base = { title: 'Fachperson Gesundheit EFZ', location: 'Regensdorf', postalCode: '8105', streetAddress: '' };

  it('drops a re-post only when both rendered pages are identical', () => {
    const a = { ...base, description: 'page text A' };
    const b = { ...base, description: 'page text A' };
    const c = { ...base, description: 'page text B (Befristet)' };
    const out = dropRepostedListings([a, b, c], 'test', { pageDescribed: new Set([a, b, c]) });
    expect(out).toEqual([a, c]);
  });

  it('ignores the requisition number: BKW posts one identical page per apprentice place', () => {
    const thun = { ...base, title: 'Lehrstelle Montage-Elektriker:in EFZ (alle)', location: 'Thun' };
    const a = { ...thun, description: '## Überblick\n• Referenznummer A-2205668\n• Arbeitsort Thun' };
    const b = { ...thun, description: '## Überblick\n• Referenznummer A-2205540\n• Arbeitsort Thun' };
    expect(dropRepostedListings([a, b], 'test', { pageDescribed: new Set([a, b]) })).toEqual([a]);
  });

  it('ignores a bare date line: Raiffeisen re-published a vacancy without withdrawing the first copy', () => {
    const egnach = { ...base, title: 'Mitarbeiter Kreditadministration (m/w/d)', location: 'Egnach' };
    const a = { ...egnach, description: '11.09.2026\n## Deine Aufgaben\n• Kreditadministration' };
    const b = { ...egnach, description: '07.08.2026\n## Deine Aufgaben\n• Kreditadministration' };
    expect(dropRepostedListings([a, b], 'test', { pageDescribed: new Set([a, b]) })).toEqual([a]);
  });

  it('never drops on listing text alone: it can hide what tells two postings apart', () => {
    // GZ Dielsdorf, audit 2026-09-29: same listing text, one "Befristet", one "Unbefristet".
    const a = { ...base, description: 'listing text' };
    const b = { ...base, description: 'listing text' };
    expect(dropRepostedListings([a, b], 'test')).toEqual([a, b]);
  });
});

describe('createProspectiveChParser({ detailPageDescription })', () => {
  it('publishes the rendered vacancy and one copy of a re-posted listing', async () => {
    const listing = JSON.parse(fixture('equans-listing-technicien-cvc.json'));
    const original = listing.jobs[0];
    const repost = { ...original, id: '99999999', hk_id: '9999999', viewkey: 'repost-of-c67de164' };
    const repostUrl = 'https://ohws.prospective.ch/public/v1/jobs/repost-of-c67de164';
    repost.links = { directlink: repostUrl };
    listing.jobs.push(repost);
    listing.total = 2;
    const html = fixture('equans-technicien-cvc.html');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/public/v1/medium/')) {
        return { ok: true, status: 200, json: async () => listing };
      }
      return htmlResponse(html, url);
    }));
    const parser = createProspectiveChParser({
      companyKey: 'equans',
      companyName: 'Equans Switzerland',
      companyDomain: 'equans.ch',
      mediumId: '1004089',
      defaultCanton: 'ZH',
      defaultCity: 'Zürich',
      defaultPostalCode: '8005',
      detailPageDescription: true,
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe(EQUANS_URL);
    expect(jobs[0].description).toContain('## Voici ce que nous vous offrons');
    expect(jobs[0].descriptionByLocale[jobs[0].sourceLang]).toBe(jobs[0].description);
  });

  it('keeps the listing text without the flag (no page fetch)', async () => {
    const listing = JSON.parse(fixture('equans-listing-technicien-cvc.json'));
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => listing }));
    vi.stubGlobal('fetch', fetchMock);
    const parser = createProspectiveChParser({
      companyKey: 'equans',
      companyName: 'Equans Switzerland',
      companyDomain: 'equans.ch',
      mediumId: '1004089',
      defaultCanton: 'ZH',
      defaultCity: 'Zürich',
      defaultPostalCode: '8005',
    });

    const jobs = await parser.fetchAllJobs();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toContain('Aufgaben:');
    expect(jobs[0].description).not.toContain('Voici ce que nous vous offrons');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
