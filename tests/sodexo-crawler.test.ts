/**
 * Sodexo (Suisse) SA — Concludis ATS parser tests
 *
 * Fixtures mirror the real server-rendered Concludis listing page
 * (`cJobboard.openJob('...')` blocks) and the JSON-LD JobPosting payload
 * embedded in each detail page, captured from
 * https://sodexo-suisse.concludis.de/prj/lst/{tenant}/GesamtlisteOffenePositionen.htm
 */
import { describe, it, expect } from 'vitest';

import {
  parseSodexoListing,
  extractJobPostingLd,
  isSodexoJob,
  isTrustedDomain,
  SODEXO_KEY,
  SODEXO_COMPANY_NAME,
} from '@/scripts/lib/sodexo-job-parser.mjs';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FIXTURE_LISTING_PAGE = `
<div class="stellenlst"><div class="stellenlsthead"><div class="stellensum">3 Stellen gefunden</div><div style="clear:both"></div></div><div class="stellen list"><div onclick="cJobboard.openJob('https://sodexo-suisse.concludis.de/prj/shw/3cc697419ea18cc98d525999665cb94a_0/5511/Rezeptionist_in_60.htm?b=0&lang=de_DE');" id="line_5511" class="line_0"><span class="headerlink stellenlink">Rezeptionist:in 60%</span><span class="kurzb"><br /> Stellennummer 5511 am Standort Baar CH-6340 - Teilzeit</span></div><div onclick="cJobboard.openJob('https://sodexo-suisse.concludis.de/prj/shw/23e582ad8087f2c03a5a31c125123f9a_0/5507/Koch_Koechin_EFZ_100.htm?b=0&lang=de_DE');" id="line_5507" class="line_1"><span class="headerlink stellenlink">Koch / Köchin EFZ 100%</span><span class="kurzb"><br /> Stellennummer 5507 am Standort Oberdorf CH-4436 - Vollzeit</span></div><div onclick="cJobboard.openJob('https://sodexo-suisse.concludis.de/prj/shw/e3c9cb08585a40829bc88130b0b8ebdf_0/5439/Unterhaltsreiniger_in_m_w_d_15h.htm?b=0&lang=de_DE');" id="line_5439" class="line_0"><span class="headerlink stellenlink">Unterhaltsreiniger:in (m/w/d) 15h pro Woche</span><span class="kurzb"><br /> Stellennummer 5439 am Standort Buchs CH-CH-5033 - Teilzeit</span></div>    </div>
`;

const FIXTURE_EMPTY_LISTING = `
<div class="stellenlst"><div class="stellenlsthead"><div class="stellensum">0 Stellen gefunden</div></div><div class="stellen list">    </div>
`;

const FIXTURE_DETAIL_PAGE = `
<!DOCTYPE html>
<html>
<head><title>Rezeptionist:in 60% - Sodexo (Suisse) SA</title>
<script type="application/ld+json">{"@context":"http://schema.org","@type":"JobPosting","datePosted":"2026-06-30","title":"Rezeptionist:in 60%","description":"<p>Sodexo wurde 1966 von Pierre Bellon in Marseille gegr\\u00fcndet und ist der weltweit f\\u00fchrende Anbieter von nachhaltiger Betriebsgastronomie. Wir suchen eine Rezeptionistin f\\u00fcr unseren Standort in Baar. Zu deinen Aufgaben geh\\u00f6ren der Empfang von G\\u00e4sten, das Bedienen der Telefonzentrale, die Verwaltung von B\\u00fcromaterial sowie die Unterst\\u00fctzung bei administrativen Aufgaben im Tagesgesch\\u00e4ft. Du bringst eine kaufm\\u00e4nnische Ausbildung mit und hast Freude am Umgang mit Menschen und einem dynamischen Team.<\\/p>","hiringOrganization":{"@type":"Organization","name":"Sodexo (Suisse) SA","sameAs":"http://ch.sodexo.com/home.html"},"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Baar","postalCode":"6340","addressCountry":"CH"}},"employmentType":"PART_TIME"}</script>
</head>
<body><h1>Rezeptionist:in 60%</h1></body>
</html>
`;

const FIXTURE_DETAIL_PAGE_NO_LD = `
<!DOCTYPE html>
<html><head><title>No LD</title></head><body><h1>Broken page</h1></body></html>
`;

// ─── parseSodexoListing ─────────────────────────────────────────────────────

describe('parseSodexoListing', () => {
  it('finds three jobs in the fixture', () => {
    const jobs = parseSodexoListing(FIXTURE_LISTING_PAGE);
    expect(jobs).toHaveLength(3);
  });

  it('extracts correct titles', () => {
    const jobs = parseSodexoListing(FIXTURE_LISTING_PAGE);
    expect(jobs[0].title).toBe('Rezeptionist:in 60%');
    expect(jobs[1].title).toBe('Koch / Köchin EFZ 100%');
    expect(jobs[2].title).toBe('Unterhaltsreiniger:in (m/w/d) 15h pro Woche');
  });

  it('extracts Stellennummer as id', () => {
    const jobs = parseSodexoListing(FIXTURE_LISTING_PAGE);
    expect(jobs[0].id).toBe('5511');
    expect(jobs[1].id).toBe('5507');
  });

  it('extracts absolute Concludis detail URLs', () => {
    const jobs = parseSodexoListing(FIXTURE_LISTING_PAGE);
    expect(jobs[0].detailUrl).toContain('sodexo-suisse.concludis.de/prj/shw/');
    expect(jobs[0].detailUrl).toContain('5511');
  });

  it('extracts location and contract label from the "kurzb" summary', () => {
    const jobs = parseSodexoListing(FIXTURE_LISTING_PAGE);
    expect(jobs[0].locationRaw).toContain('Baar');
    expect(jobs[0].contractLabel).toBe('Teilzeit');
    expect(jobs[1].contractLabel).toBe('Vollzeit');
  });

  it('returns empty array when no positions are listed', () => {
    expect(parseSodexoListing(FIXTURE_EMPTY_LISTING)).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(parseSodexoListing('')).toHaveLength(0);
  });

  it('de-duplicates repeated Stellennummer blocks', () => {
    const doubled = FIXTURE_LISTING_PAGE + FIXTURE_LISTING_PAGE;
    expect(parseSodexoListing(doubled)).toHaveLength(3);
  });
});

// ─── extractJobPostingLd ────────────────────────────────────────────────────

describe('extractJobPostingLd', () => {
  it('extracts the JobPosting object', () => {
    const ld = extractJobPostingLd(FIXTURE_DETAIL_PAGE);
    expect(ld).not.toBeNull();
    expect(ld.title).toBe('Rezeptionist:in 60%');
    expect(ld['@type']).toBe('JobPosting');
  });

  it('extracts datePosted and employmentType', () => {
    const ld = extractJobPostingLd(FIXTURE_DETAIL_PAGE);
    expect(ld.datePosted).toBe('2026-06-30');
    expect(ld.employmentType).toBe('PART_TIME');
  });

  it('extracts hiringOrganization.name matching AGENTS.md Non-Negotiable #3', () => {
    const ld = extractJobPostingLd(FIXTURE_DETAIL_PAGE);
    expect(ld.hiringOrganization.name).toBe(SODEXO_COMPANY_NAME);
  });

  it('extracts jobLocation address (postalCode + addressLocality)', () => {
    const ld = extractJobPostingLd(FIXTURE_DETAIL_PAGE);
    expect(ld.jobLocation.address.addressLocality).toBe('Baar');
    expect(ld.jobLocation.address.postalCode).toBe('6340');
  });

  it('returns null when no JSON-LD JobPosting block is present', () => {
    expect(extractJobPostingLd(FIXTURE_DETAIL_PAGE_NO_LD)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractJobPostingLd('')).toBeNull();
  });
});

// ─── isSodexoJob / isTrustedDomain ──────────────────────────────────────────

describe('isSodexoJob', () => {
  it('matches by companyKey', () => {
    expect(isSodexoJob({ companyKey: SODEXO_KEY })).toBe(true);
  });

  it('matches by Concludis tenant URL', () => {
    expect(isSodexoJob({ url: 'https://sodexo-suisse.concludis.de/prj/shw/x/1/y.htm' })).toBe(true);
  });

  it('matches by company name', () => {
    expect(isSodexoJob({ company: 'Sodexo (Suisse) SA' })).toBe(true);
  });

  it('rejects unrelated jobs', () => {
    expect(isSodexoJob({ companyKey: 'other', url: 'https://example.com', company: 'Other AG' })).toBe(false);
  });
});

describe('isTrustedDomain', () => {
  it('trusts the Concludis tenant domain', () => {
    expect(isTrustedDomain('https://sodexo-suisse.concludis.de/prj/shw/x')).toBe(true);
  });

  it('trusts the public Sodexo careers domain', () => {
    expect(isTrustedDomain('https://ch.sodexo.com/karriere.html')).toBe(true);
  });

  it('rejects unrelated domains', () => {
    expect(isTrustedDomain('https://evil.example.com')).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isTrustedDomain('not-a-url')).toBe(false);
  });
});
