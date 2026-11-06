import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `seoService`'s `sectionNames` must not accumulate per-article entries again.
 *
 * It used to hold 3593 of them, one `'blog-<id>': { name, path, parent: 'blog' }`
 * per generated article, appended by `create-article.mjs`. They were
 * unreachable: `buildBreadcrumbs` returns early for `route.activeTab === 'blog'`,
 * building the crumb from `blogTitle` + `buildPath(route)`, and `sectionNames`
 * is declared *after* that return and read only below it. The only place a
 * `blog-<id>` section key is constructed is `getSectionKey` in router.ts, inside
 * `case 'blog':` — for both sections, svizzera included — so the early return
 * always fires first.
 *
 * They were not free: they were 530 KB of the 1153 KB `assets/seoService.js`
 * chunk served to clients (45.9%), and `sectionNames` is a function-local const
 * inside a live function, so nothing tree-shakes it.
 *
 * Removing them is also what lets the article generator move out of this
 * repository (issue #4974 item 3): appending to `services/seoService.ts` was one
 * of only two reasons `create-article.mjs` had to write outside the corpus.
 *
 * This test guards all three legs — the entries stay gone, the early return that
 * makes them pointless stays in place, and the key construction stays confined
 * to the blog tab. If any one changes, re-deriving whether per-article
 * breadcrumbs are needed again has to be a deliberate decision, not a silent
 * regrowth.
 */

const ROOT = path.resolve(__dirname, '..');
const seoService = fs.readFileSync(path.join(ROOT, 'services', 'seoService.ts'), 'utf-8');
const router = fs.readFileSync(path.join(ROOT, 'services', 'router.ts'), 'utf-8');

describe('seoService carries no per-article breadcrumb entries (#4974 item 3)', () => {
  it('has zero blog-<id> entries in sectionNames', () => {
    const found = seoService.match(/'blog-[a-z0-9-]+':\s*\{\s*name:/g) ?? [];
    expect(
      found.length,
      `${found.length} per-article breadcrumb entries are back in seoService.ts. ` +
        `They are unreachable (buildBreadcrumbs returns before sectionNames for ` +
        `blog routes) and they shipped 530 KB of dead weight in the seoService ` +
        `chunk. If a caller genuinely needs one, change buildBreadcrumbs — do not ` +
        `re-grow this table.`,
    ).toBe(0);
  });

  it('buildBreadcrumbs still returns before sectionNames for blog routes', () => {
    const fnStart = seoService.indexOf('function buildBreadcrumbs(');
    expect(fnStart).toBeGreaterThan(-1);

    const guard = seoService.indexOf("if (route.activeTab === 'blog') {", fnStart);
    const declaration = seoService.indexOf('const sectionNames', fnStart);
    expect(guard).toBeGreaterThan(-1);
    expect(declaration).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(declaration);
    expect(seoService.slice(guard, declaration)).toMatch(/return\s*\{/);
  });

  it('the only place a blog-<id> section key is built is the blog tab', () => {
    const constructions = [...router.matchAll(/`blog-\$\{[^}]+\}`/g)];
    expect(constructions.length).toBeGreaterThan(0);

    for (const m of constructions) {
      const before = router.slice(0, m.index);
      const lastCase = [...before.matchAll(/case '([^']+)':/g)].pop();
      expect(lastCase, `no case label found before ${m[0]}`).toBeTruthy();
      expect(
        lastCase![1],
        `${m[0]} is built under case '${lastCase![1]}'. If that is not 'blog', the ` +
          `early return in buildBreadcrumbs no longer covers it and per-article ` +
          `breadcrumbs would need a real home again.`,
      ).toBe('blog');
    }
  });

  it('create-article.mjs no longer appends breadcrumbs to seoService.ts', () => {
    // Comments stripped first: the removal is documented in place, and that
    // explanation quotes the very shape this test looks for.
    const createArticle = fs
      .readFileSync(path.join(ROOT, 'scripts', 'create-article.mjs'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
      .join('\n');

    expect(
      createArticle,
      "create-article.mjs must not write a `parent: 'blog'` breadcrumb entry again",
    ).not.toMatch(/parent:\s*'blog'\s*\}/);
    expect(
      createArticle,
      'create-article.mjs must not stage services/seoService.ts — it no longer writes it',
    ).not.toContain("'services/seoService.ts'");
  });
});
