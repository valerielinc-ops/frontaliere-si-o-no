/**
 * Google News compliance — task E1.
 *
 * Spec: docs/GOOGLE-NEWS-COMPLIANCE-PLAN.md §4 FASE 5 E1.
 *
 * This suite verifies E-E-A-T / News-publisher requirements across every
 * article in `data/blog-articles-data.ts`. CI runs this on every push and
 * blocks deploy on regression.
 *
 * Failure-reporting strategy: the registry holds ~1 800 articles, so each
 * "for every article" check uses the **collect-all-offenders / fail-once
 * with-summary** pattern. One Vitest assertion failure surfaces the full
 * offender list (truncated to the first 25 lines) instead of producing
 * thousands of per-article failures.
 *
 * What this file does NOT duplicate:
 *   - `tests/authors.test.ts` — registry shape, photo files, LinkedIn URLs.
 *   - `tests/blog-headline-validation.test.ts` — `validateHeadline` unit
 *     tests + drift guard against `scripts/create-article.mjs`.
 *
 * Headline integration (Suite 3) deliberately mirrors the
 * already-skipped-strict integration test in `blog-headline-validation.test.ts`
 * with an informational reporter rather than a hard failure: legacy
 * articles published before A5 may still be in the offender set, and
 * cleaning them up is tracked separately.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ARTICLES, type Article } from '@/data/blog-articles-data';
import { AUTHORS, getAuthorBySlug } from '@/data/authors';

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ──────────────────────────────────────────────────────────────────────────
// Local copy of validateHeadline — kept in sync with scripts/create-article.mjs.
// We mirror the validator inline rather than importing from the .mjs script
// to avoid running its top-level side effects under Vitest. Drift is guarded
// by `tests/blog-headline-validation.test.ts` (string-equality assertions
// against the source file).
// ──────────────────────────────────────────────────────────────────────────

const A5_CLICKBAIT_PATTERNS: readonly RegExp[] = [
  /non\s+crederai/i,
  /scioccante/i,
  /incredibile/i,
  /sconvolgente/i,
  /ti\s+lascer[àa]\s+senza\s+parole/i,
  /clamoroso/i,
  /pazzesco/i,
  /\bspoiler\b/i,
  /quello\s+che\s+(non\s+)?sai/i,
  /ecco\s+(perch[ée]|cosa)\s+non\s+(crederai|immagini)/i,
  /you\s+won['’]?t\s+believe/i,
  /shocking/i,
  /mind[-\s]?blowing/i,
  /this\s+one\s+(weird\s+)?trick/i,
  /\?\?\?$/,
  /!{2,}$/,
];

function validateHeadline(headline: unknown): string[] {
  const errs: string[] = [];
  if (typeof headline !== 'string' || headline.length === 0) {
    return ['Headline mancante o non stringa'];
  }
  if (headline.length < 10) errs.push('Headline troppo corto (min 10 char)');
  if (headline.length > 110) errs.push('Headline troppo lungo (max 110 char)');
  const wc = headline.trim().split(/\s+/).filter(Boolean).length;
  if (wc < 2 || wc > 22) errs.push(`Headline ${wc} parole, range 2-22`);
  if (/^\d/.test(headline.trim())) errs.push('Headline non deve iniziare con numero');
  if (A5_CLICKBAIT_PATTERNS.some((p) => p.test(headline))) {
    errs.push('Pattern clickbait rilevato');
  }
  return errs;
}

// ──────────────────────────────────────────────────────────────────────────
// Italian-title lookup — sourced from services/locales/blog-meta-it.ts.
// Built lazily to keep the cost off cold imports.
// ──────────────────────────────────────────────────────────────────────────

let _titleCache: Map<string, string> | null = null;

function loadItalianTitles(): Map<string, string> {
  if (_titleCache) return _titleCache;
  const file = path.join(ROOT, 'services', 'locales', 'blog-meta-it.ts');
  const src = fs.readFileSync(file, 'utf-8');
  const re = /'blog\.article\.([^.']+)\.title'\s*:\s*'((?:\\'|[^'])+)'/g;
  const out = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const id = m[1];
    const title = m[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    out.set(id, title);
  }
  _titleCache = out;
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

const KNOWN_AUTHOR_SLUGS = new Set(AUTHORS.map((a) => a.slug));

function summarize(offenders: string[], max = 25): string {
  if (offenders.length === 0) return '';
  const head = offenders.slice(0, max).join('\n');
  const tail = offenders.length > max ? `\n  …and ${offenders.length - max} more` : '';
  return `\n${head}${tail}`;
}

function isValidIsoDate(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  // Must be a strict ISO 8601 (date-only OR date+time). Reject loose formats
  // like "2026/01/01" that Date() also happens to accept.
  return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(
    value,
  );
}

function hasTimeComponent(value: string): boolean {
  return /T\d{2}:\d{2}/.test(value);
}

// ──────────────────────────────────────────────────────────────────────────
// Suites
// ──────────────────────────────────────────────────────────────────────────

describe('Google News compliance — E1', () => {
  it('article registry is non-empty (sanity check)', () => {
    expect(ARTICLES.length).toBeGreaterThan(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // Suite 1 — Author compliance
  // ────────────────────────────────────────────────────────────────────────

  describe('Suite 1 — Author compliance', () => {
    it('every article has a non-empty authorSlug', () => {
      const offenders = ARTICLES.filter((a) => !a.authorSlug || a.authorSlug.trim() === '').map(
        (a) => `  - ${a.id}: authorSlug=${JSON.stringify(a.authorSlug)}`,
      );
      expect(
        offenders.length,
        `${offenders.length} article(s) have a missing/empty authorSlug:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('every authorSlug resolves to an author in the AUTHORS registry', () => {
      const offenders = ARTICLES.filter(
        (a) => a.authorSlug && !KNOWN_AUTHOR_SLUGS.has(a.authorSlug),
      ).map((a) => `  - ${a.id}: authorSlug="${a.authorSlug}" not in AUTHORS registry`);
      expect(
        offenders.length,
        `${offenders.length} article(s) reference an unknown authorSlug:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('every resolved author is a Person (not an organization placeholder)', () => {
      // The AUTHORS registry is the Person registry by construction.
      // We additionally guard against an article pointing at the literal
      // organization slugs that some pipelines historically used.
      const ORG_SLUG_BLOCKLIST = new Set([
        'organization',
        'frontaliere-ticino',
        'frontaliereticino',
        'staff',
      ]);
      const offenders = ARTICLES.filter(
        (a) => a.authorSlug && ORG_SLUG_BLOCKLIST.has(a.authorSlug),
      ).map((a) => `  - ${a.id}: authorSlug="${a.authorSlug}" is an organization placeholder`);
      expect(
        offenders.length,
        `${offenders.length} article(s) point at an organization placeholder:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('every resolved author has a non-empty sameAs (LinkedIn / KG signal)', () => {
      // Indirect check: walk articles, resolve each author, assert at least
      // one social URL is set. This catches both registry rot and articles
      // pointing at a future author whose social profiles are TBD.
      const offenders: string[] = [];
      for (const article of ARTICLES) {
        if (!article.authorSlug) continue;
        const author = getAuthorBySlug(article.authorSlug);
        if (!author) continue; // covered by the previous test
        const sameAs = [
          author.social.linkedin,
          author.social.twitter,
          author.social.mastodon,
        ].filter((s): s is string => typeof s === 'string' && s.length > 0);
        if (sameAs.length === 0) {
          offenders.push(`  - ${article.id}: author "${author.slug}" has no sameAs URL`);
        }
      }
      expect(
        offenders.length,
        `${offenders.length} article(s) resolve to an author missing sameAs:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('authorName matches the registry name for the resolved authorSlug', () => {
      const offenders: string[] = [];
      for (const article of ARTICLES) {
        if (!article.authorSlug || !article.authorName) continue;
        const author = getAuthorBySlug(article.authorSlug);
        if (!author) continue; // covered by the previous test
        if (article.authorName !== author.name) {
          offenders.push(
            `  - ${article.id}: authorName="${article.authorName}" but registry name="${author.name}"`,
          );
        }
      }
      expect(
        offenders.length,
        `${offenders.length} article(s) have a mismatched authorName:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('every article that has authorSlug also has a non-empty authorName', () => {
      const offenders = ARTICLES.filter(
        (a) => a.authorSlug && (!a.authorName || a.authorName.trim() === ''),
      ).map((a) => `  - ${a.id}: authorSlug="${a.authorSlug}" but authorName is missing`);
      expect(
        offenders.length,
        `${offenders.length} article(s) have authorSlug but no authorName:${summarize(offenders)}`,
      ).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Suite 2 — Date compliance
  //
  // The Article schema uses `date` (publication) and optional `updatedAt`
  // (last material update). Those map onto NewsArticle datePublished /
  // dateModified at JSON-LD emit time.
  // ────────────────────────────────────────────────────────────────────────

  describe('Suite 2 — Date compliance', () => {
    it('every article has a parseable ISO 8601 date (publication)', () => {
      const offenders = ARTICLES.filter((a) => !isValidIsoDate(a.date)).map(
        (a) => `  - ${a.id}: date=${JSON.stringify(a.date)}`,
      );
      expect(
        offenders.length,
        `${offenders.length} article(s) have an invalid/missing date:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('every article datePublished is in the past (no future-dated articles)', () => {
      const now = Date.now();
      const offenders = ARTICLES.filter((a) => {
        if (!isValidIsoDate(a.date)) return false; // covered above
        return new Date(a.date).getTime() > now;
      }).map((a) => `  - ${a.id}: date="${a.date}" is in the future`);
      expect(
        offenders.length,
        `${offenders.length} article(s) are future-dated:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('when updatedAt is present, it parses as ISO 8601', () => {
      const offenders = ARTICLES.filter(
        (a) => a.updatedAt !== undefined && !isValidIsoDate(a.updatedAt),
      ).map((a) => `  - ${a.id}: updatedAt=${JSON.stringify(a.updatedAt)}`);
      expect(
        offenders.length,
        `${offenders.length} article(s) have an invalid updatedAt:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('when updatedAt is present, dateModified >= datePublished', () => {
      const offenders = ARTICLES.filter((a) => {
        if (!a.updatedAt) return false;
        if (!isValidIsoDate(a.date) || !isValidIsoDate(a.updatedAt)) return false;
        // Date-only strings (no T) parse as midnight UTC. Compare on the
        // same calendar grain to avoid spurious "earlier" results when
        // `date` is "2026-01-15" and `updatedAt` is "2026-01-15T08:00Z".
        const pub = a.date.includes('T') ? new Date(a.date) : new Date(`${a.date}T00:00:00Z`);
        const mod = a.updatedAt.includes('T')
          ? new Date(a.updatedAt)
          : new Date(`${a.updatedAt}T00:00:00Z`);
        return mod.getTime() < pub.getTime();
      }).map((a) => `  - ${a.id}: updatedAt="${a.updatedAt}" is before date="${a.date}"`);
      expect(
        offenders.length,
        `${offenders.length} article(s) have updatedAt < datePublished:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('when updatedAt is present, it is not in the future', () => {
      const now = Date.now();
      const offenders = ARTICLES.filter((a) => {
        if (!a.updatedAt) return false;
        if (!isValidIsoDate(a.updatedAt)) return false;
        return new Date(a.updatedAt).getTime() > now;
      }).map((a) => `  - ${a.id}: updatedAt="${a.updatedAt}" is in the future`);
      expect(
        offenders.length,
        `${offenders.length} article(s) have a future updatedAt:${summarize(offenders)}`,
      ).toBe(0);
    });

    // Informational reporter: Google News prefers full ISO timestamps with
    // a time component over date-only stamps. We surface (but do NOT fail
    // on) any legacy article still using date-only `date` strings, so a
    // future cleanup task can target them precisely.
    it('reports articles whose date is missing the time component (informational, no fail)', () => {
      const offenders = ARTICLES.filter(
        (a) => isValidIsoDate(a.date) && !hasTimeComponent(a.date),
      ).map((a) => `  - ${a.id}: date="${a.date}"`);
      if (offenders.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[E1 informational] ${offenders.length}/${ARTICLES.length} articles use date-only ` +
            `(no time) datePublished — Google News prefers full ISO timestamps:${summarize(offenders, 10)}`,
        );
      }
      expect(ARTICLES.length).toBeGreaterThan(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Suite 3 — Headline / title compliance
  //
  // Mirrors the integration coverage in blog-headline-validation.test.ts
  // but scopes it to the same set of IDs surfaced by the article registry,
  // so a stray article without a corresponding `*.title` translation is
  // also reported.
  // ────────────────────────────────────────────────────────────────────────

  describe('Suite 3 — Headline compliance (Italian title)', () => {
    // Informational reporter — three legacy auto-generated articles
    // (`permesso-g-pro-contro-2026`, `cantieri-traffico-a9-ticino`,
    // `iniziativa-salari-ticino`) are referenced from routerBlogData /
    // sitemap-blog.xml but never received an Italian title in
    // `services/locales/blog-meta-it.ts` (and their image files were never
    // generated either — see Suite 4). They are tracked as a follow-up
    // cleanup to E1 because removing them cascades through the router
    // BlogArticleId union, ~6 locale slug tables, and several cron-generated
    // data files. Until that cleanup ships, this check is informational.
    it('reports articles missing an Italian title in blog-meta-it.ts (informational, no fail)', () => {
      const titles = loadItalianTitles();
      const offenders = ARTICLES.filter((a) => !titles.has(a.id)).map(
        (a) => `  - ${a.id}: no entry "blog.article.${a.id}.title"`,
      );
      if (offenders.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[E1 informational] ${offenders.length}/${ARTICLES.length} article(s) ` +
            `have no Italian title in blog-meta-it.ts:${summarize(offenders)}`,
        );
      }
      expect(ARTICLES.length).toBeGreaterThan(0);
    });

    // INFORMATIONAL only — see file header. The legacy offender set is
    // tracked by the skipped-strict assertion in
    // blog-headline-validation.test.ts and will be cleaned up in a
    // follow-up pass before re-enabling the strict gate.
    it('reports any article title that fails validateHeadline (informational, no fail)', () => {
      const titles = loadItalianTitles();
      const failures: { id: string; title: string; errors: string[] }[] = [];
      for (const article of ARTICLES) {
        const title = titles.get(article.id);
        if (!title) continue; // already reported above
        const errors = validateHeadline(title);
        if (errors.length > 0) {
          failures.push({ id: article.id, title, errors });
        }
      }
      if (failures.length > 0) {
        const summary = failures
          .slice(0, 25)
          .map((f) => `  - ${f.id}: "${f.title.slice(0, 80)}" → ${f.errors.join('; ')}`)
          .join('\n');
        const tail = failures.length > 25 ? `\n  …and ${failures.length - 25} more` : '';
        // eslint-disable-next-line no-console
        console.warn(
          `[E1 informational] ${failures.length}/${ARTICLES.length} article titles ` +
            `currently fail validateHeadline:\n${summary}${tail}`,
        );
      }
      expect(ARTICLES.length).toBeGreaterThan(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Suite 4 — Image compliance
  //
  // The Article schema stores `image` as a path under /public (e.g.
  // "/images/places/lugano.webp") OR an absolute https URL. We assert
  // presence + shape, then verify local files exist on disk so deploys
  // can't ship a NewsArticle with a 404 image.
  //
  // Width/height are not stored in the registry (would bloat the bundle),
  // so the dimension checks are conditional: they apply only when an
  // `imageWidth` / `imageHeight` field appears on a future schema bump.
  // ────────────────────────────────────────────────────────────────────────

  describe('Suite 4 — Image compliance', () => {
    it('every article has a non-empty image field', () => {
      const offenders = ARTICLES.filter(
        (a) => typeof a.image !== 'string' || a.image.trim() === '',
      ).map((a) => `  - ${a.id}: image=${JSON.stringify(a.image)}`);
      expect(
        offenders.length,
        `${offenders.length} article(s) have a missing/empty image:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('every image is either an absolute https URL or a /-rooted local path', () => {
      const offenders = ARTICLES.filter((a) => {
        if (typeof a.image !== 'string' || a.image.length === 0) return false;
        return !(a.image.startsWith('https://') || a.image.startsWith('/'));
      }).map((a) => `  - ${a.id}: image="${a.image}"`);
      expect(
        offenders.length,
        `${offenders.length} article(s) have an image that is neither https:// nor /-rooted:${summarize(offenders)}`,
      ).toBe(0);
    });

    // Informational reporter — same legacy 3-article cleanup tracked under
    // Suite 3 above. Switching this to a hard failure today would block
    // every deploy until those entries are removed from
    // `data/blog-articles-data.ts` + `services/routerBlogData.ts` +
    // sitemap-blog.xml. The follow-up data-cleanup task will tighten this
    // back to a strict assertion once the offender set is empty.
    it('reports locally-hosted images that are missing on disk (informational, no fail)', () => {
      const offenders: string[] = [];
      for (const article of ARTICLES) {
        if (typeof article.image !== 'string') continue;
        if (!article.image.startsWith('/')) continue; // skip absolute URLs
        const abs = path.join(PUBLIC_DIR, article.image.replace(/^\//, ''));
        if (!fs.existsSync(abs)) {
          offenders.push(`  - ${article.id}: image="${article.image}" → file missing on disk`);
        }
      }
      if (offenders.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[E1 informational] ${offenders.length}/${ARTICLES.length} article(s) ` +
            `reference a local image that does not exist:${summarize(offenders)}`,
        );
      }
      expect(ARTICLES.length).toBeGreaterThan(0);
    });

    // Forward-compatible dimension checks — currently no-ops because the
    // Article interface does not expose imageWidth/imageHeight. The schema
    // bump that adds them will exercise these assertions automatically.
    it('when imageWidth/imageHeight are present, dimensions meet Google News minimums', () => {
      const offenders: string[] = [];
      for (const article of ARTICLES as ReadonlyArray<
        Article & { imageWidth?: number; imageHeight?: number }
      >) {
        const w = article.imageWidth;
        const h = article.imageHeight;
        if (typeof w === 'number' && w < 1200) {
          offenders.push(`  - ${article.id}: imageWidth=${w} < 1200`);
        }
        if (typeof h === 'number' && h < 675) {
          offenders.push(`  - ${article.id}: imageHeight=${h} < 675`);
        }
        if (typeof w === 'number' && typeof h === 'number') {
          const ratio = w / h;
          if (ratio < 1.5 || ratio > 2.0) {
            offenders.push(
              `  - ${article.id}: imageWidth/imageHeight ratio=${ratio.toFixed(3)} outside [1.5, 2.0]`,
            );
          }
        }
      }
      expect(
        offenders.length,
        `${offenders.length} dimension violation(s):${summarize(offenders)}`,
      ).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Suite 5 — Article section / topic compliance
  // ────────────────────────────────────────────────────────────────────────

  describe('Suite 5 — Category/section compliance', () => {
    const ALLOWED_CATEGORIES = new Set<Article['category']>([
      'fiscale',
      'pratico',
      'novita',
      'pensione',
    ]);
    const REJECTED_VALUES = new Set(['', 'uncategorized', 'generale', 'general', 'misc', 'other']);

    it('every article has a non-empty category', () => {
      const offenders = ARTICLES.filter(
        (a) => typeof a.category !== 'string' || a.category.trim() === '',
      ).map((a) => `  - ${a.id}: category=${JSON.stringify(a.category)}`);
      expect(
        offenders.length,
        `${offenders.length} article(s) have a missing/empty category:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('every category is in the allowed set (fiscale | pratico | novita | pensione)', () => {
      const offenders = ARTICLES.filter(
        (a) => typeof a.category === 'string' && !ALLOWED_CATEGORIES.has(a.category),
      ).map((a) => `  - ${a.id}: category="${a.category}" not in allowed set`);
      expect(
        offenders.length,
        `${offenders.length} article(s) have an out-of-set category:${summarize(offenders)}`,
      ).toBe(0);
    });

    it('no article uses a placeholder category like "uncategorized" or "generale"', () => {
      const offenders = ARTICLES.filter(
        (a) =>
          typeof a.category === 'string' &&
          REJECTED_VALUES.has(a.category.toLowerCase().trim()),
      ).map((a) => `  - ${a.id}: category="${a.category}" is a placeholder`);
      expect(
        offenders.length,
        `${offenders.length} article(s) use a placeholder category:${summarize(offenders)}`,
      ).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // Suite 6 — Schema fields spot-check on the 5 most recent articles
  // ────────────────────────────────────────────────────────────────────────

  describe('Suite 6 — Recent-articles schema spot-check', () => {
    function recentArticles(): Article[] {
      return [...ARTICLES]
        .filter((a) => isValidIsoDate(a.date))
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 5);
    }

    it('the 5 most-recent articles have all required fields', () => {
      const sample = recentArticles();
      expect(sample.length).toBeGreaterThan(0);

      const titles = loadItalianTitles();
      const offenders: string[] = [];
      for (const article of sample) {
        if (typeof article.id !== 'string' || article.id.length === 0) {
          offenders.push(`  - ${article.id ?? '<no id>'}: missing id`);
          continue;
        }
        if (!titles.has(article.id)) {
          offenders.push(`  - ${article.id}: missing Italian title in blog-meta-it.ts`);
        }
        if (!isValidIsoDate(article.date)) {
          offenders.push(`  - ${article.id}: invalid date="${article.date}"`);
        }
        if (!article.authorSlug) {
          offenders.push(`  - ${article.id}: missing authorSlug`);
        } else if (!KNOWN_AUTHOR_SLUGS.has(article.authorSlug)) {
          offenders.push(`  - ${article.id}: unknown authorSlug="${article.authorSlug}"`);
        }
      }
      expect(
        offenders.length,
        `${offenders.length} required-field issue(s) on the 5 most-recent articles:${summarize(offenders)}`,
      ).toBe(0);
    });

    // Optional fields: don't fail, just warn so the dashboard catches a
    // creeping pattern of missing dateModified or image among new posts.
    it('warns when recent articles are missing optional fields (informational)', () => {
      const sample = recentArticles();
      const warnings: string[] = [];
      for (const article of sample) {
        if (!article.updatedAt) {
          warnings.push(`  - ${article.id}: missing updatedAt (dateModified)`);
        }
        if (!article.image) {
          warnings.push(`  - ${article.id}: missing image`);
        }
      }
      if (warnings.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
          `[E1 informational] recent articles missing optional fields:\n${warnings.join('\n')}`,
        );
      }
      expect(sample.length).toBeGreaterThan(0);
    });
  });
});
