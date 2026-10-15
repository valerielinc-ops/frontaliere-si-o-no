/**
 * #5312 §3 — the residual of audit:h1-title-duplicates left over after
 * PR #5267 closed the FAQ family (95 of 100 sampled offenders).
 *
 * #5312 §3 recorded the remaining ~5 as pages "whose headline exceeds 66
 * characters on its own", i.e. a copy problem to be fixed by rewriting the
 * headline at source. THAT DIAGNOSIS IS WRONG, and the assertions in
 * `#5312 §3 diagnosed the cause wrongly` below are what pins it: four of the
 * five sampled offenders carry a 46-60 char headline, comfortably inside the
 * 66-char cap. Duplication starts at 45 chars, not 66 — that is where
 * `buildTitleWithBrand` stops being able to fit " | Frontaliere Ticino"
 * (21 chars) and drops it. The brand suffix is the ONLY thing that told
 * <title> apart from <h1> on these templates, because all three of them ship
 * the same copy string as both.
 *
 * So the remedy is code, not copy — exactly the FAQ remedy: call the shared
 * `differentiateH1FromTitle` so the visible H1 gains a locale-aware tag while
 * the <title> keeps its keywords verbatim (build-plugins/shared/titleSuffix.ts
 * forbids shortening a headline with a mid-string `…`).
 *
 * Five producers, 52 pages, all of which shipped <title> === <h1> whenever
 * the headline passed 45 chars:
 *   - build-plugins/bfsSalaryLandingsPlugin.ts   (36 pages, 13 duplicated)
 *   - build-plugins/frenchBorderMunicipalityPagesPlugin.ts        (4 hubs, all 4)
 *   - build-plugins/germanBorderMunicipalityPagesPlugin.ts        (4 hubs, all 4)
 *   - build-plugins/austrianBorderMunicipalityPagesPlugin.ts      (4 hubs, all 4)
 *   - build-plugins/liechtensteinBorderMunicipalityPagesPlugin.ts (4 hubs, all 4)
 * 29 real offenders; at the post-deploy job's AUDIT_SAMPLE_RATE=0.25 the
 * run-31180767284 report surfaced 5 of them.
 *
 * The four border-municipality hub plugins are siblings of one pattern — a
 * single copy string emitted as both <title> and <h1> — so AGENTS.md rule 6
 * makes closing all four one job. Fixing only the two the sampled report
 * happened to name would leave the same defect live on the other two.
 *
 * SECOND, SEPARATE DEFECT on the Liechtenstein hubs only: their four
 * hubTitles were 78-96 chars, over the 66-char audit:title-length cap. That
 * one IS a copy problem, and per build-plugins/shared/titleSuffix.ts it is
 * fixed at the source (data/liechtensteinCorridorContent.ts), never by a
 * render-time truncation and never with `…`. `every border hub <title> fits
 * the SERP cap` below is the assertion that keeps it fixed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  __renderAgePageForTest,
  __renderEducationPageForTest,
} from '@/build-plugins/bfsSalaryLandingsPlugin';
import {
  SALARY_LOCALES,
  SALARY_AGE_ANCHORS,
  SALARY_EDUCATION_IDS,
  buildSalaryAgeLandingPath,
  buildSalaryEducationLandingPath,
} from '@/build-plugins/bfsSalaryLandingsData';
import { renderHubPage as renderFrenchHub } from '@/build-plugins/frenchBorderMunicipalityPagesPlugin';
import { renderHubPage as renderGermanHub } from '@/build-plugins/germanBorderMunicipalityPagesPlugin';
import { renderHubPage as renderAustrianHub } from '@/build-plugins/austrianBorderMunicipalityPagesPlugin';
import { renderHubPage as renderLiechtensteinHub } from '@/build-plugins/liechtensteinBorderMunicipalityPagesPlugin';
import { FRENCH_LOCALES, FRENCH_HUB_PATH } from '@/build-plugins/frenchBorderMunicipalityData';
import { GERMAN_LOCALES, GERMAN_HUB_PATH } from '@/build-plugins/germanBorderMunicipalityData';
import { AUSTRIAN_LOCALES } from '@/build-plugins/austrianBorderMunicipalityData';
import { LIECHTENSTEIN_LOCALES } from '@/build-plugins/liechtensteinBorderMunicipalityData';
import { TITLE_BRAND_SUFFIX, TITLE_MAX_CHARS } from '@/build-plugins/shared/titleSuffix';

// A distDir that cannot exist: buildSeoPageHtml's entry-asset resolution
// degrades to empty filenames, which is all these assertions need. Same
// device as tests/french-border-municipality-pages.test.ts.
const DIST = '/tmp/__h1_title_differentiation_dist_does_not_exist__';
const DATE = '2026-08-07';

// Mirrors scripts/audit-h1-title-duplicates.mjs: same two regexes, same
// tag-strip + entity-decode + whitespace-collapse, same case-insensitive
// comparison. Re-stated rather than imported because the audit keeps its
// matchers module-private; if the audit's normalisation ever changes, these
// assertions are the ones that must be re-read against it.
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const H1_RE = /<h1[^>]*>([\s\S]*?)<\/h1>/i;

function normalizeText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface Page {
  path: string;
  title: string;
  h1: string;
  /** True for the four border-municipality hub families. */
  borderHub: boolean;
}

function readPage(path: string, html: string, borderHub = false): Page {
  return {
    path,
    title: normalizeText(html.match(TITLE_RE)?.[1] ?? ''),
    h1: normalizeText(html.match(H1_RE)?.[1] ?? ''),
    borderHub,
  };
}

/**
 * The four border-municipality hub renderers, kept in one table so a fifth
 * corridor cannot be added without landing in every assertion below.
 */
const HUB_RENDERERS = [
  ['france', FRENCH_LOCALES, renderFrenchHub],
  ['germany', GERMAN_LOCALES, renderGermanHub],
  ['austria', AUSTRIAN_LOCALES, renderAustrianHub],
  ['liechtenstein', LIECHTENSTEIN_LOCALES, renderLiechtensteinHub],
] as const;

/** Every page the five producers emit, rendered once and shared. */
const PAGES: Page[] = (() => {
  const out: Page[] = [];
  for (const locale of SALARY_LOCALES) {
    for (const age of SALARY_AGE_ANCHORS) {
      const { html } = __renderAgePageForTest({ locale, age, dateStamp: DATE });
      out.push(readPage(buildSalaryAgeLandingPath(locale, age), html));
    }
    for (const eduId of SALARY_EDUCATION_IDS) {
      const { html } = __renderEducationPageForTest({ locale, eduId, dateStamp: DATE });
      out.push(readPage(buildSalaryEducationLandingPath(locale, eduId), html));
    }
  }
  for (const [, locales, render] of HUB_RENDERERS) {
    for (const locale of locales) {
      const { urlPath, html } = render({ locale, dateStamp: DATE, distDir: DIST });
      out.push(readPage(urlPath, html, true));
    }
  }
  return out;
})();

const BORDER_HUBS = PAGES.filter((p) => p.borderHub);

const byPath = (p: string): Page => {
  const found = PAGES.find((x) => x.path === p);
  if (!found) throw new Error(`no rendered page for ${p} (rendered: ${PAGES.length})`);
  return found;
};

/** The five paths the run-31180767284 audit-reports artifact listed. */
const REPORTED_OFFENDERS = [
  buildSalaryEducationLandingPath('it', 'formazione-superiore'), // /stipendio-svizzera-formazione-superiore/
  buildSalaryAgeLandingPath('de', 50), //                          /de/durchschnittslohn-schweiz-50-jahre/
  buildSalaryEducationLandingPath('en', 'universita'), //          /en/salary-switzerland-university-degree/
  FRENCH_HUB_PATH.it, //                                           /vivere-in-francia-lavorare-in-svizzera/
  GERMAN_HUB_PATH.it, //                                           /vivere-in-germania-lavorare-in-svizzera/
];

const stripBrand = (t: string) =>
  t.replace(/\s*[|·]\s*Frontaliere Ticino\s*$/i, '').trim();

describe('#5312 §3 — the five reported paths are the ones under test', () => {
  it('renders all 52 pages of the five producers, including the five offenders', () => {
    expect(PAGES).toHaveLength(36 + 4 * 4);
    expect(BORDER_HUBS).toHaveLength(16);
    expect(REPORTED_OFFENDERS).toEqual([
      '/stipendio-svizzera-formazione-superiore/',
      '/de/durchschnittslohn-schweiz-50-jahre/',
      '/en/salary-switzerland-university-degree/',
      '/vivere-in-francia-lavorare-in-svizzera/',
      '/vivere-in-germania-lavorare-in-svizzera/',
    ]);
    for (const p of REPORTED_OFFENDERS) expect(byPath(p).path).toBe(p);
  });
});

describe('#5312 §3 diagnosed the cause wrongly', () => {
  // The five offenders lost their brand suffix — that, not a 66-char
  // overflow, is what collapsed <title> onto <h1>.
  it.each(REPORTED_OFFENDERS)('%s ships a <title> with no brand suffix', (path) => {
    expect(byPath(path).title).not.toContain(TITLE_BRAND_SUFFIX.trim());
  });

  it('all five headlines are now WELL INSIDE the 66-char cap', () => {
    // If #5312 §3 were right ("headline exceeds 66 chars on its own"), every
    // one of these would be > TITLE_MAX_CHARS. None is: `/en/salary-
    // switzerland-university-degree/` used to be the one exception — its
    // headline came from the education-level dataset's EN name ("University
    // / University of Applied Sciences", 45 char, the odd one out among four
    // otherwise-compact labels), pushing "Salary in Switzerland with {name}"
    // to 73 char. Issue #5355 shortened that one dataset label (`name.en` in
    // scripts/update-bfs-salary-by-age.mjs's `universita` entry) to
    // "University / Applied Sciences" — matching the DE/FR siblings'
    // compact two-noun shape — so the headline is now 58 char, well inside
    // the cap. It still duplicates <h1> for the 45-char brand-suffix reason
    // this describe block is about, not a 66-char overflow.
    const overCap = REPORTED_OFFENDERS.filter(
      (p) => stripBrand(byPath(p).title).length > TITLE_MAX_CHARS,
    );
    expect(overCap).toEqual([]);

    // The real boundary: headline + 21-char brand > 66, i.e. headline > 45.
    for (const p of REPORTED_OFFENDERS) {
      const headline = stripBrand(byPath(p).title);
      expect(
        headline.length + TITLE_BRAND_SUFFIX.length,
        `${p} headline ${headline.length} chars`,
      ).toBeGreaterThan(TITLE_MAX_CHARS);
    }
  });
});

describe('border-municipality hubs — one pattern, all four corridors', () => {
  it('every border hub <title> fits the SERP cap', () => {
    // The Liechtenstein four were 78-96 chars, the only corridor that had
    // drifted off the family shape; they are rewritten at the source in
    // data/liechtensteinCorridorContent.ts. If this fails, the fix is a
    // SHORTER AUTHORED HEADLINE there — never a render-time cut, never `…`
    // (build-plugins/shared/titleSuffix.ts module header).
    const over = BORDER_HUBS.filter((p) => p.title.length > TITLE_MAX_CHARS).map(
      (p) => `${p.path} (${p.title.length})`,
    );
    expect(over).toEqual([]);
  });

  it('no border hub headline was shortened with an ellipsis', () => {
    for (const p of BORDER_HUBS) {
      expect(p.title, p.path).not.toMatch(/[…]|\.\.\.$/);
      expect(p.h1, p.path).not.toMatch(/[…]|\.\.\.$/);
    }
  });

  it('all 16 hubs differentiate — no corridor left behind (AGENTS.md rule 6)', () => {
    const duplicates = BORDER_HUBS.filter(
      (p) => p.h1.toLowerCase() === p.title.toLowerCase(),
    ).map((p) => p.path);
    expect(duplicates).toEqual([]);
  });
});

describe('h1-title-duplicates — the five producers no longer emit a duplicate', () => {
  it.each(PAGES.map((p) => [p.path, p] as const))(
    '%s: <h1> differs from <title>',
    (_path, page) => {
      expect(page.title).not.toBe('');
      expect(page.h1).not.toBe('');
      // The exact predicate of scripts/audit-h1-title-duplicates.mjs.
      expect(page.h1.toLowerCase()).not.toBe(page.title.toLowerCase());
    },
  );

  it('differentiates the H1 without touching the <title>', () => {
    for (const page of PAGES) {
      const headline = stripBrand(page.title);
      // The headline survives verbatim at the head of the H1: the remedy
      // appended, it did not rewrite or amputate. This is the assertion that
      // fails if someone "fixes" the duplicate by shortening the title.
      expect(page.h1.startsWith(headline), `${page.path}: h1=${page.h1}`).toBe(true);
      expect(page.h1.length, page.path).toBeGreaterThan(headline.length);
      // No mid-headline ellipsis anywhere — build-plugins/shared/titleSuffix.ts
      // module header, the /calcola-stipendio/ CTR collapse.
      expect(page.title, page.path).not.toContain('…');
      expect(page.h1, page.path).not.toContain('…');
    }
  });
});

describe('the call sites keep the shape that makes the fix work', () => {
  const bfs = readFileSync(resolve('build-plugins/bfsSalaryLandingsPlugin.ts'), 'utf8');
  const fr = readFileSync(resolve('build-plugins/frenchBorderMunicipalityPagesPlugin.ts'), 'utf8');
  const de = readFileSync(resolve('build-plugins/germanBorderMunicipalityPagesPlugin.ts'), 'utf8');
  const at = readFileSync(resolve('build-plugins/austrianBorderMunicipalityPagesPlugin.ts'), 'utf8');
  const li = readFileSync(
    resolve('build-plugins/liechtensteinBorderMunicipalityPagesPlugin.ts'),
    'utf8',
  );

  it('bfsSalaryLandingsPlugin compares against the title the page really ships', () => {
    // `title` is the exact string renderCommon hands to buildSeoPageHtml.
    // differentiateH1FromTitle RETURNS ITS FIRST ARGUMENT, so `h1` must come
    // first — inverted, the page would silently start shipping the title as
    // its H1.
    expect(bfs).toContain('const h1Display = differentiateH1FromTitle(h1, title, locale);');
    expect(bfs).not.toContain('differentiateH1FromTitle(title, h1, locale)');
    expect(bfs).toContain('${esc(h1Display)}</h1>');
    // The <title> argument is untouched.
    expect(bfs).toContain('    title,\n    description,\n    canonicalUrl,');
  });

  // All four corridors, one table: a sibling that stops matching this shape
  // is the exact way the pattern half-closes again (AGENTS.md rule 6).
  it.each([
    ['french', fr, 'c.hubTitle'],
    ['german', de, 'c.hubTitle'],
    ['austrian', at, 'c.hubTitle'],
    ['liechtenstein', li, 'content.hubTitle'],
  ])('%s border-municipality hub differentiates its H1 only', (_name, src, titleExpr) => {
    expect(src).toContain(`const hubH1 = differentiateH1FromTitle(${titleExpr}, ${titleExpr}, locale);`);
    expect(src).toContain('${esc(hubH1)}</h1>');
    // The hub still ships the untagged copy string as its <title>, and the
    // cross-page link labels that reuse the same field stay untagged too.
    expect(src).toContain(`title: ${titleExpr},`);
    expect(src).not.toContain(`${titleExpr}</h1>`);
  });

  it('the Liechtenstein hub headlines are capped at the source, not at render', () => {
    const content = readFileSync(resolve('data/liechtensteinCorridorContent.ts'), 'utf8');
    const authored = [...content.matchAll(/^\s*hubTitle: '((?:[^'\\]|\\.)*)',/gm)].map(
      (m) => m[1],
    );
    expect(authored).toHaveLength(4);
    for (const s of authored) {
      expect(s.length, s).toBeLessThanOrEqual(TITLE_MAX_CHARS);
      expect(s).not.toContain('…');
    }
    // The plugin must not have grown a truncation of its own in response.
    expect(li).not.toContain('truncateHeadline(content.hubTitle');
    expect(li).not.toContain('composePlaceTitle([content.hubTitle');
  });
});
