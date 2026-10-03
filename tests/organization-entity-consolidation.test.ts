import { describe, expect, it } from 'vitest';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { jsToJson } from '../build-plugins/shared/jsToJson';
import {
  ORGANIZATION_ID,
  ORGANIZATION_LD,
  ORGANIZATION_LD_FULL,
  ORGANIZATION_POLICIES,
  ORGANIZATION_SAME_AS,
  ORGANIZATION_FOUNDING_DATE,
} from '../services/seo/organizationLd';
import { imageObjectLd } from '../services/seo/imageObjectLd';
import { normalizeStructuredData } from '../services/seo/schema-normalizers';
import { SKIP_LIVE_DATA } from './helpers/live-data';

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
const STATIC_PAGES_PLUGIN = read('build-plugins/staticPagesPlugin.ts');
// Corpus pubblicato (`packages/articles/content/`, riscritto dal sync del
// corpus): letto solo dentro il caso che lo verifica, che nel gate PR salta con
// SKIP_LIVE_DATA e gira nel monitor dei dati vivi (live-data-test-guard).
const STATIC_BLOG_SEO_FILES = [
  'packages/articles/content/seo/seo-blog-2.ts',
  'packages/articles/content/seo/seo-blog-3.ts',
  'packages/articles/content/seo/seo-blog-4.ts',
  'packages/articles/content/seo/seo-blog-5.ts',
  'packages/articles/content/seo/seo-blog-6.ts',
  'packages/articles/content/seo/seo-blog-7.ts',
  'packages/articles/content/seo/seo-blog-ch.ts',
  'packages/articles/content/seo/seo-blog.ts',
];

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


/**
 * Emitters whose JSON-LD reaches the page as written. Excluded, each with its
 * own guard: `services/seo/seo-pages.ts` (every consumer runs it through
 * normalizeStructuredData — staticPagesPlugin and seoService — covered by the
 * "normalizes legacy nested site organizations" case) and the corpus SEO
 * chunks (symlinks into packages/articles/content, live-data case below).
 */
const PAGE_EMITTER_DIRS = ['build-plugins', 'packages/articles/engine', 'components', 'services'];
const PAGE_EMITTER_FILES = ['index.html', 'scripts/create-article.mjs'];
const NORMALIZED_SOURCES = new Set(['services/seo/seo-pages.ts']);

function pageEmitterFiles(): string[] {
  const root = resolve(__dirname, '..');
  const files = [...PAGE_EMITTER_FILES];
  for (const dir of PAGE_EMITTER_DIRS) {
    for (const entry of readdirSync(join(root, dir), { recursive: true }) as string[]) {
      const rel = `${dir}/${entry}`;
      if (!/\.(ts|tsx|mjs)$/.test(rel) || /\.test\./.test(rel) || NORMALIZED_SOURCES.has(rel)) continue;
      if (rel.startsWith('services/locales/')) continue;
      if (!lstatSync(join(root, rel)).isFile()) continue; // symlink = corpus data
      files.push(rel);
    }
  }
  return files;
}

/** Top-level text of a `{…}` literal: nested objects dropped, `${…}` kept. */
function topLevelText(obj: string): string {
  let out = '';
  const stack: boolean[] = []; // true = object brace, false = template expression
  const objDepth = () => stack.filter(Boolean).length;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (c === '{') {
      stack.push(obj[i - 1] !== '$');
      if (objDepth() <= 1 || !stack[stack.length - 1]) out += c;
    } else if (c === '}') {
      if (objDepth() <= 1 || !stack[stack.length - 1]) out += c;
      stack.pop();
    } else if (objDepth() <= 1) {
      out += c;
    }
  }
  return out;
}

const SITE_NAME_RX = /(?:^|[{,\s])(['"]?)name\1\s*:\s*(['"])Frontaliere Ticino\2/;
const SITE_ROOT_URL_RX =
  /(?:^|[{,\s])(['"]?)url\1\s*:\s*(?:`\$\{BASE_URL\}\/?`|(?:BASE_URL|BASE)\s*[,}\n]|(['"])https:\/\/frontaliereticino\.ch\/?\2)/;

/**
 * `Organization` literals that name the site (by name or root URL) without the
 * canonical `@id` — the anonymous second entity issue #5004 removed.
 */
function anonymousSiteOrganizations(src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(/(['"])@type\1\s*:\s*(['"])Organization\2/g)) {
    const start = src.lastIndexOf('{', m.index);
    let depth = 0;
    let end = -1;
    for (let i = start; i < Math.min(src.length, start + 4000); i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (start < 0 || end < 0) continue;
    const top = topLevelText(src.slice(start, end + 1));
    if (/(['"]?)@id\1\s*:/.test(top)) continue;
    if (!SITE_NAME_RX.test(top) && !SITE_ROOT_URL_RX.test(top)) continue;
    hits.push(`line ${src.slice(0, m.index).split('\n').length}: ${top.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  return hits;
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
  it('uses the Google-supported Organization type and preserves its editorial specialization', () => {
    expect(ORGANIZATION_LD['@type']).toBe('Organization');
    expect(ORGANIZATION_LD_FULL.additionalType).toBe('https://schema.org/NewsMediaOrganization');
    expect(homepageOrganization()['@type']).toBe('Organization');
    expect(homepageOrganization().additionalType).toBe(ORGANIZATION_LD_FULL.additionalType);
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

  it('reuses the canonical identity for the default ImageObject creator', () => {
    expect(imageObjectLd({ contentUrl: `${BASE_URL}/image.webp` }).creator).toEqual({
      '@type': 'Organization',
      '@id': ORGANIZATION_ID,
      name: ORGANIZATION_LD.name,
      url: ORGANIZATION_LD.url,
    });
  });

  it('replaces stale site identities while preserving external attribution', () => {
    const creator = Object.freeze({
      '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE_URL,
      '@id': 'https://example.com/#stale-site-id',
    });
    const publisher = Object.freeze({
      '@type': 'Organization', name: 'External newsroom', url: 'https://example.com/',
      '@id': 'https://example.com/#newsroom',
    });
    const normalized = normalizeStructuredData({ '@type': 'NewsArticle', creator, publisher });
    expect(normalized.creator).toEqual({ ...creator, '@id': ORGANIZATION_ID });
    expect(normalized.publisher).toEqual(publisher);
    expect(creator['@id']).toBe('https://example.com/#stale-site-id');
  });

  it.each(['ImageObject', 'NewsArticle'])('preserves same-name external identities without a URL inside %s', (type) => {
    const external = Object.freeze({
      '@type': 'Organization', name: 'Frontaliere Ticino', '@id': 'https://example.com/#newsroom',
    });
    const normalized = normalizeStructuredData({ '@type': type, creator: external, publisher: external, author: external });
    for (const entity of [normalized.creator, normalized.publisher, normalized.author]) {
      expect(entity).toEqual(external);
    }
  });

  it('normalizes legacy nested site organizations to the canonical identity', () => {
    const normalized = normalizeStructuredData({
      '@type': 'ImageObject',
      creator: { '@type': 'Organization', name: 'Frontaliere Ticino', url: BASE_URL },
    });
    expect(normalized).toMatchObject({
      creator: {
        '@type': 'Organization',
        '@id': ORGANIZATION_ID,
        name: ORGANIZATION_LD.name,
      },
    });
  });

  it.each([
    'NewsMediaOrganization',
    ['NewsMediaOrganization', 'Organization'],
    ['Organization', 'NewsMediaOrganization'],
  ].map((creatorType) => ({ creatorType })))('repairs creator and publisher type $creatorType without changing their identity', ({ creatorType }) => {
    const legacy = {
      '@type': creatorType,
      name: 'Frontaliere Ticino', url: `${BASE_URL}/`,
    };
    for (const type of ['Dataset', 'ImageObject', 'Article']) {
      const output = normalizeStructuredData({ '@type': type, creator: legacy, publisher: legacy });
      for (const entity of [output.creator, output.publisher]) {
        expect(entity).toEqual({ ...legacy, '@type': 'Organization', '@id': ORGANIZATION_ID });
      }
    }
    expect(legacy['@type']).toEqual(creatorType);
  });

  it('detects an anonymous site Organization literal and ignores identified or foreign ones', () => {
    expect(anonymousSiteOrganizations(`creator: {\n '@type': 'Organization',\n name: 'Frontaliere Ticino',\n url: \`\${BASE_URL}/\`,\n},`)).toHaveLength(1);
    expect(anonymousSiteOrganizations(`publisher: { '@type': 'Organization', name: copy.org, url: BASE_URL, logo: imageObjectLd({ url: x }) }`)).toHaveLength(1);
    expect(anonymousSiteOrganizations('"creator":{"@type":"Organization","name":"Frontaliere Ticino"}')).toHaveLength(1);
    expect(anonymousSiteOrganizations(`{ '@type': 'Organization', '@id': \`\${BASE_URL}/#organization\`, name: 'Frontaliere Ticino' }`)).toEqual([]);
    expect(anonymousSiteOrganizations(`{ '@type': 'Organization', name: companyName, url: cWebsite !== BASE_URL ? cWebsite : undefined }`)).toEqual([]);
    expect(anonymousSiteOrganizations(`{ '@type': 'Organization', name: c.employer, url: \`\${BASE_URL}\${href}\` }`)).toEqual([]);
    expect(anonymousSiteOrganizations(`{ '@type': 'Organization', name: 'BFS', isPartOf: { '@id': 'x', name: 'Frontaliere Ticino' } }`)).toEqual([]);
  });

  it('no page emitter declares the site as an anonymous Organization', () => {
    const offenders = pageEmitterFiles().flatMap((file) =>
      anonymousSiteOrganizations(read(file)).map((hit) => `${file} ${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  it('emitters never put the Google-rejected news subtype in @type', () => {
    const offenders = pageEmitterFiles().filter((file) =>
      /['"]@type['"]\s*:\s*['"]NewsMediaOrganization['"]\s*[,}]/.test(read(file)),
    );
    expect(offenders).toEqual([]);
  });

  it.skipIf(SKIP_LIVE_DATA)('gives every static blog ImageObject creator the canonical identity', () => {
    for (const file of STATIC_BLOG_SEO_FILES) {
      const source = read(file);
      expect(source, `${file} still emits an anonymous site ImageObject creator`).not.toContain(
        '"creator": { "@type": "Organization", "name": "Frontaliere Ticino"',
      );
      const creators = [...source.matchAll(/"creator":\s*(\{[^{}]*"@id":\s*"https:\/\/frontaliereticino\.ch\/#organization"[^{}]*\})/g)];
      expect(creators.length, `${file} has no canonical image creator`).toBeGreaterThan(0);
      for (const match of creators) {
        // Static registry consumers normalize legacy corpus records before emission.
        expect(normalizeStructuredData(JSON.parse(match[1]))).toMatchObject({
          '@type': 'Organization', '@id': ORGANIZATION_ID, name: ORGANIZATION_LD.name,
        });
      }
    }
  });

  it('gives every static editorial byline the canonical microdata itemid', () => {
    const bylines = [
      ...STATIC_PAGES_PLUGIN.matchAll(
        /itemprop="author"[^>]*itemid="https:\/\/frontaliereticino\.ch\/#organization"/g,
      ),
    ];
    expect(bylines).toHaveLength(4);
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
