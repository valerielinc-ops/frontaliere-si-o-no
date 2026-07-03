import { describe, expect, it } from 'vitest';
import {
 safeIsoDate,
 composeJobPageTitle,
 composeJobPageH1,
 pickJobDisambiguator,
 fnv8,
 titleCompareKey,
} from '../build-plugins/jobsSeoPagesPlugin';
import { composeSerpJobTitle, truncateHeadline, TITLE_MAX_CHARS, TITLE_BRAND_SUFFIX } from '../build-plugins/shared/titleSuffix';
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

describe('composeSerpJobTitle measureLength (#3402: disambiguator-branch escape-budget gap)', () => {
 // Follow-up from PR #3365's adversarial check: the internal recursive
 // buildTitleWithBrand call at titleSuffix.ts:286 (the disambiguator branch)
 // did not forward measureLength, so the brand-append decision was always
 // budgeted on the RAW (pre-escape) length even for callers whose composed
 // title is later HTML-escaped exactly once (jobsSeoPagesPlugin.ts's
 // `<title>${esc(title)}</title>`). A company/role/city containing `&`
 // expands by 4 chars on escape ("&" -> "&amp;"), which can silently push
 // an already-budgeted title past the 66-char cap post-escape.
 const esc = (s: string): string => s
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;');
 const role = 'Addetto vendite senior';
 const company = 'C&A';
 const city = 'Lugano';
 const disambiguator = '80%';

 it('without measureLength (raw default): brand is appended but the escaped title overflows the cap', () => {
 const out = composeSerpJobTitle(role, company, city, 'it', { disambiguator });
 expect(out.endsWith(TITLE_BRAND_SUFFIX)).toBe(true);
 expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 // The string that actually ships in <title>${esc(title)}</title> blows
 // the cap — this is the exact gap #3402 flagged for the reachable path.
 expect(esc(out).length).toBeGreaterThan(TITLE_MAX_CHARS);
 });

 it('with escape-aware measureLength: brand is dropped so the escaped title respects the cap', () => {
 const out = composeSerpJobTitle(role, company, city, 'it', {
 disambiguator,
 measureLength: (s) => esc(s).length,
 });
 expect(out.endsWith(TITLE_BRAND_SUFFIX)).toBe(false);
 expect(esc(out).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 });

 it('composeJobPageTitle wrapper forwards measureLength to the disambiguator branch (live call-site shape)', () => {
 const withoutFix = composeJobPageTitle(role, company, city, 'it', disambiguator);
 const withFix = composeJobPageTitle(role, company, city, 'it', disambiguator, undefined, (s) => esc(s).length);
 expect(esc(withoutFix).length).toBeGreaterThan(TITLE_MAX_CHARS);
 expect(esc(withFix).length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 });
});

describe('composeSerpJobTitle cityOptional (#1932: drop city on non-colliding pages)', () => {
 it('still keeps the city when the full "role — company a city" headline fits', () => {
 // cityOptional only changes behaviour on OVERFLOW; a fitting title is unchanged.
 const out = composeSerpJobTitle('Sviluppatore', 'Acme', 'Lugano', 'it', { cityOptional: true });
 expect(out).toBe('Sviluppatore — Acme a Lugano | Frontaliere Ticino');
 });

 it('drops the city tail during role truncation when the role itself overflows', () => {
 // role(75) > 66: even the bare role must be truncated. Mandatory-city keeps a
 // " a {city}" tail (shrinking the role further); cityOptional gives the whole
 // budget to the role so more of the keyword-rich role survives.
 const role = 'Specialista Senior Pianificazione Controllo Produzione Industriale Avanzata';
 const withCity = composeSerpJobTitle(role, '', 'Lugano', 'it');
 const dropped = composeSerpJobTitle(role, '', 'Lugano', 'it', { cityOptional: true });
 // Mandatory: truncated role + preserved city tail.
 expect(withCity).toMatch(/… a Lugano$/);
 expect(withCity.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 // Optional: truncated role, NO city tail, ending in a bare ellipsis.
 expect(dropped).toMatch(/…$/);
 expect(dropped).not.toContain('Lugano');
 expect(dropped.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 // The role fragment gets at least as much budget without the reserved tail.
 expect(dropped.length).toBeGreaterThanOrEqual(withCity.replace(' a Lugano', '').length);
 });

 it('keeps the full role verbatim (no "…") when role+city overflows but role fits', () => {
 // role(56) + " a Mendrisio"(12) = 68 > 66 but role alone (56) fits. The
 // standard mandatory cascade already drops to bare role here; cityOptional
 // produces the same clean, ellipsis-free role.
 const role = 'Responsabile Pianificazione e Controllo della Produzione';
 const dropped = composeSerpJobTitle(role, '', 'Mendrisio', 'it', { cityOptional: true });
 expect(dropped).toBe(role);
 expect(dropped).not.toContain('…');
 expect(dropped).not.toContain('Mendrisio');
 });

 it('prefers role — company over role a city when the city would overflow', () => {
 // "role — company"(54) fits, "role — company a city"(74) overflows, and
 // "role a city"(66) also fits. Mandatory-city keeps the city (drops company);
 // cityOptional keeps the company tail and drops the city instead.
 const role = 'Impiegato amministrativo logistica e magazzino';
 const mandatory = composeSerpJobTitle(role, 'Alpha', 'Castel San Pietro', 'it');
 const optional = composeSerpJobTitle(role, 'Alpha', 'Castel San Pietro', 'it', { cityOptional: true });
 expect(mandatory).toContain('Castel San Pietro');
 expect(mandatory).not.toContain('Alpha');
 expect(optional).toContain(`${role} — Alpha`);
 expect(optional).not.toContain('Castel San Pietro');
 expect(optional.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 });

 it('budgets a disambiguator before the optional-city cascade', () => {
 const out = composeSerpJobTitle('Sviluppatore', 'Acme', 'Lugano', 'it', { cityOptional: true, disambiguator: '80%' });
 expect(out).toContain(' · 80%');
 expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
 });

 it('KEEPS the city for a no-company job when "role a city" fits (reviewer 🔴)', () => {
 // No company → "role a city" is the only city-bearing candidate. cityOptional
 // must NOT strip the geo keyword when it fits the cap; the city is dropped
 // ONLY on overflow (covered by the long-role test above). Regression for the
 // #1932 reviewer finding (drop-when-fits geo regression).
 const out = composeSerpJobTitle('Operaio', '', 'Lugano', 'it', { cityOptional: true });
 expect(out).toBe('Operaio a Lugano | Frontaliere Ticino');
 expect(out).toContain('Lugano');
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
