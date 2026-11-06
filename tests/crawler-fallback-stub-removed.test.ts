/**
 * Only the source's own text is published (issue 5253, lot P part 1 — the
 * "fallbackDesc" class): when a posting had no body, or one under a local
 * character/word threshold, these parsers published a stand-in they wrote
 * themselves — "<title> — <company>, <place>", "<title> — Stelle bei … +
 * company paragraph", "<title> — open position at …", "<company> — Stelle in
 * <city>". Now a body under the common 50-word floor gives no description: the
 * shared pipeline keeps the body stored from an earlier read of the source
 * (the locale-preserving merge) or quarantines the posting (thin-source path),
 * and the posting keeps its slug.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllAdusKlinikJobs } from '../scripts/lib/adus-klinik-job-parser.mjs';
import { fetchAllTetherJobs } from '../scripts/lib/tether-job-parser.mjs';
import { HILTI_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/hilti-job-parser.mjs';
import { HESS_CARROSSERIE_FABRICATED_DESCRIPTION_RE } from '../scripts/lib/hess-carrosserie-job-parser.mjs';
import { dropFabricatedDescription } from '../scripts/lib/drop-fabricated-description.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = (file: string) => fs.readFileSync(path.join(__dirname, '..', 'scripts', ...file.split('/')), 'utf8');
const fixture = (file: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'crawler-fallback-stub', file), 'utf8');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ADUS Klinik (Teamtailor RSS)', () => {
  // Minimised live feed (2026-09-29): one real item, and the same item with
  // its body cut under the floor.
  const rss = fixture('adus-klinik-jobs.rss');

  it('publishes the feed body, the clinic paragraph included, as it is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rss, { status: 200 })));
    const [real] = await fetchAllAdusKlinikJobs();
    expect(real.description).toContain('Belegarztspital im Zürcher Unterland');
    expect(real.description).not.toMatch(/ — Stelle bei der ADUS Klinik in /);
    expect(real.descriptionByLocale).toEqual({ [real.sourceLang]: real.description });
  });

  it('writes no text of its own for a body under the floor, and keeps the slug', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(rss, { status: 200 })));
    const [, thin] = await fetchAllAdusKlinikJobs();
    expect(thin.description).toBe('');
    expect(thin.descriptionByLocale).toEqual({ [thin.sourceLang]: '' });
    expect(thin.slug).toMatch(/-adus-klinik-dielsdorf$/);
  });
});

describe('Tether (Recruitee)', () => {
  // Minimised live offers (2026-09-29): one real offer, and one with the
  // body sections cut under the floor.
  const offers = fixture('tether-offers.json');

  it('publishes the offer sections and writes no text of its own under the floor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(offers, { status: 200, headers: { 'content-type': 'application/json' } })));
    const jobs = await fetchAllTetherJobs();
    expect(jobs).toHaveLength(2);
    const [real, thin] = jobs;
    expect(real.description.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    expect(thin.description).toBe('');
    expect(thin.descriptionByLocale).toEqual({ [thin.sourceLang]: '' });
    for (const job of jobs) expect(job.description).not.toMatch(/open position at Tether Operations/);
  });
});

describe('stored rows with the old stand-in are cleared before the merge', () => {
  // The stored rows on main (2026-09-29): hilti 1/9, hess-carrosserie 1/32.
  it.each([
    ['hilti', HILTI_FABRICATED_DESCRIPTION_RE, 'Quereinsteiger aus der Baubranche/Technischer Berater Grossraum Luzern (m/w/d) (100% oder Jobsharing 50-70% möglich) — Hilti'],
    ['hess-carrosserie', HESS_CARROSSERIE_FABRICATED_DESCRIPTION_RE, 'Inbetriebnahmespezialist "Hot Commissioning" 80-100% (m/w/d) bei Carrosserie HESS AG in Bellach. HESS ist der Schweizer Pionier im Fahrzeugbau (Bus- und Nutzfahrzeugbau) mit Sitz in Bellach (SO).'],
  ])('%s', (_key, pattern, text) => {
    const job = { sourceLang: 'de', description: text, descriptionByLocale: { de: text, it: 'Traduzione del testo del crawler' } };
    expect(dropFabricatedDescription(job, pattern)).toBe(true);
    expect(job.description).toBe('');
    expect(job.descriptionByLocale).toEqual({});
    expect((job as any).needsRetranslation).toBe(true);
  });

  it('leaves a real posting alone, even one quoting the same company line', () => {
    // hess-carrosserie: the live ads open with "HESS - Der Schweizer Pionier im Fahrzeugbau".
    const hess = 'Carrosseriespengler (m/w/d | 100%)\n\nHESS - Der Schweizer Pionier im Fahrzeugbau\nDie Carrosserie Rothenburg ist eine Zweigniederlassung der HESS AG, einem der führenden Schweizer Fahrzeugbauer. HESS ist der Schweizer Pionier im Fahrzeugbau (Bus- und Nutzfahrzeugbau) mit Sitz in Bellach (SO).';
    const hilti = 'Technischer Berater — Hilti\n\nIhre Aufgaben: Beratung unserer Kunden auf Baustellen im Raum Luzern.';
    for (const [pattern, text] of [[HESS_CARROSSERIE_FABRICATED_DESCRIPTION_RE, hess], [HILTI_FABRICATED_DESCRIPTION_RE, hilti]] as const) {
      const job = { sourceLang: 'de', description: text, descriptionByLocale: { de: text, it: 'Traduzione' } };
      expect(dropFabricatedDescription(job, pattern)).toBe(false);
      expect(job.descriptionByLocale).toEqual({ de: text, it: 'Traduzione' });
    }
  });
});

// The parsers build the description inside their fetch loop (network,
// Playwright): guard the removed stand-in and the shared floor on the body.
// kellerhals-carrard, spital-thurgau, fondation-soins-lausanne and ksml assert
// the behaviour in their own tests too.
describe('no crawler-written stand-in, and the common 50-word floor', () => {
  it.each([
    ['lib/adus-klinik-job-parser.mjs', /fallbackDesc|Stelle bei der ADUS Klinik in|Seit 2025 Teil der Epiona Gruppe/],
    ['lib/fondation-soins-lausanne-job-parser.mjs', /buildFallbackDescription|un poste à pourvoir au sein de la/],
    ['lib/kellerhals-carrard-job-parser.mjs', /fallbackDesc|`\$\{title\} — Stelle bei Kellerhals Carrard/],
    ['lib/ksml-job-parser.mjs', /fallbackDesc|Publiziert auf dem Kantonalen Stellenmarkt|Publié sur le marché cantonal/],
    ['lib/tether-job-parser.mjs', /fallbackDesc|open position at Tether/],
    ['lib/hilti-job-parser.mjs', /descriptionText \|\| `\$\{title\} — \$\{HILTI_COMPANY_NAME\}`/],
    ['lib/hess-carrosserie-job-parser.mjs', /descriptionText \|\|\s*`\$\{title\} bei \$\{HESS_CARROSSERIE_COMPANY_NAME\}/],
    ['lib/spital-thurgau-job-parser.mjs', /`\$\{title\} — \$\{SPITAL_THURGAU_COMPANY_NAME\}/],
  ])('%s', (file, pattern) => {
    const text = source(file);
    expect(text).not.toMatch(pattern);
    expect(text).toMatch(/meetsSourceBodyFloor\(/);
  });
});
