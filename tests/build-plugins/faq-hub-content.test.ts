/**
 * Regression coverage for issue #3653 (FAQ hub fiscal entries + internal
 * linking to the tax-guide pillar pages and the evergreen salary-hub tax
 * articles).
 *
 * Three things are guarded here because they were the concrete risks of
 * growing `data/faq-hub/category-fisco.ts` past its original fixed size:
 *
 * 1. `faqHubPlugin.ts` used to hardcode "100" (total Q&A) and "(10)" (per
 *    category count) directly in the on-page copy/TOC. Adding entries
 *    without also making those dynamic would ship a page that visibly
 *    lies about its own content. This test asserts the FAQPage JSON-LD
 *    `mainEntity` length always matches `ALL_FAQ_HUB.length` and that the
 *    stale "100 ..." strings are gone from the rendered HTML.
 * 2. The per-category TOC count must track `getFaqHubByCategory(cat).length`
 *    for every category, not just fisco.
 * 3. `FaqHubRelatedLink.href` was extended to accept a
 *    `Record<locale, path>` so new entries can link to locale-specific
 *    routes without hardcoding a single locale's path and reusing it
 *    across all 4 rendered pages (the exact anti-pattern fixed in #3686
 *    for build-plugins/salaryHubArticles.ts). This test proves the three
 *    new fisco entries actually resolve a different href per locale.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';
import { faqHubPlugin } from '../../build-plugins/faqHubPlugin';
import {
  ALL_FAQ_HUB,
  FAQ_HUB_CATEGORIES,
  FAQ_HUB_LOCALES,
  buildFaqHubPath,
  getFaqHubByCategory,
} from '../../data/faq-hub';
import { extractJsonLdBlocks, flattenSchemas } from '../post-build/seo-helpers';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'faq-hub-content-test-'));
  fs.mkdirSync(path.join(tempRoot, 'dist'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Attribute matcher tolerant to `build-plugins/shared/htmlMinify.ts` step 5
 * ("remove quotes from HTML5-safe attribute values"): a value like `fh-lnk`
 * or a kebab-case id gets unquoted (`class=fh-lnk`) unless it ends in `/`
 * (every route path here does, per the site's mandatory-trailing-slash
 * convention, so hrefs stay quoted — but we don't rely on that either way).
 */
function attrEq(name: string, value: string): string {
  const v = escapeRegex(value);
  return `${name}=(?:"${v}"|${v})`;
}

async function runCloseBundle(plugin: Plugin): Promise<void> {
  await (plugin as unknown as { closeBundle: () => Promise<void> }).closeBundle();
}

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function buildAllLocaleHtml(): Promise<Record<string, string>> {
  const tempRoot = makeTempRoot();
  await runCloseBundle(faqHubPlugin(tempRoot));
  const out: Record<string, string> = {};
  for (const locale of FAQ_HUB_LOCALES) {
    const urlPath = buildFaqHubPath(locale);
    const htmlPath = path.join(tempRoot, 'dist', urlPath, 'index.html');
    expect(fs.existsSync(htmlPath), `missing rendered page for locale ${locale}: ${htmlPath}`).toBe(true);
    out[locale] = fs.readFileSync(htmlPath, 'utf-8');
  }
  return out;
}

describe('FAQ hub (AE-5) — dynamic count sync (#3653 regression)', () => {
  it('FAQPage mainEntity count matches ALL_FAQ_HUB.length on every locale page, no stale "100" copy', async () => {
    const htmlByLocale = await buildAllLocaleHtml();

    for (const locale of FAQ_HUB_LOCALES) {
      const html = htmlByLocale[locale];
      const schemas = flattenSchemas(extractJsonLdBlocks(html));
      const faqPage = schemas.find((s) => s['@type'] === 'FAQPage');
      expect(faqPage, `${locale}: missing FAQPage JSON-LD`).toBeDefined();

      const mainEntity = faqPage?.mainEntity;
      expect(Array.isArray(mainEntity), `${locale}: FAQPage.mainEntity must be an array`).toBe(true);
      expect(mainEntity.length, `${locale}: FAQPage entity count must track ALL_FAQ_HUB`).toBe(
        ALL_FAQ_HUB.length,
      );

      // Regression guard: the old hardcoded "100 domande/risposte/FAQs/..."
      // copy must never resurface once the data set grows past 100.
      expect(html).not.toMatch(
        /\b100\s+(domande|risposte|FAQs?|answers|Fragen|Antworten|questions|réponses)\b/i,
      );
    }
  });

  it('per-category TOC count matches getFaqHubByCategory(cat).length for every category', async () => {
    const htmlByLocale = await buildAllLocaleHtml();
    const html = htmlByLocale.it;

    for (const cat of FAQ_HUB_CATEGORIES) {
      const count = getFaqHubByCategory(cat).length;
      const re = new RegExp(
        `${attrEq('href', `#cat-${cat}`)}[^>]*>[^<]*</a>[\\s\\S]{0,10}${attrEq(
          'class',
          'fh-tocc',
        )}>\\(${count}\\)</span>`,
      );
      expect(re.test(html), `TOC entry for category "${cat}" should read (${count})`).toBe(true);
    }

    // fisco grew from 10 to 13 entries as part of #3653.
    expect(getFaqHubByCategory('fisco').length).toBe(13);
  });
});

describe('FAQ hub (AE-5) — new fisco entries link internally per-locale (#3653)', () => {
  const NEW_ENTRY_IDS = [
    'fisco-guida-completa-tassazione-2026',
    'fisco-impatto-coniuge-figli-netto',
    'fisco-zona-frontaliera-20km-fiscalita',
  ];

  function extractArticle(html: string, id: string): string {
    const re = new RegExp(`<article ${attrEq('id', id)}[\\s\\S]*?</article>`);
    const match = re.exec(html);
    return match ? match[0] : '';
  }

  it('renders on every locale page with non-empty question/answer text', async () => {
    const htmlByLocale = await buildAllLocaleHtml();
    for (const locale of FAQ_HUB_LOCALES) {
      const html = htmlByLocale[locale];
      for (const id of NEW_ENTRY_IDS) {
        const articleHtml = extractArticle(html, id);
        expect(articleHtml, `${locale}: entry "${id}" missing from rendered page`).not.toBe('');
        const question = new RegExp(`<h3 ${attrEq('class', 'fh-qt')}>([^<]+)</h3>`).exec(articleHtml)?.[1];
        const answer = new RegExp(`<p ${attrEq('class', 'fh-qa')}>([\\s\\S]*?)</p>`).exec(articleHtml)?.[1];
        expect(question && question.trim().length > 0, `${locale}: entry "${id}" has empty question`).toBe(
          true,
        );
        expect(answer && answer.trim().length > 20, `${locale}: entry "${id}" has too-short answer`).toBe(
          true,
        );
      }
    }
  });

  it('resolves a distinct related-link href per locale (Record<locale, path> pattern, not one IT path reused)', async () => {
    const htmlByLocale = await buildAllLocaleHtml();

    for (const id of NEW_ENTRY_IDS) {
      const hrefByLocale: Record<string, string> = {};
      for (const locale of FAQ_HUB_LOCALES) {
        const html = htmlByLocale[locale];
        const articleHtml = extractArticle(html, id);
        expect(articleHtml, `${locale}: entry "${id}" missing`).not.toBe('');
        const hrefMatch = new RegExp(`href=(?:"([^"]+)"|([^\\s>]+))\\s+${attrEq(
          'class',
          'fh-lnk',
        )}`).exec(articleHtml);
        expect(hrefMatch, `${locale}: entry "${id}" has no related-link href`).toBeTruthy();
        hrefByLocale[locale] = (hrefMatch![1] ?? hrefMatch![2])!;

        // Every rendered href must itself carry the correct locale prefix
        // (or be the IT-rooted path for the it locale, which has none).
        if (locale !== 'it') {
          expect(
            hrefByLocale[locale].startsWith(`/${locale}/`),
            `${locale}: entry "${id}" related-link href "${hrefByLocale[locale]}" must be locale-prefixed`,
          ).toBe(true);
        }
      }

      expect(hrefByLocale.it, `entry "${id}": EN href must differ from IT`).not.toBe(hrefByLocale.en);
      expect(hrefByLocale.it, `entry "${id}": DE href must differ from IT`).not.toBe(hrefByLocale.de);
      expect(hrefByLocale.it, `entry "${id}": FR href must differ from IT`).not.toBe(hrefByLocale.fr);
    }
  });
});
