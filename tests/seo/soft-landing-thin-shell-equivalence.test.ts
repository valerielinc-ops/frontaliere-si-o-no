/**
 * soft-landing-thin-shell-equivalence.test.ts
 *
 * `buildSoftLandingThinHtml` rewrites 139 223 of the 183 445 expired-job
 * soft-landings per build. It used to do that by materialising a
 * script/style-stripped copy of the whole document (twice), JSON.parse-ing
 * every <script> body (throwing on the five that are not JSON), and running
 * two more whole-document `.replace()` calls — 219 s on the `it` leg of run
 * 31065272867, 12 % of jobsSeoPagesPlugin.
 *
 * The optimised version walks the document once and splices the result in a
 * single pass, and it is only allowed to do that because it produces the
 * SAME BYTES. This file pins that: `buildSoftLandingThinHtmlReference` and
 * `extractJobPostingFactsReference` are the pre-optimisation code, kept
 * executable in their own modules so they cannot drift into agreeing with a
 * bug, and every input must round-trip to an identical string through both.
 *
 * A thin shell that differed would not fail loudly — it would ship a page
 * with the wrong <h1>, a missing `window.__THIN_SHELL__` signal (which
 * disables the self-heal promotion loop that lifts a thinned page back to
 * full), or a mangled JobPosting fact sentence. All three are invisible to
 * every other gate in the repo.
 *
 * Guard value — every mutation below was applied to the two modules and this
 * file turned red:
 *   - fast-path extractH1 stops skipping <script> regions      → 24 failures
 *   - <style> no longer defers to the reference                →  1 failure
 *   - $-in-replacement guard dropped from the splice           →  1 failure
 *   - head marker inserted at the LAST </head>                 →  1 failure
 *   - <h1> open-tag markup guard removed                       →  2 failures
 *   - `{` precondition inverted (no JSON-LD ever parsed)       → 48 failures
 *   - close tag searched from 0 instead of the body start      →  2 failures
 *   - JSON whitespace skip stops honouring \n                  →  2 failures
 *   - h1 content skips the text run before a <script>          →  2 failures
 *   - splice keeps the original article alongside the thin one → 25 failures
 *
 * One mutation SURVIVED and is documented rather than papered over: replacing
 * the final `return extractH1Reference(html)` (the `<h1` with no `</h1>` in
 * surviving text) with `return ''`. It is unreachable-as-different — if no
 * `</h1>` follows the first `<h1` outside a script, none follows any later
 * `<h1` either, so the reference regex also fails everywhere and returns ''.
 * The deferral stays because it costs nothing and keeps the fast path total.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSoftLandingThinHtml,
  buildSoftLandingThinHtmlReference,
} from '../../build-plugins/shared/softLandingThinShell';
import {
  extractJobPostingFacts,
  extractJobPostingFactsReference,
} from '../../build-plugins/shared/jobPostingFacts';

// ── fixtures ─────────────────────────────────────────────────────────────

const LOCALES = ['it', 'en', 'de', 'fr'];

function page(opts: {
  h1?: string;
  company?: string;
  location?: string;
  extraHead?: string;
  extraBody?: string;
  article?: string;
} = {}): string {
  const h1 = opts.h1 ?? 'Infermiere SOPRACENERI — EOC';
  const jobPosting = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: h1,
    hiringOrganization: { '@type': 'Organization', name: opts.company ?? 'EOC' },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: opts.location ?? 'Bellinzona' } },
  });
  const breadcrumb = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [{ '@type': 'ListItem', position: 1, name: 'Home', item: 'https://frontaliereticino.ch/' }],
  });
  const article = opts.article ?? `<article class=ft-static-article>\n<h1>${h1}</h1>\n<p>corpo lungo</p>\n<section><h2>Simili</h2><ul><li><a href="/x/">a</a></li></ul></section>\n</article>`;
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<link rel="canonical" href="https://frontaliereticino.ch/cerca-lavoro-ticino/slug-x/">
<script src="/assets/early-boot-a1.js" defer></script>
<script type="application/ld+json">${breadcrumb}</script>
<script type="application/ld+json">${jobPosting}</script>
<script>window.__EXPIRED_JOB_DATA__={"slug":"slug-x","title":"<h1>NOT THE REAL H1</h1>"};</script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}</script>
${opts.extraHead ?? ''}
</head>
<body>
<div id="root">
<nav class="ft-n"><a href="/">Frontaliere Ticino</a></nav>
${article}
<footer class="ft-f">&copy; 2026</footer>
</div>
${opts.extraBody ?? ''}
<script>window.__STATIC_BODY_HTML__=(document.querySelector('.ft-static-article')||{}).innerHTML||'';</script><script type="module" src="/assets/index-1.js"></script>
</body>
</html>`;
}

const CASES: Array<[string, string]> = [
  ['plain soft-landing', page()],
  ['h1 text also present inside a script', page({ h1: 'Autista C/E' })],
  ['accented + entity h1', page({ h1: 'Käufer &amp; Verkäufer <em>senior</em>' })],
  ['dollar signs in h1', page({ h1: 'Stipendio $& $1 $` $\' $$ lordo' })],
  ['dollar signs in company', page({ company: 'A$B & Co', location: 'L$M' })],
  ['no canonical link', page().replace(/<link rel="canonical"[^>]*>/, '')],
  ['no </head>', page().replace('</head>', '')],
  ['no JobPosting json-ld', page().replace(/<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"JobPosting[\s\S]*?<\/script>/, '')],
  ['json-ld with leading whitespace', page({ extraHead: '<script type="application/ld+json">\n\t  {"@type":"JobPosting","hiringOrganization":{"name":"WS Co"}}\n</script>' })],
  // The ONLY JobPosting on the page is newline-indented: if the JSON
  // whitespace skip stopped honouring \n, the facts sentence would silently
  // vanish from every page whose JSON-LD is pretty-printed.
  ['newline-indented json-ld is the only JobPosting', page({ h1: 'Solo WS' })
    .replace(/<script type="application\/ld\+json">\{"@context":"https:\/\/schema\.org","@type":"JobPosting[\s\S]*?<\/script>/, '<script type="application/ld+json">\n\t  {"@type":"JobPosting","hiringOrganization":{"name":"Solo WS Co"},"jobLocation":{"address":{"addressLocality":"Airolo"}}}\n  </script>')],
  ['non-object json scripts first', page({ extraHead: '<script>[1,2,3]</script><script>42</script><script>"s"</script><script>null</script><script>true</script>' })],
  ['empty and whitespace-only scripts', page({ extraHead: '<script></script><script>   </script>' })],
  ['style block in head', page({ extraHead: '<style>h1{color:red}</style>' })],
  ['style containing a script', page({ extraHead: '<style>a<script>b</style>c</script>' })],
  ['script containing a style', page({ extraHead: '<script>a<style>b</script>c</style>' })],
  ['unterminated script before the article', page({ extraHead: '<script>oops<h1>IN OPEN SCRIPT</h1>' })],
  ['orphan </script> with no opener', page({ extraHead: '</script>' })],
  ['uppercase tags', '<HTML><HEAD></HEAD><BODY><ARTICLE CLASS=ft-static-article><H1 data-x="1">Upper Case</H1></ARTICLE></BODY></HTML>'],
  ['quoted article class', page({ article: '<article class="ft-static-article" data-x="1"><h1>Quoted</h1></article>' })],
  ['near-miss article class', page({ article: '<article class=ft-static-article-xyz><h1>NearMiss</h1></article>' })],
  ['no article at all', page({ article: '<div><h1>NoArticle</h1></div>' })],
  ['no h1 anywhere', page({ article: '<article class=ft-static-article><p>niente</p></article>' })],
  ['h1 never closed', page({ article: '<article class=ft-static-article><h1>mai chiuso</article>' })],
  ['h1 straddling a script', page({ article: '<article class=ft-static-article><h1>abc<script>q</script>def</h1></article>' })],
  ['</h1> hidden inside a script', page({ article: '<article class=ft-static-article><h1>abc<script></h1></script>def</h1></article>' })],
  ['h1 before the article, in the nav', page({ extraHead: '', article: '<article class=ft-static-article><h1>Second</h1></article>' }).replace('<nav class="ft-n">', '<nav class="ft-n"><h1>NavH1</h1>')],
  ['</head> also appearing escaped in body', page({ extraBody: '&lt;/head&gt;' })],
  ['script opening inside the h1 tag itself', page({ article: '<article class=ft-static-article><h1 data-x="<script>q</script>y">Tag</h1></article>' })],
  ['style opening inside the h1 tag itself', page({ article: '<article class=ft-static-article><h1 data-x="<style>q</style>y">Tag2</h1></article>' })],
  ['h1 open with no > at all', page({ article: '<article class=ft-static-article><h1 data-x="unterminated</article>' })],
  ['empty document', ''],
  ['not html at all', 'just some text'],
];

// Randomised structural mutations of a real page: markup tokens spliced at
// arbitrary offsets, which is how the pathological shapes the fast path has
// to defer on get generated without hand-writing each one.
function mutate(source: string, seed: number): string {
  const tokens = ['</script>', '<script', '<script>', '<h1', '</h1>', '</head>', '<article', '</article>', '<style', '</style>', '<h1 x=', '>'];
  let out = source;
  let s = seed;
  const rnd = (n: number) => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let i = 0; i < 3; i++) {
    const at = rnd(out.length + 1);
    out = out.slice(0, at) + tokens[rnd(tokens.length)] + out.slice(at);
  }
  return out;
}

describe('soft-landing thin shell — output equivalence', () => {
  it.each(CASES)('%s: byte-identical to the pre-optimisation implementation, all 4 locales', (_name, html) => {
    for (const locale of LOCALES) {
      expect(buildSoftLandingThinHtml(html, locale)).toBe(buildSoftLandingThinHtmlReference(html, locale));
    }
  });

  it.each(CASES)('%s: extractJobPostingFacts matches the parse-every-script reference', (_name, html) => {
    expect(extractJobPostingFacts(html)).toEqual(extractJobPostingFactsReference(html));
  });

  it('rewrites exactly the pages the article regex matches, and leaves the rest byte-identical', () => {
    const articleRe = /<article\s+class=["']?ft-static-article(?=[\s>"'])[^>]*>[\s\S]*?<\/article>/i;
    for (const [name, html] of CASES) {
      const out = buildSoftLandingThinHtml(html, 'it');
      if (articleRe.test(html)) {
        expect(out, name).not.toBe(html);
        expect(out, name).toContain('<article class="ft-static-article">');
      } else {
        expect(out, name).toBe(html);
      }
    }
  });

  it('adds the __THIN_SHELL__ signal exactly once, at the first </head>', () => {
    const out = buildSoftLandingThinHtml(page(), 'it');
    expect(out.split('window.__THIN_SHELL__=1;').length - 1).toBe(1);
    const marker = out.indexOf('window.__THIN_SHELL__=1;');
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(out.indexOf('</head>'));
    expect(marker).toBeLessThan(out.indexOf('<article class="ft-static-article">'));
    // and never on a page with no </head>
    const noHead = page().replace('</head>', '');
    expect(buildSoftLandingThinHtml(noHead, 'it')).not.toContain('__THIN_SHELL__');
  });

  it('preserves the head verbatim up to the inserted signal', () => {
    const src = page();
    const out = buildSoftLandingThinHtml(src, 'it');
    const headSrc = src.slice(0, src.indexOf('</head>'));
    expect(out.startsWith(headSrc)).toBe(true);
    // the JobPosting JSON-LD and the SPA data blob survive untouched
    expect(out).toContain('"@type":"JobPosting"');
    expect(out).toContain('window.__EXPIRED_JOB_DATA__=');
  });

  it('splices the real employer and location into the thin prose', () => {
    const out = buildSoftLandingThinHtml(page({ company: 'Coop Ticino', location: 'Mendrisio' }), 'it');
    expect(out).toContain('La posizione era presso Coop Ticino, Mendrisio.');
    // …and reads them from the JSON-LD, not from the discarded body
    const noBodyFacts = page({ company: 'Migros', location: 'Locarno', article: '<article class=ft-static-article><h1>X</h1></article>' });
    expect(buildSoftLandingThinHtml(noBodyFacts, 'de')).toContain('Die Stelle war bei Migros, Locarno.');
  });

  it.each(LOCALES)('%s: stays byte-stable across repeated calls (no regex lastIndex leak)', (locale) => {
    const src = page();
    const first = buildSoftLandingThinHtml(src, locale);
    for (let i = 0; i < 5; i++) {
      expect(buildSoftLandingThinHtml(src, locale)).toBe(first);
    }
    // interleave other documents — a shared /g regex would desynchronise here
    for (const [, other] of CASES) buildSoftLandingThinHtml(other, locale);
    expect(buildSoftLandingThinHtml(src, locale)).toBe(first);
  });

  it('survives 1500 randomised structural mutations byte-for-byte', () => {
    const base = page();
    let checked = 0;
    let rewritten = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const html = mutate(base, seed);
      expect(extractJobPostingFacts(html), `seed ${seed}`).toEqual(extractJobPostingFactsReference(html));
      for (const locale of LOCALES) {
        const out = buildSoftLandingThinHtml(html, locale);
        expect(out, `seed ${seed} / ${locale}`).toBe(buildSoftLandingThinHtmlReference(html, locale));
        if (out !== html) rewritten++;
        checked++;
      }
    }
    expect(checked).toBe(6000);
    // Guard the guard: mutations that destroy every article would make the
    // comparison above trivially true on both sides.
    expect(rewritten).toBeGreaterThan(3000);
  });
});
