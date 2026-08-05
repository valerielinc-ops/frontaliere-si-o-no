import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { jsToJson } from '../build-plugins/shared/jsToJson';
import {
  ORGANIZATION_ID,
  ORGANIZATION_LD,
  ORGANIZATION_LD_FULL,
  ORGANIZATION_POLICIES,
  ORGANIZATION_SAME_AS,
  ORGANIZATION_FOUNDING_DATE,
} from '../services/seo/organizationLd';

/**
 * One `@id`, one entity (issue #5004 — Preferred Sources / AI Overviews).
 *
 * `https://frontaliereticino.ch/#organization` had FOUR definitions with
 * disjoint property sets:
 *
 *   index.html                      Organization,           sameAs x4, foundingDate 2023, no policies
 *   services/seo/seo-pages.ts:80    NewsMediaOrganization,  sameAs x1, foundingDate 2024, policies
 *   services/seo/seo-pages.ts:6535  NewsMediaOrganization,  no sameAs, no logo,           policies
 *   services/seo/organizationLd.ts  Organization,           no sameAs, no policies
 *
 * The last one is embedded as `publisher` in every article's NewsArticle and
 * inlined by every static SSG emitter, so the *most widely served* definition
 * was also the thinnest. `/chi-siamo/` shipped two of them in the same
 * document, sharing an `@id`, one with the logo and one with the policies.
 *
 * A knowledge graph resolves an `@id` collision by picking. Giving it four
 * things to pick between — including two contradictory founding years — is
 * the opposite of the entity clarity these surfaces are gated on.
 */
const read = (rel: string) => readFileSync(resolve(__dirname, '..', rel), 'utf-8');

const INDEX_HTML = read('index.html');
const SEO_PAGES = read('services/seo/seo-pages.ts');

const BASE_URL = 'https://frontaliereticino.ch';

/** Same brace/bracket walk staticPagesPlugin uses to slice a literal out of the source. */
function extractBalanced(src: string, pos: number): string | null {
  const open = src[pos];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let instr: string | null = null;
  for (let i = pos; i < src.length; i++) {
    const c = src[i];
    if (instr) {
      if (c === '\\') { i++; continue; }
      if (c === instr) instr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { instr = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(pos, i + 1); }
  }
  return null;
}


/** The `#organization` JSON-LD block served on the homepage. */
function homepageOrganization(): Record<string, unknown> {
  const blocks = [
    ...INDEX_HTML.matchAll(/<script type="application\/ld\+json">\s*(\{[\s\S]*?\})\s*<\/script>/g),
  ].map((m) => JSON.parse(m[1]) as Record<string, unknown>);
  const org = blocks.find((b) => b['@id'] === ORGANIZATION_ID);
  if (!org) throw new Error('index.html has no #organization JSON-LD block');
  return org;
}

describe('the canonical #organization entity', () => {
  it('is a NewsMediaOrganization, the type news surfaces expect from a publisher', () => {
    expect(ORGANIZATION_LD['@type']).toBe('NewsMediaOrganization');
  });

  it('carries sameAs on the node that gets embedded everywhere', () => {
    // sameAs is how a graph decides two nodes are the same real organization.
    // It used to exist only in index.html, so every static page and every
    // article's publisher referenced an entity with no external anchor.
    expect(ORGANIZATION_LD.sameAs.length).toBeGreaterThanOrEqual(4);
    expect(ORGANIZATION_LD.sameAs).toEqual([...ORGANIZATION_SAME_AS]);
  });

  it('declares every publisher-transparency property Google reads', () => {
    for (const prop of [
      'correctionsPolicy',
      'ethicsPolicy',
      'ownershipFundingInfo',
      'masthead',
      'verificationFactCheckingPolicy',
      'publishingPrinciples',
      'actionableFeedbackPolicy',
    ] as const) {
      expect(ORGANIZATION_LD_FULL[prop], `${prop} missing from the full entity`).toMatch(
        /^https:\/\/frontaliereticino\.ch\//,
      );
    }
  });

  it('keeps the embeddable node compact — policies belong to the full node only', () => {
    // ORGANIZATION_LD is inlined as `publisher` on ~12k article pages. A
    // referencing node needs identity, not the transparency block.
    expect(ORGANIZATION_LD).not.toHaveProperty('correctionsPolicy');
    expect(ORGANIZATION_LD).not.toHaveProperty('masthead');
  });
});

describe('no two definitions of #organization disagree', () => {
  it('the homepage block matches the canonical @type, sameAs and foundingDate', () => {
    const org = homepageOrganization();
    expect(org['@type']).toBe(ORGANIZATION_LD['@type']);
    expect(org.sameAs).toEqual([...ORGANIZATION_SAME_AS]);
    expect(org.foundingDate).toBe(ORGANIZATION_FOUNDING_DATE);
  });

  it('the homepage block carries the transparency properties too', () => {
    const org = homepageOrganization();
    for (const [prop, url] of Object.entries(ORGANIZATION_POLICIES)) {
      expect(org[prop], `index.html #organization is missing ${prop}`).toBe(url);
    }
  });

  /**
   * seo-pages.ts must inline the entity as LITERAL JSON, not spread the
   * imported binding.
   *
   * `staticPagesPlugin` regex-parses this file — it does not import it. Its
   * `constDefs` map resolves only `const NAME = …` declared in the source, so
   * `...ORGANIZATION_LD_FULL` would survive into `jsToJson` as literal text,
   * `JSON.parse` would throw, and the plugin's silent
   * `catch { /* skip SD *\/ }` would drop the ENTIRE structuredData array for
   * the entry — WebSite + SearchAction + WebPage included, with a green build.
   *
   * So the single-source-of-truth guarantee cannot be "one object referenced
   * everywhere" here. It is enforced instead by comparing the parsed literal
   * against the canonical module — drift fails this test rather than being
   * prevented by construction, which is the strongest option this file's
   * parse contract allows.
   */
  it('every inlined #organization literal deep-equals the canonical entity', () => {
    const entries = [
      ...SEO_PAGES.matchAll(/structuredData:\s*(\[|\{)/g),
    ];
    expect(entries.length).toBeGreaterThan(0);

    // staticPagesPlugin substitutes locally-declared `const NAME = …` into the
    // literal before parsing it; without the same pass, any entry referencing
    // SPEAKABLE_SECTION / HOWTO_CALCULATOR fails to parse and would be skipped
    // here — including the home entry we most need to check.
    const constDefs = new Map<string, string>();
    const constRefRx = /^const\s+([A-Z_][A-Z0-9_]*)\s*=\s*/gm;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = constRefRx.exec(SEO_PAGES)) !== null) {
      const balanced = extractBalanced(SEO_PAGES, cMatch.index + cMatch[0].length);
      if (balanced) constDefs.set(cMatch[1], balanced);
    }
    const resolveConsts = (sd: string): string => {
      let out = sd;
      for (const [name, value] of constDefs) {
        out = out.replace(new RegExp(`(?<=[\\[,\\s])${name}(?=[\\],\\s,;])`, 'g'), value);
      }
      return out;
    };

    const found: Record<string, unknown>[] = [];
    for (const m of entries) {
      const start = m.index! + m[0].length - 1;
      const raw = extractBalanced(SEO_PAGES, start);
      if (!raw) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          jsToJson(resolveConsts(raw), { baseUrl: BASE_URL, buildDateIso: '2026-01-01T00:00:00.000Z' }),
        );
      } catch {
        continue; // covered by tests/static-pages-seo-entry-lookup.test.ts
      }
      for (const node of (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[]) {
        if (node && node['@id'] === ORGANIZATION_ID) found.push(node);
      }
    }

    expect(found.length, 'no inlined #organization node found in seo-pages.ts').toBeGreaterThanOrEqual(3);
    const canonical = { '@context': 'https://schema.org', ...ORGANIZATION_LD_FULL } as Record<string, unknown>;
    for (const node of found) {
      // Page-specific colour (description/knowsAbout) is allowed to differ;
      // every identity and transparency field must not.
      const { description: _d, knowsAbout: _k, ...rest } = node;
      const { description: _cd, knowsAbout: _ck, ...canonicalRest } = canonical;
      expect(rest).toEqual(canonicalRest);
    }
  });

  it('exactly one founding year exists across the whole entity surface', () => {
    const years = new Set(
      [
        ...INDEX_HTML.matchAll(/"foundingDate":\s*"(\d{4})"/g),
        ...SEO_PAGES.matchAll(/"foundingDate":\s*"(\d{4})"/g),
      ].map((m) => m[1]),
    );
    years.add(ORGANIZATION_FOUNDING_DATE);
    expect([...years]).toEqual([ORGANIZATION_FOUNDING_DATE]);
  });
});

describe('every policy URL points at something that exists', () => {
  it('verificationFactCheckingPolicy resolves to a real anchor', () => {
    // This is the regression that motivated the test: the property pointed at
    // /metodologia/#fact-checking and components/pages/Metodologia.tsx had
    // zero `id` attributes, so the fragment resolved to nothing.
    const fragment = ORGANIZATION_POLICIES.verificationFactCheckingPolicy.split('#')[1];
    expect(fragment).toBeTruthy();
    expect(read('components/pages/Metodologia.tsx')).toContain(`id="${fragment}"`);
  });

  it.each([
    ['ethicsPolicy', 'ChiSiamo.tsx'],
    ['ownershipFundingInfo', 'ChiSiamo.tsx'],
    ['masthead', 'ChiSiamo.tsx'],
  ] as const)('%s resolves to a real anchor in %s', (prop, component) => {
    const fragment = ORGANIZATION_POLICIES[prop].split('#')[1];
    expect(fragment).toBeTruthy();
    expect(read(`components/pages/${component}`)).toContain(fragment);
  });
});
