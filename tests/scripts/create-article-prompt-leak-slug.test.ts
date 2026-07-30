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
      'the id guard (PROMPT_ID_LEAK_RX) is gone — a model echoing the schema ' +
        'placeholder would publish it as a permanent URL again',
    ).toMatch(/PROMPT_ID_LEAK_RX/);
    expect(createArticle).toMatch(/kebab\[-_\]\?case/);
  });

  it('create-article.mjs strips the leak from the per-locale slugs', () => {
    // The IT slug is assigned from the id, so it inherits the id guard; en/de/fr
    // come straight from the model and need their own.
    const sanitizer = createArticle.slice(createArticle.indexOf('Sanitize ALL locale slugs'));
    expect(
      sanitizer.slice(0, 1600),
      'the en/de/fr slug sanitizer no longer strips `kebab-case-`',
    ).toContain("replace(/^kebab-case-/, '')");
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
    const src = createArticle.slice(createArticle.indexOf('function truncateAtWordBoundary'));
    const body = src.slice(0, src.indexOf('\n}\n') + 3);
    const fn = new Function(`${body}; return truncateAtWordBoundary;`)() as (
      t: string,
      n: number,
    ) => string;

    const long = 'Incidente mortale a Porlezza: muore un giovane motociclista di Como';
    const cut = fn(long, 57);
    expect(cut.length).toBeLessThanOrEqual(57);
    // The whole point: no dangling partial word, and no trailing separator.
    expect(long.startsWith(cut)).toBe(true);
    expect(cut).not.toMatch(/[,:;.\-–—\s]$/);
    expect(long[cut.length] === ' ' || cut.length === long.length).toBe(true);
  });
});
