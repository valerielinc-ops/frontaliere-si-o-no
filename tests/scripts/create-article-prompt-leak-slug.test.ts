import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * An article's URL must never carry the prompt's own placeholder.
 *
 * The generation schema shows the id field as
 * `"id": "kebab-case-3-5-words-max-40-chars"`. Models sometimes echo that
 * instead of replacing it — verbatim, or with the `kebab-case-` prefix glued to
 * a real slug. Four reached production as permanent public URLs:
 *
 *   /articoli-frontaliere/kebab-case-3-5-words-max-40-chars/
 *   /articoli-frontaliere/kebab-case-turismo-ticino/
 *   /articoli-frontaliere/kebab-case-ticino-nubifragio-grigioni/
 *   /articoli-frontaliere/kebab-case-rossi-bruxelles-ticino/
 *
 * The articles are fine — real titles, real content, 1000+ words. Only the URL
 * is wrong, which is the one part that cannot be corrected afterwards without a
 * redirect and a ranking reset, so it has to be caught before the write.
 *
 * Two legs guarded here: the generator strips the leak (id and per-locale
 * slugs), and no NEW article ships with such a slug. The four already live are
 * deliberately excluded — renaming an indexed URL costs more than it recovers,
 * and a slug migration in this repo has already lost 13% of a cluster once.
 *
 * ── Updated for issue #5334 ──────────────────────────────────────────────
 *
 * The first version of the guard knew one literal, `^kebab-case-`, which was
 * enough for the four slugs that had already leaked and nothing else: the same
 * instruction reworded ("lowercase, hyphen-separated, max 40 chars") leaks
 * different words in a different position and walked straight through. The
 * pattern list now lives in `scripts/lib/slug-prompt-leak-guard.mjs`, shared by
 * the generator, the exported slug derivation and `audit-slug-prompt-leaks.mjs`,
 * and the leak is a hard THROW before the first file write rather than a strip
 * that only ever ran on the AI path. Behavioural coverage of the list itself is
 * in `tests/article-slug-prompt-leak-guard.test.ts`; what stays here is the
 * wiring — that create-article.mjs actually calls it.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const createArticle = fs.readFileSync(path.join(ROOT, 'scripts', 'create-article.mjs'), 'utf-8');

/** The four that predate the guard; not a licence to add more. */
const GRANDFATHERED = new Set([
  'kebab-case-3-5-words-max-40-chars',
  'kebab-case-turismo-ticino',
  'kebab-case-ticino-nubifragio-grigioni',
  'kebab-case-rossi-bruxelles-ticino',
]);

describe('article slugs never carry the prompt placeholder (#4974)', () => {
  it('create-article.mjs strips the leak from the id', () => {
    expect(
      createArticle,
      'the id guard is gone — a model echoing the schema placeholder would ' +
        'publish it as a permanent URL again',
    ).toContain("from './lib/slug-prompt-leak-guard.mjs'");
    const idGuard = createArticle.slice(createArticle.indexOf('The prompt shows the id field as'));
    expect(idGuard.slice(0, 2200)).toMatch(/findSlugPromptLeak\(data\.id\)/);
    expect(idGuard.slice(0, 2200)).toMatch(/stripSlugPromptLeak\(data\.id\)/);
  });

  it('create-article.mjs strips the leak from the per-locale slugs', () => {
    // The IT slug is assigned from the id, so it inherits the id guard; en/de/fr
    // come straight from the model and need their own.
    const sanitizer = createArticle.slice(createArticle.indexOf('Sanitize ALL locale slugs'));
    expect(
      sanitizer.slice(0, 1800),
      'the en/de/fr slug sanitizer no longer strips the prompt template',
    ).toContain('stripSlugPromptLeak(data.slugs[locale])');
  });

  it('refuses to WRITE a contaminated slug, not merely to strip one', () => {
    // The strip is a courtesy: it recovers a good article whose id was spoiled.
    // The guarantee is the throw, and it has to sit in modifyRouterTs because
    // that is the first file writer on BOTH registration paths — main()'s AI
    // flow and registerArticleFiles() for the journalist/digest callers.
    // Guarding one caller would leave the other exactly as unprotected as
    // everything was when the four leaked slugs shipped.
    const writer = createArticle.slice(createArticle.indexOf('function modifyRouterTs(data) {'));
    expect(
      writer.slice(0, 2000),
      'modifyRouterTs no longer asserts on the slug — a leak can reach routerBlogData.ts again',
    ).toContain('assertNoSlugPromptLeak');

    const derive = createArticle.slice(createArticle.indexOf('export function deriveAndSanitizeArticleSlugs'));
    expect(
      derive.slice(0, 2000),
      'the exported derivation (publish-journalist-article.mjs calls it directly) no longer asserts',
    ).toContain('assertNoSlugPromptLeak');
  });

  it('no new article ships with a placeholder slug', () => {
    const slugData = fs.readFileSync(
      path.join(ROOT, 'packages', 'articles', 'content', 'routerBlogData.ts'),
      'utf-8',
    );
    const offenders = [...slugData.matchAll(/["'](kebab-case-[a-z0-9-]+)["']/g)]
      .map((m) => m[1])
      .filter((s) => !GRANDFATHERED.has(s));

    expect(
      offenders,
      `new article slug(s) carrying the prompt placeholder: ${offenders.join(', ')}. ` +
        `The generator strips it — if one got through, the guard has a hole.`,
    ).toEqual([]);
  });
});

/**
 * SEO titles must not be cut mid-word.
 *
 * When the model omits the `seo` block — common with the smaller fallback
 * models — create-article.mjs synthesizes it from `content.it`. That branch
 * used a hard `.slice(0, 57)`, which lands wherever character 57 happens to
 * fall: "Incidente mortale a Porlezza: muore un | Frontaliere Ticino",
 * "Educatori in Germania: stipendi fino a | Frontaliere Ticino". 443 of the
 * 4552 titles in the corpus (9.7%) are cut that way, and the cut usually
 * removes exactly the part that would earn the click.
 *
 * `truncateAtWordBoundary` was already in the same file, used for the
 * description and the breadcrumb name four lines below. This call site simply
 * never got it.
 */
describe('SEO titles are truncated at word boundaries (#4974)', () => {
  it('the synthesized-seo branch uses truncateAtWordBoundary, not a hard slice', () => {
    // Window widened from 1600 to 2600: the branch now carries the #5515
    // review's rationale for de-hyphenating `data.id`, and `data.seo = {`
    // sits past the old cutoff.
    const branch = createArticle.slice(
      createArticle.indexOf('Synthesize seo from content.it'),
      createArticle.indexOf('Synthesize seo from content.it') + 2600,
    );
    expect(branch, 'the synthesized seo branch is gone or moved').toContain('data.seo = {');
    expect(
      branch,
      'the synthesized title/description are back to a hard slice — they will ' +
        'ship title tags cut mid-word again',
    ).not.toMatch(/\.slice\(0,\s*(57|160)\)/);
    // The title goes through the NON-EMPTY helper, not the plain one: its
    // fallback source is `data.id`, a spaceless slug, and the plain helper
    // refuses those with '' (#5452) — see the dedicated test below.
    expect(branch).toMatch(/truncateToClauseNonEmpty\(titleSource,\s*57\)/);
    expect(branch).toMatch(/truncateAtWordBoundary\(String\(it\.excerpt/);
  });

  it('truncateAtWordBoundary really stops at a word boundary', async () => {
    // Exercised through the real helper rather than re-implemented here.
    // create-article.mjs's truncateAtWordBoundary now delegates to the shared
    // build-plugins/shared/clauseTail.mjs (one implementation for the generator
    // AND the SERP render layer — AGENTS.md Non-Negotiable #6), so this imports
    // the real module instead of eval-ing a source slice: a source slice cannot
    // resolve the delegate's import, and testing the module is closer to what
    // actually ships than testing a re-parsed copy of it.
    const { truncateToClause } = await import('../../build-plugins/shared/clauseTail.mjs');
    const fn = truncateToClause as (t: string, n: number) => string;

    const long = 'Incidente mortale a Porlezza: muore un giovane motociclista di Como';
    const cut = fn(long, 57);
    expect(cut.length).toBeLessThanOrEqual(57);
    // The whole point: no dangling partial word, and no trailing separator.
    expect(long.startsWith(cut)).toBe(true);
    expect(cut).not.toMatch(/[,:;.\-–—\s]$/);
    expect(long[cut.length] === ' ' || cut.length === long.length).toBe(true);
  });

  it('never exceeds maxLen NOR cuts mid-word when the first token alone is longer than the budget (#5452)', async () => {
    // No space reachable within maxLen + 1 chars. Two defects lived on this
    // branch, fixed in two separate rounds:
    //   - #5474 closed the overshoot: the old fallback returned the
    //     maxLen + 1 lookahead slice whole, one char past budget.
    //   - #5452 (this test) closes the mid-word cut #5474 left behind: its
    //     fix slid the slice from `maxLen + 1` to `maxLen`, which stayed
    //     inside the token — one character earlier, still not a word.
    // A single token longer than the budget has no non-empty prefix that is
    // simultaneously <= maxLen and ends on a word boundary, so the only
    // value satisfying both is ''.
    const { truncateToClause } = await import('../../build-plugins/shared/clauseTail.mjs');
    const fn = truncateToClause as (t: string, n: number) => string;

    const long = 'Krankenversicherungspflichtbefreiungsantragsformularvorlage fuer Grenzgaenger';
    const cut = fn(long, 57);
    expect(cut.length).toBeLessThanOrEqual(57);
    expect(long.startsWith(cut)).toBe(true);
    expect(cut, 'must not return a mid-word fragment of the oversized token').toBe('');

    const singleToken = 'Grenzgaengerbewilligungsverfahrensantragsformularvorlageblattes';
    expect(singleToken.length).toBe(63);
    const cutSingle = fn(singleToken, 30);
    expect(cutSingle.length).toBeLessThanOrEqual(30);
    expect(singleToken.startsWith(cutSingle)).toBe(true);
    expect(cutSingle, 'must not return a mid-word fragment of the oversized token').toBe('');
  });

  /**
   * The other half of #5452, found by PR #5515's review.
   *
   * On this branch `it.title` is missing by definition, so the title falls back
   * to `data.id` — a SLUG. A slug has no spaces, so the empty-refusal above is
   * not a theoretical edge case here: it is what the fallback path returns for
   * every id past the budget. And `title` is not a droppable field, it is
   * interpolated into the brand suffix, so `''` ships " | Frontaliere Ticino"
   * as the entire <title> plus an empty ogTitle and JSON-LD headline.
   *
   * Measured on the published corpus: 62 of 3 166 ids exceed 57 chars (the
   * title budget), 450 exceed 42 (the breadcrumbName budget), and none of the
   * 3 166 contains a space.
   */
  describe('the slug fallback never yields a brand-only title (#5515 review)', () => {
    it('de-hyphenates data.id before truncating, and uses the non-empty helper', () => {
      const branch = createArticle.slice(
        createArticle.indexOf('Synthesize seo from content.it'),
        createArticle.indexOf('Synthesize seo from content.it') + 2600,
      );
      expect(branch, 'the synthesized seo branch is gone or moved').toContain('data.seo = {');
      expect(
        branch,
        'data.id is fed to the truncator as a raw slug again — no word boundary ' +
          'in it, so the title collapses to "" and the page ships " | Frontaliere Ticino"',
      ).toMatch(/replace\(\/\[-_\]\+\/g, ' '\)/);
      expect(branch).toContain('truncateToClauseNonEmpty');
      expect(
        branch,
        'the title is back on the refusing helper — see this test\'s docblock',
      ).not.toMatch(/truncateAtWordBoundary\(String\(it\.title\s*\|\|\s*data\.id\)/);
    });

    it('breadcrumbName uses the non-empty helper too (450/3166 ids exceed its 42-char budget)', () => {
      const site = createArticle.indexOf('data.seo.breadcrumbName = ');
      expect(site, 'the breadcrumbName assignment moved').toBeGreaterThan(-1);
      expect(createArticle.slice(site, site + 260)).toContain('truncateToClauseNonEmpty');
    });

    it('produces a real title for the ids that used to collapse to ""', async () => {
      const { truncateToClause, truncateToClauseNonEmpty } = await import(
        '../../build-plugins/shared/clauseTail.mjs'
      );
      const nonEmpty = truncateToClauseNonEmpty as (t: string, n: number) => string;
      const plain = truncateToClause as (t: string, n: number) => string;

      for (const id of [
        'incidente-mortale-a-porlezza-muore-un-frontaliere-di-38-anni-2026',
        'educatori-in-germania-stipendi-fino-a-4500-euro-al-mese-per-frontalieri',
        'taglio-alle-accise-mette-sotto-pressione-i-distributori-ticinesi',
      ]) {
        expect(id, 'precondition: article ids are spaceless slugs').not.toMatch(/\s/);
        // What the raw slug did before this fix.
        expect(plain(id, 57), 'precondition: the raw slug is refused').toBe('');

        const prose = id.replace(/[-_]+/g, ' ').trim();
        const title = nonEmpty(prose.charAt(0).toUpperCase() + prose.slice(1), 57);
        expect(title.length).toBeLessThanOrEqual(57);
        expect(title).not.toBe('');
        expect(`${title} | Frontaliere Ticino`).not.toBe(' | Frontaliere Ticino');
        // Still a clean ending — the point of #5452 is not given up to get one.
        expect(title).not.toMatch(/[,:;.\-–—\s]$/);

        const breadcrumb = nonEmpty(prose.split(/[:.–—]/)[0] || 'Articolo', 42);
        expect(breadcrumb.length).toBeLessThanOrEqual(42);
        expect(breadcrumb, 'an empty breadcrumbName ships a nameless BreadcrumbList item').not.toBe('');
      }
    });
  });
});
