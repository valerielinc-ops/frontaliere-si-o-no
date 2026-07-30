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
