import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Award, ExternalLink, Info, Loader2, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { useTranslation, type Locale } from '@/services/i18n';
import { buildPlateAuctionPath, parsePlateAuctionPath } from '@/services/plateAuctions/paths';
import { fetchPlateAuctionEditorialSnapshot, fetchPlateAuctionSnapshot, type PlateAuctionApiSnapshot, type PlateAuctionEditorialSnapshot, type PlateAuctionSourceSnapshot } from '@/services/plateAuctions/api';
import { rankPlateAuctions, type PlateAuctionRankingMode, type PlateAuctionRankingPeriod } from '@/services/plateAuctions/ranking';
import type { PlateAuction, PlateAuctionListingType } from '@/services/plateAuctions/types';

const COPY: Record<Locale, {
  title: string;
  intro: string;
  current: string;
  final: string;
  active: string;
  finals: string;
  sources: string;
  sourceStatus: string;
  allCantons: string;
  search: string;
  period: string;
  week: string;
  month: string;
  year: string;
  allTime: string;
  plate: string;
  price: string;
  bids: string;
  end: string;
  source: string;
  detail: string;
  noData: string;
  noFinals: string;
  unavailable: string;
  refresh: string;
  methodology: string;
  official: string;
  notVerified: string;
  back: string;
  allTypes: string;
  auctionType: string;
  fixedPrice: string;
  wanted: string;
  futureRegistration: string;
  observations: string;
  editorial: string;
  guide: string;
  noHighlights: string;
  canton: string;
  rows: string;
  lastFetch: string;
  fetched: string;
  results: string;
  summary: string;
  filters: string;
}> = {
  it: {
    title: 'Aste targhe svizzere', intro: 'Aste pubbliche, prezzi correnti e risultati finali verificati dalle fonti cantonali.', current: 'In corso', final: 'Risultati verificati', active: 'Aste attive', finals: 'Finali certificate', sources: 'Copertura delle fonti', sourceStatus: 'Stato fonte', allCantons: 'Tutti i cantoni', search: 'Cerca targa', period: 'Periodo', week: 'Settimana', month: 'Mese', year: 'Anno', allTime: 'Tutto lo storico', plate: 'Targa', price: 'Prezzo', bids: 'Offerte', end: 'Scadenza', source: 'Fonte', detail: 'Apri dettaglio', noData: 'Nessuna asta pubblica disponibile per i filtri scelti.', noFinals: 'Non risultano ancora risultati finali verificati per questo periodo. Le aste attive non vengono presentate come vendite concluse.', unavailable: 'Il feed live non è raggiungibile. Riprova tra poco; non mostriamo dati stimati.', refresh: 'Aggiorna', methodology: 'Metodo: leggiamo solo cataloghi pubblici cantonali. I nomi degli offerenti non vengono pubblicati e un prezzo finale entra nelle classifiche solo dopo verifica ufficiale.', official: 'Fonte ufficiale', notVerified: 'Non verificato', back: 'Torna alle aste', allTypes: 'Tutti i tipi', auctionType: 'Asta', fixedPrice: 'Vendita diretta', wanted: 'Targa desiderata', futureRegistration: 'Registrazione futura', observations: 'Osservazioni storiche', editorial: 'Aggiornamento editoriale', guide: 'Guida permanente', noHighlights: 'Nessuna osservazione recente da evidenziare.', canton: 'Cantone', rows: 'Righe', lastFetch: 'Ultimo fetch', fetched: 'Lettura', results: 'risultati', summary: 'Riepilogo aste', filters: 'Filtri aste',
  },
  en: {
    title: 'Swiss plate auctions', intro: 'Public auctions, current prices and verified final results from cantonal sources.', current: 'Live auctions', final: 'Verified results', active: 'Active auctions', finals: 'Certified finals', sources: 'Source coverage', sourceStatus: 'Source status', allCantons: 'All cantons', search: 'Search plate', period: 'Period', week: 'Week', month: 'Month', year: 'Year', allTime: 'All history', plate: 'Plate', price: 'Price', bids: 'Bids', end: 'Ends', source: 'Source', detail: 'Open detail', noData: 'No public auction is available for these filters.', noFinals: 'No verified final results are available for this period yet. Live auctions are never presented as completed sales.', unavailable: 'The live feed is unavailable. Please try again; no estimated data is shown.', refresh: 'Refresh', methodology: 'Method: we read public cantonal catalogues only. Bidder names are not published and a final price enters rankings only after official verification.', official: 'Official source', notVerified: 'Not verified', back: 'Back to auctions', allTypes: 'All types', auctionType: 'Auction', fixedPrice: 'Direct sale', wanted: 'Wanted plate', futureRegistration: 'Future registration', observations: 'Historical observations', editorial: 'Editorial update', guide: 'Evergreen guide', noHighlights: 'There are no recent observations to highlight.', canton: 'Canton', rows: 'Rows', lastFetch: 'Last fetch', fetched: 'Fetched', results: 'results', summary: 'Auction summary', filters: 'Auction filters',
  },
  de: {
    title: 'Schweizer Kontrollschildauktionen', intro: 'Öffentliche Auktionen, aktuelle Preise und verifizierte Ergebnisse aus kantonalen Quellen.', current: 'Laufend', final: 'Verifizierte Ergebnisse', active: 'Laufende Auktionen', finals: 'Bestätigte Ergebnisse', sources: 'Quellenabdeckung', sourceStatus: 'Quellenstatus', allCantons: 'Alle Kantone', search: 'Kontrollschild suchen', period: 'Zeitraum', week: 'Woche', month: 'Monat', year: 'Jahr', allTime: 'Gesamte Historie', plate: 'Kontrollschild', price: 'Preis', bids: 'Gebote', end: 'Ende', source: 'Quelle', detail: 'Details öffnen', noData: 'Für diese Filter sind keine öffentlichen Auktionen verfügbar.', noFinals: 'Für diesen Zeitraum liegen noch keine verifizierten Ergebnisse vor. Laufende Auktionen werden nicht als Verkäufe dargestellt.', unavailable: 'Der Live-Feed ist nicht erreichbar. Bitte später erneut versuchen; es werden keine Schätzungen angezeigt.', refresh: 'Aktualisieren', methodology: 'Methode: Wir lesen nur öffentliche kantonale Kataloge. Bieternamen werden nicht veröffentlicht; Endpreise erscheinen erst nach offizieller Prüfung.', official: 'Offizielle Quelle', notVerified: 'Nicht verifiziert', back: 'Zurück zu den Auktionen', allTypes: 'Alle Arten', auctionType: 'Auktion', fixedPrice: 'Direktverkauf', wanted: 'Wunschkontrollschild', futureRegistration: 'Zukünftige Registrierung', observations: 'Historische Beobachtungen', editorial: 'Redaktionelles Update', guide: 'Dauerhafte Anleitung', noHighlights: 'Keine aktuellen Beobachtungen hervorzuheben.', canton: 'Kanton', rows: 'Zeilen', lastFetch: 'Letzter Fetch', fetched: 'Abruf', results: 'Ergebnisse', summary: 'Auktionsübersicht', filters: 'Auktionsfilter',
  },
  fr: {
    title: 'Ventes aux enchères de plaques suisses', intro: 'Enchères publiques, prix actuels et résultats finaux vérifiés par les sources cantonales.', current: 'En cours', final: 'Résultats vérifiés', active: 'Enchères actives', finals: 'Résultats certifiés', sources: 'Couverture des sources', sourceStatus: 'État de la source', allCantons: 'Tous les cantons', search: 'Rechercher une plaque', period: 'Période', week: 'Semaine', month: 'Mois', year: 'Année', allTime: 'Tout l’historique', plate: 'Plaque', price: 'Prix', bids: 'Offres', end: 'Fin', source: 'Source', detail: 'Ouvrir le détail', noData: 'Aucune enchère publique ne correspond à ces filtres.', noFinals: 'Aucun résultat final vérifié pour cette période. Les enchères en cours ne sont jamais présentées comme des ventes conclues.', unavailable: 'Le flux en direct est indisponible. Réessayez plus tard; aucune estimation ne sera affichée.', refresh: 'Actualiser', methodology: 'Méthode: seules les catalogues cantonaux publics sont lus. Les noms des enchérisseurs ne sont pas publiés et un prix final n’entre dans le classement qu’après vérification officielle.', official: 'Source officielle', notVerified: 'Non vérifié', back: 'Retour aux enchères', allTypes: 'Tous les types', auctionType: 'Enchère', fixedPrice: 'Vente directe', wanted: 'Plaque souhaitée', futureRegistration: 'Inscription future', observations: 'Observations historiques', editorial: 'Mise à jour éditoriale', guide: 'Guide permanent', noHighlights: 'Aucune observation récente à mettre en avant.', canton: 'Canton', rows: 'Lignes', lastFetch: 'Dernier fetch', fetched: 'Lecture', results: 'résultats', summary: 'Résumé des enchères', filters: 'Filtres des enchères',
  },
};

const CANTON_LABELS: Record<string, Record<Locale, string>> = {
  AG: { it: 'Argovia', en: 'Aargau', de: 'Aargau', fr: 'Argovie' }, AI: { it: 'Appenzello Interno', en: 'Appenzell Innerrhoden', de: 'Appenzell Innerrhoden', fr: 'Appenzell Rhodes-Intérieures' }, AR: { it: 'Appenzello Esterno', en: 'Appenzell Ausserrhoden', de: 'Appenzell Ausserrhoden', fr: 'Appenzell Rhodes-Extérieures' }, BE: { it: 'Berna', en: 'Bern', de: 'Bern', fr: 'Berne' }, BL: { it: 'Basilea Campagna', en: 'Basel-Landschaft', de: 'Basel-Landschaft', fr: 'Bâle-Campagne' }, BS: { it: 'Basilea Città', en: 'Basel-Stadt', de: 'Basel-Stadt', fr: 'Bâle-Ville' }, FR: { it: 'Friburgo', en: 'Fribourg', de: 'Freiburg', fr: 'Fribourg' }, GE: { it: 'Ginevra', en: 'Geneva', de: 'Genf', fr: 'Genève' }, GL: { it: 'Glarona', en: 'Glarus', de: 'Glarus', fr: 'Glaris' }, GR: { it: 'Grigioni', en: 'Graubünden', de: 'Graubünden', fr: 'Grisons' }, JU: { it: 'Giura', en: 'Jura', de: 'Jura', fr: 'Jura' }, LU: { it: 'Lucerna', en: 'Lucerne', de: 'Luzern', fr: 'Lucerne' }, NE: { it: 'Neuchâtel', en: 'Neuchâtel', de: 'Neuenburg', fr: 'Neuchâtel' }, NW: { it: 'Nidvaldo', en: 'Nidwalden', de: 'Nidwalden', fr: 'Nidwald' }, OW: { it: 'Obvaldo', en: 'Obwalden', de: 'Obwalden', fr: 'Obwald' }, SG: { it: 'San Gallo', en: 'St. Gallen', de: 'St. Gallen', fr: 'Saint-Gall' }, SH: { it: 'Sciaffusa', en: 'Schaffhausen', de: 'Schaffhausen', fr: 'Schaffhouse' }, SO: { it: 'Soletta', en: 'Solothurn', de: 'Solothurn', fr: 'Soleure' }, SZ: { it: 'Svitto', en: 'Schwyz', de: 'Schwyz', fr: 'Schwytz' }, TG: { it: 'Turgovia', en: 'Thurgau', de: 'Thurgau', fr: 'Thurgovie' }, TI: { it: 'Ticino', en: 'Ticino', de: 'Tessin', fr: 'Tessin' }, UR: { it: 'Uri', en: 'Uri', de: 'Uri', fr: 'Uri' }, VD: { it: 'Vaud', en: 'Vaud', de: 'Waadt', fr: 'Vaud' }, VS: { it: 'Vallese', en: 'Valais', de: 'Wallis', fr: 'Valais' }, ZG: { it: 'Zugo', en: 'Zug', de: 'Zug', fr: 'Zoug' }, ZH: { it: 'Zurigo', en: 'Zurich', de: 'Zürich', fr: 'Zurich' },
};

function cantonLabel(canton: string, locale: Locale): string {
  return CANTON_LABELS[canton]?.[locale] || canton;
}

function sourceLabel(source: PlateAuctionSourceSnapshot, locale: Locale): string {
  return CANTON_LABELS[source.plateCode]?.[locale] || source.canton;
}

function formatChf(value: number | undefined, locale: Locale): string {
  if (typeof value !== 'number') return '—';
  return new Intl.NumberFormat(locale === 'it' ? 'it-CH' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-CH', { style: 'currency', currency: 'CHF', maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string | undefined, locale: Locale): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-CH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Zurich' }).format(date);
}

function sourceStatusText(source: PlateAuctionSourceSnapshot, locale: Locale): string {
  if (source.status === 'active') return locale === 'it' ? 'attiva' : locale === 'de' ? 'aktiv' : locale === 'fr' ? 'active' : 'active';
  if (source.status === 'blocked') return locale === 'it' ? 'bloccata' : locale === 'de' ? 'blockiert' : locale === 'fr' ? 'bloquée' : 'blocked';
  if (source.status === 'degraded') return locale === 'it' ? 'degradata' : locale === 'de' ? 'eingeschränkt' : locale === 'fr' ? 'dégradée' : 'degraded';
  if (source.status === 'no-public-auction') return locale === 'it' ? 'nessuna asta pubblica' : locale === 'de' ? 'keine öffentliche Auktion' : locale === 'fr' ? 'aucune enchère publique' : 'no public auction';
  if (source.status === 'unverified') return locale === 'it' ? 'non verificata' : locale === 'de' ? 'nicht verifiziert' : locale === 'fr' ? 'non vérifiée' : 'unverified';
  return locale === 'it' ? 'scoperta da completare' : locale === 'de' ? 'noch nicht entdeckt' : locale === 'fr' ? 'à découvrir' : 'not discovered';
}

function PlateRow({ auction, locale, onNavigate, copy }: { key?: React.Key; auction: PlateAuction; locale: Locale; onNavigate: (href: string) => void; copy: typeof COPY.it }) {
  const href = buildPlateAuctionPath({ locale, view: 'detail', canton: auction.sourceKey || auction.platePrefix, plate: auction.normalizedPlate });
  return (
    <tr className="border-t border-edge align-top">
      <td className="px-3 py-3 font-semibold text-heading whitespace-nowrap"><a href={href} onClick={(event) => { event.preventDefault(); onNavigate(href); }} className="text-link hover:underline">{auction.normalizedPlate}</a></td>
      <td className="px-3 py-3 text-heading whitespace-nowrap">{formatChf(auction.finalPriceChf ?? auction.currentBidChf, locale)}</td>
      <td className="px-3 py-3 text-subtle">{typeof auction.bidCount === 'number' ? auction.bidCount : '—'}</td>
      <td className="px-3 py-3 text-subtle whitespace-nowrap">{formatDate(auction.endsAt || auction.closedAt, locale)}</td>
      <td className="px-3 py-3 text-subtle">{cantonLabel(auction.sourceKey || auction.platePrefix, locale) || auction.canton}</td>
      <td className="px-3 py-3 text-right"><a href={href} onClick={(event) => { event.preventDefault(); onNavigate(href); }} className="text-xs font-semibold text-link hover:underline">{copy.detail}</a></td>
    </tr>
  );
}

export function PlateAuctionsPage(): React.ReactElement {
  const { locale } = useTranslation();
  const copy = COPY[locale] || COPY.it;
  const [pathname, setPathname] = useState(() => (typeof window === 'undefined' ? '/' : window.location.pathname));
  const [snapshot, setSnapshot] = useState<PlateAuctionApiSnapshot | null>(null);
  const [editorial, setEditorial] = useState<PlateAuctionEditorialSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [mode, setMode] = useState<PlateAuctionRankingMode>('current');
  const [period, setPeriod] = useState<PlateAuctionRankingPeriod>('all-time');
  const [canton, setCanton] = useState('');
  const [search, setSearch] = useState('');
  const [listingType, setListingType] = useState<PlateAuctionListingType | ''>('');

  const load = useCallback(async (refresh = false) => {
    setError(null);
    if (refresh) setRefreshing(true); else setLoading(true);
    try {
      const [nextSnapshot, nextEditorial] = await Promise.all([
        fetchPlateAuctionSnapshot(),
        fetchPlateAuctionEditorialSnapshot(),
      ]);
      setSnapshot(nextSnapshot);
      setEditorial(nextEditorial);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : copy.unavailable);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [copy.unavailable]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const route = parsePlateAuctionPath(pathname);
    const title = route?.view === 'detail' && route.plate ? `${route.plate} — ${copy.title}` : copy.title;
    document.title = title;
    const description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute('content', copy.intro);
  }, [copy.intro, copy.title, pathname]);

  const route = useMemo(() => parsePlateAuctionPath(pathname), [pathname]);
  useEffect(() => {
    if (route?.view === 'rankings') {
      setMode('final');
      setPeriod('week');
    } else if (route?.view === 'hub' || route?.view === 'canton') {
      setMode('current');
      setPeriod('all-time');
    }
  }, [route?.view]);
  const routeCanton = route?.canton || '';
  const effectiveCanton = canton || routeCanton;
  const filterAuctions = useCallback((all: readonly PlateAuction[]) => {
    return all.filter((auction) => {
      if (effectiveCanton && auction.sourceKey !== effectiveCanton && auction.platePrefix !== effectiveCanton) return false;
      if (search && !auction.normalizedPlate.toLowerCase().includes(search.trim().toLowerCase())) return false;
      if (listingType && (auction.listingType || 'auction') !== listingType) return false;
      return true;
    });
  }, [effectiveCanton, listingType, search]);
  const visibleAuctions = useMemo(() => filterAuctions(snapshot?.auctions || []), [filterAuctions, snapshot?.auctions]);
  const rankingAuctions = useMemo(() => mode === 'final' && snapshot?.history?.length ? filterAuctions(snapshot.history) : visibleAuctions, [filterAuctions, mode, snapshot?.history, visibleAuctions]);
  const ranking = useMemo(() => rankPlateAuctions(rankingAuctions, { mode, period, canton: undefined, limit: 50 }), [mode, period, rankingAuctions]);
  const detail = useMemo(() => {
    if (route?.view !== 'detail' || !snapshot) return undefined;
    const matches = [...snapshot.auctions, ...(snapshot.history || [])]
      .filter((auction) => auction.dataConfidence !== 'conflicting'
        && (auction.normalizedPlate.toLowerCase() === route.plate?.toLowerCase() || auction.id.toLowerCase() === route.plate?.toLowerCase())
        && (!route.canton || auction.sourceKey === route.canton || auction.platePrefix === route.canton));
    return matches.sort((left, right) => Date.parse(right.sourceFetchedAt) - Date.parse(left.sourceFetchedAt))[0];
  }, [route?.plate, route?.view, snapshot]);
  const detailRequested = route?.view === 'detail';
  const detailHistory = useMemo(() => detail && snapshot?.history ? snapshot.history.filter((row) => row.id === detail.id && row.dataConfidence !== 'conflicting').sort((left, right) => Date.parse(left.sourceFetchedAt) - Date.parse(right.sourceFetchedAt)).slice(-20) : [], [detail, snapshot?.history]);
  const navigate = useCallback((href: string) => {
    window.history.pushState({}, '', href);
    setPathname(new URL(href, window.location.origin).pathname);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, []);

  const currentCount = snapshot?.auctions.filter((auction) => auction.auctionStatus === 'active' && auction.dataConfidence !== 'conflicting').length || 0;
  const finalCount = snapshot?.counts.finalsVerified || 0;
  const weeklyEditorial = editorial?.weekly[locale] || editorial?.weekly.it;
  const evergreenEditorial = editorial?.evergreen[locale] || editorial?.evergreen.it;
  const sources: Array<[string, PlateAuctionSourceSnapshot]> = snapshot ? Object.entries(snapshot.sources) : [];
  sources.sort(([, left], [, right]) => left.plateCode.localeCompare(right.plateCode));

  if (loading) {
    return <div className="rounded-3xl border border-edge bg-surface p-8 flex items-center justify-center" role="status"><Loader2 className="h-5 w-5 animate-spin text-accent" /><span className="sr-only">Loading</span></div>;
  }

  return (
    <div className="space-y-6 pb-8" data-testid="plate-auctions-page">
      <header className="rounded-3xl border border-edge bg-surface p-5 sm:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3"><Award className="h-7 w-7 text-accent" aria-hidden="true" /><h1 className="text-2xl sm:text-3xl font-bold font-display text-heading">{detail ? (detail.normalizedPlate) : detailRequested ? (route?.plate || copy.title) : route?.view === 'rankings' ? `${copy.title} — ${copy.final}` : routeCanton ? `${copy.title}: ${CANTON_LABELS[routeCanton]?.[locale] || routeCanton}` : copy.title}</h1></div>
            <p className="mt-3 text-sm leading-7 text-subtle">{detail ? copy.methodology : copy.intro}</p>
            <nav className="mt-5 flex flex-wrap gap-2" aria-label={copy.title}>
              <a href={buildPlateAuctionPath({ locale })} onClick={(event) => { event.preventDefault(); navigate(buildPlateAuctionPath({ locale })); }} className="rounded-xl border border-edge px-3 py-2 text-sm font-semibold text-link hover:border-accent">{copy.current}</a>
              <a href={buildPlateAuctionPath({ locale, view: 'rankings' })} onClick={(event) => { event.preventDefault(); navigate(buildPlateAuctionPath({ locale, view: 'rankings' })); }} className="rounded-xl border border-edge px-3 py-2 text-sm font-semibold text-link hover:border-accent">{copy.final}</a>
              {detail && <a href={buildPlateAuctionPath({ locale, canton: detail.sourceKey || detail.platePrefix, view: 'canton' })} onClick={(event) => { event.preventDefault(); navigate(buildPlateAuctionPath({ locale, canton: detail.sourceKey || detail.platePrefix, view: 'canton' })); }} className="rounded-xl border border-edge px-3 py-2 text-sm font-semibold text-link hover:border-accent">{copy.back}</a>}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => void load(true)} disabled={refreshing} className="inline-flex items-center gap-2 rounded-xl border border-edge px-3 py-2 text-sm font-semibold text-body hover:border-accent disabled:opacity-60"><RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden="true" />{copy.refresh}</button>
          </div>
        </div>
      </header>

      {error && <div className="rounded-2xl border border-warning-border bg-warning-subtle px-4 py-3 text-sm text-body" role="alert">{copy.unavailable}</div>}

      {detailRequested && !detail ? (
        <section className="rounded-3xl border border-edge bg-surface p-6 sm:p-8" aria-labelledby="plate-detail-missing-title">
          <h2 id="plate-detail-missing-title" className="text-xl font-bold font-display text-heading">{copy.noData}</h2>
          <p className="mt-3 text-sm leading-6 text-subtle">{copy.methodology}</p>
          <a href={buildPlateAuctionPath({ locale, canton: routeCanton || undefined, view: routeCanton ? 'canton' : 'hub' })} onClick={(event) => { event.preventDefault(); navigate(buildPlateAuctionPath({ locale, canton: routeCanton || undefined, view: routeCanton ? 'canton' : 'hub' })); }} className="mt-5 inline-flex rounded-xl border border-edge px-4 py-2 text-sm font-semibold text-link hover:border-accent">{copy.back}</a>
        </section>
      ) : detail ? (
        <section className="rounded-3xl border border-edge bg-surface p-5 sm:p-7" aria-labelledby="plate-detail-title">
          <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">{CANTON_LABELS[detail.sourceKey || detail.platePrefix]?.[locale] || detail.canton}</p><h2 id="plate-detail-title" className="mt-2 text-2xl font-bold font-display text-heading">{detail.normalizedPlate}</h2></div><span className="rounded-full border border-accent-border bg-accent-subtle px-3 py-1 text-xs font-semibold text-link">{detail.auctionStatus === 'active' ? copy.active : copy.notVerified}</span></div>
          <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4"><div><dt className="text-xs text-muted">{copy.price}</dt><dd className="mt-1 text-lg font-bold text-heading">{formatChf(detail.finalPriceChf ?? detail.currentBidChf, locale)}</dd></div><div><dt className="text-xs text-muted">{copy.bids}</dt><dd className="mt-1 text-lg font-bold text-heading">{detail.bidCount ?? '—'}</dd></div><div><dt className="text-xs text-muted">{copy.end}</dt><dd className="mt-1 text-sm font-semibold text-heading">{formatDate(detail.endsAt || detail.closedAt, locale)}</dd></div><div><dt className="text-xs text-muted">{copy.source}</dt><dd className="mt-1 text-sm font-semibold text-heading">{detail.sourceKey || detail.platePrefix}</dd></div></dl>
          <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-edge pt-5 text-sm"><a href={detail.officialDetailUrl || detail.officialAuctionUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 font-semibold text-link hover:underline"><ExternalLink className="h-4 w-4" aria-hidden="true" />{copy.official}</a><span className="text-subtle">{copy.methodology}</span></div>
        </section>
      ) : (
        <>
          <section className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm text-subtle" aria-label={copy.summary}><span><strong className="text-xl text-heading">{currentCount}</strong> {copy.active}</span><span><strong className="text-xl text-heading">{finalCount}</strong> {copy.finals}</span><span><strong className="text-xl text-heading">{snapshot?.counts.cantonsWithData || 0}</strong> / 26 {copy.sources.toLowerCase()}</span></section>

          {weeklyEditorial && evergreenEditorial && <section className="rounded-3xl border border-edge bg-surface p-5 sm:p-6" aria-labelledby="plate-auction-editorial-title">
            <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
              <article>
                <p className="text-xs font-bold uppercase tracking-[0.16em] text-muted">{copy.editorial}</p>
                <h2 id="plate-auction-editorial-title" className="mt-2 text-xl font-bold font-display text-heading">{weeklyEditorial.title}</h2>
                <p className="mt-2 text-sm leading-6 text-subtle">{weeklyEditorial.excerpt}</p>
                <p className="mt-3 text-sm leading-6 text-body">{weeklyEditorial.paragraphs[0]}</p>
                {weeklyEditorial.highlights && weeklyEditorial.highlights.length > 0 ? <ul className="mt-4 grid gap-2 sm:grid-cols-2" aria-label={weeklyEditorial.title}>{weeklyEditorial.highlights.slice(0, 4).map((highlight) => <li key={`${highlight.plate}-${highlight.endsAt || 'open'}`} className="rounded-xl border border-edge bg-surface-alt px-3 py-2 text-sm"><span className="font-semibold text-heading">{highlight.plate}</span><span className="ml-2 text-subtle">{highlight.canton || '—'}</span><span className="ml-2 text-body">{formatChf(highlight.currentPriceChf, locale)}</span></li>)}</ul> : <p className="mt-4 text-sm text-muted">{copy.noHighlights}</p>}
              </article>
              <details className="rounded-2xl border border-edge bg-surface-alt p-4">
                <summary className="cursor-pointer text-sm font-semibold text-heading">{copy.guide}</summary>
                <div className="mt-3 space-y-3 text-sm leading-6 text-subtle">{evergreenEditorial.paragraphs.slice(0, 2).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}{evergreenEditorial.bullets && <ul className="list-disc space-y-1 pl-5">{evergreenEditorial.bullets.slice(0, 4).map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}</div>
              </details>
            </div>
          </section>}

          <section className="rounded-3xl border border-edge bg-surface p-4 sm:p-6" aria-label={copy.filters}>
            <div className="grid gap-3 xl:grid-cols-[1fr_160px_170px_170px_180px]">
              <label className="relative block"><span className="sr-only">{copy.search}</span><Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted" aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy.search} className="w-full rounded-xl border border-edge bg-surface px-9 py-2.5 text-sm text-body outline-none focus:border-accent focus:ring-2 focus:ring-accent/30" /></label>
              <label className="block"><span className="sr-only">{copy.canton}</span><select value={canton} onChange={(event) => setCanton(event.target.value)} className="w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-sm text-body"><option value="">{copy.allCantons}</option>{Object.keys(CANTON_LABELS).sort().map((code) => <option key={code} value={code}>{code} — {CANTON_LABELS[code][locale]}</option>)}</select></label>
              <label className="block"><span className="sr-only">{copy.current}/{copy.final}</span><select value={mode} onChange={(event) => setMode(event.target.value as PlateAuctionRankingMode)} className="w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-sm text-body"><option value="current">{copy.current}</option><option value="final">{copy.final}</option></select></label>
              <label className="block"><span className="sr-only">{copy.period}</span><select value={period} onChange={(event) => setPeriod(event.target.value as PlateAuctionRankingPeriod)} className="w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-sm text-body"><option value="week">{copy.week}</option><option value="month">{copy.month}</option><option value="year">{copy.year}</option><option value="all-time">{copy.allTime}</option></select></label>
              <label className="block"><span className="sr-only">{copy.allTypes}</span><select value={listingType} onChange={(event) => setListingType(event.target.value as PlateAuctionListingType | '')} className="w-full rounded-xl border border-edge bg-surface px-3 py-2.5 text-sm text-body"><option value="">{copy.allTypes}</option><option value="auction">{copy.auctionType}</option><option value="fixed-price">{copy.fixedPrice}</option><option value="wanted">{copy.wanted}</option><option value="future-registration">{copy.futureRegistration}</option></select></label>
            </div>
          </section>

          <section className="overflow-hidden rounded-3xl border border-edge bg-surface" aria-labelledby="auction-table-title">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6"><h2 id="auction-table-title" className="text-lg font-bold font-display text-heading">{mode === 'final' ? copy.final : copy.current}</h2><span className="text-sm text-subtle">{ranking.length} {copy.results}</span></div>
            {ranking.length > 0 ? <div className="overflow-x-auto"><table className="w-full min-w-[700px] text-left text-sm"><thead className="bg-surface-alt text-xs uppercase tracking-wider text-muted"><tr><th className="px-3 py-3">{copy.plate}</th><th className="px-3 py-3">{copy.price}</th><th className="px-3 py-3">{copy.bids}</th><th className="px-3 py-3">{copy.end}</th><th className="px-3 py-3">{copy.source}</th><th className="px-3 py-3"><span className="sr-only">{copy.detail}</span></th></tr></thead><tbody>{ranking.map(({ auction }) => <PlateRow key={auction.id} auction={auction} locale={locale} onNavigate={navigate} copy={copy} />)}</tbody></table></div> : <div className="px-5 py-8 text-sm text-subtle">{mode === 'final' ? copy.noFinals : copy.noData}</div>}
          </section>
        </>
      )}

      {detail && detailHistory.length > 0 && <section className="rounded-3xl border border-edge bg-surface p-5 sm:p-6" aria-labelledby="auction-history-title"><div className="flex items-center justify-between gap-3"><h2 id="auction-history-title" className="text-lg font-bold font-display text-heading">{copy.observations}</h2><span className="text-xs text-muted">{detailHistory.length}</span></div><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[420px] text-left text-sm"><thead className="text-xs uppercase tracking-wider text-muted"><tr><th className="px-3 py-2">{copy.price}</th><th className="px-3 py-2">{copy.bids}</th><th className="px-3 py-2">{copy.fetched}</th></tr></thead><tbody>{detailHistory.map((row) => <tr key={`${row.id}-${row.sourceFetchedAt}`} className="border-t border-edge"><td className="px-3 py-2 font-semibold text-heading">{formatChf(row.finalPriceChf ?? row.currentBidChf, locale)}</td><td className="px-3 py-2 text-subtle">{row.bidCount ?? '—'}</td><td className="px-3 py-2 text-subtle">{formatDate(row.sourceFetchedAt, locale)}</td></tr>)}</tbody></table></div></section>}

      <section className="rounded-3xl border border-edge bg-surface p-5 sm:p-6" aria-labelledby="source-coverage-title"><div className="flex items-center gap-2"><ShieldCheck className="h-5 w-5 text-accent" aria-hidden="true" /><h2 id="source-coverage-title" className="text-lg font-bold font-display text-heading">{copy.sources}</h2></div><p className="mt-2 text-sm leading-6 text-subtle">{copy.methodology}</p><div className="mt-4 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="text-xs uppercase tracking-wider text-muted"><tr><th className="px-3 py-2">{copy.canton}</th><th className="px-3 py-2">{copy.sourceStatus}</th><th className="px-3 py-2">{copy.rows}</th><th className="px-3 py-2">{copy.lastFetch}</th><th className="px-3 py-2"><span className="sr-only">{copy.official}</span></th></tr></thead><tbody>{sources.map(([key, source]) => <tr key={key} className="border-t border-edge"><td className="px-3 py-2 font-semibold text-heading">{source.plateCode} — {sourceLabel(source, locale)}</td><td className="px-3 py-2 text-subtle">{sourceStatusText(source, locale)}</td><td className="px-3 py-2 text-subtle">{source.rowCount}</td><td className="px-3 py-2 text-subtle">{formatDate(source.lastFetchedAt, locale)}</td><td className="px-3 py-2 text-right"><a href={source.officialUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-link hover:underline">{copy.official}<ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a></td></tr>)}</tbody></table></div></section>

      <aside className="flex gap-3 rounded-2xl border border-edge bg-surface-alt px-4 py-4 text-sm leading-6 text-subtle"><Info className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" /><p>{copy.methodology}</p></aside>
    </div>
  );
}
