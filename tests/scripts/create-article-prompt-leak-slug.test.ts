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
    const branch = createArticle.slice(
      createArticle.indexOf('Synthesize seo from content.it'),
      createArticle.indexOf('Synthesize seo from content.it') + 1600,
    );
    expect(branch, 'the synthesized seo branch is gone or moved').toContain('data.seo = {');
    expect(
      branch,
      'the synthesized title/description are back to a hard slice — they will ' +
        'ship title tags cut mid-word again',
    ).not.toMatch(/\.slice\(0,\s*(57|160)\)/);
    expect(branch).toMatch(/truncateAtWordBoundary\(String\(it\.title/);
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

  it('never exceeds maxLen when the first token alone is longer than the budget (#5452)', async () => {
    // No space reachable within maxLen + 1 chars — the old fallback returned
    // the maxLen + 1 lookahead slice whole, overshooting the budget by 1.
    const { truncateToClause } = await import('../../build-plugins/shared/clauseTail.mjs');
    const fn = truncateToClause as (t: string, n: number) => string;

    const long = 'Krankenversicherungspflichtbefreiungsantragsformularvorlage fuer Grenzgaenger';
    const cut = fn(long, 57);
    expect(cut.length).toBeLessThanOrEqual(57);
    expect(long.startsWith(cut)).toBe(true);

    const singleToken = 'Grenzgaengerbewilligungsverfahrenantragsformularvorlageblatt';
    const cutSingle = fn(singleToken, 30);
    expect(cutSingle.length).toBeLessThanOrEqual(30);
    expect(singleToken.startsWith(cutSingle)).toBe(true);
  });
});
