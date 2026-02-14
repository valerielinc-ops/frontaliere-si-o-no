/**
 * Path-based Router Service (SEO-friendly)
 * 
 * Uses clean URLs with history.pushState for proper SEO indexing.
 * GitHub Pages SPA support via 404.html redirect.
 * 
 * Routes (SEO-friendly Italian slugs):
 *   /                                         → calculator
 *   /simulatore-what-if                        → calculator / what-if
 *   /comparatori                               → comparatori / exchange (default)
 *   /comparatori/cambio-valuta                 → comparatori / exchange
 *   /comparatori/operatori-mobili              → comparatori / mobile
 *   /comparatori/trasporti                     → comparatori / transport
 *   /comparatori/assicurazioni-sanitarie       → comparatori / health
 *   /comparatori/banche                        → comparatori / banks
 *   /comparatori/traffico-valichi              → comparatori / traffic
 *   /comparatori/offerte-lavoro                → comparatori / jobs
 *   /pianificatore-pensione                    → pension / planner (default)
 *   /pianificatore-pensione/terzo-pilastro     → pension / pillar3
 *   /guida-frontalieri                         → guide / municipalities (default)
 *   /guida-frontalieri/comuni-frontiera        → guide / municipalities
 *   /guida-frontalieri/vivere-in-svizzera      → guide / living-ch
 *   /guida-frontalieri/vivere-in-italia        → guide / living-it
 *   /guida-frontalieri/valichi-frontiera       → guide / border
 *   /guida-frontalieri/costi-pendolarismo      → guide / costs
 *   /guida-frontalieri/calendario-fiscale      → guide / calendar
 *   /guida-frontalieri/permessi-lavoro         → guide / permits
 *   /guida-frontalieri/aziende-ticino          → guide / companies
 *   /guida-frontalieri/spesa-transfrontaliera  → guide / shopping
 *   /guida-frontalieri/costo-della-vita        → guide / cost-of-living
 *   /statistiche                               → stats
 *   /supporto                                  → feedback
 *   /privacy                                   → privacy
 *   /data-deletion                             → data-deletion
 *   /api-status                                → api-status
 */

type ActiveTab = 'calculator' | 'feedback' | 'stats' | 'pension' | 'guide' | 'comparatori' | 'privacy' | 'data-deletion' | 'api-status';
type ComparatoriSubTab = 'exchange' | 'mobile' | 'transport' | 'health' | 'banks' | 'traffic' | 'jobs';
type SimulatorSubTab = 'calculator' | 'whatif';
type PensionSubTab = 'planner' | 'pillar3';
type GuideSection = 'municipalities' | 'living-ch' | 'living-it' | 'border' | 'costs' | 'calendar' | 'permits' | 'companies' | 'shopping' | 'cost-of-living';

export interface AppRoute {
  activeTab: ActiveTab;
  comparatoriSubTab?: ComparatoriSubTab;
  simulatorSubTab?: SimulatorSubTab;
  pensionSubTab?: PensionSubTab;
  guideSection?: GuideSection;
}

// ── Slug maps (internal ID ↔ SEO-friendly Italian slug) ──

const COMPARATORI_SLUG_TO_ID: Record<string, ComparatoriSubTab> = {
  'cambio-valuta': 'exchange',
  'operatori-mobili': 'mobile',
  'trasporti': 'transport',
  'assicurazioni-sanitarie': 'health',
  'banche': 'banks',
  'traffico-valichi': 'traffic',
  'offerte-lavoro': 'jobs',
};

const COMPARATORI_ID_TO_SLUG: Record<ComparatoriSubTab, string> = {
  exchange: 'cambio-valuta',
  mobile: 'operatori-mobili',
  transport: 'trasporti',
  health: 'assicurazioni-sanitarie',
  banks: 'banche',
  traffic: 'traffico-valichi',
  jobs: 'offerte-lavoro',
};

const GUIDE_SLUG_TO_ID: Record<string, GuideSection> = {
  'comuni-frontiera': 'municipalities',
  'vivere-in-svizzera': 'living-ch',
  'vivere-in-italia': 'living-it',
  'valichi-frontiera': 'border',
  'costi-pendolarismo': 'costs',
  'calendario-fiscale': 'calendar',
  'permessi-lavoro': 'permits',
  'aziende-ticino': 'companies',
  'spesa-transfrontaliera': 'shopping',
  'costo-della-vita': 'cost-of-living',
};

const GUIDE_ID_TO_SLUG: Record<GuideSection, string> = {
  municipalities: 'comuni-frontiera',
  'living-ch': 'vivere-in-svizzera',
  'living-it': 'vivere-in-italia',
  border: 'valichi-frontiera',
  costs: 'costi-pendolarismo',
  calendar: 'calendario-fiscale',
  permits: 'permessi-lavoro',
  companies: 'aziende-ticino',
  shopping: 'spesa-transfrontaliera',
  'cost-of-living': 'costo-della-vita',
};

/**
 * Parse the current pathname into an AppRoute.
 * Also handles legacy hash-based URLs (#/...) for backwards compatibility.
 */
export function parsePath(pathname: string): AppRoute {
  // Strip trailing slash (keep root as empty)
  const path = pathname.replace(/\/$/, '').toLowerCase() || '/';
  const parts = path.split('/').filter(Boolean);

  if (parts.length === 0) {
    return { activeTab: 'calculator', simulatorSubTab: 'calculator' };
  }

  // /simulatore-what-if
  if (parts[0] === 'simulatore-what-if') {
    return { activeTab: 'calculator', simulatorSubTab: 'whatif' };
  }

  // /comparatori or /comparatori/{slug}
  if (parts[0] === 'comparatori') {
    const sub = parts[1] ? (COMPARATORI_SLUG_TO_ID[parts[1]] || 'exchange') : 'exchange';
    return { activeTab: 'comparatori', comparatoriSubTab: sub };
  }

  // /pianificatore-pensione or /pianificatore-pensione/terzo-pilastro
  if (parts[0] === 'pianificatore-pensione') {
    const sub = parts[1] === 'terzo-pilastro' ? 'pillar3' : 'planner';
    return { activeTab: 'pension', pensionSubTab: sub };
  }

  // /guida-frontalieri or /guida-frontalieri/{slug}
  if (parts[0] === 'guida-frontalieri') {
    const section = parts[1] ? (GUIDE_SLUG_TO_ID[parts[1]] || 'municipalities') : 'municipalities';
    return { activeTab: 'guide', guideSection: section };
  }

  if (parts[0] === 'statistiche') return { activeTab: 'stats' };
  if (parts[0] === 'supporto') return { activeTab: 'feedback' };
  if (parts[0] === 'privacy') return { activeTab: 'privacy' };
  if (parts[0] === 'data-deletion') return { activeTab: 'data-deletion' };
  if (parts[0] === 'api-status') return { activeTab: 'api-status' };

  return { activeTab: 'calculator', simulatorSubTab: 'calculator' };
}

/**
 * Parse legacy hash-based URL into pathname for migration
 */
export function parseHashToPath(hash: string): string | null {
  if (!hash || hash === '#' || hash === '#/') return null;
  const path = hash.replace(/^#\/?/, '').toLowerCase();
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  // Map old hash routes to new clean paths
  if (parts[0] === 'calculator') {
    return parts[1] === 'whatif' ? '/simulatore-what-if' : '/';
  }
  if (parts[0] === 'comparatori') {
    const slug = COMPARATORI_ID_TO_SLUG[parts[1] as ComparatoriSubTab];
    return slug ? `/comparatori/${slug}` : '/comparatori/cambio-valuta';
  }
  if (parts[0] === 'pensione') {
    return parts[1] === 'pillar3' ? '/pianificatore-pensione/terzo-pilastro' : '/pianificatore-pensione';
  }
  if (parts[0] === 'guida') {
    const slug = GUIDE_ID_TO_SLUG[parts[1] as GuideSection];
    return slug ? `/guida-frontalieri/${slug}` : '/guida-frontalieri';
  }
  if (parts[0] === 'statistiche') return '/statistiche';
  if (parts[0] === 'supporto') return '/supporto';
  if (parts[0] === 'privacy') return '/privacy';
  if (parts[0] === 'data-deletion') return '/data-deletion';
  if (parts[0] === 'api-status') return '/api-status';

  return null;
}

/**
 * Build a clean URL path from route state
 */
export function buildPath(route: AppRoute): string {
  switch (route.activeTab) {
    case 'calculator':
      return route.simulatorSubTab === 'whatif' ? '/simulatore-what-if' : '/';
    case 'comparatori': {
      const slug = COMPARATORI_ID_TO_SLUG[route.comparatoriSubTab || 'exchange'];
      return `/comparatori/${slug}`;
    }
    case 'pension': {
      return route.pensionSubTab === 'pillar3'
        ? '/pianificatore-pensione/terzo-pilastro'
        : '/pianificatore-pensione';
    }
    case 'guide': {
      const section = route.guideSection || 'municipalities';
      const slug = GUIDE_ID_TO_SLUG[section];
      return section === 'municipalities'
        ? '/guida-frontalieri'
        : `/guida-frontalieri/${slug}`;
    }
    case 'stats':
      return '/statistiche';
    case 'feedback':
      return '/supporto';
    case 'privacy':
      return '/privacy';
    case 'data-deletion':
      return '/data-deletion';
    case 'api-status':
      return '/api-status';
    default:
      return '/';
  }
}

/**
 * Get the SEO section key for updating meta tags
 */
export function getSeoSection(route: AppRoute): string {
  switch (route.activeTab) {
    case 'calculator':
      return route.simulatorSubTab === 'whatif' ? 'whatif' : 'calculator';
    case 'comparatori':
      return route.comparatoriSubTab || 'exchange';
    case 'pension':
      return route.pensionSubTab === 'pillar3' ? 'pillar3' : 'pension';
    case 'guide': {
      const section = route.guideSection || 'municipalities';
      const seoMap: Record<string, string> = {
        calendar: 'calendar',
        permits: 'permits',
        shopping: 'shopping',
        'cost-of-living': 'costOfLiving',
        companies: 'companies',
        municipalities: 'guide',
        'living-ch': 'livingCH',
        'living-it': 'livingIT',
        border: 'border',
        costs: 'costs',
      };
      return seoMap[section] || 'guide';
    }
    case 'stats':
      return 'stats';
    case 'feedback':
      return 'feedback';
    default:
      return route.activeTab;
  }
}

/**
 * Push a new route to the browser history (creates new history entry)
 */
export function pushRoute(route: AppRoute): void {
  const newPath = buildPath(route);
  if (window.location.pathname !== newPath) {
    history.pushState({ route }, '', newPath);
  }
}

/**
 * Replace current route (no new history entry)
 */
export function replaceRoute(route: AppRoute): void {
  const newPath = buildPath(route);
  if (window.location.pathname !== newPath) {
    history.replaceState({ route }, '', newPath);
  }
}
