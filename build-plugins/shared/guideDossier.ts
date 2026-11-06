import { LOCALE_CALC_PREFIX } from '../salaryHubScenarios';
import { HEALTH_PREMIUM_COMPARATOR_PATH } from './healthPremiumsPaths';

export type GuideDossierLocale = 'it' | 'en' | 'de' | 'fr';
export type GuideDossierVisualKey = 'border' | 'salary' | 'health' | 'work' | 'car';
type GuideDossierIndexGroup = 'work' | 'salary' | 'health' | 'mobility' | 'unemployment';

export interface GuideDossierAction {
  href: string;
  label: string;
}

export interface GuideDossierVisual {
  key: GuideDossierVisualKey;
  src: string;
  width: number;
  height: number;
  alt: Record<GuideDossierLocale, string>;
}

const GUIDE_VISUALS: Record<GuideDossierVisualKey, GuideDossierVisual> = {
  border: {
    key: 'border',
    src: '/assets/guide-editorial/border-commute.jpg',
    width: 1280,
    height: 853,
    alt: {
      it: 'Pendolare in attesa su una piattaforma ferroviaria con vista sul lago',
      en: 'Commuter waiting on a train platform beside a lake',
      de: 'Pendler auf einem Bahnsteig mit Blick auf den See',
      fr: 'Voyageur attendant sur un quai avec vue sur le lac',
    },
  },
  salary: {
    key: 'salary',
    src: '/assets/guide-editorial/salary-desk.jpg',
    width: 1600,
    height: 900,
    alt: {
      it: 'Mani che prendono appunti accanto a una calcolatrice e a un computer',
      en: 'Hands taking notes beside a calculator and a laptop',
      de: 'Hände, die neben Taschenrechner und Laptop Notizen machen',
      fr: 'Des mains prennent des notes près d’une calculatrice et d’un ordinateur',
    },
  },
  health: {
    key: 'health',
    src: '/assets/guide-editorial/health-insurance.jpg',
    width: 1600,
    height: 900,
    alt: {
      it: 'Due adulti consultano alcuni documenti al tavolo di casa',
      en: 'Two adults review documents at a kitchen table',
      de: 'Zwei Erwachsene besprechen Unterlagen am Küchentisch',
      fr: 'Deux adultes consultent des documents à la table de la cuisine',
    },
  },
  work: {
    key: 'work',
    src: '/assets/guide-editorial/work-permit.jpg',
    width: 1600,
    height: 900,
    alt: {
      it: 'Due persone parlano all’ingresso di un ufficio',
      en: 'Two people talk at an office reception',
      de: 'Zwei Personen sprechen am Empfang eines Büros',
      fr: 'Deux personnes échangent à l’accueil d’un bureau',
    },
  },
  car: {
    key: 'car',
    src: '/assets/guide-editorial/cross-border-car.jpg',
    width: 1600,
    height: 900,
    alt: {
      it: 'Auto scura su una strada lungo il lago',
      en: 'Dark car on a road beside the lake',
      de: 'Dunkles Auto auf einer Straße am See',
      fr: 'Voiture sombre sur une route au bord du lac',
    },
  },
};

type LocalizedGuidePaths = {
  root: string;
  pages: Record<string, GuideDossierVisualKey>;
};

const LOCALIZED_GUIDE_PATHS: LocalizedGuidePaths[] = [
  {
    root: '/guida-frontaliere/',
    pages: {
      'confronta-permesso-g-vs-b': 'work',
      'guida-completa-lavoro-frontaliere-svizzera-2026': 'border',
      'primo-giorno-lavoro': 'work',
      'permessi-di-lavoro': 'work',
      'disoccupazione-transfrontaliera': 'work',
      'trasferire-auto-svizzera': 'car',
      'costo-auto-pendolare': 'car',
      'mappa-confine': 'border',
      'mappa-live-valichi': 'border',
      'tassa-salute-frontalieri': 'health',
      'lamal-frontalieri': 'health',
    },
  },
  {
    root: '/en/cross-border-guide/',
    pages: {
      'compare-permit-g-vs-b': 'work',
      'complete-guide-cross-border-work-switzerland-2026': 'border',
      'first-day-at-work': 'work',
      'work-permits-guide': 'work',
      'unemployment-benefits': 'work',
      'transfer-car-to-switzerland': 'car',
      'commuting-car-costs': 'car',
      'border-map': 'border',
      'live-border-crossings-map': 'border',
      'cross-border-health-contribution': 'health',
      'lamal-for-cross-border-workers': 'health',
    },
  },
  {
    root: '/de/grenzgaenger-ratgeber/',
    pages: {
      'bewilligung-g-vs-b': 'work',
      'komplettanleitung-grenzgaenger-arbeit-schweiz-2026': 'border',
      'erster-arbeitstag': 'work',
      'arbeitsbewilligungen': 'work',
      'arbeitslosengeld': 'work',
      'auto-in-schweiz-ummelden': 'car',
      'pendler-autokosten': 'car',
      'grenzkarte': 'border',
      'live-grenzuebergaenge-karte': 'border',
      'gesundheitsabgabe-grenzgaenger': 'health',
      'krankenversicherung-grenzgaenger': 'health',
    },
  },
  {
    root: '/fr/guide-frontalier/',
    pages: {
      'comparer-permis-g-vs-b': 'work',
      'guide-complet-travail-frontalier-suisse-2026': 'border',
      'premier-jour-travail': 'work',
      'permis-de-travail': 'work',
      'allocations-chomage': 'work',
      'transferer-voiture-suisse': 'car',
      'cout-voiture-pendulaire': 'car',
      'carte-frontiere': 'border',
      'carte-live-passages-frontaliers': 'border',
      'contribution-sante-frontaliers': 'health',
      'lamal-frontaliers': 'health',
    },
  },
];

const GUIDE_DOSSIER_STATIC_ARTICLE_SLUGS = new Set([
  'guida-completa-lavoro-frontaliere-svizzera-2026',
  'tassa-salute-frontalieri',
  'lamal-frontalieri',
  'complete-guide-cross-border-work-switzerland-2026',
  'cross-border-health-contribution',
  'lamal-for-cross-border-workers',
  'komplettanleitung-grenzgaenger-arbeit-schweiz-2026',
  'gesundheitsabgabe-grenzgaenger',
  'krankenversicherung-grenzgaenger',
  'guide-complet-travail-frontalier-suisse-2026',
  'contribution-sante-frontaliers',
  'lamal-frontaliers',
]);

const STATIC_GUIDE_VISUAL_BY_PATH = new Map<string, GuideDossierVisualKey>();
for (const guide of LOCALIZED_GUIDE_PATHS) {
  STATIC_GUIDE_VISUAL_BY_PATH.set(guide.root, 'border');
  for (const [slug, visual] of Object.entries(guide.pages)) {
    STATIC_GUIDE_VISUAL_BY_PATH.set(`${guide.root}${slug}/`, visual);
  }
}

const GUIDE_ACTION_KEYS: Record<GuideDossierLocale, Record<string, 'salary' | 'permit' | 'car' | 'map' | 'health'>> = {
  it: {
    'confronta-permesso-g-vs-b': 'permit',
    'guida-completa-lavoro-frontaliere-svizzera-2026': 'salary',
    'permessi-di-lavoro': 'permit',
    'trasferire-auto-svizzera': 'car',
    'costo-auto-pendolare': 'car',
    'mappa-confine': 'map',
    'tassa-salute-frontalieri': 'health',
    'lamal-frontalieri': 'health',
  },
  en: {
    'compare-permit-g-vs-b': 'permit',
    'complete-guide-cross-border-work-switzerland-2026': 'salary',
    'work-permits-guide': 'permit',
    'transfer-car-to-switzerland': 'car',
    'commuting-car-costs': 'car',
    'border-map': 'map',
    'cross-border-health-contribution': 'health',
    'lamal-for-cross-border-workers': 'health',
  },
  de: {
    'bewilligung-g-vs-b': 'permit',
    'komplettanleitung-grenzgaenger-arbeit-schweiz-2026': 'salary',
    'arbeitsbewilligungen': 'permit',
    'auto-in-schweiz-ummelden': 'car',
    'pendler-autokosten': 'car',
    'grenzkarte': 'map',
    'gesundheitsabgabe-grenzgaenger': 'health',
    'krankenversicherung-grenzgaenger': 'health',
  },
  fr: {
    'comparer-permis-g-vs-b': 'permit',
    'guide-complet-travail-frontalier-suisse-2026': 'salary',
    'permis-de-travail': 'permit',
    'transferer-voiture-suisse': 'car',
    'cout-voiture-pendulaire': 'car',
    'carte-frontiere': 'map',
    'contribution-sante-frontaliers': 'health',
    'lamal-frontaliers': 'health',
  },
};

const GUIDE_ACTION_LABELS: Record<GuideDossierLocale, Record<'salary' | 'permit' | 'car' | 'map' | 'health', string>> = {
  it: { salary: 'Apri il calcolatore stipendio', permit: 'Confronta i permessi G e B', car: 'Calcola i costi dell’auto', map: 'Apri la mappa live dei valichi', health: 'Confronta le casse malati' },
  en: { salary: 'Open the salary calculator', permit: 'Compare G and B permits', car: 'Calculate car commuting costs', map: 'Open the live border map', health: 'Compare health insurance plans' },
  de: { salary: 'Gehaltsrechner öffnen', permit: 'Bewilligungen G und B vergleichen', car: 'Autopendelkosten berechnen', map: 'Live-Grenzkarte öffnen', health: 'Krankenkassen vergleichen' },
  fr: { salary: 'Ouvrir le calculateur de salaire', permit: 'Comparer les permis G et B', car: 'Calculer le coût des trajets en voiture', map: 'Ouvrir la carte des passages', health: 'Comparer les caisses maladie' },
};

const BORDER_MAP_PATHS: Record<GuideDossierLocale, string> = {
  it: '/guida-frontaliere/mappa-live-valichi/',
  en: '/en/cross-border-guide/live-border-crossings-map/',
  de: '/de/grenzgaenger-ratgeber/live-grenzuebergaenge-karte/',
  fr: '/fr/guide-frontalier/carte-live-passages-frontaliers/',
};

const LEGACY_TOOL_PATHS: Record<GuideDossierLocale, { permit: string; car: string }> = {
  it: { permit: '/strumenti/permesso-g-vs-b/', car: '/strumenti/costo-auto/' },
  en: { permit: '/tools/permit-g-vs-b/', car: '/tools/car-cost/' },
  de: { permit: '/werkzeuge/bewilligung-g-vs-b/', car: '/werkzeuge/autokosten/' },
  fr: { permit: '/outils/permis-g-vs-b/', car: '/outils/cout-voiture/' },
};

export function isGuideDossierIndexPath(canonicalPath: string): boolean {
  return LOCALIZED_GUIDE_PATHS.some(({ root }) => root === canonicalPath);
}

export function isGuideDossierStaticArticlePath(canonicalPath: string): boolean {
  return [...GUIDE_DOSSIER_STATIC_ARTICLE_SLUGS].some((slug) =>
    LOCALIZED_GUIDE_PATHS.some(({ root }) => canonicalPath === `${root}${slug}/`),
  );
}

export function resolveStaticGuideAction(canonicalPath: string, locale: GuideDossierLocale): GuideDossierAction | null {
  const guide = LOCALIZED_GUIDE_PATHS.find(({ root }) => canonicalPath.startsWith(root));
  if (!guide) return null;

  const pageSlug = canonicalPath.slice(guide.root.length).replace(/\/+$/, '');
  const actionKey = pageSlug ? GUIDE_ACTION_KEYS[locale][pageSlug] : 'salary';
  if (!actionKey) return null;

  let href: string;
  if (actionKey === 'salary') href = `${LOCALE_CALC_PREFIX[locale]}/`;
  else if (actionKey === 'map') href = BORDER_MAP_PATHS[locale];
  else if (actionKey === 'health') href = HEALTH_PREMIUM_COMPARATOR_PATH[locale];
  else href = LEGACY_TOOL_PATHS[locale][actionKey];

  return { href, label: GUIDE_ACTION_LABELS[locale][actionKey] };
}

const GUIDE_INDEX_GROUP_ORDER: GuideDossierIndexGroup[] = ['work', 'salary', 'health', 'mobility', 'unemployment'];

const GUIDE_INDEX_HEADINGS: Record<GuideDossierLocale, { title: string; groups: Record<GuideDossierIndexGroup, string> }> = {
  it: { title: 'Scegli da dove iniziare', groups: { work: 'Lavoro e permessi', salary: 'Stipendio e imposte', health: 'Copertura sanitaria', mobility: 'Auto e spostamenti', unemployment: 'Se il lavoro termina' } },
  en: { title: 'Choose where to start', groups: { work: 'Work and permits', salary: 'Salary and tax', health: 'Health coverage', mobility: 'Car and commuting', unemployment: 'If your job ends' } },
  de: { title: 'Wählen Sie, womit Sie beginnen', groups: { work: 'Arbeit und Bewilligungen', salary: 'Lohn und Steuern', health: 'Krankenversicherung', mobility: 'Auto und Pendeln', unemployment: 'Wenn Ihre Stelle endet' } },
  fr: { title: 'Choisissez par où commencer', groups: { work: 'Emploi et permis', salary: 'Salaire et impôts', health: 'Couverture santé', mobility: 'Voiture et trajets', unemployment: 'En cas de perte d’emploi' } },
};

const STATIC_GUIDE_INDEX_LABELS: Record<GuideDossierLocale, Array<{ group: GuideDossierIndexGroup; title: string }>> = {
  it: [
    { group: 'work', title: 'Permesso G o B: quale si applica' },
    { group: 'work', title: 'Guida completa al lavoro in Svizzera' },
    { group: 'work', title: 'Il primo giorno di lavoro' },
    { group: 'work', title: 'Permessi di lavoro G e B' },
    { group: 'unemployment', title: 'Disoccupazione transfrontaliera' },
    { group: 'mobility', title: 'Trasferire l’auto in Svizzera' },
    { group: 'mobility', title: 'Costo dell’auto per chi fa il pendolare' },
    { group: 'mobility', title: 'Mappa dei comuni di frontiera' },
    { group: 'mobility', title: 'Mappa live dei valichi' },
    { group: 'health', title: 'Contributo sanitario per frontalieri' },
    { group: 'health', title: 'LAMal per frontalieri' },
  ],
  en: [
    { group: 'work', title: 'Permit G or B: which one applies' },
    { group: 'work', title: 'Complete guide to working in Switzerland' },
    { group: 'work', title: 'Your first day at work' },
    { group: 'work', title: 'Swiss work permits G and B' },
    { group: 'unemployment', title: 'Cross-border unemployment benefits' },
    { group: 'mobility', title: 'Bringing your car to Switzerland' },
    { group: 'mobility', title: 'Commuting by car: costs' },
    { group: 'mobility', title: 'Map of border municipalities' },
    { group: 'mobility', title: 'Live map of border crossings' },
    { group: 'health', title: 'Cross-border health contribution' },
    { group: 'health', title: 'LAMal for cross-border workers' },
  ],
  de: [
    { group: 'work', title: 'Bewilligung G oder B: Was gilt?' },
    { group: 'work', title: 'Leitfaden zum Arbeiten in der Schweiz' },
    { group: 'work', title: 'Der erste Arbeitstag' },
    { group: 'work', title: 'Arbeitsbewilligungen G und B' },
    { group: 'unemployment', title: 'Arbeitslosigkeit als Grenzgänger' },
    { group: 'mobility', title: 'Auto in die Schweiz ummelden' },
    { group: 'mobility', title: 'Pendeln mit dem Auto: Kosten' },
    { group: 'mobility', title: 'Karte der Grenzgemeinden' },
    { group: 'mobility', title: 'Live-Karte der Grenzübergänge' },
    { group: 'health', title: 'Gesundheitsbeitrag für Grenzgänger' },
    { group: 'health', title: 'LAMal für Grenzgänger' },
  ],
  fr: [
    { group: 'work', title: 'Permis G ou B : lequel s’applique' },
    { group: 'work', title: 'Guide complet du travail en Suisse' },
    { group: 'work', title: 'Le premier jour de travail' },
    { group: 'work', title: 'Permis de travail G et B' },
    { group: 'unemployment', title: 'Chômage des travailleurs frontaliers' },
    { group: 'mobility', title: 'Transférer sa voiture en Suisse' },
    { group: 'mobility', title: 'Coût du trajet en voiture' },
    { group: 'mobility', title: 'Carte des communes frontalières' },
    { group: 'mobility', title: 'Carte en direct des passages frontaliers' },
    { group: 'health', title: 'Contribution santé des frontaliers' },
    { group: 'health', title: 'LAMal pour les frontaliers' },
  ],
};

export interface GuideDossierIndexGroupData {
  id: GuideDossierIndexGroup;
  title: string;
  links: Array<{ href: string; title: string }>;
}

export interface GuideDossierIndexData {
  title: string;
  groups: GuideDossierIndexGroupData[];
}

export function buildGuideDossierIndexData(
  canonicalPath: string,
  locale: GuideDossierLocale,
  salaryItems: Array<{ href: string; title: string }>,
): GuideDossierIndexData | null {
  const guide = LOCALIZED_GUIDE_PATHS.find(({ root }) => root === canonicalPath);
  if (!guide) return null;

  const slugs = Object.keys(guide.pages);
  const staticItems = STATIC_GUIDE_INDEX_LABELS[locale];
  if (slugs.length !== staticItems.length) {
    throw new Error(`Guide index route/title count mismatch for ${locale}: ${slugs.length} routes, ${staticItems.length} labels`);
  }

  const groups = new Map<GuideDossierIndexGroup, Array<{ href: string; title: string }>>(
    GUIDE_INDEX_GROUP_ORDER.map((group) => [group, []]),
  );
  staticItems.forEach(({ group, title }, index) => {
    groups.get(group)!.push({ href: `${guide.root}${slugs[index]}/`, title });
  });
  for (const item of salaryItems) groups.get('salary')!.push(item);

  const copy = GUIDE_INDEX_HEADINGS[locale];
  return {
    title: copy.title,
    groups: GUIDE_INDEX_GROUP_ORDER.flatMap((group) => {
      const links = groups.get(group) ?? [];
      return links.length ? [{ id: group, title: copy.groups[group], links }] : [];
    }),
  };
}

export function renderGuideDossierIndexMap(
  canonicalPath: string,
  locale: GuideDossierLocale,
  salaryItems: Array<{ href: string; title: string }>,
): string {
  const data = buildGuideDossierIndexData(canonicalPath, locale, salaryItems);
  if (!data) return '';

  const groupsHtml = data.groups.map((group) => {
    const links = group.links.map(({ href, title }) => `<li><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></li>`).join('');
    return `<section class="guide-dossier-map__group" data-group="${group.id}"><h3 id="guide-dossier-map-${group.id}">${escapeHtml(group.title)}</h3><ul>${links}</ul></section>`;
  }).join('');

  return `<nav class="guide-dossier-map" aria-labelledby="guide-dossier-map-title"><h2 id="guide-dossier-map-title">${escapeHtml(data.title)}</h2><div class="guide-dossier-map__grid">${groupsHtml}</div></nav>`;
}

const SALARY_ARTICLE_VISUALS: Record<string, GuideDossierVisualKey> = {
  'guida-calcolo-stipendio-2026': 'salary',
  'confronto-vecchio-nuovo-frontaliere': 'salary',
  'tabelle-imposta-fonte-ticino': 'salary',
  'impatto-figli-stipendio-frontaliere': 'health',
  'distanza-confine-20km-frontaliere': 'border',
  'progressione-stipendio-frontaliere': 'salary',
  'sposato-single-tasse-frontaliere': 'health',
  'cambio-chf-eur-stipendio-frontaliere': 'salary',
  'hub-fiscale-frontalieri': 'salary',
};

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const visualForKey = (key: GuideDossierVisualKey): GuideDossierVisual => GUIDE_VISUALS[key];

export function resolveStaticGuideVisual(canonicalPath: string): GuideDossierVisual | null {
  const key = STATIC_GUIDE_VISUAL_BY_PATH.get(canonicalPath);
  return key ? visualForKey(key) : null;
}

export function resolveSalaryGuideVisual(articleId: string): GuideDossierVisual {
  return visualForKey(SALARY_ARTICLE_VISUALS[articleId] ?? 'salary');
}

export function renderGuideDossierHero(options: {
  title: string;
  description: string;
  visual: GuideDossierVisual;
  locale: GuideDossierLocale;
  action?: { href: string; label: string };
}): string {
  const { title, description, visual, locale, action } = options;
  const actionHtml = action
    ? `<a class="guide-dossier-action !text-on-accent" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`
    : '';

  return `<header class="guide-dossier-hero">
    <div class="guide-dossier-hero__copy">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      ${actionHtml}
    </div>
    <figure class="guide-dossier-hero__figure">
      <img src="${visual.src}" alt="${escapeHtml(visual.alt[locale])}" width="${visual.width}" height="${visual.height}" decoding="async" fetchpriority="high">
    </figure>
  </header>`;
}

const TOC_LABEL: Record<GuideDossierLocale, string> = {
  it: 'In questa guida',
  en: 'In this guide',
  de: 'In diesem Ratgeber',
  fr: 'Dans ce guide',
};

export function prepareGuideDossierContent(html: string, locale: GuideDossierLocale): {
  html: string;
  tocHtml: string;
} {
  const headings: Array<{ id: string; label: string }> = [];
  const usedIds = new Set<string>();
  let index = 0;

  const preparedHtml = html.replace(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi, (_match, rawAttrs: string, inner: string) => {
    index += 1;
    const existingId = rawAttrs.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2];
    const baseId = existingId || `guide-dossier-section-${index}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    usedIds.add(id);

    const label = inner
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
    if (label) headings.push({ id, label });

    const attrsWithoutId = rawAttrs.replace(/\s+id\s*=\s*(["']).*?\1/i, '');
    return `<h2${attrsWithoutId} id="${escapeHtml(id)}">${inner}</h2>`;
  });

  if (headings.length < 2) return { html: preparedHtml, tocHtml: '' };

  const links = headings.slice(0, 7).map(({ id, label }) =>
    `<li><a href="#${escapeHtml(id)}">${escapeHtml(label)}</a></li>`,
  ).join('');
  const ariaLabel = escapeHtml(TOC_LABEL[locale]);
  return {
    html: preparedHtml,
    tocHtml: `<nav class="guide-dossier-index" aria-label="${ariaLabel}"><p>${ariaLabel}</p><ul>${links}</ul></nav>`,
  };
}
