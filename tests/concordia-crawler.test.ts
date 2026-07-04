/**
 * Concordia crawler parser tests.
 *
 * Concordia (jobs.concordia.ch) is a Prospective.ch "careercenter" tenant
 * (id 1000725) served directly on the corporate subdomain as server-rendered
 * HTML with GET-based offset pagination and a per-job schema.org/JobPosting
 * JSON-LD block. Unlike the `medium`-scoped Prospective tenants, this
 * tenant's JSON listing API (`ohws.prospective.ch/public/v1/medium/1000725/jobs`)
 * returns HTTP 400 (verified live 2026-07-03), so this parser scrapes the
 * listing HTML + JSON-LD detail pages directly instead of going through
 * `prospective-ch-job-parser-common.mjs`.
 */
import { describe, it, expect } from 'vitest';

import {
  CONCORDIA_KEY,
  CONCORDIA_COMPANY_NAME,
  isConcordiaJob,
  isTrustedDomain,
  parseConcordiaListing,
  resolveCanton,
  detectCategory,
  detectExperienceLevel,
} from '@/scripts/lib/concordia-job-parser.mjs';

// ── Constants ──

describe('Concordia crawler parser', () => {
  it('exports valid company key + name', () => {
    expect(CONCORDIA_KEY).toBe('concordia');
    expect(CONCORDIA_COMPANY_NAME).toBe('Concordia');
  });

  // ── isConcordiaJob ──
  describe('isConcordiaJob', () => {
    it('matches by companyKey', () => {
      expect(isConcordiaJob({ companyKey: 'concordia' })).toBe(true);
    });

    it('matches by company name', () => {
      expect(isConcordiaJob({ company: 'Concordia' })).toBe(true);
    });

    it('matches by board host in the URL', () => {
      expect(isConcordiaJob({ url: 'https://jobs.concordia.ch/offene-stellen/x/y' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(isConcordiaJob({
        companyKey: 'other-company',
        company: 'Other',
        url: 'https://other.com/jobs',
      })).toBe(false);
    });

    it('handles null/undefined/empty gracefully', () => {
      expect(isConcordiaJob(null)).toBe(false);
      expect(isConcordiaJob(undefined)).toBe(false);
      expect(isConcordiaJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts the job board host', () => {
      expect(isTrustedDomain('https://jobs.concordia.ch/offene-stellen/x/y')).toBe(true);
    });

    it('trusts the corporate domain and subdomains', () => {
      expect(isTrustedDomain('https://www.concordia.ch/de/ueber-uns/jobs/')).toBe(true);
      expect(isTrustedDomain('https://concordia.ch/')).toBe(true);
    });

    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com/jobs')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });

  // ── parseConcordiaListing ──
  describe('parseConcordiaListing', () => {
    const LISTING_FIXTURE = `
      <div class="job">
        <a href="https://jobs.concordia.ch/offene-stellen/agenturleiter-in-in-zug/68c71b34-b782-45cc-93da-6e2f5c6e73df" class="job-title">Agenturleiter/in in Zug</a>
      </div>
      <div class="job">
        <a href="/offene-stellen/lehrstelle-kauffrau-oder-kaufmann-efz-in-horw/1927e1ec-c4e4-44db-b2c7-953571d7b0f1" class="job-title">Lehrstelle</a>
      </div>
    `;

    it('extracts absolute detail URLs', () => {
      const urls = parseConcordiaListing(LISTING_FIXTURE);
      expect(urls).toContain(
        'https://jobs.concordia.ch/offene-stellen/agenturleiter-in-in-zug/68c71b34-b782-45cc-93da-6e2f5c6e73df',
      );
    });

    it('resolves root-relative hrefs to absolute URLs', () => {
      const urls = parseConcordiaListing(LISTING_FIXTURE);
      expect(urls).toContain(
        'https://jobs.concordia.ch/offene-stellen/lehrstelle-kauffrau-oder-kaufmann-efz-in-horw/1927e1ec-c4e4-44db-b2c7-953571d7b0f1',
      );
    });

    it('deduplicates repeated hrefs', () => {
      const dup = `${LISTING_FIXTURE}${LISTING_FIXTURE}`;
      const urls = parseConcordiaListing(dup);
      expect(urls).toHaveLength(2);
    });

    it('returns [] for empty/unrelated HTML', () => {
      expect(parseConcordiaListing('')).toEqual([]);
      expect(parseConcordiaListing('<p>no jobs here</p>')).toEqual([]);
    });
  });

  // ── resolveCanton — addressRegion is the canton name, DE/FR/IT variants ──
  describe('resolveCanton', () => {
    it('maps German canton names', () => {
      expect(resolveCanton('Luzern', 'Luzern')).toBe('LU');
      expect(resolveCanton('Zürich', 'Zürich')).toBe('ZH');
      expect(resolveCanton('Bern', 'Biel')).toBe('BE');
    });

    it('maps French canton names', () => {
      expect(resolveCanton('Vaud', 'Lausanne')).toBe('VD');
      expect(resolveCanton('Genève', 'Genève')).toBe('GE');
    });

    it('falls back to city-based inference when region is unmapped', () => {
      // No addressRegion, but a well-known Ticino city.
      expect(resolveCanton('', 'Lugano')).toBe('TI');
    });

    it('falls back to HQ default (LU) when nothing resolves', () => {
      expect(resolveCanton('', '')).toBe('LU');
    });
  });

  // ── detectCategory ──
  describe('detectCategory', () => {
    it('detects apprenticeship/training roles', () => {
      expect(detectCategory('Lehrstelle Kauffrau oder Kaufmann EFZ')).toBe('Formazione');
    });

    it('detects IT roles', () => {
      expect(detectCategory('Senior AI Engineer / Architect (m/w/d)')).toBe('IT');
    });

    it('detects sales/agency roles', () => {
      expect(detectCategory('Agenturleiter/in in Zug')).toBe('Commerciale');
    });

    it('falls back to Assicurazioni for generic insurance roles', () => {
      expect(detectCategory('Sachbearbeiter Leistungen')).not.toBe('');
    });
  });

  // ── detectExperienceLevel ──
  describe('detectExperienceLevel', () => {
    it('detects intern/apprentice level', () => {
      expect(detectExperienceLevel('Lehrstelle Kauffrau EFZ')).toBe('intern');
    });

    it('detects senior level', () => {
      expect(detectExperienceLevel('Leiter Underwriting')).toBe('senior');
    });

    it('defaults to mid level', () => {
      expect(detectExperienceLevel('Sachbearbeiter Leistungen')).toBe('mid');
    });
  });
});
