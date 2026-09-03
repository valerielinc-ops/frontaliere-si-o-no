import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SF_J2W_WIDGET_PATTERNS,
  hasSuccessFactorsMoreLocations,
  isSuccessFactorsWidgetText,
  sanitizeSuccessFactorsField,
  stripSuccessFactorsMoreLocations,
} from '../scripts/lib/successfactors-jobs2web-widget-guard.mjs';

/**
 * Guard against SAP SuccessFactors jobs2web page chrome being scraped as job
 * content.
 *
 * Background: on 2026-08-24 thirteen Schindler postings were live with a title
 * taken from the page around them instead of from the posting — eleven titled
 * "Manager für Cookie-Einwilligungen" (the cookie-consent widget's <h2>, the
 * only <h2> on the SBB-tenant detail pages, reached through the parser's
 * `<h1 class="job-title">` → `<h2>` fallback chain) and two titled
 * "[[Title]] à Le Mont-sur-Lausanne" (an unrendered career-site token). Three
 * parsers already carried private copies of a `GARBAGE` list against this, all
 * three applied to `description` only, never to `title`.
 */
describe('SuccessFactors jobs2web widget guard', () => {
  describe('rejects page chrome', () => {
    // Exactly the strings that reached production, in every locale the j2w
    // sites serve. These are regression anchors: if one stops matching, the
    // 2026-08-24 incident can recur verbatim.
    const shipped = [
      'Manager für Cookie-Einwilligungen',
      'Cookie consent manager',
      'Gestionnaire de consentements pour les cookies',
      'Gestore consenso ai cookie',
      'Gestione delle autorizzazioni dei cookie',
      '[[Title]] à Le Mont-sur-Lausanne',
      '[[Titel]] in Le Mont-sur-Lausanne',
      '[[Title] a Le Mont-sur-Lausanne', // observed with an unbalanced bracket
    ];
    for (const text of shipped) {
      it(`flags ${JSON.stringify(text)}`, () => {
        expect(isSuccessFactorsWidgetText(text)).toBe(true);
      });
    }

    // The other two j2w widgets, covered by the three pre-existing per-file
    // GARBAGE arrays this module replaces.
    const widgets = [
      'Suche nach Stichwort',
      'Search by keyword',
      'Recherche par mot-clé',
      'Ricerca per parola chiave',
      'Benachrichtigung erstellen',
      'Create Alert',
      'Créer une alerte',
      'Crea un avviso',
      'Select how often (in days) to receive an alert:',
      'Wählen Sie aus, wie oft (in Tagen) Sie eine Benachrichtigung erhalten möchten:',
    ];
    for (const text of widgets) {
      it(`flags ${JSON.stringify(text)}`, () => {
        expect(isSuccessFactorsWidgetText(text)).toBe(true);
      });
    }
  });

  describe('does not flag genuine postings', () => {
    // Every entry below is a REAL title from the live dataset. The first two
    // are the traps that a naive substring list walks into, and both were
    // caught by sweeping the corpus rather than by reading the patterns:
    //   - "RF De(sign In)gegnere" contains "sign in"
    //   - Otis publishes six evergreen reqs literally named "Talent Community …"
    const realTitles = [
      'RF Design Engineer (m/f/d)',
      'RF Design Ingegnere (m/f/d)',
      'RF Design Ingenieur (m/f/d)',
      'RF Design Ingénieur (m/f/d)',
      'Talent Community St.Gallen - Aufzug Monteur/Reparateur/Servicetechniker (m/w/d)',
      'Talent Community Bern - Aufzug Monteur/Reparateur/Servicetechniker (m/w/d)',
      'Schnupperlehre als Polymechaniker*in EFZ mit Schwerpunkt Liftmontage (Lehrstart 2027)',
      'Lehrstelle als Anlagen- und Apparatebauer*in EFZ für 2027',
      "Apprentissage d'Employé-e de commerce CFC pour 2027",
      'Apprendistato Elettronico/a AFC per il 2027',
      'Legal Counsel Transactions Competition Law (m/f/d) 80-100%',
      'Global Communications Manager (m/f/d) 80-100 %',
      'Recruiter (m/f/d) 100%',
      'Working Student IT Application Support (m/w/d) 50-60%',
      'Sustainability Trainee (m/f/d) 80-100%',
      'Data Privacy Officer',
      'Consultant Cyber Security',
      'Responsabile marketing digitale',
    ];
    for (const title of realTitles) {
      it(`keeps ${JSON.stringify(title)}`, () => {
        expect(isSuccessFactorsWidgetText(title)).toBe(false);
      });
    }
  });

  describe('input handling', () => {
    it('treats absent or empty input as not-chrome', () => {
      // An absent field is a different problem from a contaminated one.
      // Conflating them would make callers drop rows that merely lack a value.
      for (const value of [undefined, null, '', '   ', 0, 42, {}, []]) {
        expect(isSuccessFactorsWidgetText(value as unknown as string)).toBe(false);
      }
    });

    it('sanitize blanks chrome and passes content through untouched', () => {
      expect(sanitizeSuccessFactorsField('Manager für Cookie-Einwilligungen')).toBe('');
      expect(sanitizeSuccessFactorsField('Recruiter (m/f/d) 100%')).toBe('Recruiter (m/f/d) 100%');
      expect(sanitizeSuccessFactorsField(undefined as unknown as string)).toBe('');
    });

    it('matches mid-string, not only at the start', () => {
      // The bleed arrives concatenated with real text as often as alone.
      expect(
        isSuccessFactorsWidgetText('Ihre Bewerbung Manager für Cookie-Einwilligungen Impressum'),
      ).toBe(true);
    });

    it('exposes a frozen pattern list', () => {
      // A consumer must not be able to mutate the list for every other crawler.
      expect(Object.isFrozen(SF_J2W_WIDGET_PATTERNS)).toBe(true);
      expect(SF_J2W_WIDGET_PATTERNS.length).toBeGreaterThan(20);
    });
  });

  describe('multi-location "+N more" marker', () => {
    it('keeps the visible office and drops the marker, entity-encoded or not', () => {
      // The Zurich Insurance run that failed closed read exactly this cell.
      expect(stripSuccessFactorsMoreLocations('Zürich, CH +1 more&hellip;')).toBe('Zürich, CH');
      expect(stripSuccessFactorsMoreLocations('Basel, CH +2 more…')).toBe('Basel, CH');
      expect(stripSuccessFactorsMoreLocations('Muttenz, CH, +3 weitere…')).toBe('Muttenz, CH');
      expect(stripSuccessFactorsMoreLocations('Genève, CH +1 autre…')).toBe('Genève, CH');
      expect(stripSuccessFactorsMoreLocations('Mendrisio +4 altri…')).toBe('Mendrisio');
    });

    it('leaves a single-office location untouched', () => {
      for (const value of ['Sierre, CH', 'Zürich, CH', 'Mendrisio', 'Route 66, CH']) {
        expect(stripSuccessFactorsMoreLocations(value)).toBe(value);
        expect(hasSuccessFactorsMoreLocations(value)).toBe(false);
      }
    });

    it('detects the marker in the raw row HTML too', () => {
      // benteler reads it off the whole `<tr>` block to flag rows whose hidden
      // office may be the Swiss one.
      expect(
        hasSuccessFactorsMoreLocations(
          '<span class="jobLocation">Paderborn, DE <small class="nobr">+1 more&hellip;</small></span>',
        ),
      ).toBe(true);
    });

    it('treats non-string input as marker-free and yields an empty string', () => {
      for (const value of [undefined, null, 0, {}, []]) {
        expect(hasSuccessFactorsMoreLocations(value as unknown as string)).toBe(false);
        expect(stripSuccessFactorsMoreLocations(value as unknown as string)).toBe('');
      }
    });
  });

  /**
   * The gate that actually keeps this fixed.
   *
   * Every jobs2web parser must route its title through the shared guard. A new
   * crawler copy-pasted from an old one is the exact way the three private
   * GARBAGE arrays came about, so assert the wiring rather than trusting it.
   */
  describe('every jobs2web parser is wired to the shared guard', () => {
    const libDir = join(__dirname, '..', 'scripts', 'lib');
    const GUARD_MODULE = 'successfactors-jobs2web-widget-guard.mjs';

    const jobs2webParsers = readdirSync(libDir)
      .filter((f) => f.endsWith('.mjs'))
      .filter((f) => f !== GUARD_MODULE)
      .filter((f) => {
        const src = readFileSync(join(libDir, f), 'utf8');
        // The signature of a hand-rolled j2w scraper. `successfactors-client`
        // and `shared-jobs-crawler` are infrastructure, not scrapers, and
        // `jobposting-jsonld` reads structured data rather than page chrome.
        if (/^(successfactors-client|shared-jobs-crawler|jobposting-jsonld)/.test(f)) return false;
        // Ignore the token where it only appears inside a comment (medartis is
        // a config wrapper that delegates all parsing to the shared CSB module).
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        return code.includes('jobTitle-link');
      });

    it('finds the known jobs2web parser population', () => {
      // Fails loudly if a new j2w parser lands, so it gets wired up too.
      expect(jobs2webParsers.length).toBeGreaterThanOrEqual(17);
    });

    for (const file of jobs2webParsers) {
      it(`${file} imports the shared guard`, () => {
        const src = readFileSync(join(libDir, file), 'utf8');
        expect(src).toContain(GUARD_MODULE);
      });

      it(`${file} keeps no private copy of the widget list`, () => {
        const src = readFileSync(join(libDir, file), 'utf8');
        // The drifted duplicate this module exists to delete.
        expect(src).not.toMatch(/const\s+GARBAGE\s*=\s*\[/);
      });
    }
  });

  /**
   * Follow-up of #6370 (tracked as #6393): the 151'598-record corpus sweep in
   * that PR body validated the pattern set only against title/titleByLocale.
   * `sanitizeSuccessFactorsField` wipes the ENTIRE field on any match, and it
   * is wired to `description`/`descriptionByLocale` in every parser below —
   * a genuine posting whose description legitimately contains a matched
   * phrase (e.g. a DPO/privacy role mentioning "Cookie-Einstellungen", or
   * footnote-style `[[1]]` markup) would lose its whole body, not just the
   * offending sentence.
   *
   * Swept the live `data/jobs/by-crawler/*.json` slices (which, unlike the
   * assembled `data/jobs.json`, are checked in and always present) for every
   * crawler whose parser routes description/descriptionByLocale through
   * `sanitizeSuccessFactorsField` — found via `grep -n
   * "sanitizeSuccessFactorsField" scripts/lib/*.mjs | grep -i descri` plus
   * the 15 tenants sharing `successfactors-shared-job-parser-common.mjs`
   * (`parseCsbDetailPage`, which applies the same guard to `descriptionText`).
   *
   * Result on 2026-08-24: 2'345 records across 31 crawlers (`benteler` has
   * zero live jobs), 2'345 with a non-empty description, 0 empty. An empty
   * description is the only observable signature of a wipe having fired —
   * sanitizeSuccessFactorsField returns '' on a match, nothing else does for
   * these fields — so zero empties means the wipe has never fired on this
   * corpus: no false positive to fix, and the claim "verified" becomes true
   * instead of presumed. This test pins that finding as a regression anchor:
   * if a future pattern addition starts wiping real descriptions, existing
   * records flip from non-empty to empty and this test goes red.
   */
  describe('description-field corpus sweep (issue #6393)', () => {
    const dataDir = join(__dirname, '..', 'data', 'jobs', 'by-crawler');

    // Every crawlerKey whose parser applies sanitizeSuccessFactorsField to
    // description/descriptionByLocale (title-only wiring, e.g. aldi-suisse,
    // is out of scope — its fallback to listing.title makes a title wipe
    // safe by design, per the module's own doc comment).
    const descriptionGuardedKeys = [
      'benteler', 'clariant', 'constellium', 'epfl', 'hirslanden', 'holcim',
      'liebherr', 'patek-philippe', 'rolex', 'schindler', 'sonova',
      'stadler-rail', 'stadt-zuerich', 'damiani-group', 'prada', 'rapelli',
      'skyguide-sa',
      // Tenants on the shared successfactors-shared-job-parser-common.mjs
      // CSB parser (parseCsbDetailPage), same guard wiring.
      'bachem', 'breitling', 'etat-de-fribourg', 'endress-hauser', 'helsana',
      'groupe-e', 'hoch-health', 'idorsia', 'medartis', 'octapharma',
      'sicpa', 'six-group', 'tecan', 'tl-lausanne', 'zurzach-care',
    ];

    it('has zero empty descriptions across the description-guarded crawlers', () => {
      let recordsWithDescription = 0;
      let emptyDescriptionFields = 0;
      let recordsSeen = 0;

      for (const key of descriptionGuardedKeys) {
        const file = join(dataDir, `${key}.json`);
        let raw;
        try {
          raw = readFileSync(file, 'utf8');
        } catch {
          continue; // A crawler with zero current jobs writes no slice file.
        }
        const parsed = JSON.parse(raw);
        const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
        if (!Array.isArray(jobs)) continue;

        for (const job of jobs) {
          recordsSeen++;
          const fields = [job.description, ...Object.values(job.descriptionByLocale || {})];
          for (const value of fields) {
            if (typeof value !== 'string') continue;
            if (value.trim()) recordsWithDescription++;
            else emptyDescriptionFields++;
          }
        }
      }

      // Sanity: the sweep actually covered a meaningful corpus, not an
      // accidentally-empty data directory.
      expect(recordsSeen).toBeGreaterThan(1000);
      expect(recordsWithDescription).toBeGreaterThan(1000);
      expect(emptyDescriptionFields).toBe(0);
    });

    it('has no residual widget-pattern match in a live description field', () => {
      // Defence in depth alongside the empty-field check above: even if a
      // future refactor made sanitizeSuccessFactorsField non-idempotent (or
      // a caller stopped routing description through it), no description
      // currently shipped should still contain page chrome.
      let checked = 0;
      for (const key of descriptionGuardedKeys) {
        const file = join(dataDir, `${key}.json`);
        let raw;
        try {
          raw = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        const parsed = JSON.parse(raw);
        const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
        if (!Array.isArray(jobs)) continue;

        for (const job of jobs) {
          const fields = [job.description, ...Object.values(job.descriptionByLocale || {})];
          for (const value of fields) {
            if (typeof value !== 'string' || !value.trim()) continue;
            checked++;
            expect(isSuccessFactorsWidgetText(value)).toBe(false);
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
    });
  });
});
