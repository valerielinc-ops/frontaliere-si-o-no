function normalizePath(input = '') {
  let path = String(input || '').trim();
  if (!path) return '/';

  try {
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      path = `${url.pathname}${url.search || ''}`;
    }
  } catch {
    return '/';
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

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function classifyAnalyticsPath(inputPath = '') {
  const normalizedPath = normalizePath(inputPath);
  const localeMatch = normalizedPath.match(/^\/(en|de|fr)(?=\/|$)/i);
  const contentLocale = (localeMatch?.[1]?.toLowerCase() || 'it');
  const localPath = normalizedPath.replace(/^\/(en|de|fr)(?=\/|$)/i, '') || '/';

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
    return { contentGroup: 'core', pageTemplate: 'homepage', siteSection: 'home', contentLocale, routeFamily: 'home' };
  }

  if (startsWithAny(localPath, jobBoardRoots)) {
    const tail = localPath.split('/').filter(Boolean).slice(1).join('/');
    const firstTail = tail.split('/')[0] || '';
    const isCompany = /^(azienda|company|unternehmen|entreprise)-/i.test(firstTail);
    const isSearch = /^(ricerca|search|suche|recherche)-/i.test(firstTail);
    const pageTemplate = !tail ? 'jobs_index' : isCompany ? 'jobs_company' : isSearch ? 'jobs_search' : 'job_detail';
    return { contentGroup: 'jobs', pageTemplate, siteSection: 'jobs', contentLocale, routeFamily: pageTemplate };
  }

  if (startsWithAny(localPath, articleRoots)) {
    const hasChild = localPath.split('/').filter(Boolean).length > 1;
    return { contentGroup: 'articles', pageTemplate: hasChild ? 'article_detail' : 'article_index', siteSection: 'articles', contentLocale, routeFamily: hasChild ? 'article_detail' : 'article_index' };
  }

  if (startsWithAny(localPath, statsRoots)) {
    const hasChild = localPath.split('/').filter(Boolean).length > 1;
    return { contentGroup: 'stats', pageTemplate: hasChild ? 'stats_detail' : 'stats_index', siteSection: 'stats', contentLocale, routeFamily: hasChild ? 'stats_detail' : 'stats_index' };
  }

  if (startsWithAny(localPath, calculatorRoots)) {
    return { contentGroup: 'tools', pageTemplate: localPath.split('/').filter(Boolean).length > 1 ? 'calculator_tool' : 'calculator_index', siteSection: 'calculator', contentLocale, routeFamily: 'calculator' };
  }
  if (startsWithAny(localPath, compareRoots)) {
    return { contentGroup: 'tools', pageTemplate: localPath.split('/').filter(Boolean).length > 1 ? 'comparison_tool' : 'comparison_index', siteSection: 'compare', contentLocale, routeFamily: 'comparison' };
  }
  if (startsWithAny(localPath, guideRoots)) {
    return { contentGroup: 'guides', pageTemplate: localPath.split('/').filter(Boolean).length > 1 ? 'guide_detail' : 'guide_index', siteSection: 'guide', contentLocale, routeFamily: 'guide' };
  }
  if (startsWithAny(localPath, taxRoots)) {
    return { contentGroup: 'guides', pageTemplate: localPath.split('/').filter(Boolean).length > 1 ? 'tax_detail' : 'tax_index', siteSection: 'tax', contentLocale, routeFamily: 'tax' };
  }
  if (startsWithAny(localPath, lifeRoots)) {
    return { contentGroup: 'guides', pageTemplate: localPath.split('/').filter(Boolean).length > 1 ? 'life_detail' : 'life_index', siteSection: 'life', contentLocale, routeFamily: 'life' };
  }
  if (startsWithAny(localPath, glossaryRoots)) {
    return { contentGroup: 'reference', pageTemplate: localPath.split('/').filter(Boolean).length > 1 ? 'glossary_detail' : 'glossary_index', siteSection: 'glossary', contentLocale, routeFamily: 'glossary' };
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
  return { contentGroup: 'other', pageTemplate: 'generic_page', siteSection: firstSegment, contentLocale, routeFamily: firstSegment };
}

export function aggregateRowsByTemplate(rows = [], metricShape = 'gsc') {
  const byTemplate = new Map();

  for (const row of rows) {
    const path = row?.path || row?.page || '';
    if (!path) continue;
    const context = classifyAnalyticsPath(path);
    const current = byTemplate.get(context.pageTemplate) || {
      pageTemplate: context.pageTemplate,
      contentGroup: context.contentGroup,
      siteSection: context.siteSection,
      contentLocale: context.contentLocale,
      pages: 0,
      views: 0,
      users: 0,
      clicks: 0,
      impressions: 0,
      weightedDuration: 0,
      weightedPosition: 0,
    };

    current.pages += 1;
    if (metricShape === 'ga4') {
      const views = Number(row?.views || 0);
      const users = Number(row?.users || 0);
      const avgDuration = Number(row?.avgDuration || 0);
      current.views += views;
      current.users += users;
      current.weightedDuration += avgDuration * Math.max(users, 1);
    } else {
      const clicks = Number(row?.clicks || 0);
      const impressions = Number(row?.impressions || 0);
      const position = Number(row?.position || 0);
      current.clicks += clicks;
      current.impressions += impressions;
      current.weightedPosition += position * Math.max(impressions, 1);
    }
    byTemplate.set(context.pageTemplate, current);
  }

  return [...byTemplate.values()]
    .map((entry) => ({
      pageTemplate: entry.pageTemplate,
      contentGroup: entry.contentGroup,
      siteSection: entry.siteSection,
      contentLocale: entry.contentLocale,
      pages: entry.pages,
      ...(metricShape === 'ga4'
        ? {
            views: entry.views,
            users: entry.users,
            avgDuration: entry.users > 0 ? Math.round(entry.weightedDuration / entry.users) : 0,
          }
        : {
            clicks: entry.clicks,
            impressions: entry.impressions,
            ctr: entry.impressions > 0 ? Number(((entry.clicks / entry.impressions) * 100).toFixed(2)) : 0,
            avgPosition: entry.impressions > 0 ? Number((entry.weightedPosition / entry.impressions).toFixed(1)) : 0,
          }),
    }))
    .sort((a, b) => (metricShape === 'ga4' ? b.views - a.views : b.impressions - a.impressions));
}

export function clusterTopQueries(queries = []) {
  const patterns = [
    { cluster: 'jobs', re: /\b(lavoro|offerte|impiego|job|posti|concorso|concorsi)\b/i },
    { cluster: 'salary', re: /\b(stipendio|stipendi|salary|salario|salari|ral|busta paga|netto)\b/i },
    { cluster: 'tax', re: /\b(tasse|tass|irpef|imposta|fonte|730|redditi|fisc)\b/i },
    { cluster: 'permits', re: /\b(permesso|permit|bewilligung)\b/i },
    { cluster: 'border', re: /\b(dogana|valico|frontiera|border|traffico)\b/i },
    { cluster: 'insurance', re: /\b(lamal|cassa malati|assicurazione|krankenkasse|assurance)\b/i },
  ];
  const buckets = new Map();

  for (const query of queries) {
    const label = String(query?.query || '').trim();
    if (!label) continue;
    const matcher = patterns.find((pattern) => pattern.re.test(label));
    const cluster = matcher?.cluster || 'other';
    const current = buckets.get(cluster) || { cluster, queries: 0, clicks: 0, impressions: 0 };
    current.queries += 1;
    current.clicks += Number(query?.clicks || 0);
    current.impressions += Number(query?.impressions || 0);
    buckets.set(cluster, current);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      ctr: bucket.impressions > 0 ? Number(((bucket.clicks / bucket.impressions) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.impressions - a.impressions);
}

export function buildNearWinQueries(queries = [], { minImpressions = 50, minPosition = 2.5, maxPosition = 12 } = {}) {
  return queries
    .filter((query) => Number(query?.impressions || 0) >= minImpressions)
    .filter((query) => Number(query?.position || 0) >= minPosition && Number(query?.position || 0) <= maxPosition)
    .map((query) => ({
      ...query,
      opportunityScore: Math.round(Number(query.impressions || 0) * Math.max(1, maxPosition - Number(query.position || 0))),
    }))
    .sort((a, b) => b.opportunityScore - a.opportunityScore || b.impressions - a.impressions)
    .slice(0, 15);
}

export function buildAnalyticsSnapshot(report = {}) {
  const gsc = report.searchConsole || {};
  const ga4 = report.ga4 || {};
  return {
    generated: report.generated || new Date().toISOString(),
    periodDays: report.periodDays || null,
    searchConsole: {
      summary: gsc.summary || null,
      nearWinQueries: gsc.nearWinQueries || [],
      lowCtrPages: gsc.lowCtrPages || [],
      queryClusters: gsc.queryClusters || [],
      pageTemplatePerformance: gsc.pageTemplatePerformance || [],
    },
    ga4: {
      summary: ga4.summary || null,
      pageTemplatePerformance: ga4.pageTemplatePerformance || [],
      internalSearchTerms: ga4.internalSearchTerms || [],
      landingPages: ga4.landingPages || [],
      recommendations: ga4.recommendations || [],
    },
    bing: report.bing?.traffic || null,
    clarity: report.clarity?.overview || null,
    pageSpeed: report.pageSpeed || null,
    crux: report.crux || null,
  };
}
