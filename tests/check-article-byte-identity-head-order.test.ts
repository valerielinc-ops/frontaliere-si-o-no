/**
 * Pins the ONE normalization scripts/check-article-byte-identity.mjs applies
 * before comparing (issue #5444): the ORDER of `<meta>` tags inside `<head>`,
 * and strictly nothing else.
 *
 * WHY THIS FILE EXISTS AT ALL. The audit that consumes that comparison
 * (scripts/audit-article-corpus-drift.mjs) reported `content-mismatch` on
 * 20/20 sampled articles across all four locales. It was not drift: every
 * pair had the IDENTICAL byte length with the first divergence inside the
 * `<meta>` block — the two render paths emit the same tags in a different
 * sequence. Making the comparison order-insensitive is what turns that audit
 * from useless back into the only probe covering article pages.
 *
 * The failure mode to guard against is the OPPOSITE one, and it is silent:
 * normalize a little too much — compare `<head>` as a set of tag NAMES, strip
 * `content=`, lowercase, collapse whitespace — and the audit stops being able
 * to see the very class of fault it exists for, a page served by a stale
 * renderer whose meta VALUES differ. It would then report a comfortable green
 * forever. So the assertions below come in pairs: same tags reordered must
 * compare EQUAL, and any change to what a tag says must compare DIFFERENT.
 */
import { describe, it, expect } from 'vitest';
import { canonicalizeHeadMetaOrder } from '../scripts/check-article-byte-identity.mjs';

const page = (head: string, body = '<p>corpo</p>') =>
  `<!doctype html>\n<html lang="it">\n<head>\n${head}\n</head>\n<body>\n${body}\n</body>\n</html>\n`;

const OG_TITLE = '<meta property="og:title" content="Frontalieri, la stretta sui costi">';
const OG_LOCALE = '<meta property="og:locale" content="it_CH">';
const OG_SITE = '<meta property="og:site_name" content="Frontaliere Ticino">';
const ROBOTS = '<meta name="robots" content="index, follow, max-snippet:-1">';
const FB_APP = '<meta property="fb:app_id" content="891036063797338">';
const PUBLISHED = '<meta property="article:published_time" content="2026-08-01T16:35:29+00:00">';

/** The comparison the script actually performs, second pass. */
const comparesEqual = (a: string, b: string) =>
  canonicalizeHeadMetaOrder(a) === canonicalizeHeadMetaOrder(b);

describe('canonicalizeHeadMetaOrder — ORDER is ignored', () => {
  it('treats the same <meta> tags in a different order as identical', () => {
    // The real shape observed on run 31324948161: identical length, identical
    // tags, permuted sequence.
    const fast = page([OG_TITLE, OG_LOCALE, OG_SITE, ROBOTS, FB_APP, PUBLISHED].join('\n'));
    const live = page([OG_TITLE, ROBOTS, PUBLISHED, OG_LOCALE, FB_APP, OG_SITE].join('\n'));

    expect(fast).not.toBe(live); // precondition: raw bytes really do differ
    expect(fast.length).toBe(live.length); // …and only by permutation
    expect(comparesEqual(fast, live)).toBe(true);
  });

  it('is a permutation: it never adds, drops or edits a character of any tag', () => {
    const html = page([OG_TITLE, OG_LOCALE, ROBOTS, FB_APP].join('\n'));
    const canon = canonicalizeHeadMetaOrder(html);

    expect(canon.length).toBe(html.length);
    for (const tag of [OG_TITLE, OG_LOCALE, ROBOTS, FB_APP]) {
      expect(canon).toContain(tag);
    }
    // Everything that is not a movable <meta> is copied through verbatim.
    expect(canon.startsWith('<!doctype html>\n<html lang="it">\n<head>\n')).toBe(true);
    expect(canon.endsWith('</head>\n<body>\n<p>corpo</p>\n</body>\n</html>\n')).toBe(true);
  });

  it('is idempotent and stable regardless of the input order', () => {
    const a = canonicalizeHeadMetaOrder(page([ROBOTS, OG_TITLE, FB_APP].join('\n')));
    const b = canonicalizeHeadMetaOrder(page([FB_APP, ROBOTS, OG_TITLE].join('\n')));
    expect(a).toBe(b);
    expect(canonicalizeHeadMetaOrder(a)).toBe(a);
  });
});

describe('canonicalizeHeadMetaOrder — VALUES are still compared exactly', () => {
  // This is the half that keeps the audit able to detect the fault it exists
  // for. Each case is a page whose <meta> MULTISET differs from the reference
  // — by one character, by one tag, by one attribute — and each must survive
  // canonicalization as a difference.
  const reference = page([OG_TITLE, OG_LOCALE, ROBOTS, FB_APP].join('\n'));

  it('a different content= value stays different (one character is enough)', () => {
    const stale = page(
      [OG_TITLE, '<meta property="og:locale" content="it_IT">', ROBOTS, FB_APP].join('\n'),
    );
    expect(comparesEqual(reference, stale)).toBe(false);
  });

  it('a different content= value stays different even when the order also changed', () => {
    // The nasty one: a stale renderer that BOTH reorders and changes a value.
    // Absorbing the reorder must not absorb the value with it.
    const stale = page(
      [ROBOTS, '<meta property="og:title" content="Frontalieri, la stretta sui COSTI">', FB_APP, OG_LOCALE].join('\n'),
    );
    expect(comparesEqual(reference, stale)).toBe(false);
  });

  it('a missing tag stays different', () => {
    expect(comparesEqual(reference, page([OG_TITLE, OG_LOCALE, ROBOTS].join('\n')))).toBe(false);
  });

  it('an extra tag stays different', () => {
    expect(comparesEqual(reference, page([OG_TITLE, OG_LOCALE, ROBOTS, FB_APP, PUBLISHED].join('\n')))).toBe(
      false,
    );
  });

  it('a different attribute NAME on the same value stays different', () => {
    const swapped = page(
      [OG_TITLE, OG_LOCALE, '<meta property="robots" content="index, follow, max-snippet:-1">', FB_APP].join('\n'),
    );
    expect(comparesEqual(reference, swapped)).toBe(false);
  });

  it('a duplicated tag stays different (multiset, not set)', () => {
    expect(comparesEqual(reference, page([OG_TITLE, OG_TITLE, OG_LOCALE, ROBOTS, FB_APP].join('\n')))).toBe(
      false,
    );
  });
});

describe('canonicalizeHeadMetaOrder — scope: <head> <meta> and nothing else', () => {
  it('leaves <body> alone, where reordering IS a real difference', () => {
    const head = [OG_TITLE, OG_LOCALE].join('\n');
    const one = page(head, '<h1>Titolo</h1>\n<p>Primo</p>\n<p>Secondo</p>');
    const two = page(head, '<h1>Titolo</h1>\n<p>Secondo</p>\n<p>Primo</p>');
    expect(comparesEqual(one, two)).toBe(false);
  });

  it('does not reorder <meta> tags that live in the <body>', () => {
    const head = [OG_TITLE, OG_LOCALE].join('\n');
    const one = page(head, `<div>${ROBOTS}\n${FB_APP}</div>`);
    const two = page(head, `<div>${FB_APP}\n${ROBOTS}</div>`);
    expect(comparesEqual(one, two)).toBe(false);
  });

  it('does not reorder non-<meta> head tags around each other', () => {
    const one = page('<title>A</title>\n<link rel="canonical" href="https://x/">');
    const two = page('<link rel="canonical" href="https://x/">\n<title>A</title>');
    expect(comparesEqual(one, two)).toBe(false);
  });

  it('keeps charset and http-equiv pinned — their POSITION is meaningful', () => {
    // charset must sit in the first 1024 bytes; an http-equiv pragma is a
    // response header in disguise. Moving either is not a no-op, so they are
    // excluded from the sort and a document that moved one still differs.
    const charset = '<meta charset="utf-8">';
    const pragma = '<meta http-equiv="x-ua-compatible" content="ie=edge">';
    const first = page([charset, pragma, OG_TITLE, ROBOTS].join('\n'));
    const moved = page([OG_TITLE, ROBOTS, charset, pragma].join('\n'));
    expect(comparesEqual(first, moved)).toBe(false);

    // …while the descriptive tags around them are still order-insensitive.
    const reordered = page([charset, pragma, ROBOTS, OG_TITLE].join('\n'));
    expect(comparesEqual(first, reordered)).toBe(true);
  });

  it('pins by ATTRIBUTE NAME, not by substring — "charset=" inside a value does not pin', () => {
    // An article description is free text and may contain anything. If the
    // pin were a substring search, this tag would stop being sortable and a
    // pure reorder would read as drift again — for that one article only,
    // which is the worst kind of intermittent.
    const tricky = '<meta name="description" content="come impostare charset=utf-8 nel CMS">';
    const one = page([tricky, ROBOTS, FB_APP].join('\n'));
    const two = page([FB_APP, tricky, ROBOTS].join('\n'));
    expect(one).not.toBe(two);
    expect(comparesEqual(one, two)).toBe(true);
  });

  it('passes documents without a usable <head> through untouched', () => {
    const noHead = `<!doctype html>\n<html><body>${ROBOTS}${FB_APP}</body></html>`;
    expect(canonicalizeHeadMetaOrder(noHead)).toBe(noHead);
    const unclosed = `<!doctype html>\n<html><head>\n${ROBOTS}\n${FB_APP}\n`;
    expect(canonicalizeHeadMetaOrder(unclosed)).toBe(unclosed);
  });

  it('handles <head> with attributes, and a single-meta head', () => {
    const withAttrs = `<!doctype html>\n<html>\n<head prefix="og: https://ogp.me/ns#">\n${ROBOTS}\n${OG_TITLE}\n</head>\n<body></body>\n</html>`;
    const swapped = `<!doctype html>\n<html>\n<head prefix="og: https://ogp.me/ns#">\n${OG_TITLE}\n${ROBOTS}\n</head>\n<body></body>\n</html>`;
    expect(comparesEqual(withAttrs, swapped)).toBe(true);

    const single = page(ROBOTS);
    expect(canonicalizeHeadMetaOrder(single)).toBe(single);
  });
});
