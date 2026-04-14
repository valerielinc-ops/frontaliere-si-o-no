export type AnalyticsPageContext = {
 contentGroup: string;
 pageTemplate: string;
 siteSection: string;
 contentLocale: 'it' | 'en' | 'de' | 'fr';
 routeFamily: string;
};

const LOCALE_PREFIX_RE = /^\/(en|de|fr)(?=\/|$)/i;

function normalizePath(input: string): string {
 let path = String(input || '').trim();
 if (!path) return '/';

 if (/^https?:\/\//i.test(path)) {
 try {
 path = new URL(path).pathname + (new URL(path).search || '');
 } catch {
 return '/';
 }
 }

 const hashIndex = path.indexOf('#');
 if (hashIndex >= 0) path = path.slice(0, hashIndex);
 const queryIndex = path.indexOf('?');
 if (queryIndex >= 0) path = path.slice(0, queryIndex);
 if (!path.startsWith('/')) path = `/${path}`;
 path = path.replace(/\/{2,}/g, '/');
 if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
 return path || '/';
}

function startsWithAny(path: string, prefixes: string[]): boolean {
 return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function deriveAnalyticsPageContext(inputPath: string): AnalyticsPageContext {
 const normalizedPath = normalizePath(inputPath);
 const localeMatch = normalizedPath.match(LOCALE_PREFIX_RE);
 const contentLocale = (localeMatch?.[1]?.toLowerCase() || 'it') as AnalyticsPageContext['contentLocale'];
 const localPath = normalizedPath.replace(LOCALE_PREFIX_RE, '') || '/';

 const jobBoardRoots = ['/cerca-lavoro-ticino', '/find-jobs-ticino', '/jobs-im-tessin', '/trouver-emploi-tessin'];
 const articleRoots = ['/articoli-frontaliere', '/cross-border-articles', '/artikel-grenzgaenger', '/articles-frontaliers'];
 const statsRoots = ['/statistiche', '/statistics', '/statistiken', '/statistiques'];
 const guideRoots = ['/guida-frontaliere', '/cross-border-guide', '/grenzgaenger-guide', '/guide-frontalier'];
 const compareRoots = ['/compara-servizi', '/compare-services', '/services-vergleichen', '/comparer-services'];
 const calculatorRoots = ['/calcola-stipendio', '/salary-calculator', '/lohnrechner', '/calcul-salaire'];
 const taxRoots = ['/tasse-e-pensione', '/taxes-and-pension', '/steuern-und-rente', '/impots-et-pension'];
 const lifeRoots = ['/vivere-in-ticino', '/living-in-ticino', '/leben-im-tessin', '/vivre-au-tessin'];
 const glossaryRoots = ['/glossario-frontaliere', '/cross-border-glossary', '/grenzgaenger-glossar', '/glossaire-frontalier'];

 if (localPath === '/') {
 return {
 contentGroup: 'core',
 pageTemplate: 'homepage',
 siteSection: 'home',
 contentLocale,
 routeFamily: 'home',
 };
 }

 if (startsWithAny(localPath, jobBoardRoots)) {
 const tail = localPath.split('/').filter(Boolean).slice(1).join('/');
 const firstTail = tail.split('/')[0] || '';
 const isCompany = /^(azienda|company|unternehmen|entreprise)-/i.test(firstTail);
 const isSearch = /^(ricerca|search|suche|recherche)-/i.test(firstTail);
 return {
 contentGroup: 'jobs',
 pageTemplate: !tail ? 'jobs_index' : isCompany ? 'jobs_company' : isSearch ? 'jobs_search' : 'job_detail',
 siteSection: 'jobs',
 contentLocale,
 routeFamily: !tail ? 'jobs_index' : isCompany ? 'jobs_company' : isSearch ? 'jobs_search' : 'job_detail',
 };
 }

 if (startsWithAny(localPath, articleRoots)) {
 const hasArticleSlug = localPath.split('/').filter(Boolean).length > 1;
 return {
 contentGroup: 'articles',
 pageTemplate: hasArticleSlug ? 'article_detail' : 'article_index',
 siteSection: 'articles',
 contentLocale,
 routeFamily: hasArticleSlug ? 'article_detail' : 'article_index',
 };
 }

 if (startsWithAny(localPath, statsRoots)) {
 const hasChild = localPath.split('/').filter(Boolean).length > 1;
 return {
 contentGroup: 'stats',
 pageTemplate: hasChild ? 'stats_detail' : 'stats_index',
 siteSection: 'stats',
 contentLocale,
 routeFamily: hasChild ? 'stats_detail' : 'stats_index',
 };
 }

 if (startsWithAny(localPath, calculatorRoots)) {
 return {
 contentGroup: 'tools',
 pageTemplate: localPath === calculatorRoots.find((root) => localPath === root) ? 'calculator_index' : 'calculator_tool',
 siteSection: 'calculator',
 contentLocale,
 routeFamily: 'calculator',
 };
 }

 if (startsWithAny(localPath, compareRoots)) {
 return {
 contentGroup: 'tools',
 pageTemplate: localPath === compareRoots.find((root) => localPath === root) ? 'comparison_index' : 'comparison_tool',
 siteSection: 'compare',
 contentLocale,
 routeFamily: 'comparison',
 };
 }

 if (startsWithAny(localPath, guideRoots)) {
 return {
 contentGroup: 'guides',
 pageTemplate: localPath === guideRoots.find((root) => localPath === root) ? 'guide_index' : 'guide_detail',
 siteSection: 'guide',
 contentLocale,
 routeFamily: 'guide',
 };
 }

 if (startsWithAny(localPath, taxRoots)) {
 return {
 contentGroup: 'guides',
 pageTemplate: localPath === taxRoots.find((root) => localPath === root) ? 'tax_index' : 'tax_detail',
 siteSection: 'tax',
 contentLocale,
 routeFamily: 'tax',
 };
 }

 if (startsWithAny(localPath, lifeRoots)) {
 return {
 contentGroup: 'guides',
 pageTemplate: localPath === lifeRoots.find((root) => localPath === root) ? 'life_index' : 'life_detail',
 siteSection: 'life',
 contentLocale,
 routeFamily: 'life',
 };
 }

 if (startsWithAny(localPath, glossaryRoots)) {
 return {
 contentGroup: 'reference',
 pageTemplate: localPath === glossaryRoots.find((root) => localPath === root) ? 'glossary_index' : 'glossary_detail',
 siteSection: 'glossary',
 contentLocale,
 routeFamily: 'glossary',
 };
 }

 if (startsWithAny(localPath, ['/community'])) {
 return { contentGroup: 'community', pageTemplate: 'community', siteSection: 'community', contentLocale, routeFamily: 'community' };
 }
 if (startsWithAny(localPath, ['/profilo', '/profile', '/profil'])) {
 return { contentGroup: 'account', pageTemplate: 'account', siteSection: 'account', contentLocale, routeFamily: 'account' };
 }
 if (startsWithAny(localPath, ['/newsletter'])) {
 return { contentGroup: 'marketing', pageTemplate: 'newsletter', siteSection: 'newsletter', contentLocale, routeFamily: 'newsletter' };
 }

 const firstSegment = localPath.split('/').filter(Boolean)[0] || 'other';
 return {
 contentGroup: 'other',
 pageTemplate: 'generic_page',
 siteSection: firstSegment,
 contentLocale,
 routeFamily: firstSegment,
 };
}
