import { describe, expect, it } from 'vitest';
import {
 safeIsoDate,
 buildJobTitleCore,
 truncateTitleCore,
 composeJobPageTitle,
 composeJobPageH1,
 pickJobDisambiguator,
} from '../build-plugins/jobsSeoPagesPlugin';

describe('safeIsoDate', () => {
 it('returns ISO-8601 string for a valid date string', () => {
 expect(safeIsoDate('2025-01-15T10:00:00Z')).toBe('2025-01-15T10:00:00.000Z');
 });

 it('returns ISO-8601 string for a valid epoch number', () => {
 const result = safeIsoDate(1737000000000);
 expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
 });

 it('returns null for null', () => {
 expect(safeIsoDate(null)).toBeNull();
 });

 it('returns null for undefined', () => {
 expect(safeIsoDate(undefined)).toBeNull();
 });

 it('returns null for an unparseable string', () => {
 expect(safeIsoDate('not-a-date')).toBeNull();
 });

 it('returns null for an empty string', () => {
 expect(safeIsoDate('')).toBeNull();
 });

 it('never returns the literal string "Invalid Date"', () => {
 const samples: unknown[] = [
 'Invalid Date',
 'NaN',
 {},
 [],
 Number.NaN,
 'Mon, bogus format',
 '0000-00-00',
 ];
 for (const s of samples) {
 const out = safeIsoDate(s);
 expect(out === null || /^\d{4}-\d{2}-\d{2}T/.test(out)).toBe(true);
 expect(out).not.toBe('Invalid Date');
 }
 });
});

describe('buildJobTitleCore', () => {
 it('includes the city with Italian connector "a"', () => {
 expect(buildJobTitleCore('Sviluppatore', 'Acme', 'Lugano', 'it'))
 .toBe('Sviluppatore — Acme a Lugano');
 });

 it('uses English "in" connector', () => {
 expect(buildJobTitleCore('Developer', 'Acme', 'Lugano', 'en'))
 .toBe('Developer — Acme in Lugano');
 });

 it('uses German "in" connector', () => {
 expect(buildJobTitleCore('Entwickler', 'Acme', 'Lugano', 'de'))
 .toBe('Entwickler — Acme in Lugano');
 });

 it('uses French "à" connector', () => {
 expect(buildJobTitleCore('Développeur', 'Acme', 'Lugano', 'fr'))
 .toBe('Développeur — Acme à Lugano');
 });

 it('falls back to connector when city missing', () => {
 expect(buildJobTitleCore('Developer', 'Acme', '', 'it'))
 .toBe('Developer — Acme');
 });

 it('falls back when company is missing but city is present', () => {
 expect(buildJobTitleCore('Developer', '', 'Lugano', 'it'))
 .toBe('Developer a Lugano');
 });

 it('returns only the title when both company and city missing', () => {
 expect(buildJobTitleCore('Developer', '', '', 'it')).toBe('Developer');
 });

 it('differentiates multi-sede jobs by city', () => {
 const a = buildJobTitleCore('Stage', 'Lidl', 'Lugano', 'it');
 const b = buildJobTitleCore('Stage', 'Lidl', 'Bellinzona', 'it');
 expect(a).not.toBe(b);
 });
});

describe('truncateTitleCore', () => {
 it('returns input verbatim when shorter than maxCore', () => {
 expect(truncateTitleCore('Short core', 40)).toBe('Short core');
 });

 it('truncates word-aware on whitespace boundary when possible', () => {
 const out = truncateTitleCore('Senior Software Engineer Backend Developer', 30);
 expect(out.length).toBeLessThanOrEqual(30);
 expect(out.endsWith('…')).toBe(true);
 // Cuts on a space boundary — the char immediately before "…" is the
 // last char of a complete word from the input, never a partially-cut token.
 const lastWord = out.replace(/…$/, '').split(/\s+/).pop() ?? '';
 expect('Senior Software Engineer Backend Developer'.split(/\s+/)).toContain(lastWord);
 });

 it('falls back to hard cut for tokens with no usable space boundary', () => {
 const out = truncateTitleCore('a'.repeat(50), 20);
 expect(out.length).toBeLessThanOrEqual(20);
 expect(out.endsWith('…')).toBe(true);
 });

 it('caps absurdly long input that contains body content (regression)', () => {
 const malformed = 'Java Software Ingegnere — ALTEN Switzerland a : Ticino, Switzerland.Availability to work on-site is required. What we offer you.';
 const out = truncateTitleCore(malformed, 70);
 expect(out.length).toBeLessThanOrEqual(70);
 });
});

describe('composeJobPageTitle', () => {
 const SUFFIX = ' | Frontaliere Ticino';
 const MAX = 70;

 it('appends the brand suffix when total ≤ 70', () => {
 const out = composeJobPageTitle('Dev', 'Acme', 'Lugano', 'it');
 expect(out.endsWith(SUFFIX)).toBe(true);
 expect(out.length).toBeLessThanOrEqual(MAX);
 });

 it('drops the brand (but preserves city) when the title is too long', () => {
 // Policy change (titleSuffix.ts): when the headline+brand exceeds the
 // SERP cap (66 chars), the brand suffix is dropped — preferring keyword
 // content over brand. The city-preserving core keeps the trailing city
 // token intact regardless, even when the headline itself must be
 // shortened to fit the 70-char cap.
 const jobTitle = 'Very Long Senior Software Engineer Position with Specialty';
 const company = 'International Consulting Group AG';
 const out = composeJobPageTitle(jobTitle, company, 'Lugano', 'it');
 expect(out.length).toBeLessThanOrEqual(MAX);
 // City-preserving truncation keeps the trailing city token (the city is
 // the disambiguator that prevents multi-sede titles from collapsing).
 expect(out).toContain('Lugano');
 // The brand suffix is dropped when the title would otherwise exceed 66.
 expect(out.endsWith(SUFFIX)).toBe(false);
 });

 it('includes the city in the headline', () => {
 const out = composeJobPageTitle('Dev', 'Acme', 'Lugano', 'it');
 expect(out).toContain('Lugano');
 });

 it('produces DIFFERENT titles for the same role in different cities', () => {
 const a = composeJobPageTitle('Stage', 'Lidl', 'Lugano', 'it');
 const b = composeJobPageTitle('Stage', 'Lidl', 'Bellinzona', 'it');
 expect(a).not.toBe(b);
 });

 it('preserves the city even when the headline is long', () => {
 const jobTitle = 'Impiegato/a amministrativo/a';
 const company = 'EOC – Ente Ospedaliero Cantonale';
 const lugano = composeJobPageTitle(jobTitle, company, 'Lugano', 'it');
 const bellinzona = composeJobPageTitle(jobTitle, company, 'Bellinzona', 'it');
 const novaggio = composeJobPageTitle(jobTitle, company, 'Novaggio', 'it');
 expect(lugano).toContain('Lugano');
 expect(bellinzona).toContain('Bellinzona');
 expect(novaggio).toContain('Novaggio');
 expect(new Set([lugano, bellinzona, novaggio]).size).toBe(3);
 });

 it('does not repeat the brand suffix twice', () => {
 const out = composeJobPageTitle('Dev', 'Acme', 'Lugano', 'it');
 const matches = out.match(/Frontaliere Ticino/g);
 expect(matches?.length ?? 0).toBeLessThanOrEqual(1);
 });

 it('handles empty company gracefully', () => {
 const out = composeJobPageTitle('Dev', '', 'Lugano', 'it');
 expect(out).toContain('Lugano');
 });

 it('caps the final <title> at 70 chars even when input contains malformed body content', () => {
 // Regression: PR #36 removed the truncate net; jobs whose `city` field
 // contained the full job description body produced 400+ char titles.
 const jobTitle = 'Java Software Ingegnere';
 const company = 'ALTEN Switzerland';
 const malformedCity = ': Ticino, Switzerland.Availability to work on-site is required. What we offer youAt ALTEN you benefit from a permanent contract.';
 const out = composeJobPageTitle(jobTitle, company, malformedCity, 'it');
 expect(out.length).toBeLessThanOrEqual(MAX);
 });

 it('keeps multi-slug jobs distinct via disambiguator inside the 70-char cap', () => {
 // Same role + company + city, two different human-readable disambig
 // tokens (e.g. salary range vs work-hours percentage). Each disambig
 // must land inside the cap so audit:title-uniqueness stays green.
 // Disambiguator now formatted as ` · ${token}` (was a hash before).
 const a = composeJobPageTitle('Stage', 'Lidl', 'Lugano', 'it', '80%');
 const b = composeJobPageTitle('Stage', 'Lidl', 'Lugano', 'it', 'CHF 30-45k');
 expect(a).not.toBe(b);
 expect(a.length).toBeLessThanOrEqual(MAX);
 expect(b.length).toBeLessThanOrEqual(MAX);
 // The "· {token}" separator must be present (not the legacy "(#hash8)").
 expect(a).toContain(' · 80%');
 expect(b).toContain(' · CHF 30-45k');
 });

 it('keeps the disambiguator even when jobTitle + company + city overflow the cap', () => {
 const longJob = 'Specialist Senior Software Engineer Backend Distributed Systems';
 const out = composeJobPageTitle(longJob, 'International Consulting Group AG', 'Lugano', 'it', 'apr 2027');
 expect(out.length).toBeLessThanOrEqual(MAX);
 expect(out).toContain(' · apr 2027');
 });
});

describe('pickJobDisambiguator (human-readable cascade)', () => {
 const baseTitle = 'Receptionist — Migros, Lugano';

 it('picks workHours percentage when employmentType encodes "80 _ 100%"', () => {
  const job = { employmentType: '80 _ 100%', salaryMin: 50000, salaryMax: 70000, postedDate: '2027-04-01', id: 'migros-lugano-recept-abc1' };
  expect(pickJobDisambiguator(job, 'it', baseTitle)).toBe('80-100%');
 });

 it('picks single percentage when employmentType is "80%"', () => {
  const job = { employmentType: '80%', salaryMin: 50000, salaryMax: 70000, postedDate: '2027-04-01', id: 'migros-lugano-recept-abc1' };
  expect(pickJobDisambiguator(job, 'it', baseTitle)).toBe('80%');
 });

 it('skips workHours when 100% (effectively full-time)', () => {
  const job = { employmentType: '100%', salaryMin: 50000, salaryMax: 70000, postedDate: '2027-04-01', id: 'migros-lugano-recept-abc1' };
  // Should fall through to salary
  expect(pickJobDisambiguator(job, 'it', baseTitle)).toBe('CHF 50-70k');
 });

 it('picks employmentType label (PART_TIME → "Part-time" in IT)', () => {
  const job = { employmentType: 'PART_TIME', salaryMin: 50000, salaryMax: 70000, postedDate: '2027-04-01', id: 'migros-lugano-recept-abc1' };
  expect(pickJobDisambiguator(job, 'it', baseTitle)).toBe('Part-time');
 });

 it('skips FULL_TIME (default) and falls through to salary', () => {
  const job = { employmentType: 'FULL_TIME', salaryMin: 60000, salaryMax: 85000, postedDate: '2027-04-01', id: 'migros-lugano-recept-abc1' };
  expect(pickJobDisambiguator(job, 'it', baseTitle)).toBe('CHF 60-85k');
 });

 it('localizes employmentType labels per locale', () => {
  const job = { employmentType: 'TEMPORARY' };
  expect(pickJobDisambiguator(job, 'it', baseTitle)).toBe('Temporaneo');
  expect(pickJobDisambiguator(job, 'de', baseTitle)).toBe('Befristet');
  expect(pickJobDisambiguator(job, 'fr', baseTitle)).toBe('Temporaire');
  expect(pickJobDisambiguator(job, 'en', baseTitle)).toBe('Temporary');
 });

 it('falls through to posted month when no salary', () => {
  const job = { employmentType: 'FULL_TIME', postedDate: '2027-04-01', id: 'migros-lugano-recept-abc1' };
  expect(pickJobDisambiguator(job, 'it', baseTitle)).toBe('apr 2027');
 });

 it('falls through to job-id reference as last resort', () => {
  const job = { employmentType: 'FULL_TIME', id: 'migros-lugano-recept-abc1' };
  expect(pickJobDisambiguator(job, 'it', baseTitle)).toBe('rif. abc1');
 });

 it('skips a token already present in the base title (case-insensitive)', () => {
  // baseTitle already contains "Part-time"
  const job = { employmentType: 'PART_TIME', salaryMin: 50000, salaryMax: 70000, postedDate: '2027-04-01' };
  const out = pickJobDisambiguator(job, 'it', 'Receptionist Part-time — Migros, Lugano');
  expect(out).toBe('CHF 50-70k');  // skipped Part-time, fell through
 });

 it('returns empty string when nothing usable is available', () => {
  const job = {};
  expect(pickJobDisambiguator(job, 'it', baseTitle)).toBe('');
 });
});

describe('composeJobPageH1', () => {
 it('combines title and company without brand suffix', () => {
 const h1 = composeJobPageH1('Developer', 'Acme');
 expect(h1).toBe('Developer — Acme');
 expect(h1).not.toContain('Frontaliere Ticino');
 expect(h1).not.toContain('Lugano');
 });

 it('omits the connector when company is empty', () => {
 expect(composeJobPageH1('Developer', '')).toBe('Developer');
 });

 it('differs from the page title (no city, no brand)', () => {
 const title = composeJobPageTitle('Developer', 'Acme', 'Lugano', 'it');
 const h1 = composeJobPageH1('Developer', 'Acme');
 expect(h1).not.toBe(title);
 // Specifically, H1 must not contain the brand suffix
 expect(h1.includes('| Frontaliere Ticino')).toBe(false);
 });
});
