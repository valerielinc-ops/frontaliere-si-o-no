// @vitest-environment node
/**
 * Per-question FAQ pages (issue #5008).
 *
 * WHAT THESE DEFEND. The issue's premise is that Reddit outranks this site on
 * informational queries. The half of it worth acting on is not "post on
 * Reddit" — it is that a Reddit thread wins because it is ONE URL whose entire
 * content answers ONE question, while 103 researched, sourced answers were
 * reachable only through four hub URLs. Search engines rank, and LLMs cite, at
 * the granularity of a URL.
 *
 * So the assertions below are about the properties that make a page the better
 * answer AND a citable one: the question is the `<h1>` and the `<title>`, the
 * structured data says the same thing the body says, every locale exists so no
 * hreflang alternate dangles, and — the one that is easy to get wrong — the hub
 * never links to a question whose page was not emitted.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_FAQ_HUB,
  FAQ_HUB_LOCALES,
  buildFaqEntryPath,
  buildFaqHubPath,
  parseFaqEntryPath,
  isFaqEntryPath,
  getFaqHubByCategory,
} from '@/data/faq-hub';
import type { FaqHubEntry, FaqHubLocale } from '@/data/faq-hub';
import { MIN_INDEXABLE_WORDS } from '@/build-plugins/constants';
import {
  __renderFaqEntryPageForTest,
  __renderFaqHubPageForTest,
  __faqEntryPageEligibleLocalesForTest,
  __faqLinkedIdsForLocaleForTest,
  __faqSiblingEntriesForTest,
} from '@/build-plugins/faqHubPlugin';

const DATE = '2026-08-05';
const BASE = 'https://frontaliereticino\\.ch';
/** entry id → locales whose page this build writes. */
const ENTRY_LOCALES = new Map<string, Set<FaqHubLocale>>(
  ALL_FAQ_HUB.map((e) => [e.id, __faqEntryPageEligibleLocalesForTest(e)] as const),
);
/** Ids with a page in IT — what the IT hub is allowed to link. */
const ELIGIBLE = __faqLinkedIdsForLocaleForTest('it', ENTRY_LOCALES);
const firstEligible = ALL_FAQ_HUB.find((e) => ELIGIBLE.has(e.id)) as FaqHubEntry;

const render = (entry: FaqHubEntry, locale: FaqHubLocale) =>
  __renderFaqEntryPageForTest(
    entry,
    locale,
    DATE,
    __faqLinkedIdsForLocaleForTest(locale, ENTRY_LOCALES),
    ENTRY_LOCALES.get(entry.id)!,
  );

describe('routes', () => {
  it('builds `<hub>/<entry id>/` in every locale', () => {
    expect(buildFaqEntryPath('it', 'avs-lpp-contributi-volontari')).toBe(
      '/domande-frequenti-frontalieri/avs-lpp-contributi-volontari/',
    );
    expect(buildFaqEntryPath('de', 'avs-lpp-contributi-volontari')).toBe(
      '/de/haeufige-fragen/avs-lpp-contributi-volontari/',
    );
  });

  it('round-trips every real entry in every locale', () => {
    for (const entry of ALL_FAQ_HUB) {
      for (const locale of FAQ_HUB_LOCALES) {
        const path = buildFaqEntryPath(locale, entry.id);
        expect(parseFaqEntryPath(path), path).toEqual({ locale, entryId: entry.id });
        expect(isFaqEntryPath(path)).toBe(true);
      }
    }
  });

  it('does not mistake the hub itself, or a deeper path, for an entry', () => {
    for (const locale of FAQ_HUB_LOCALES) {
      expect(parseFaqEntryPath(buildFaqHubPath(locale))).toBeNull();
      expect(parseFaqEntryPath(`${buildFaqHubPath(locale)}a/b/`)).toBeNull();
    }
    expect(parseFaqEntryPath('/tutti/qualcosa/')).toBeNull();
  });

  it('tolerates a missing trailing slash', () => {
    expect(parseFaqEntryPath('/domande-frequenti-frontalieri/avs-lpp-contributi-volontari')).toEqual({
      locale: 'it',
      entryId: 'avs-lpp-contributi-volontari',
    });
  });
});

describe('a per-question page is the answer to exactly one question', () => {
  const html = render(firstEligible, 'it').html;

  it('carries the question verbatim as its single h1 and as its title', () => {
    const h1s = html.match(/<h1[\s>]/gi) ?? [];
    expect(h1s).toHaveLength(1);
    const q = firstEligible.question.it;
    expect(html).toContain(q.replace(/&/g, '&amp;'));
    const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
    // The title is the question — no keyword assembly the body has to live up to.
    expect(title.replace(/&#39;|&apos;/g, "'")).toContain(q.slice(0, 30).replace(/&/g, '&amp;'));
  });

  it('self-canonicalises', () => {
    expect(html).toContain(`https://frontaliereticino.ch${buildFaqEntryPath('it', firstEligible.id)}`);
  });

  it('clears the thin-content floor', () => {
    expect(render(firstEligible, 'it').wordCount).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
  });

  it('emits exactly one Question in its FAQPage, matching the visible answer', () => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) =>
      JSON.parse(m[1]),
    );
    const faq = blocks.find((b) => b['@type'] === 'FAQPage');
    expect(faq).toBeDefined();
    expect(faq.mainEntity).toHaveLength(1);
    expect(faq.mainEntity[0].name).toBe(firstEligible.question.it);

    // Structured data that disagrees with the visible answer is worse than none
    // (#4398). Compare on a distinctive slice of the answer prose.
    const answerText: string = faq.mainEntity[0].acceptedAnswer.text;
    const plain = firstEligible.answer.it.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
    expect(answerText).toBe(plain);
  });

  it('declares Article + BreadcrumbList + Speakable, and points back at the hub', () => {
    const types = [...html.matchAll(/"@type":"([A-Za-z]+)"/g)].map((m) => m[1]);
    for (const t of ['Article', 'BreadcrumbList', 'FAQPage', 'Question', 'Answer', 'SpeakableSpecification']) {
      expect(types, t).toContain(t);
    }
    expect(html).toContain(`https://frontaliereticino.ch${buildFaqHubPath('it')}`);
  });

  it('is indexable', () => {
    expect(html).not.toMatch(/content="?noindex/);
  });
});

describe('every locale of a question exists, so no hreflang alternate dangles', () => {
  it('emits all four locales plus x-default, all above the floor', () => {
    for (const locale of FAQ_HUB_LOCALES) {
      const r = render(firstEligible, locale);
      expect(r.wordCount, `${locale} thin`).toBeGreaterThanOrEqual(MIN_INDEXABLE_WORDS);
      for (const alt of FAQ_HUB_LOCALES) {
        // Quote-flexible: the emitted HTML is minified and single-token
        // attribute values lose their quotes.
        expect(r.html, `${locale} missing ${alt} alternate`).toMatch(
          new RegExp(
            `hreflang="?${alt}"?\\s+href="${BASE}${buildFaqEntryPath(alt, firstEligible.id).replace(/\//g, '\\/')}"`,
          ),
        );
      }
      expect(r.html).toMatch(/hreflang="?x-default"?/);
    }
  });

  it('renders the question in the page locale, not always Italian', () => {
    const de = render(firstEligible, 'de').html;
    expect(de).toMatch(/<html lang="?de"?/);
    expect(de).toContain(firstEligible.question.de.slice(0, 25).replace(/&/g, '&amp;'));
  });
});

describe('eligibility — nothing thin ships, and nothing links to what did not ship', () => {
  it('accepts the whole committed corpus — every answer clears the floor in all four locales', () => {
    // Measured before the feature was built, and the reason per-question pages
    // are viable at all: no answer is thin, in any locale.
    expect(ELIGIBLE.size).toBe(ALL_FAQ_HUB.length);
    for (const entry of ALL_FAQ_HUB) {
      expect(ENTRY_LOCALES.get(entry.id)!.size, entry.id).toBe(FAQ_HUB_LOCALES.length);
    }
  });

  it('counts the answer as it RENDERS, not as it is stored', () => {
    // 7 answers use comparison operators in prose ("enfants < 21 ans … ordinaire
    // >CHF 120 000"). countHtmlBodyWords strips `<…>` as a tag, which ate 53 of
    // that answer's 93 words and marked a good question ineligible. mdLinks()
    // escapes before emitting, so the page was always fine — the predicate was
    // measuring a page that does not exist.
    const withOperators = ALL_FAQ_HUB.filter((e) =>
      FAQ_HUB_LOCALES.some((l) => /<[^>]*>/.test(e.answer[l])),
    );
    expect(withOperators.length).toBeGreaterThan(0);
    for (const e of withOperators) {
      expect(
        ENTRY_LOCALES.get(e.id)!.size,
        `${e.id} wrongly excluded by a pseudo-tag in its prose`,
      ).toBe(FAQ_HUB_LOCALES.length);
    }
  });

  it('the hub links to every question that has a page', () => {
    const hub = __renderFaqHubPageForTest('it', DATE, undefined, new Set(FAQ_HUB_LOCALES), ELIGIBLE).html;
    for (const entry of ALL_FAQ_HUB) {
      expect(hub, `${entry.id} should be linked`).toContain(
        `href="${buildFaqEntryPath('it', entry.id)}"`,
      );
    }
  });

  it('never links a question whose page was NOT emitted, but still shows its answer', () => {
    // The whole corpus is eligible today, so the branch is driven with a
    // synthetic set. A dangling internal link is the silent-skip failure the
    // repo's below-floor-bridge rule exists to prevent; here the heading simply
    // stays unlinked and the answer stays readable inline on the hub.
    const dropped = ALL_FAQ_HUB[0];
    const restricted = new Set([...ELIGIBLE].filter((id) => id !== dropped.id));
    const hub = __renderFaqHubPageForTest('it', DATE, undefined, new Set(FAQ_HUB_LOCALES), restricted).html;

    expect(hub).not.toContain(`href="${buildFaqEntryPath('it', dropped.id)}"`);
    expect(hub).toMatch(new RegExp(`id="?${dropped.id}"?`));
    expect(hub).toContain(dropped.answer.it.slice(0, 40).replace(/&/g, '&amp;'));
  });

  it('sibling links never point at an entry without a page', () => {
    for (const entry of ALL_FAQ_HUB.filter((e) => ELIGIBLE.has(e.id))) {
      for (const sib of __faqSiblingEntriesForTest(entry, ELIGIBLE)) {
        expect(ELIGIBLE.has(sib.id), `${entry.id} → ${sib.id}`).toBe(true);
        expect(sib.id).not.toBe(entry.id);
      }
    }
  });
});

describe('sibling links spread inbound equity instead of concentrating it', () => {
  it('does not give every page in a category the same six links', () => {
    // Always taking the first N would make the category's first entries the
    // only ones that ever receive an internal link — the exact concentration
    // failure relatedArticlesIndex.ts was written to fix.
    const category = ALL_FAQ_HUB.find((e) => getFaqHubByCategory(e.category).length >= 6)!.category;
    const entries = getFaqHubByCategory(category).filter((e) => ELIGIBLE.has(e.id));

    const inbound = new Map<string, number>(entries.map((e) => [e.id, 0]));
    for (const entry of entries) {
      for (const sib of __faqSiblingEntriesForTest(entry, ELIGIBLE)) {
        inbound.set(sib.id, (inbound.get(sib.id) ?? 0) + 1);
      }
    }
    // Every entry in the category receives at least one inbound sibling link.
    for (const [id, n] of inbound) expect(n, `${id} has no inbound sibling link`).toBeGreaterThan(0);
  });

  it('is deterministic — the same entry yields the same siblings every call', () => {
    const a = __faqSiblingEntriesForTest(firstEligible, ELIGIBLE).map((e) => e.id);
    const b = __faqSiblingEntriesForTest(firstEligible, ELIGIBLE).map((e) => e.id);
    expect(a).toEqual(b);
  });
});
