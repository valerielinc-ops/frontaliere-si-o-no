/**
 * JSON-LD delle pagine statiche localizzate: parità sui 4 locali.
 *
 * Il difetto (issue 9108, casi #10992 e #11328): in `staticPagesPlugin.ts`
 * `deriveLocaleSeo` sceglie l'head di una variante EN/DE/FR con un ramo per
 * famiglia di pagina (metodologia, glossario hub e foglia, guide, landing
 * salariali, homepage, fallback generico). Diversi rami restituiscono
 * `sd: italianSeo.sd`, cioè il JSON-LD italiano, e affidano la localizzazione
 * al passaggio comune che li segue. Quel passaggio traduceva solo i testi che
 * un dizionario per-@type conosceva e rimetteva in pagina l'IDENTITÀ italiana
 * del nodo pagina: `url` e `@id` della pagina italiana, `name` e
 * `description` italiani, con `inLanguage` già in inglese/tedesco/francese.
 * Ogni ramo nuovo doveva ricordarsi di localizzare il proprio `sd` (lo hanno
 * fatto, a posteriori, metodologia e glossario): un ramo dimenticato era una
 * pagina `/en/…` che si dichiarava `/…` in italiano.
 *
 * Questo test gira il passaggio comune VERO (`localizeStaticPageStructuredData`,
 * lo stesso che chiama il plugin) su ogni voce statica italiana di
 * `services/seo/seo-pages.ts` (metodologia, glossario, contatti, statistiche…)
 * più le correzioni, cioè sul caso peggiore: il ramo che passa l'`sd` italiano
 * così com'è. Per ogni voce e ogni locale verifica:
 *   - stessi @type, nello stesso ordine, della versione italiana;
 *   - nessun campo presente in italiano sparisce;
 *   - il nodo pagina (url o @id della pagina sorgente) dichiara l'URL e la
 *     lingua della variante, e il suo name/description non è più l'italiano.
 */
import { describe, it, expect } from 'vitest';
import SEO_PAGES_METADATA from '../services/seo/seo-pages';
import { buildCorrezioniSeo } from '../services/seo/seo-correzioni';
import { parsePath, buildAllLocalePaths } from '../services/router';
import { buildGlossaryHubSchema } from '../services/seo/glossaryHubSchema';
import { inlineScriptJson } from '../build-plugins/shared/inlineJsonScript';
import { normalizeArticleStructuredData, normalizeStructuredData } from '../services/seo/schema-normalizers';
import {
  localizeStaticPageStructuredData,
  PAGE_IDENTITY_TYPES,
} from '../build-plugins/shared/localeStaticStructuredData';

const BASE = 'https://frontaliereticino.ch';
const SEPARATOR = '</script>\n <script type="application/ld+json">';
const LOCALES = ['en', 'de', 'fr'] as const;
/** Page types whose `name`/`description` describe the page itself. */
const WEB_PAGE_FAMILY = new Set(['WebPage', 'AboutPage', 'CollectionPage', 'ContactPage', 'ProfilePage', 'ItemPage', 'QAPage', 'MedicalWebPage', 'SearchResultsPage']);

type Node = Record<string, unknown>;
interface Case { key: string; sourcePath: string; sd: string }

const stripFragment = (u: unknown) => (typeof u === 'string' ? u.split('#')[0].replace(/\/+$/, '') : undefined);

const nodesOf = (serialized: string): Node[] => serialized.split(SEPARATOR).flatMap((part) => {
  const parsed: unknown = JSON.parse(part);
  const top = Array.isArray(parsed) ? parsed : [parsed];
  return top.flatMap((n) => (n && typeof n === 'object' && Array.isArray((n as Node)['@graph'])
    ? ((n as Node)['@graph'] as Node[])
    : [n as Node]));
});

const typeOf = (n: Node) => JSON.stringify(n['@type']);

/**
 * The Italian `sd` exactly as staticPagesPlugin builds it from a registry entry
 * (step 2, `seoMap`): the redundant WebPage dropped next to a more specific
 * type, both normalizers, one script per item.
 */
const SPECIFIC_TYPES = new Set(['FAQPage', 'WebApplication', 'Dataset', 'ItemList', 'Organization', 'Article', 'NewsArticle', 'BlogPosting', 'Event', 'HowTo', 'Product', 'SoftwareApplication', 'CollectionPage']);
const serialize = (sd: unknown) => {
  let parsed: unknown = JSON.parse(JSON.stringify(sd));
  if (Array.isArray(parsed) && parsed.length > 1 && parsed.some((n: Node) => SPECIFIC_TYPES.has(String(n['@type'] || '')))) {
    parsed = parsed.filter((n: Node) => String(n['@type'] || '') !== 'WebPage');
  }
  parsed = normalizeArticleStructuredData(normalizeStructuredData(parsed));
  return Array.isArray(parsed) ? parsed.map((item) => inlineScriptJson(item)).join(SEPARATOR) : inlineScriptJson(parsed);
};

const cases: Case[] = [];
for (const [key, meta] of Object.entries(SEO_PAGES_METADATA as Record<string, { canonicalPath?: string; structuredData?: unknown }>)) {
  if (!meta.structuredData || !meta.canonicalPath) continue;
  // EN/DE/FR alias entries are their own page, looked up before deriveLocaleSeo.
  if (/^\/(?:en|de|fr)\//.test(meta.canonicalPath)) continue;
  cases.push({ key, sourcePath: meta.canonicalPath, sd: serialize(meta.structuredData) });
}
// `deriveLocaleSeo` serializes the corrections page as ONE top-level array.
cases.push({ key: 'correzioni', sourcePath: '/correzioni/', sd: JSON.stringify([buildCorrezioniSeo('it').jsonLd]) });

const byKey = (k: string) => cases.find((c) => c.key === k);

/**
 * The variant's real path, as the sitemap hreflang gives it to the plugin; a
 * path the router does not round-trip keeps a prefixed stand-in, which still
 * differs from the Italian URL the parity is about.
 */
const variantPath = (sourcePath: string, locale: typeof LOCALES[number]) => {
  const { route, notFoundPath } = parsePath(sourcePath);
  const paths = notFoundPath ? null : buildAllLocalePaths(route);
  return paths && paths.it === sourcePath && paths[locale] !== sourcePath ? paths[locale] : `/${locale}${sourcePath}`;
};

const localize = (c: Case, locale: typeof LOCALES[number]) => {
  const canonicalUrl = `${BASE}${variantPath(c.sourcePath, locale)}`;
  const out = localizeStaticPageStructuredData(c.sd, {
    sourceUrl: `${BASE}${c.sourcePath}`,
    canonicalUrl,
    headline: `[${locale}] ${c.key} | Frontaliere Ticino`,
    description: `[${locale}] description of ${c.key}`,
    locale,
  }, SEPARATOR);
  return { canonicalUrl, out: out ?? '' };
};

describe('JSON-LD delle pagine statiche localizzate: rami SSG per locale', () => {
  it('il censimento copre le pagine statiche localizzate, metodologia e glossario compresi', () => {
    expect(cases.length).toBeGreaterThan(50);
    expect(byKey('metodologia')).toBeDefined();
    expect(cases.some((c) => c.sourcePath.startsWith('/glossario-frontaliere/'))).toBe(true);
  });

  for (const locale of LOCALES) {
    it(`${locale}: stessi @type e nessun campo perso rispetto all'italiano`, () => {
      const drift: string[] = [];
      for (const c of cases) {
        const itNodes = nodesOf(c.sd);
        const loc = nodesOf(localize(c, locale).out);
        if (itNodes.map(typeOf).join() !== loc.map(typeOf).join()) {
          drift.push(`${c.key}: @type ${itNodes.map(typeOf).join()} -> ${loc.map(typeOf).join()}`);
          continue;
        }
        itNodes.forEach((node, i) => {
          const lost = Object.keys(node).filter((k) => !(k in loc[i]));
          if (lost.length) drift.push(`${c.key}#${i} ${typeOf(node)}: persi ${lost.join(', ')}`);
        });
      }
      expect(drift).toEqual([]);
    });

    it(`${locale}: il nodo pagina dichiara URL e lingua della variante, non l'italiano`, () => {
      const drift: string[] = [];
      let pageNodes = 0;
      for (const c of cases) {
        const source = stripFragment(`${BASE}${c.sourcePath}`);
        const itNodes = nodesOf(c.sd);
        const { canonicalUrl, out } = localize(c, locale);
        const loc = nodesOf(out);
        itNodes.forEach((node, i) => {
          const types = (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]) as unknown[];
          if (!types.some((t) => typeof t === 'string' && PAGE_IDENTITY_TYPES.has(t))) return;
          if (stripFragment(node.url) !== source && stripFragment(node['@id']) !== source) return;
          pageNodes++;
          const l = loc[i];
          const where = `${c.key}#${i} ${typeOf(node)}`;
          if (typeof node.url === 'string' && l.url !== canonicalUrl) drift.push(`${where}: url ${String(l.url)}`);
          if (stripFragment(node['@id']) === source && stripFragment(l['@id']) !== stripFragment(canonicalUrl)) drift.push(`${where}: @id ${String(l['@id'])}`);
          if (typeof node.inLanguage === 'string' && l.inLanguage !== locale) drift.push(`${where}: inLanguage ${String(l.inLanguage)}`);
          if (types.some((t) => typeof t === 'string' && WEB_PAGE_FAMILY.has(t))) {
            if (typeof node.name === 'string' && l.name === node.name) drift.push(`${where}: name italiano «${node.name}»`);
            if (typeof node.description === 'string' && l.description === node.description) drift.push(`${where}: description italiana`);
          }
        });
      }
      expect(pageNodes).toBeGreaterThan(0);
      expect(drift).toEqual([]);
    });
  }

  it('metodologia: l’AboutPage in tedesco è la pagina tedesca (caso #11328)', () => {
    const c = byKey('metodologia')!;
    const { canonicalUrl, out } = localize(c, 'de');
    const about = nodesOf(out).find((n) => n['@type'] === 'AboutPage')!;
    expect(about.url).toBe(canonicalUrl);
    expect(about.inLanguage).toBe('de');
    expect(about.name).not.toMatch(/Metodologia/);
  });

  it('i nodi che non sono la pagina restano intatti (Organization, WebSite, HowTo)', () => {
    const c = byKey('calculator')!;
    const itNodes = nodesOf(c.sd);
    const loc = nodesOf(localize(c, 'en').out);
    itNodes.forEach((node, i) => {
      if (node['@type'] === 'Organization' || node['@type'] === 'WebSite') {
        expect(loc[i].url).toBe(node.url);
        expect(loc[i].name).toBe(node.name);
      }
    });
  });

  it('il passaggio è idempotente: una seconda passata non cambia niente', () => {
    for (const c of cases.slice(0, 40)) {
      const page = {
        sourceUrl: `${BASE}${c.sourcePath}`,
        canonicalUrl: `${BASE}${variantPath(c.sourcePath, 'fr')}`,
        headline: `[fr] ${c.key}`,
        description: `[fr] ${c.key}`,
        locale: 'fr' as const,
      };
      const once = localizeStaticPageStructuredData(c.sd, page, SEPARATOR);
      expect(localizeStaticPageStructuredData(once, page, SEPARATOR)).toBe(once);
    }
  });
});

// Il gemello SPA della stessa classe: il DefinedTermSet che `Glossary.tsx`
// inietta all'idratazione portava nome, descrizione e URL italiani (senza
// slash finale) anche su `/en/cross-border-glossary/` e fratelli.
describe('glossario SPA: il DefinedTermSet idratato è nella lingua della pagina', () => {
  const terms = [{ name: 'AVS', description: 'Assicurazione vecchiaia e superstiti.' }];
  const itSchema = buildGlossaryHubSchema(terms, 'it');
  const HUB_PATHS = { it: '/glossario-frontaliere/', en: '/en/cross-border-glossary/', de: '/de/grenzgaenger-glossar/', fr: '/fr/glossaire-frontalier/' } as const;

  for (const locale of ['it', ...LOCALES] as const) {
    it(`${locale}: stessa forma dell'italiano, URL dell'hub della lingua con slash finale`, () => {
      const loc = buildGlossaryHubSchema(terms, locale);
      expect(Object.keys(loc)).toEqual(Object.keys(itSchema));
      expect(loc['@type']).toBe('DefinedTermSet');
      expect(loc.url).toBe(`${BASE}${HUB_PATHS[locale]}`);
      const term = (loc.hasDefinedTerm as Node[])[0];
      expect(term['@type']).toBe('DefinedTerm');
      expect(Object.keys(term)).toEqual(Object.keys((itSchema.hasDefinedTerm as Node[])[0]));
      if (locale !== 'it') {
        expect(loc.name).not.toBe(itSchema.name);
        expect(loc.description).not.toBe(itSchema.description);
        expect((term.inDefinedTermSet as Node).name).not.toBe(((itSchema.hasDefinedTerm as Node[])[0].inDefinedTermSet as Node).name);
      }
    });
  }
});
