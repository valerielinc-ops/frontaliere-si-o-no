import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useTranslation, type Locale } from '@/services/i18n';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';
import { buildPath, type GuidaSubTab } from '@/services/router';
import DataFreshness from '@/components/shared/DataFreshness';
import '@/components/guide/guideDossier.css';

const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
import { AD_SLOTS } from '@/services/adsenseSlots';
const SeoContentBlock = lazyRetry(() => import('@/components/shared/SeoContentBlock'));
const FrontierGuide = lazyRetry(() => import('@/components/guide/FrontierGuide'));
const TrafficAlerts = lazyRetry(() => import('@/components/guide/TrafficAlerts'));
const CarCostCalculator = lazyRetry(() => import('@/components/guide/CarCostCalculator'));
const PermitCompare = lazyRetry(() => import('@/components/guide/PermitCompare'));
const BorderMunicipalitiesMap = lazyRetry(() => import('@/components/guide/BorderMunicipalitiesMap'));

type GuideDossierIndexGroupId = 'work' | 'salary' | 'health' | 'mobility' | 'unemployment';

interface GuideDossierIndexData {
 title: string;
 groups: Array<{
  id: GuideDossierIndexGroupId;
  title: string;
  links: Array<{ href: string; title: string }>;
 }>;
}

interface GuideDossierIndexBootstrap {
 locale: Locale;
 data: GuideDossierIndexData | null;
}

interface WindowWithGuideDossierIndex extends Window {
 __FT_GUIDE_DOSSIER_INDEX__?: GuideDossierIndexBootstrap;
}

const GUIDE_INDEX_PATHS = new Set([
 '/guida-frontaliere/',
 '/en/cross-border-guide/',
 '/de/grenzgaenger-ratgeber/',
 '/fr/guide-frontalier/',
]);

const GUIDE_INDEX_DESCRIPTIONS: Record<Locale, string> = {
 it: 'Regole, scenari e strumenti per capire quale percorso riguarda la tua situazione da frontaliere.',
 en: 'Rules, scenarios and tools to help you identify the path that fits your cross-border situation.',
 de: 'Regeln, Szenarien und Werkzeuge helfen Ihnen, den passenden Weg für Ihre Situation als Grenzgänger zu finden.',
 fr: 'Règles, scénarios et outils pour repérer le parcours qui correspond à votre situation de frontalier.',
};

const GUIDE_INDEX_ACTION_LABELS: Record<Locale, string> = {
 it: 'Calcola il tuo stipendio',
 en: 'Calculate your net salary',
 de: 'Nettogehalt berechnen',
 fr: 'Calculer votre salaire net',
};

const GUIDE_INDEX_SEO_HEADINGS: Record<Locale, string> = {
 it: 'Esplora le regole, gli scenari e gli strumenti',
 en: 'Explore the rules, scenarios and tools',
 de: 'Regeln, Szenarien und Werkzeuge entdecken',
 fr: 'Explorer les règles, les scénarios et les outils',
};

const GUIDE_INDEX_VISUAL_ALT: Record<Locale, string> = {
 it: 'Pendolare in attesa su una piattaforma ferroviaria con vista sul lago',
 en: 'Commuter waiting on a train platform beside a lake',
 de: 'Pendler auf einem Bahnsteig mit Blick auf den See',
 fr: 'Voyageur attendant sur un quai avec vue sur le lac',
};

function GuideDossierIndexMap({ data }: { data: GuideDossierIndexData }) {
 return (
  <nav className="guide-dossier-map" aria-labelledby="guide-dossier-map-title">
   <h2 id="guide-dossier-map-title">{data.title}</h2>
   <div className="guide-dossier-map__grid">
    {data.groups.map((group) => (
     <section className="guide-dossier-map__group" data-group={group.id} key={group.id}>
      <h3 id={`guide-dossier-map-${group.id}`}>{group.title}</h3>
      <ul>
       {group.links.map((link) => (
        <li key={link.href}><a href={link.href}>{link.title}</a></li>
       ))}
      </ul>
     </section>
    ))}
   </div>
  </nav>
 );
}

function parseGuideDossierIndexHtml(html: string): GuideDossierIndexData | null {
 const parsed = new DOMParser().parseFromString(html, 'text/html');
 const nav = parsed.querySelector<HTMLElement>('nav.guide-dossier-map');
 const title = nav?.querySelector('h2')?.textContent?.trim();
 if (!nav || !title) return null;

 const groups: GuideDossierIndexData['groups'] = [];
 for (const element of Array.from(nav.querySelectorAll<HTMLElement>('.guide-dossier-map__group'))) {
   const id = element.dataset.group;
   const groupTitle = element.querySelector('h3')?.textContent?.trim();
   const links = Array.from(element.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .map((anchor) => ({ href: anchor.getAttribute('href')?.trim() ?? '', title: anchor.textContent?.trim() ?? '' }))
    .filter((link) => link.href.startsWith('/') && link.title);
   if (!id || !['work', 'salary', 'health', 'mobility', 'unemployment'].includes(id) || !groupTitle || !links.length) continue;
   groups.push({ id: id as GuideDossierIndexGroupId, title: groupTitle, links });
 }

 return groups.length ? { title, groups } : null;
}

const GUIDE_COVER_VISUALS: Record<GuidaSubTab, {
 src: string;
 width: number;
 height: number;
 alt: Record<Locale, string>;
}> = {
 'first-day': {
 src: '/assets/guide-editorial/work-permit.jpg', width: 1600, height: 900,
 alt: {
 it: 'Due persone parlano all’ingresso di un ufficio',
 en: 'Two people talk at an office reception',
 de: 'Zwei Personen sprechen am Empfang eines Büros',
 fr: 'Deux personnes échangent à l’accueil d’un bureau',
 },
 },
 permits: {
 src: '/assets/guide-editorial/work-permit.jpg', width: 1600, height: 900,
 alt: {
 it: 'Due persone parlano all’ingresso di un ufficio',
 en: 'Two people talk at an office reception',
 de: 'Zwei Personen sprechen am Empfang eines Büros',
 fr: 'Deux personnes échangent à l’accueil d’un bureau',
 },
 },
 border: {
 src: '/assets/guide-editorial/border-commute.jpg', width: 1280, height: 853,
 alt: {
 it: 'Pendolare in attesa su una piattaforma ferroviaria con vista sul lago',
 en: 'Commuter waiting on a train platform beside a lake',
 de: 'Pendler auf einem Bahnsteig mit Blick auf den See',
 fr: 'Voyageur attendant sur un quai avec vue sur le lac',
 },
 },
 unemployment: {
 src: '/assets/guide-editorial/work-permit.jpg', width: 1600, height: 900,
 alt: {
 it: 'Due persone parlano all’ingresso di un ufficio',
 en: 'Two people talk at an office reception',
 de: 'Zwei Personen sprechen am Empfang eines Büros',
 fr: 'Deux personnes échangent à l’accueil d’un bureau',
 },
 },
 'car-transfer': {
 src: '/assets/guide-editorial/cross-border-car.jpg', width: 1600, height: 900,
 alt: {
 it: 'Auto scura su una strada lungo il lago',
 en: 'Dark car on a road beside the lake',
 de: 'Dunkles Auto auf einer Straße am See',
 fr: 'Voiture sombre sur une route au bord du lac',
 },
 },
 'car-cost': {
 src: '/assets/guide-editorial/cross-border-car.jpg', width: 1600, height: 900,
 alt: {
 it: 'Auto scura su una strada lungo il lago',
 en: 'Dark car on a road beside the lake',
 de: 'Dunkles Auto auf einer Straße am See',
 fr: 'Voiture sombre sur une route au bord du lac',
 },
 },
 'permit-compare': {
 src: '/assets/guide-editorial/work-permit.jpg', width: 1600, height: 900,
 alt: {
 it: 'Due persone parlano all’ingresso di un ufficio',
 en: 'Two people talk at an office reception',
 de: 'Zwei Personen sprechen am Empfang eines Büros',
 fr: 'Deux personnes échangent à l’accueil d’un bureau',
 },
 },
 'border-map': {
 src: '/assets/guide-editorial/border-commute.jpg', width: 1280, height: 853,
 alt: {
 it: 'Pendolare in attesa su una piattaforma ferroviaria con vista sul lago',
 en: 'Commuter waiting on a train platform beside a lake',
 de: 'Pendler auf einem Bahnsteig mit Blick auf den See',
 fr: 'Voyageur attendant sur un quai avec vue sur le lac',
 },
 },
};

const GUIDE_COVER_TARGETS: Partial<Record<GuidaSubTab, GuidaSubTab>> = {
 'first-day': 'permits',
 permits: 'permit-compare',
 border: 'border-map',
 'car-transfer': 'car-cost',
 'car-cost': 'car-transfer',
 'permit-compare': 'permits',
 'border-map': 'border',
};

const GUIDE_COVER_TITLES: Record<Locale, Record<GuidaSubTab, string>> = {
 it: {
  'first-day': 'Da dove iniziare il tuo percorso da frontaliere',
  permits: 'Permessi per lavorare in Svizzera: regole e confronto',
  border: 'Pianifica il tragitto e attraversa il confine',
  unemployment: 'Cosa fare se termina il lavoro in Svizzera',
  'car-transfer': 'Importare e immatricolare l’auto in Svizzera',
  'car-cost': 'Calcolare i costi dell’auto da frontaliere',
  'permit-compare': 'Confronto tra permesso G e B',
  'border-map': 'Scegli il valico in base al tuo percorso',
 },
 en: {
  'first-day': 'Starting your cross-border work journey',
  permits: 'Swiss work permits: rules and comparison',
  border: 'Plan your border crossing',
  unemployment: 'What to do if your Swiss job ends',
  'car-transfer': 'Importing and registering a car in Switzerland',
  'car-cost': 'Compare commuting car costs',
  'permit-compare': 'G or B permit? Compare the requirements',
  'border-map': 'Choose a crossing for your route',
 },
 de: {
  'first-day': 'So starten Sie als Grenzgänger',
  permits: 'Schweizer Arbeitsbewilligungen: Regeln und Vergleich',
  border: 'Planen Sie Ihren Grenzübertritt',
  unemployment: 'Was tun, wenn die Arbeit in der Schweiz endet?',
  'car-transfer': 'Ein Auto in die Schweiz einführen und anmelden',
  'car-cost': 'Autopendelkosten vergleichen',
  'permit-compare': 'Bewilligung G oder B? Voraussetzungen vergleichen',
  'border-map': 'Passenden Grenzübergang für Ihre Strecke wählen',
 },
 fr: {
  'first-day': 'Commencer votre parcours de frontalier',
  permits: 'Permis de travail suisse : règles et comparaison',
  border: 'Planifier votre passage à la frontière',
  unemployment: 'Que faire si votre emploi en Suisse prend fin',
  'car-transfer': 'Importer et immatriculer une voiture en Suisse',
  'car-cost': 'Comparer le coût des trajets en voiture',
  'permit-compare': 'Permis G ou B : comparer les conditions',
  'border-map': 'Choisir un passage adapté à votre trajet',
 },
};

const GUIDE_COVER_DESCRIPTIONS: Record<Locale, string> = {
 it: 'Esamina le regole e gli scenari pertinenti, poi passa alla guida o allo strumento collegato.',
 en: 'Review the relevant rules and scenarios, then open the related guide or tool.',
 de: 'Prüfen Sie die relevanten Regeln und Szenarien und öffnen Sie anschließend den passenden Ratgeber oder das passende Werkzeug.',
 fr: 'Consultez les règles et scénarios pertinents, puis ouvrez le guide ou l’outil associé.',
};

const GUIDE_COVER_ACTION_LABELS: Record<Locale, Partial<Record<GuidaSubTab, string>>> = {
 it: {
 'first-day': 'Consulta i permessi di lavoro', permits: 'Confronta G e B', border: 'Apri la mappa dei comuni',
 'car-transfer': 'Calcola il costo dell’auto', 'car-cost': 'Consulta la procedura per l’auto',
 'permit-compare': 'Leggi la guida ai permessi', 'border-map': 'Controlla i tempi ai valichi',
 },
 en: {
 'first-day': 'Read the work permits guide', permits: 'Compare G and B permits', border: 'Open the municipalities map',
 'car-transfer': 'Calculate car costs', 'car-cost': 'Read the car transfer guide',
 'permit-compare': 'Read the work permits guide', 'border-map': 'Check border crossing times',
 },
 de: {
 'first-day': 'Arbeitsbewilligungen ansehen', permits: 'G und B vergleichen', border: 'Karte der Gemeinden öffnen',
 'car-transfer': 'Autokosten berechnen', 'car-cost': 'Anleitung zur Autoeinfuhr lesen',
 'permit-compare': 'Ratgeber zu Bewilligungen lesen', 'border-map': 'Wartezeiten an den Übergängen prüfen',
 },
 fr: {
 'first-day': 'Consulter le guide des permis', permits: 'Comparer les permis G et B', border: 'Ouvrir la carte des communes',
 'car-transfer': 'Calculer le coût de la voiture', 'car-cost': 'Consulter la procédure pour la voiture',
 'permit-compare': 'Lire le guide des permis', 'border-map': 'Consulter les temps aux passages',
 },
};

function normalizePath(pathname: string): string {
 return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

export default function GuidaTabContent() {
 const { t, locale } = useTranslation();
 const { guidaSubTab } = useNavigation();
 const { userProfile, borderCrossing, authUser } = useTabContent();
 const pathname = typeof window === 'undefined' ? '' : normalizePath(window.location.pathname);
 const isGuideIndexPage = GUIDE_INDEX_PATHS.has(pathname);
 const [guideIndexState, setGuideIndexState] = React.useState(() => {
  if (typeof window === 'undefined') return null;
  const bootstrap = (window as WindowWithGuideDossierIndex).__FT_GUIDE_DOSSIER_INDEX__;
  return bootstrap?.locale === locale && bootstrap.data
   ? { locale: bootstrap.locale, data: bootstrap.data }
   : null;
 });
 const guideIndex = isGuideIndexPage && guideIndexState?.locale === locale ? guideIndexState.data : null;
 React.useEffect(() => {
  if (!isGuideIndexPage || guideIndex) return;
  const controller = new AbortController();
  fetch('/data/guide-dossier-index.json', { signal: controller.signal })
   .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
   .then((payload: Partial<Record<Locale, GuideDossierIndexData>>) => {
    const data = payload[locale];
    if (!data) throw new Error(`Missing ${locale} guide dossier index`);
    setGuideIndexState({ locale, data });
   })
   .catch(async () => {
    if (controller.signal.aborted) return;
    try {
     const response = await fetch(pathname, { signal: controller.signal });
     if (!response.ok) return;
     const data = parseGuideDossierIndexHtml(await response.text());
     if (data) setGuideIndexState({ locale, data });
    } catch {
     // The prerendered category directory is a fallback if its generated JSON asset cannot load.
    }
   });
  return () => controller.abort();
 }, [isGuideIndexPage, locale, guideIndex]);
 const coverVisual = isGuideIndexPage ? GUIDE_COVER_VISUALS.border : GUIDE_COVER_VISUALS[guidaSubTab];
 const coverDescription = isGuideIndexPage ? GUIDE_INDEX_DESCRIPTIONS[locale] : GUIDE_COVER_DESCRIPTIONS[locale];
 const coverTitle = isGuideIndexPage ? t('seoContent.guida.title') : GUIDE_COVER_TITLES[locale][guidaSubTab];
 const coverTarget = isGuideIndexPage ? undefined : GUIDE_COVER_TARGETS[guidaSubTab];
 const coverHref = coverTarget
 ? buildPath({ activeTab: 'guida', guidaSubTab: coverTarget }, locale)
 : isGuideIndexPage ? buildPath({ activeTab: 'calculator', calcolatoreSubTab: 'calculator' }, locale) : undefined;

 return (
 <div className="guide-dossier-page guide-dossier-runtime mx-auto space-y-8">
 <div data-speakable>
 {coverVisual ? (
 <header className="guide-dossier-hero">
 <div className="guide-dossier-hero__copy">
 <h1>{coverTitle}</h1>
 {coverDescription && <p>{coverDescription}</p>}
 {coverHref && (
 <a className="guide-dossier-action" href={coverHref}>
   {isGuideIndexPage ? GUIDE_INDEX_ACTION_LABELS[locale] : GUIDE_COVER_ACTION_LABELS[locale][guidaSubTab]}
 </a>
 )}
 </div>
 <figure className="guide-dossier-hero__figure">
 <img
 src={coverVisual.src}
 alt={coverVisual.alt[locale]}
 width={coverVisual.width}
 height={coverVisual.height}
 fetchPriority="high"
 decoding="async"
 />
 </figure>
 </header>
 ) : (
 <h1 className="text-base sm:text-2xl font-bold font-display text-heading mb-2 sm:mb-4">
 {t('seoContent.guida.title')}
 </h1>
 )}
  {guideIndex && <GuideDossierIndexMap data={guideIndex} />}
 </div>
 <DataFreshness dateKind="reviewed" source={t('freshness.source.ufficiMigrazione')} sourceUrl="https://www.sem.admin.ch/" variant="badge" />
 <Suspense fallback={<div className="min-h-[44px]" />}>
 <SeoContentBlock context="guida" titleOverride={isGuideIndexPage ? GUIDE_INDEX_SEO_HEADINGS[locale] : undefined} />
 </Suspense>
 <div id="guide-dossier-content">
 {guidaSubTab === 'first-day' ? (
 <FrontierGuide activeSection="first-day" />
 ) : guidaSubTab === 'permits' ? (
 <FrontierGuide activeSection="permits" />
 ) : guidaSubTab === 'border' ? (
 <TrafficAlerts initialCrossingId={borderCrossing || undefined} />
 ) : guidaSubTab === 'unemployment' ? (
 <FrontierGuide activeSection="unemployment" />
 ) : guidaSubTab === 'car-transfer' ? (
 <FrontierGuide activeSection="car-transfer" />
 ) : guidaSubTab === 'car-cost' ? (
 <CarCostCalculator />
 ) : guidaSubTab === 'permit-compare' ? (
 <PermitCompare key={authUser?.uid ?? 'anonymous'} userProfile={userProfile} />
 ) : guidaSubTab === 'border-map' ? (
 <BorderMunicipalitiesMap key={authUser?.uid ?? 'anonymous'} userProfile={userProfile} />
 ) : null}
 </div>

 {/* AdSense — bottom multiplex */}
 <Suspense fallback={null}>
 <AdSenseBanner adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot} adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format} className="mt-8 mb-4" />
 </Suspense>
 </div>
 );
}
