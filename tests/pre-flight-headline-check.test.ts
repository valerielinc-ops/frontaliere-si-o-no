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
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tokenizeIt, jaccardSim, containmentSim } from '../scripts/lib/it-text-similarity.mjs';
import { filterDistinctive } from '../scripts/lib/dup-stoplist.mjs';
import { readMetaFieldEntries } from '../scripts/lib/meta-field-regex.mjs';
import { readStaticMetaFieldEntries, readStaticMetaFields } from '../scripts/lib/meta-field-regex.mjs';

const ROOT = resolve(__dirname, '..');
const src = readFileSync(resolve(ROOT, 'scripts/create-article.mjs'), 'utf8');

function staticMetaModule(properties: string): string {
  return [
    'const blogMeta: Record<string, string> = {',
    properties,
    '};',
    'export default blogMeta;',
  ].join('\n');
}

function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const fnMatch = src.match(/function preFlightHeadlineCheck\(headline, titleMatches = readMetaFieldEntries\(readAllSectionsMetaIt\(\), 'title'\)\) \{[\s\S]*?\n\}\n/);
if (!fnMatch) throw new Error('preFlightHeadlineCheck not found in scripts/create-article.mjs');

type CheckResult =
  | { duplicate: false }
  | { duplicate: true; signal: string; sim: number; existingId: string; existingTitle: string };

// The function references `readAllSectionsMetaIt`, `tokenizeIt`, `jaccardSim`,
// `containmentSim`, `filterDistinctive`, and the shared token-aware
// `readStaticMetaFieldEntries` imported from scripts/lib/meta-field-regex.mjs
// rather than re-declared here. Inject them all: this harness lifts the function body
// out of
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
const readAllSectionsMetaIt = () => [{
  source: read('tests/__fixtures__/blog-meta-it-headline-check.ts'),
  sourcePath: 'tests/__fixtures__/blog-meta-it-headline-check.ts',
}];
const runner = new Function(
  'readAllSectionsMetaIt',
  'tokenizeIt',
  'jaccardSim',
  'containmentSim',
  'filterDistinctive',
  'readMetaFieldEntries',
  `${fnMatch[0]}\nreturn preFlightHeadlineCheck;`,
);
const preFlightHeadlineCheck = runner(
  readAllSectionsMetaIt,
  tokenizeIt,
  jaccardSim,
  containmentSim,
  filterDistinctive,
  readStaticMetaFieldEntries,
) as (headline: string) => CheckResult;

describe('readMetaFieldEntries', () => {
  it('ignores keys inside comments and prose strings', () => {
    const source = [
      "const note = `docs: 'blog.article.fake.title': 'not an entry'`;",
      '// \'blog.article.comment.title\': \'not an entry\'',
      'const blogMeta = {',
      "  'blog.article.real.title': 'Real title',",
      "  'blog.article.real.excerpt': 'Real excerpt',",
      '};',
    ].join('\n');

    expect(readMetaFieldEntries(source, 'title')).toEqual([{ id: 'real', value: 'Real title' }]);
  });

  it('rejects a matching value without a real member delimiter', () => {
    const source = [
      'const blogMeta = {',
      "  'blog.article.fake.title': 'not an entry' followed by prose",
      '};',
    ].join('\n');

    expect(() => readMetaFieldEntries(source, 'title')).toThrow(/member delimiter/u);
  });

  it('fails closed on a dynamic matching value', () => {
    const source = "const blogMeta = { 'blog.article.fake.title': getTitle(), };";
    expect(() => readMetaFieldEntries(source, 'title')).toThrow(/static string value/u);
  });
});

describe('readStaticMetaFieldEntries', () => {
  it('parses full modules independently and preserves module and property order', () => {
    const first = staticMetaModule([
      "  'blog.article.shared.title': 'Frontaliere title',",
      "  'blog.article.shared.excerpt': 'Frontaliere excerpt',",
    ].join('\n'));
    const second = staticMetaModule([
      "  'blog.article.shared.title': 'Svizzera title',",
      "  'blog.article.other.title': 'Other title',",
    ].join('\n'));

    expect(readStaticMetaFieldEntries([
      { source: first, sourcePath: 'blog-meta-it.ts' },
      { source: second, sourcePath: 'blog-meta-ch-it.ts' },
    ], 'title')).toEqual([
      { id: 'shared', value: 'Frontaliere title' },
      { id: 'shared', value: 'Svizzera title' },
      { id: 'other', value: 'Other title' },
    ]);
  });

  it('rejects a malformed later module instead of returning earlier entries', () => {
    const valid = staticMetaModule("  'blog.article.valid.title': 'Valid title',");
    const malformed = `${staticMetaModule("  'blog.article.valid.title': 'Valid title',")}\nconst broken = ;`;

    expect(() => readStaticMetaFieldEntries([
      { source: valid, sourcePath: 'blog-meta-it.ts' },
      { source: malformed, sourcePath: 'blog-meta-ch-it.ts' },
    ], 'title')).toThrow(/TypeScript syntax error.*blog-meta-ch-it\.ts/u);
  });

  it('fails closed on a dynamic value anywhere in a present metadata module', () => {
    const source = staticMetaModule([
      "  'blog.article.valid.title': 'Valid title',",
      "  'blog.article.valid.excerpt': makeExcerpt(),",
    ].join('\n'));

    expect(() => readStaticMetaFieldEntries({ source, sourcePath: 'blog-meta-it.ts' }, 'title'))
      .toThrow(/static string literal value/u);
  });

  it('allows callers to represent an intentionally missing module as no input', () => {
    expect(readStaticMetaFieldEntries([], 'title')).toEqual([]);
  });

  it('projects multiple fields from the same ordered module entries', () => {
    const source = staticMetaModule([
      "  'blog.article.first.title': 'First title',",
      "  'blog.article.first.excerpt': 'First excerpt',",
      "  'blog.article.second.title': 'Second title',",
      "  'blog.article.second.excerpt': 'Second excerpt',",
    ].join('\n'));

    expect(readStaticMetaFields({ source, sourcePath: 'blog-meta-it.ts' }, ['title', 'excerpt']))
      .toEqual({
        title: [
          { id: 'first', value: 'First title' },
          { id: 'second', value: 'Second title' },
        ],
        excerpt: [
          { id: 'first', value: 'First excerpt' },
          { id: 'second', value: 'Second excerpt' },
        ],
      });
  });

  it('parses each source module once when projecting multiple fields', () => {
    const compilerShim = resolve(ROOT, 'tests/__fixtures__/counting-typescript.cjs');
    const readerPath = resolve(ROOT, 'scripts/lib/meta-field-regex.mjs');
    const childScript = `
      const paths = [];
      globalThis.__articleSourceParsePaths = paths;
      process.env.ARTICLE_SOURCE_TYPESCRIPT = ${JSON.stringify(compilerShim)};
      const { pathToFileURL } = await import('node:url');
      const { readStaticMetaFields } = await import(pathToFileURL(${JSON.stringify(readerPath)}));
      const source = (id) => [
        'const blogMeta: Record<string, string> = {',
        "  'blog.article." + id + ".title': 'Title',",
        "  'blog.article." + id + ".excerpt': 'Excerpt',",
        '};',
        'export default blogMeta;',
      ].join('\\n');
      const result = readStaticMetaFields([
        { source: source('first'), sourcePath: 'first.ts' },
        { source: source('second'), sourcePath: 'second.ts' },
      ], ['title', 'excerpt']);
      process.stdout.write(JSON.stringify({ paths, result }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', childScript], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const output = JSON.parse(child.stdout);
    expect(output.paths).toEqual(['first.ts', 'second.ts']);
    expect(output.result).toEqual({
      title: [
        { id: 'first', value: 'Title' },
        { id: 'second', value: 'Title' },
      ],
      excerpt: [
        { id: 'first', value: 'Excerpt' },
        { id: 'second', value: 'Excerpt' },
      ],
    });
  });
});

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
