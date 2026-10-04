import { normalizeStructuredData } from '../../services/seo/schema-normalizers';
import { translateSchema, type SupportedLocale } from '../../services/seo/schema-translators';
import { localizeArticlePageIdentity } from '../../services/seo/article-page-identity';
import { inlineScriptJson } from './inlineJsonScript';

/**
 * Schema types that can BE the page (or the entity the page is about, for the
 * glossary): when one of them still carries the Italian source URL on an
 * EN/DE/FR variant, its identity is the Italian page's.
 */
export const PAGE_IDENTITY_TYPES: ReadonlySet<string> = new Set([
  'WebPage', 'AboutPage', 'CollectionPage', 'ContactPage', 'FAQPage', 'ProfilePage', 'ItemPage',
  'QAPage', 'MedicalWebPage', 'SearchResultsPage', 'DefinedTermSet', 'DefinedTerm',
]);

/** Page types whose `name`/`description` describe the page itself. */
const WEB_PAGE_TYPES: ReadonlySet<string> = new Set([
  'WebPage', 'AboutPage', 'CollectionPage', 'ContactPage', 'ProfilePage', 'ItemPage',
  'QAPage', 'MedicalWebPage', 'SearchResultsPage',
]);

const BRAND_SUFFIX_RE = /\s*\|\s*Frontaliere Ticino\s*$/;

export interface LocaleStaticPage {
  /** Absolute URL of the Italian source page the entry was written for. */
  sourceUrl: string;
  /** Absolute URL of the localized page being emitted (its self-canonical). */
  canonicalUrl: string;
  /** Localized headline (h1, og title or title) of the emitted page. */
  headline: string;
  /** Localized meta description of the emitted page. */
  description: string;
  /** Localized page name for WebPage-like nodes; defaults to the headline without the brand. */
  name?: string;
  locale: SupportedLocale;
}

type Node = Record<string, unknown>;

const withoutFragment = (url: unknown): string | undefined =>
  typeof url === 'string' ? url.split('#')[0].replace(/\/+$/, '') : undefined;

const typesOf = (node: Node): string[] =>
  (Array.isArray(node['@type']) ? node['@type'] : [node['@type']])
    .filter((t): t is string => typeof t === 'string');

/** Top-level schema nodes of one parsed script: the array items, or the `@graph` members. */
function schemaNodes(parsed: unknown): Node[] {
  const top = Array.isArray(parsed) ? parsed : [parsed];
  return top.flatMap((n) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) return [];
    const node = n as Node;
    return Array.isArray(node['@graph'])
      ? [node, ...(node['@graph'] as unknown[]).filter((g): g is Node => !!g && typeof g === 'object' && !Array.isArray(g))]
      : [node];
  });
}

/**
 * A page node that still names the ITALIAN source page is re-pointed at the
 * variant: url/@id → the variant's canonical, inLanguage → its locale, and a
 * name/description the type translator left untouched → the variant's copy.
 * Nodes already pointing elsewhere (a branch that localized its own `sd`, a
 * linked page, the WebSite/Organization entities) are left alone, so the pass
 * is idempotent.
 */
function localizePageIdentity(node: Node, italian: { name: unknown; description: unknown }, page: LocaleStaticPage): void {
  const types = typesOf(node);
  if (!types.some((t) => PAGE_IDENTITY_TYPES.has(t))) return;
  const source = withoutFragment(page.sourceUrl);
  const urlMatches = withoutFragment(node.url) === source;
  const id = node['@id'];
  const idMatches = withoutFragment(id) === source;
  if (!urlMatches && !idMatches) return;
  if (urlMatches) node.url = page.canonicalUrl;
  if (idMatches && typeof id === 'string') {
    const hash = id.includes('#') ? `#${id.split('#').slice(1).join('#')}` : '';
    node['@id'] = page.canonicalUrl + hash;
  }
  if (typeof node.inLanguage === 'string') node.inLanguage = page.locale;
  if (!types.some((t) => WEB_PAGE_TYPES.has(t))) return;
  if (typeof node.name === 'string' && node.name === italian.name) {
    node.name = page.name ?? page.headline.replace(BRAND_SUFFIX_RE, '');
  }
  if (typeof node.description === 'string' && node.description === italian.description) {
    node.description = page.description;
  }
}

function localizeScript(raw: unknown, page: LocaleStaticPage): unknown {
  const parsed = normalizeStructuredData(raw);
  for (const node of schemaNodes(parsed)) {
    const italian = { name: node.name, description: node.description };
    translateSchema(node, page.locale);
    localizePageIdentity(node, italian, page);
    if (typeof node.inLanguage === 'string') node.inLanguage = page.locale;
  }
  localizeArticlePageIdentity(parsed, page);
  return parsed;
}

/**
 * The single locale pass every EN/DE/FR static page's JSON-LD goes through in
 * staticPagesPlugin, whichever `deriveLocaleSeo` branch produced its `sd`.
 *
 * Several branches return the Italian `sd` untouched and rely on this pass.
 * It used to translate only the text a per-@type dictionary knew and to keep
 * the Italian page identity (url, @id, name, description) under an
 * `inLanguage` already set to the variant: every branch had to localize its
 * own `sd` (methodology #11328, glossary #10992) and a forgotten one shipped
 * `/en/…` pages that declared themselves the Italian page. The identity is
 * now localized here, for every branch, by construction.
 * `tests/static-locale-jsonld-parity.test.ts` holds the 4-locale parity.
 */
export function localizeStaticPageStructuredData(
  serialized: string | undefined,
  page: LocaleStaticPage,
  separator: string,
): string | undefined {
  if (!serialized) return serialized;
  return serialized.split(separator).map((part) => {
    try {
      // Re-escape `<` (inlineScriptJson, NOT a bare JSON.stringify): the JSON.parse
      // below decodes the IT builder's `<` back to a literal `<`, so a raw
      // re-stringify would DOWNGRADE the escape and let a `</script>` inside a
      // translated string value break out of the inline tag on the EN/DE/FR variants
      // — `locSeo.sd` is emitted RAW via `${seoData.sd}` (#1672 escalation).
      return inlineScriptJson(localizeScript(JSON.parse(part), page));
    } catch { /* not valid JSON, pass through (already escaped by the IT builder) */ }
    return part;
  }).join(separator);
}
