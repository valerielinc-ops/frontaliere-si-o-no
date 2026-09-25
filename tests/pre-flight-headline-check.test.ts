/**
 * Regression tests for preFlightHeadlineCheck in scripts/create-article.mjs.
 *
 * Background: in May 2026 the auto-generate workflow burned 6 LLM cycles
 * on the news "Salario minimo Ticino 4000 dal 2029" because the URL dedup
 * passed (different source URL than the original news 2 weeks earlier)
 * but the title-collision gate hard-failed at the very end. This filter
 * catches semantic duplicates BEFORE the LLM cycles run, using
 * Italian-stemmed containment against existing article-ID slugs.
 *
 * Threshold tuning anchors:
 *   - identical / rephrased headlines → containment 0.75-1.00 → caught
 *   - unrelated headlines → 0 or below threshold → passed through
 *   - ID slugs <4 distinctive tokens are skipped to avoid stem-collision
 *     false positives (e.g. "capit" stems both "capitano" and "capitale").
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenizeIt, jaccardSim, containmentSim } from '../scripts/lib/it-text-similarity.mjs';
import { filterDistinctive } from '../scripts/lib/dup-stoplist.mjs';
import { metaFieldRegex, unescapeTsValue } from '../scripts/lib/meta-field-regex.mjs';

const ROOT = resolve(__dirname, '..');
const src = readFileSync(resolve(ROOT, 'scripts/create-article.mjs'), 'utf8');

function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const fnMatch = src.match(/function preFlightHeadlineCheck\(headline\) \{[\s\S]*?\n\}\n/);
if (!fnMatch) throw new Error('preFlightHeadlineCheck not found in scripts/create-article.mjs');

type CheckResult =
  | { duplicate: false }
  | { duplicate: true; signal: string; sim: number; existingId: string; existingTitle: string };

// The function references `readAllSectionsMetaIt`, `tokenizeIt`, `jaccardSim`,
// `containmentSim`, `filterDistinctive`, and — since the quote-safe extractor
// consolidation (#4881) — the shared `metaFieldRegex` / `unescapeTsValue`
// pair, imported from scripts/lib/meta-field-regex.mjs rather than re-declared
// here (a local copy would let the script regress while this suite stays
// green — the very drift the consolidation closed). Inject them all: this harness lifts the function body out of
// create-article.mjs by regex, so every free identifier it gains has to be
// mirrored here or the whole suite fails with a ReferenceError rather than a
// meaningful assertion. Since 2026-07-11 the
// meta seam is cross-section (readAllSectionsMetaIt → both blog-meta-it.ts and
// blog-meta-ch-it.ts) so a sibling-section twin is caught too. The dedup
// contract under test is unchanged; injecting the frontaliere reader alone
// keeps these fixtures deterministic (the frontaliere corpus is the one they
// were tuned against).
// Corpus PINNATO, non quello vivo.
//
// Questa riga leggeva `services/locales/blog-meta-it.ts`, cioe' i 3'457 titoli
// che la pipeline pubblica ogni giorno. Una suite che legge dati vivi non e'
// riproducibile e non e' CI: la stessa identica revisione passava alle 15:47 e
// falliva alle 18:38 perche' nel frattempo era uscito un articolo che collideva
// con uno dei titoli «unrelated» qui sotto — su una PR che non toccava nulla di
// tutto cio'. Il file portava gia' la cicatrice di un giro precedente dello
// stesso problema (vedi il commento «Cathedral 2026-05-10» piu' sotto), sanato
// spostando il titolo invece della causa.
//
// La fixture contiene voci reali nella forma reale, incluso il cluster
// `salario-minimo` su cui poggiano i test di deduplica, ma ferme: il verde
// dipende dal codice e non da cosa e' stato pubblicato stanotte.
const readAllSectionsMetaIt = () => read('tests/__fixtures__/blog-meta-it-headline-check.ts');
const runner = new Function(
  'readAllSectionsMetaIt',
  'tokenizeIt',
  'jaccardSim',
  'containmentSim',
  'filterDistinctive',
  'metaFieldRegex',
  'unescapeTsValue',
  `${fnMatch[0]}\nreturn preFlightHeadlineCheck;`,
);
const preFlightHeadlineCheck = runner(
  readAllSectionsMetaIt,
  tokenizeIt,
  jaccardSim,
  containmentSim,
  filterDistinctive,
  metaFieldRegex,
  unescapeTsValue,
) as (headline: string) => CheckResult;

describe('preFlightHeadlineCheck', () => {
  describe('catches semantic duplicates of existing articles', () => {
    it('catches the May 2026 "salario minimo 4000 dal 2029" recurrence (identical wording)', () => {
      const r = preFlightHeadlineCheck('Salario minimo Ticino: 4000 franchi dal 2029');
      expect(r.duplicate).toBe(true);
      if (!r.duplicate) return;
      expect(r.existingId).toMatch(/salario-minimo/);
      expect(r.sim).toBeGreaterThanOrEqual(0.75);
    });

    it('catches the same news rephrased ("Gran Consiglio approva il compromesso")', () => {
      const r = preFlightHeadlineCheck(
        'Salario minimo, Gran Consiglio approva il compromesso: 4000 franchi dal 2029',
      );
      expect(r.duplicate).toBe(true);
      if (!r.duplicate) return;
      expect(r.existingId).toMatch(/salario-minimo/);
    });

    it('catches reordered headline ("Ticino, salario minimo a 4000 al mese...")', () => {
      const r = preFlightHeadlineCheck('Ticino, salario minimo a 4000 franchi al mese dal 2029');
      expect(r.duplicate).toBe(true);
    });

    it('catches a different angle on the same topic', () => {
      const r = preFlightHeadlineCheck(
        'Frontalieri Ticino: ecco quanto guadagneranno con il salario minimo a 4000',
      );
      expect(r.duplicate).toBe(true);
    });
  });

  describe('passes through genuinely unrelated headlines', () => {
    it('does not match an unrelated road-incident headline', () => {
      // Cathedral 2026-05-10: A new article about the exact Fornasette incident was
      // published (incidente-fornasette-2026-ribaltamento-auto), making the old headline
      // a legitimate duplicate. Replaced with a genuinely unrelated headline.
      const r = preFlightHeadlineCheck('Valichi di frontiera: code rallentate per lavori in corso');
      expect(r.duplicate).toBe(false);
    });

    it('does not match a generic borderline evergreen ("Permesso B vs G")', () => {
      // Existing `apprendisti-frontalieri-permessi-g` is about apprentices, not B-vs-G.
      // The 4-token-min on the ID slug skips this 3-token ID and avoids false positive.
      const r = preFlightHeadlineCheck('Permesso B differenze con G per i frontalieri');
      expect(r.duplicate).toBe(false);
    });

    it('does not match a brand-new news topic', () => {
      const r = preFlightHeadlineCheck('Trenord, lunedì sciopero di 24 ore: i treni garantiti');
      expect(r.duplicate).toBe(false);
    });

    it('does not match a specific market-data story', () => {
      const r = preFlightHeadlineCheck('Affitti a Lugano in calo del 5% nel primo trimestre 2026');
      expect(r.duplicate).toBe(false);
    });
  });

  describe('skips short headlines (insufficient signal)', () => {
    it('returns no-duplicate for headlines with <3 distinctive tokens', () => {
      const r = preFlightHeadlineCheck('Eccezionale');
      expect(r.duplicate).toBe(false);
    });
  });
});
