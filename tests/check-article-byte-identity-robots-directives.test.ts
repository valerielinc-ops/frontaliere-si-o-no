/**
 * Pins the SECOND normalization scripts/check-article-byte-identity.mjs
 * applies before comparing (issue #5444): the ORDER of the comma-separated
 * directives inside the `content=` of a robots-family `<meta>`, and strictly
 * nothing else.
 *
 * WHY THIS FILE EXISTS. Absorbing the `<meta>` TAG order (PR #5489, pinned by
 * tests/check-article-byte-identity-head-order.test.ts) took the audit from
 * 0/20 verified-identical to 1/16 — and revealed the layer underneath. Run
 * 31328174202 diverged at offset 713 of the already-canonicalized text on:
 *
 *   fast: content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"
 *   live: content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1"
 *
 * The same five directives, permuted. Nothing else on the surrounding lines
 * differed. This is the third finding of one family, so the assertions below
 * are written to hold for the family and not for the instance.
 *
 * The failure mode to guard against is the OPPOSITE one, and it is silent:
 * normalize a little too much — sort every comma-separated `content=`, strip
 * the qualifiers, compare directive NAMES without their values — and the audit
 * stops being able to see the very class of fault it exists for. A page served
 * by a stale renderer that says `max-snippet:50`, or that has quietly gained a
 * `noindex`, would then read as a comfortable green forever. So the assertions
 * come in pairs: same directives reordered must compare EQUAL, and any change
 * to WHAT the directives say must compare DIFFERENT.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalizeRobotsDirectiveOrder,
  canonicalizeForComparison,
} from '../scripts/check-article-byte-identity.mjs';

const page = (head: string, body = '<p>corpo</p>') =>
  `<!doctype html>\n<html lang="it">\n<head>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

const robots = (content: string) => `<meta name="robots" content="${content}">`;

/** The two literals the repo actually holds, verbatim. */
const FAST_ROBOTS = 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1';
const LIVE_ROBOTS = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

const OG_TITLE = '<meta property="og:title" content="Frontalieri, la stretta sui costi">';
const CANONICAL = '<link rel="canonical" href="https://frontaliereticino.ch/blog/x/">';

/** The comparison the script actually performs on its last pass. */
const comparesEqual = (a: string, b: string) =>
  canonicalizeForComparison(a) === canonicalizeForComparison(b);

describe('robots directive ORDER is ignored', () => {
  it('treats the exact pair observed on run 31328174202 as identical', () => {
    const fast = page([OG_TITLE, robots(FAST_ROBOTS), CANONICAL].join('\n'));
    const live = page([OG_TITLE, robots(LIVE_ROBOTS), CANONICAL].join('\n'));

    expect(fast).not.toBe(live); // precondition: raw bytes really do differ
    expect(fast.length).toBe(live.length); // …and only by permutation
    expect(comparesEqual(fast, live)).toBe(true);
  });

  it('ignores order for directives of different lengths, in any permutation', () => {
    // Not just the observed swap: every arrangement of one multiset collapses
    // to the same canonical form. Lengths differ between tokens, which is
    // where a naive in-place sort would corrupt the separators.
    const parts = ['index', 'follow', 'max-snippet:-1', 'max-image-preview:large'];
    const canon = canonicalizeRobotsDirectiveOrder(page(robots(parts.join(', '))));
    const permutations = [
      ['follow', 'index', 'max-image-preview:large', 'max-snippet:-1'],
      ['max-image-preview:large', 'max-snippet:-1', 'follow', 'index'],
      ['max-snippet:-1', 'index', 'max-image-preview:large', 'follow'],
    ];
    for (const p of permutations) {
      expect(canonicalizeRobotsDirectiveOrder(page(robots(p.join(', '))))).toBe(canon);
    }
  });

  it('is a permutation: same length, same directives, surroundings verbatim', () => {
    const html = page([OG_TITLE, robots(FAST_ROBOTS), CANONICAL].join('\n'));
    const canon = canonicalizeRobotsDirectiveOrder(html);

    expect(canon.length).toBe(html.length);
    for (const directive of FAST_ROBOTS.split(', ')) {
      expect(canon).toContain(directive);
    }
    // Only the value moved: the tag around it, and everything else, is copied
    // through character for character.
    expect(canon).toContain('<meta name="robots" content="');
    expect(canon).toContain(OG_TITLE);
    expect(canon).toContain(CANONICAL);
    expect(canon.startsWith('<!doctype html>\n<html lang="it">\n<head>\n')).toBe(true);
    expect(canon.endsWith('</head>\n<body>\n<p>corpo</p>\n</body>\n</html>\n')).toBe(true);
  });

  it('is idempotent and stable regardless of the input order', () => {
    const a = canonicalizeRobotsDirectiveOrder(page(robots(FAST_ROBOTS)));
    const b = canonicalizeRobotsDirectiveOrder(page(robots(LIVE_ROBOTS)));
    expect(a).toBe(b);
    expect(canonicalizeRobotsDirectiveOrder(a)).toBe(a);
  });

  it('composes with the tag-order pass: both reorderings at once still match', () => {
    // The realistic shape once both renderers are free to disagree: the tags
    // are in a different sequence AND the robots directives are permuted
    // inside one of them. Neither pass alone closes this.
    const fast = page([OG_TITLE, robots(FAST_ROBOTS), CANONICAL].join('\n'));
    const live = page([robots(LIVE_ROBOTS), OG_TITLE, CANONICAL].join('\n'));

    expect(fast).not.toBe(live);
    expect(comparesEqual(fast, live)).toBe(true);
  });
});

describe('robots directive VALUES are still compared exactly', () => {
  // The half that keeps the audit able to detect the fault it exists for.
  // Each case differs from the reference by exactly one thing, and each must
  // survive canonicalization as a difference.
  const reference = page([OG_TITLE, robots(FAST_ROBOTS), CANONICAL].join('\n'));
  const withRobots = (content: string) => page([OG_TITLE, robots(content), CANONICAL].join('\n'));

  it('a changed qualifier value stays different (max-snippet:-1 vs max-snippet:50)', () => {
    const stale = withRobots(
      'index, follow, max-snippet:50, max-image-preview:large, max-video-preview:-1',
    );
    expect(comparesEqual(reference, stale)).toBe(false);
  });

  it('a value change survives a simultaneous reorder — the nasty one', () => {
    // Absorbing the permutation must not absorb the value along with it. This
    // is the case a `.sort()` on parsed directive NAMES would silently pass.
    const stale = withRobots(
      'max-image-preview:large, max-snippet:50, follow, index, max-video-preview:-1',
    );
    expect(comparesEqual(reference, stale)).toBe(false);
  });

  it('noindex appearing stays different, in any position', () => {
    expect(
      comparesEqual(
        reference,
        withRobots('noindex, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1'),
      ),
    ).toBe(false);
    // …including sorted to the end, where a permutation-blind comparison is
    // most tempting to get wrong.
    expect(
      comparesEqual(
        reference,
        withRobots('index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1, noindex'),
      ),
    ).toBe(false);
  });

  it('a missing directive stays different', () => {
    expect(
      comparesEqual(reference, withRobots('index, follow, max-snippet:-1, max-image-preview:large')),
    ).toBe(false);
  });

  it('an extra directive stays different', () => {
    expect(
      comparesEqual(
        reference,
        withRobots(
          'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1, nositelinkssearchbox',
        ),
      ),
    ).toBe(false);
  });

  it('a duplicated directive stays different (multiset, not set)', () => {
    expect(
      comparesEqual(
        reference,
        withRobots('index, index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1'),
      ),
    ).toBe(false);
  });

  it('does not normalize whitespace — index,follow and index, follow stay different', () => {
    // Not an oversight: absorbing separator differences would be a second,
    // unargued normalization. A spurious mismatch is the safe direction.
    expect(comparesEqual(withRobots('index,follow'), withRobots('index, follow'))).toBe(false);
  });

  it('does not lowercase or otherwise rewrite a directive', () => {
    expect(comparesEqual(withRobots('index, follow'), withRobots('INDEX, follow'))).toBe(false);
  });
});

describe('scope: the robots-family allowlist, and nothing else', () => {
  const permuteCsv = (name: string, a: string, b: string) => ({
    one: page(`<meta name="${name}" content="${a}">`),
    two: page(`<meta name="${name}" content="${b}">`),
  });

  it('applies to the allowlisted crawler tokens (robots, googlebot, bingbot, msnbot)', () => {
    // index.html emits bingbot and msnbot with the identical grammar; the
    // googlebot forms are Google's per-agent version of the same tag.
    for (const name of ['robots', 'googlebot', 'googlebot-news', 'bingbot', 'msnbot']) {
      const { one, two } = permuteCsv(name, 'index, follow, max-snippet:-1', 'max-snippet:-1, follow, index');
      expect(one).not.toBe(two);
      expect(comparesEqual(one, two)).toBe(true);
    }
  });

  it('does NOT reorder a description — commas there are prose', () => {
    // The trap a generic "sort any comma-separated content=" rule would fall
    // into. Reordering clauses of a sentence IS a content change.
    const { one, two } = permuteCsv(
      'description',
      'Imposta alla fonte, AVS, LPP: la guida 2026',
      'AVS, Imposta alla fonte, LPP: la guida 2026',
    );
    expect(comparesEqual(one, two)).toBe(false);
  });

  it('does NOT reorder keywords, citation_keywords or viewport', () => {
    // All three are comma-separated and all three are emitted by index.html.
    for (const name of ['keywords', 'citation_keywords']) {
      const { one, two } = permuteCsv(name, 'frontaliere, ticino, imposta', 'ticino, imposta, frontaliere');
      expect(comparesEqual(one, two)).toBe(false);
    }
    const { one, two } = permuteCsv(
      'viewport',
      'width=device-width, initial-scale=1.0, viewport-fit=cover',
      'initial-scale=1.0, viewport-fit=cover, width=device-width',
    );
    expect(comparesEqual(one, two)).toBe(false);
  });

  it('keys on name=, not property= — property="robots" is not a robots tag', () => {
    const one = page('<meta property="robots" content="index, follow, max-snippet:-1">');
    const two = page('<meta property="robots" content="max-snippet:-1, follow, index">');
    expect(comparesEqual(one, two)).toBe(false);
  });

  it('reads name= by walking attributes, not by substring — "name=robots" inside a value does not qualify', () => {
    // The same trap the tag-order pass documents for "charset=". An article
    // description is free text and may contain anything; if the detector
    // searched for the substring, this tag's commas would start being sorted
    // and a real content change inside it would stop being visible — for that
    // one article only, which is the worst kind of intermittent.
    const one = page('<meta name="description" content="scrivi name=robots, poi index, poi follow">');
    const two = page('<meta name="description" content="poi follow, scrivi name=robots, poi index">');
    expect(comparesEqual(one, two)).toBe(false);
  });

  it('does not reorder directives of a robots <meta> living in the <body>', () => {
    const head = OG_TITLE;
    const one = page(head, `<div>${robots(FAST_ROBOTS)}</div>`);
    const two = page(head, `<div>${robots(LIVE_ROBOTS)}</div>`);
    expect(comparesEqual(one, two)).toBe(false);
  });

  it('leaves a robots tag with a single directive, or none, untouched', () => {
    const single = page(robots('noindex'));
    expect(canonicalizeRobotsDirectiveOrder(single)).toBe(single);
    const empty = page('<meta name="robots" content="">');
    expect(canonicalizeRobotsDirectiveOrder(empty)).toBe(empty);
    const valueless = page('<meta name="robots">');
    expect(canonicalizeRobotsDirectiveOrder(valueless)).toBe(valueless);
  });

  it('passes documents without a usable <head> through untouched', () => {
    const noHead = `<!doctype html>\n<html><body>${robots(FAST_ROBOTS)}</body></html>`;
    expect(canonicalizeRobotsDirectiveOrder(noHead)).toBe(noHead);
    const unclosed = `<!doctype html>\n<html><head>\n${robots(FAST_ROBOTS)}\n`;
    expect(canonicalizeRobotsDirectiveOrder(unclosed)).toBe(unclosed);
  });

  it('handles single quotes, an XHTML self-closing tag and attribute order', () => {
    const one = page(`<meta content='${FAST_ROBOTS}' name='robots' />`);
    const two = page(`<meta content='${LIVE_ROBOTS}' name='robots' />`);
    expect(one).not.toBe(two);
    expect(comparesEqual(one, two)).toBe(true);
  });

  it('handles the UNQUOTED minified form dist/ actually ships', () => {
    // PR #478's `removeAttributeQuotes` turns the tag into
    // `<meta name=robots content=index,follow>` — the shape
    // build-plugins/constants.ts's ROBOTS_META_TAG_RE already documents. The
    // attribute walk has to survive it, or the normalization silently stops
    // applying to exactly the minified output this audit compares.
    const one = page('<meta name=robots content=index,follow,max-snippet:-1>');
    const two = page('<meta name=robots content=max-snippet:-1,follow,index>');
    expect(one).not.toBe(two);
    expect(comparesEqual(one, two)).toBe(true);
    // …and the value half still holds in that form.
    const changed = page('<meta name=robots content=index,follow,max-snippet:50>');
    expect(comparesEqual(one, changed)).toBe(false);
  });
});
