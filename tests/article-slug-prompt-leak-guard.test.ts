/**
 * Guard for issue #5334: an article slug must never be the prompt instruction
 * that was supposed to produce it.
 *
 * Four such slugs reached production as permanent, indexable, sitemap-listed
 * URLs — `/articoli-frontaliere/kebab-case-3-5-words-max-40-chars/` and three
 * siblings where the instruction prefix was welded onto a real topic. Nothing
 * between the model's answer and `sitemap-blog.xml` looked at the value.
 *
 * The four cases below are the actual leaked slugs, not invented ones, and the
 * false-positive sweep runs against the real registries rather than a fixture:
 * the risk a pattern list carries is not "does it catch the known bad string"
 * (trivially yes) but "does it start eating legitimate slugs at 03:00 with
 * nobody watching". That second question is the one this file spends most of
 * its assertions on.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  findSlugPromptLeak,
  isCleanArticleSlug,
  stripSlugPromptLeak,
  assertNoSlugPromptLeak,
  SLUG_PROMPT_LEAK_PATTERNS,
} from '../scripts/lib/slug-prompt-leak-guard.mjs';
import { deriveAndSanitizeArticleSlugs } from '../scripts/create-article.mjs';
import {
  AUDIT_SOURCES,
  KNOWN_LEGACY_LEAKS,
  extractRegistrySlugs,
  extractSitemapSlugs,
} from '../scripts/audit-slug-prompt-leaks.mjs';

const ROOT = resolve(__dirname, '..');

/** The four slugs from the issue, live at the time this test was written. */
const LEAKED_SLUGS = [
  'kebab-case-3-5-words-max-40-chars',
  'kebab-case-turismo-ticino',
  'kebab-case-ticino-nubifragio-grigioni',
  'kebab-case-rossi-bruxelles-ticino',
];

/** Real slugs currently serving traffic — must never be flagged. */
const LEGITIMATE_SLUGS = [
  'stipendio-netto-frontaliere-2026',
  'lamal-vs-cmi-frontaliere',
  'primo-giorno-lavoro-svizzera',
  'nuovo-accordo-frontalieri-ticino',
  'turismo-ticino',
  'ticino-nubifragio-grigioni',
  'rossi-bruxelles-ticino',
  // Words that only leak as a WHOLE slug must survive as substrings.
  'test-antigenici-frontalieri',
  'titolo-di-soggiorno-ticino',
  'articolo-40-costituzione',
  'esempio-pratico-ristorni',
  // Numbers next to nouns must not look like a length constraint.
  'aumento-40-franchi-orari',
  'salario-medio-5-cantoni-2026',
  'max-frisch-biografia-zurigo',
];

describe('findSlugPromptLeak — the four slugs from issue #5334', () => {
  it.each(LEAKED_SLUGS)('rejects the live leaked slug "%s"', (slug) => {
    const leak = findSlugPromptLeak(slug);
    expect(leak, `"${slug}" must be rejected`).not.toBeNull();
    expect(leak!.match.toLowerCase()).toContain('kebab');
    expect(isCleanArticleSlug(slug)).toBe(false);
  });
});

describe('findSlugPromptLeak — legitimate slugs pass untouched', () => {
  it.each(LEGITIMATE_SLUGS)('accepts "%s"', (slug) => {
    expect(findSlugPromptLeak(slug), `"${slug}" must NOT be rejected`).toBeNull();
    expect(isCleanArticleSlug(slug)).toBe(true);
  });
});

describe('findSlugPromptLeak — instruction vocabulary beyond the kebab-case prefix', () => {
  // Three of the four live leaks are the prefix glued onto a topic, so a
  // prefix-only check happened to cover them. It would not cover the same
  // instruction reworded, which is the failure this list guards.
  it.each([
    ['3-5-words-max-40-chars', 'no kebab-case prefix at all'],
    ['max-40-chars-titolo-articolo', 'char limit in the middle'],
    ['titolo-articolo-words-max', 'constraint as a suffix'],
    ['lowercase-hyphen-separated-title', 'a reworded prompt'],
    ['url-safe-slug-here', 'slug-formatting vocabulary'],
    ['snake_case_turismo_ticino', 'a different casing convention'],
    ['your-title-here-ticino', 'placeholder vocabulary'],
    ['tbd-accordo-frontalieri', 'an unfilled template marker'],
  ])('rejects "%s" (%s)', (slug) => {
    expect(findSlugPromptLeak(slug), `"${slug}" must be rejected`).not.toBeNull();
  });

  // `slug` is deliberately NOT in this list any more — see the block below.
  it.each(['titolo', 'test', 'example', 'undefined', 'article'])(
    'rejects the bare field-name answer "%s" while allowing it as a substring',
    (slug) => {
      expect(findSlugPromptLeak(slug)).not.toBeNull();
      expect(findSlugPromptLeak(`${slug}-frontalieri-ticino`)).toBeNull();
    },
  );

  describe('the half-obeyed family: the label kept in front of a real slug', () => {
    // ── A CONTRACT CHANGE, AND THE MEASUREMENT THAT FORCED IT ──────────────
    //
    // This file used to assert that `slug-frontalieri-ticino` is a LEGITIMATE
    // slug: `slug` was grouped with `titolo`/`test`/`example` as a word that
    // leaks only as a whole value and must survive as a prefix. That
    // assumption is what production disproved.
    //
    // Measured 2026-08-09 over all 19 035 published slug positions (id + 4
    // locales × 3 807 articles in the two registries): TWELVE live slugs across
    // four articles have exactly the shape the old assertion called safe —
    // `slug-gaggiolo-traffic`, `slug-traffico-da-record`,
    // `slug-terzo-pilastro-3a-schweiz` and siblings. The model produced a real
    // slug and kept the schema's field label welded to its front.
    //
    // So the two readings of `slug-<something>-<something>` are "a real article
    // about slugs" and "the placeholder plus content". The first has zero
    // instances in 19 035; the second has twelve. The old assertion optimised
    // for the empty class.
    //
    // The cost is asymmetric, which is what settles it: a false positive costs
    // a slightly different slug on an article not yet published, a false
    // negative costs a permanent public URL. The sweep at the bottom of this
    // file is what keeps the aggressiveness honest — it re-runs the rule over
    // every published slug on every CI run.
    it.each([
      'slug-gaggiolo-traffic',
      'slug-gaggiolo-verkehr',
      'slug-traffico-da-record',
      'slug-terzo-pilastro-3a-switzerland',
      'slug-terzo-pilastro-3a-schweiz',
      'slug-terzo-pilastro-3a-suisse',
      'slug-terzo-pilastro-3a-vantaggi-2026-basilea',
      // These seven are DETECTOR inputs, and stay seven even as production is
      // repaired: the rule must keep rejecting the string whether or not any
      // article still carries it. Two of them (`slug-gaggiolo-*`) were fixed
      // upstream on 2026-08-13 and left KNOWN_LEGACY_LEAKS in #5510 — which is
      // a statement about the ALLOWLIST, not about the pattern. Whether an
      // allowlist entry still describes something live is asserted in
      // `tests/slug-leak-allowlist-liveness.test.ts`, deliberately not here.
    ])('rejects "%s" — a slug shape the old rule called clean', (slug) => {
      expect(findSlugPromptLeak(slug), `"${slug}" must be rejected`).not.toBeNull();
      expect(findSlugPromptLeak(slug)!.pattern).toBe('schema-placeholder-prefix');
    });

    it('recovers the article the model actually wrote, rather than discarding it', () => {
      // The remainder IS the slug the model chose; deriving from the title
      // instead would throw away a better answer that is already there.
      expect(stripSlugPromptLeak('slug-gaggiolo-traffic')).toBe('gaggiolo-traffic');
      expect(stripSlugPromptLeak('slug-terzo-pilastro-3a-schweiz')).toBe('terzo-pilastro-3a-schweiz');
      expect(stripSlugPromptLeak('slug-traffico-da-record')).toBe('traffico-da-record');
    });

    it('refuses to recover when the remainder is itself a label', () => {
      // `slug-en` → `en` is a worse URL than no URL: the caller's fallback
      // (translated title, then the IT slug) is strictly better.
      for (const slug of ['slug-en', 'slug-inglese', 'slug-slug-en', 'kebab-case-3-5-words-max-40-chars']) {
        expect(stripSlugPromptLeak(slug), `"${slug}" must not be salvaged`).toBe('');
      }
    });

    it('does not fire on a real word that merely starts with "slug"', () => {
      // The prefix requires a separator, so only the label form matches.
      for (const slug of ['sluggish-market-ticino', 'slugs-e-url-guida', 'gaggiolo-traffic']) {
        expect(findSlugPromptLeak(slug), `"${slug}" must NOT be rejected`).toBeNull();
      }
    });
  });

  it.each(['slug-it', 'slug-en', 'slug-de', 'slug-fr'])(
    'rejects "%s" — the placeholder the schema uses for the per-locale slugs',
    (slug) => {
      // The `slugs` line of the prompt is `{ "it": "slug-it", "en": "slug-en", … }`.
      // These are well-formed slugs, so nothing structural can flag them; only
      // the whole-value list can. A model echoing the id placeholder would echo
      // these too, and `/articoli-frontaliere/slug-de/` is not more acceptable
      // than `/articoli-frontaliere/kebab-case-turismo-ticino/`.
      expect(findSlugPromptLeak(slug)).not.toBeNull();
    },
  );
});

describe('stripSlugPromptLeak — recovery', () => {
  it('recovers the real topic from a half-obeyed answer', () => {
    expect(stripSlugPromptLeak('kebab-case-turismo-ticino')).toBe('turismo-ticino');
    expect(stripSlugPromptLeak('kebab-case-ticino-nubifragio-grigioni')).toBe('ticino-nubifragio-grigioni');
    expect(stripSlugPromptLeak('kebab-case-rossi-bruxelles-ticino')).toBe('rossi-bruxelles-ticino');
  });

  it('returns "" for the verbatim placeholder, which is instruction end to end', () => {
    // The caller MUST fall back to the title here: there is no topic to keep.
    expect(stripSlugPromptLeak('kebab-case-3-5-words-max-40-chars')).toBe('');
  });

  it('never returns a value that still fails the check (composed fragments)', () => {
    for (const slug of [...LEAKED_SLUGS, '3-5-words-max-40-chars', 'lowercase-slug-here', 'kebab-case-lowercase-max-40-chars']) {
      const stripped = stripSlugPromptLeak(slug);
      if (stripped) expect(findSlugPromptLeak(stripped), `strip("${slug}") = "${stripped}" is still dirty`).toBeNull();
    }
  });

  it('leaves a clean slug alone', () => {
    expect(stripSlugPromptLeak('turismo-ticino')).toBe('turismo-ticino');
  });
});

describe('assertNoSlugPromptLeak — the pre-write gate', () => {
  it('throws naming the locale, the pattern and the issue', () => {
    expect(() =>
      assertNoSlugPromptLeak(
        { it: 'accordo-frontalieri', en: 'kebab-case-cross-border-deal' },
        { id: 'accordo-frontalieri', source: 'test' },
      ),
    ).toThrow(/#5334[\s\S]*en="kebab-case-cross-border-deal"/);
  });

  it('reports EVERY offending locale, not just the first', () => {
    expect(() =>
      assertNoSlugPromptLeak({ it: 'kebab-case-a', en: 'ok-slug', de: 'lowercase-b' }),
    ).toThrow(/it=.*de=/s);
  });

  it('passes a fully clean locale map', () => {
    expect(() =>
      assertNoSlugPromptLeak({ it: 'turismo-ticino', en: 'ticino-tourism', de: 'tessin-tourismus', fr: 'tourisme-tessin' }),
    ).not.toThrow();
  });
});

describe('deriveAndSanitizeArticleSlugs refuses to hand a contaminated slug downstream', () => {
  // This is the function registerArticleFiles() calls immediately before the
  // first file write, and the one publish-journalist-article.mjs calls
  // directly — so it is where "the article is not written" is decided.
  it('throws when data.id carries the prompt template', () => {
    expect(() =>
      deriveAndSanitizeArticleSlugs({
        id: 'kebab-case-3-5-words-max-40-chars',
        slugs: {},
        content: { it: { title: 'Nuovo accordo frontalieri: cosa cambia' } },
      }),
    ).toThrow(/#5334/);
  });

  it('throws when only a translated slug carries it (the IT slug looking fine is not enough)', () => {
    expect(() =>
      deriveAndSanitizeArticleSlugs({
        id: 'nuovo-accordo-frontalieri',
        slugs: { en: 'kebab-case-new-agreement' },
        content: { it: { title: 'Nuovo accordo frontalieri' } },
      }),
    ).toThrow(/#5334/);
  });

  it('still derives a legitimate article normally', () => {
    const data = {
      id: 'nuovo-accordo-frontalieri',
      slugs: {},
      content: {
        it: { title: 'Nuovo accordo frontalieri' },
        en: { title: 'New cross-border agreement' },
      },
    };
    const slugs = deriveAndSanitizeArticleSlugs(data);
    expect(slugs.it).toBe('nuovo-accordo-frontalieri');
    expect(slugs.en).toBe('new-cross-border-agreement');
  });
});

describe('published-corpus sweep (the check that actually runs in CI)', () => {
  // `npm run audit:slug-prompt-leaks` is the operator-facing form of this, but
  // vitest is what runs on every PR, so the enforcement lives here and imports
  // the audit's own sources/extractors rather than restating them — two lists
  // would drift, and the drift that matters is the silent one where the test
  // scans less than the audit and still reports green.
  //
  // It is also the false-positive net: a pattern that starts eating real slugs
  // fails here, not at 03:00 in a publish run.
  const present = AUDIT_SOURCES.filter((s) => existsSync(resolve(ROOT, s.path)));

  it('reads at least the two article registries (fail-closed)', () => {
    // `public/` is git-tracked but absent from a sparse worktree, so the
    // sitemaps may legitimately be missing locally and present in CI. The
    // registries never are — and an empty scan must never read as a clean one.
    expect(
      present.filter((s) => s.kind === 'registry').length,
      'no article registry found — this sweep would have proved nothing',
    ).toBe(2);
  });

  it('flags nothing beyond the documented already-published leaks', () => {
    const tokens = new Set<string>();
    for (const source of present) {
      const src = readFileSync(resolve(ROOT, source.path), 'utf8');
      const slugs = source.kind === 'registry' ? extractRegistrySlugs(src) : extractSitemapSlugs(src);
      for (const slug of slugs) tokens.add(slug);
    }
    expect(tokens.size).toBeGreaterThan(5000);

    const flagged = [...tokens].filter((t) => !isCleanArticleSlug(t));
    const unexpected = flagged.filter((t) => !KNOWN_LEGACY_LEAKS.has(t)).sort();
    expect(
      unexpected,
      'a slug matched the prompt-leak patterns that is neither a known legacy leak nor ' +
        'something the pre-write gate should have stopped. Either a leak got through ' +
        '(fix the generator) or a pattern is over-matching a real slug (fix the pattern) — ' +
        'do NOT add it to KNOWN_LEGACY_LEAKS.',
    ).toEqual([]);
  });

  it('still sees all four slugs from the issue in the registries', () => {
    // Guards the inverse failure: a pattern edit that quietly stops matching
    // would make the sweep above pass for the wrong reason.
    const src = readFileSync(resolve(ROOT, 'packages/articles/content/routerBlogData.ts'), 'utf8');
    const registered = new Set(extractRegistrySlugs(src));
    for (const slug of LEAKED_SLUGS) {
      expect(registered.has(slug), `${slug} is no longer in routerBlogData.ts — was it renamed? ` +
        'If so, drop it from KNOWN_LEGACY_LEAKS too.').toBe(true);
      expect(isCleanArticleSlug(slug)).toBe(false);
    }
  });
});

describe('pattern list hygiene', () => {
  it('keeps every pattern global-and-sticky-free so lastIndex cannot leak between calls', () => {
    // A shared /g regex that is not reset skips every other match. The module
    // resets lastIndex before each exec; this asserts none of them is /y, where
    // resetting would not be enough.
    for (const { name, re } of SLUG_PROMPT_LEAK_PATTERNS) {
      expect(re.sticky, `${name} must not be sticky`).toBe(false);
    }
  });

  it('is stable across repeated calls on the same input', () => {
    for (let i = 0; i < 5; i++) {
      expect(findSlugPromptLeak('kebab-case-turismo-ticino')).not.toBeNull();
      expect(findSlugPromptLeak('turismo-ticino')).toBeNull();
    }
  });
});
