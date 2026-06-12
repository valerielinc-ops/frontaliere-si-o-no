import { describe, expect, it } from 'vitest';
import {
 safeIsoDate,
 composeJobPageTitle,
 composeJobPageH1,
 pickJobDisambiguator,
 fnv8,
 titleCompareKey,
} from '../build-plugins/jobsSeoPagesPlugin';
import { composeSerpJobTitle, truncateHeadline, TITLE_MAX_CHARS } from '../build-plugins/shared/titleSuffix';
import { stripLeadingSectionLabel } from '../build-plugins/shared/jobDescription/parser';

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

describe('composeSerpJobTitle (role > city > company > brand cascade)', () => {
 it('keeps the full "role — company a city" + brand when everything fits', () => {
 expect(composeSerpJobTitle('Sviluppatore', 'Acme', 'Lugano', 'it'))
 .toBe('Sviluppatore — Acme a Lugano | Frontaliere Ticino');
 });

 it('uses the locale connector (en/de "in", fr "à")', () => {
 expect(composeSerpJobTitle('Developer', 'Acme', 'Lugano', 'en')).toContain('Acme in Lugano');
 expect(composeSerpJobTitle('Entwickler', 'Acme', 'Lugano', 'de')).toContain('Acme in Lugano');
 expect(composeSerpJobTitle('Développeur', 'Acme', 'Lugano', 'fr')).toContain('Acme à Lugano');
 });

 it('drops the COMPANY before touching the role or the city', () => {
 // Live SERP offender (Bell Schweiz AG, Zell): the old composer emitted
 // "Addetto alla Pianificazione della Produzione PPS —… · rif. zell".
 const out = composeSerpJobTitle(
  'Addetto alla Pianificazione della Produzione PPS', 'Bell Schweiz AG', 'Zell', 'it');
 expect(out).toBe('Addetto alla Pianificazione della Produzione PPS a Zell');
 expect(out).not.toContain('…');
 expect(out).not.toContain('rif.');
 expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 });

 it('never emits a mid-headline ellipsis while any candidate fits', () => {
 const out = composeSerpJobTitle(
  'Very Long Senior Software Engineer Position with Specialty',
  'International Consulting Group AG', 'Lugano', 'it');
 // role+city (67) overflows 66, so the cascade falls back to the bare
 // role (58) — verbatim, no "…", no dangling delimiter.
 expect(out).toBe('Very Long Senior Software Engineer Position with Specialty');
 });

 it('preserves the city tail when even the bare role overflows', () => {
 const role = 'Specialist Senior Software Engineer Backend Distributed Systems Architect';
 const out = composeSerpJobTitle(role, 'Acme', 'Lugano', 'it');
 expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 expect(out).toMatch(/… a Lugano$/);
 });

 it('uses the full 66-char budget (no phantom brand reservation)', () => {
 // Old composer reserved 21 chars for a brand it then dropped 92 % of
 // the time, truncating cores at ~49 chars. A 65-char headline must now
 // survive verbatim (brand dropped, no truncation).
 const role = 'Impiegato amministrativo settore logistica e spedizioni';
 const out = composeSerpJobTitle(role, '', 'Chiasso', 'it');
 expect(out).toBe(`${role} a Chiasso`);
 expect(out.length).toBeGreaterThan(60);
 expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 });

 it('budgets the disambiguator before the cascade so it always fits', () => {
 const out = composeSerpJobTitle('Stage', 'Lidl', 'Lugano', 'it', { disambiguator: '80%' });
 expect(out).toContain(' · 80%');
 expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 });

 it('drops a malformed oversized city instead of blowing the cap (regression)', () => {
 const malformedCity = ': Ticino, Switzerland.Availability to work on-site is required. What we offer youAt ALTEN you benefit from a permanent contract.';
 const out = composeSerpJobTitle('Java Software Ingegnere', 'ALTEN Switzerland', malformedCity, 'it');
 expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 });
});

describe('truncateHeadline', () => {
 it('returns input verbatim when within budget', () => {
 expect(truncateHeadline('Short core', 40)).toBe('Short core');
 });

 it('truncates word-aware on whitespace boundary when possible', () => {
 const out = truncateHeadline('Senior Software Engineer Backend Developer', 30);
 expect(out.length).toBeLessThanOrEqual(30);
 expect(out.endsWith('…')).toBe(true);
 const lastWord = out.replace(/…$/, '').split(/\s+/).pop() ?? '';
 expect('Senior Software Engineer Backend Developer'.split(/\s+/)).toContain(lastWord);
 });

 it('never leaves a dangling delimiter before the ellipsis (live "PPS —…" regression)', () => {
 // Cut landing right after the " — " company delimiter must strip it.
 const headline = 'Addetto alla Pianificazione della Produzione PPS — Bell Schweiz AG';
 const out = truncateHeadline(headline, 54);
 expect(out).toBe('Addetto alla Pianificazione della Produzione PPS…');
 expect(out).not.toMatch(/[—–\-·|,;:&(]\s*…$/);
 });

 it('falls back to hard cut for tokens with no usable space boundary', () => {
 const out = truncateHeadline('a'.repeat(50), 20);
 expect(out.length).toBeLessThanOrEqual(20);
 expect(out.endsWith('…')).toBe(true);
 });
});

describe('stripLeadingSectionLabel', () => {
 it('strips a flattened leading "Descrizione" heading (live Bell/Zell snippet)', () => {
 expect(stripLeadingSectionLabel('Descrizione Presso la sede di Zell, il team PPS pianifica.'))
 .toBe('Presso la sede di Zell, il team PPS pianifica.');
 });

 it('strips localized variants with optional separator', () => {
 expect(stripLeadingSectionLabel('Beschreibung: Wir suchen Verstärkung.')).toBe('Wir suchen Verstärkung.');
 expect(stripLeadingSectionLabel('Description du poste Nous recherchons un agent.')).toBe('Nous recherchons un agent.');
 expect(stripLeadingSectionLabel('Job description We are hiring.')).toBe('We are hiring.');
 });

 it('keeps legitimate sentences that merely start with the word', () => {
 const legit = 'Descrizione dettagliata delle mansioni nel documento allegato.';
 expect(stripLeadingSectionLabel(legit)).toBe(legit);
 });

 it('passes through empty/absent input', () => {
 expect(stripLeadingSectionLabel('')).toBe('');
 });
});

describe('fnv8 / titleCompareKey', () => {
 it('fnv8 is deterministic, 8 hex chars, and slug-sensitive', () => {
 expect(fnv8('a-slug')).toBe(fnv8('a-slug'));
 expect(fnv8('a-slug')).toMatch(/^[0-9a-f]{8}$/);
 expect(fnv8('role-bell-zell')).not.toBe(fnv8('role-bell-wil'));
 });

 it('titleCompareKey normalizes case and whitespace like the H1 audit', () => {
 expect(titleCompareKey('  Developer —  Acme ')).toBe(titleCompareKey('developer — acme'));
 });
});

describe('composeJobPageTitle', () => {
 const SUFFIX = ' | Frontaliere Ticino';
 const MAX = 66; // TITLE_MAX_CHARS — audit:title-length cap

 it('appends the brand suffix when total ≤ 66', () => {
 const out = composeJobPageTitle('Dev', 'Acme', 'Lugano', 'it');
 expect(out.endsWith(SUFFIX)).toBe(true);
 expect(out.length).toBeLessThanOrEqual(MAX);
 });

 it('drops brand THEN company when the title is too long — role stays whole', () => {
 // role>city>company>brand cascade: "role a Lugano" (67) still overflows
 // 66, so the company AND city give way and the bare role ships verbatim
 // — never a mid-headline "…" while a whole candidate fits.
 const jobTitle = 'Very Long Senior Software Engineer Position with Specialty';
 const company = 'International Consulting Group AG';
 const out = composeJobPageTitle(jobTitle, company, 'Lugano', 'it');
 expect(out.length).toBeLessThanOrEqual(MAX);
 expect(out).toBe(jobTitle);
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

 it('caps the final <title> at 66 chars even when input contains malformed body content', () => {
 // Regression: PR #36 removed the truncate net; jobs whose `city` field
 // contained the full job description body produced 400+ char titles.
 const jobTitle = 'Java Software Ingegnere';
 const company = 'ALTEN Switzerland';
 const malformedCity = ': Ticino, Switzerland.Availability to work on-site is required. What we offer youAt ALTEN you benefit from a permanent contract.';
 const out = composeJobPageTitle(jobTitle, company, malformedCity, 'it');
 expect(out.length).toBeLessThanOrEqual(MAX);
 });

 it('keeps multi-slug jobs distinct via disambiguator inside the 66-char cap', () => {
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
