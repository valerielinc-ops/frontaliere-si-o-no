import { useEffect, useState } from 'react';
import { AlertTriangle, Clock, Fuel, MapPin } from 'lucide-react';
import { useLocale, useTranslation } from '@/services/i18n';
import { fetchFuelPrices, type FuelPricesDataset } from '@/services/fuelPricesService';
import {
  buildFuelPriceComparisonHref,
  prepareInlineFuelPriceSections,
  type InlineFuelPriceRow,
  type InlineFuelPriceSourceClass,
} from '@/components/blog/inlineFuelPriceTableData';
import type { InlineFuelPriceVariant } from '@/components/blog/fuelArticleContext';

interface InlineFuelPriceTableProps {
  variant?: InlineFuelPriceVariant;
  maxRows?: number;
}

interface LocalizedLabels {
  fuelHeading: string;
  dieselHeading: string;
  fuelSubtitle: string;
  dieselSubtitle: string;
  fuelNote: string;
  dieselNote: string;
  datasetUpdated: string;
  fuelUpdated: string;
  dieselUpdated: string;
  station: string;
  brand: string;
  address: string;
  fuelPrice: string;
  dieselPrice: string;
  source: string;
  observedGroup: string;
  derivedGroup: string;
  unknownGroup: string;
  derived: string;
  feedSource: string;
  scrapedSource: string;
  monthlyAverageSource: string;
  unknownSource: string;
  empty: string;
  errorTitle: string;
  errorBody: string;
  loading: string;
  link: string;
}

const LABELS: Record<'it' | 'en' | 'de' | 'fr', LocalizedLabels> = {
  it: {
    fuelHeading: 'Prezzi live benzina — stazioni svizzere (SP95)',
    dieselHeading: 'Prezzi live diesel — stazioni svizzere',
    fuelSubtitle: 'Prezzi SP95 ordinati dal più basso. Fonte: {source}.',
    dieselSubtitle: 'Classifica diesel per prezzo, con dati rilevati, stime e origini non verificate separati.',
    fuelNote: 'La data per ogni stazione è quella associata al prezzo SP95.',
    dieselNote: 'La data di rilevazione del diesel è mostrata se disponibile; altrimenti compare —.',
    datasetUpdated: 'Dati aggiornati al',
    fuelUpdated: 'Data del prezzo SP95',
    dieselUpdated: 'Data di rilevazione del diesel',
    station: 'Stazione',
    brand: 'Marchio',
    address: 'Indirizzo',
    fuelPrice: 'SP95 CHF/L',
    dieselPrice: 'Diesel CHF/L',
    source: 'Fonte e tipo di dato',
    observedGroup: 'Prezzi rilevati',
    derivedGroup: 'Stime e medie',
    unknownGroup: 'Origine non verificata',
    derived: 'Derivato',
    feedSource: 'dato dal feed prezzi',
    scrapedSource: 'fonte acquisita',
    monthlyAverageSource: 'media mensile',
    unknownSource: 'Origine non verificata',
    empty: 'Nessun prezzo valido disponibile per questo carburante.',
    errorTitle: 'Dati live non disponibili',
    errorBody: 'Riprova tra qualche minuto. Nel frattempo puoi consultare il confronto carburanti.',
    loading: 'Caricamento prezzi live…',
    link: 'Apri confronto carburanti',
  },
  en: {
    fuelHeading: 'Live petrol prices — Swiss stations (SP95)',
    dieselHeading: 'Live diesel prices — Swiss stations',
    fuelSubtitle: 'SP95 prices, from lowest to highest. Source: {source}.',
    dieselSubtitle: 'Diesel prices are ranked with observed data, estimates and unverified sources kept separate.',
    fuelNote: 'Each station shows the date associated with its SP95 price.',
    dieselNote: 'The diesel collection date is shown when available; otherwise, — is displayed.',
    datasetUpdated: 'Data updated as of',
    fuelUpdated: 'SP95 price date',
    dieselUpdated: 'Diesel collection date',
    station: 'Station',
    brand: 'Brand',
    address: 'Address',
    fuelPrice: 'SP95 CHF/L',
    dieselPrice: 'Diesel CHF/L',
    source: 'Source and data type',
    observedGroup: 'Observed prices',
    derivedGroup: 'Estimates and averages',
    unknownGroup: 'Unverified source',
    derived: 'Derived',
    feedSource: 'price-feed data',
    scrapedSource: 'collected source',
    monthlyAverageSource: 'monthly average',
    unknownSource: 'Unverified source',
    empty: 'No valid price is available for this fuel.',
    errorTitle: 'Live data is unavailable',
    errorBody: 'Please try again in a few minutes. Meanwhile, you can open the fuel comparison.',
    loading: 'Loading live prices…',
    link: 'Open fuel comparison',
  },
  de: {
    fuelHeading: 'Aktuelle Benzinpreise — Schweizer Tankstellen (SP95)',
    dieselHeading: 'Aktuelle Dieselpreise — Schweizer Tankstellen',
    fuelSubtitle: 'SP95-Preise, vom niedrigsten zum höchsten. Quelle: {source}.',
    dieselSubtitle: 'Dieselpreise sind sortiert; Messwerte, Schätzungen und nicht bestätigte Quellen bleiben getrennt.',
    fuelNote: 'Für jede Tankstelle wird das zum SP95-Preis gehörende Datum angezeigt.',
    dieselNote: 'Das Erfassungsdatum des Diesels wird angezeigt, wenn es verfügbar ist; sonst erscheint —.',
    datasetUpdated: 'Daten aktualisiert am',
    fuelUpdated: 'Datum des SP95-Preises',
    dieselUpdated: 'Erfassungsdatum des Diesels',
    station: 'Tankstelle',
    brand: 'Marke',
    address: 'Adresse',
    fuelPrice: 'SP95 CHF/L',
    dieselPrice: 'Diesel CHF/L',
    source: 'Quelle und Datentyp',
    observedGroup: 'Erfasste Preise',
    derivedGroup: 'Schätzungen und Durchschnitte',
    unknownGroup: 'Quelle nicht verifiziert',
    derived: 'Abgeleitet',
    feedSource: 'Preisdaten aus dem Anbieter-Feed',
    scrapedSource: 'erfasste Quelle',
    monthlyAverageSource: 'Monatsdurchschnitt',
    unknownSource: 'Quelle nicht verifiziert',
    empty: 'Für diesen Kraftstoff ist kein gültiger Preis verfügbar.',
    errorTitle: 'Live-Daten nicht verfügbar',
    errorBody: 'Bitte versuchen Sie es in einigen Minuten erneut. Inzwischen können Sie den Kraftstoffvergleich öffnen.',
    loading: 'Live-Preise werden geladen…',
    link: 'Kraftstoffvergleich öffnen',
  },
  fr: {
    fuelHeading: 'Prix en direct de l’essence — stations suisses (SP95)',
    dieselHeading: 'Prix en direct du diesel — stations suisses',
    fuelSubtitle: 'Prix SP95, du plus bas au plus élevé. Source : {source}.',
    dieselSubtitle: 'Les prix du diesel sont classés en séparant mesures, estimations et sources non vérifiées.',
    fuelNote: 'Chaque station affiche la date associée à son prix SP95.',
    dieselNote: 'La date de collecte du diesel est affichée si elle est disponible ; sinon, — apparaît.',
    datasetUpdated: 'Données mises à jour le',
    fuelUpdated: 'Date du prix SP95',
    dieselUpdated: 'Date de collecte du diesel',
    station: 'Station',
    brand: 'Marque',
    address: 'Adresse',
    fuelPrice: 'SP95 CHF/L',
    dieselPrice: 'Diesel CHF/L',
    source: 'Source et type de donnée',
    observedGroup: 'Prix relevés',
    derivedGroup: 'Estimations et moyennes',
    unknownGroup: 'Source non vérifiée',
    derived: 'Dérivé',
    feedSource: 'donnée du flux de prix',
    scrapedSource: 'source collectée',
    monthlyAverageSource: 'moyenne mensuelle',
    unknownSource: 'Source non vérifiée',
    empty: 'Aucun prix valide n’est disponible pour ce carburant.',
    errorTitle: 'Données en direct indisponibles',
    errorBody: 'Réessayez dans quelques minutes. En attendant, consultez le comparatif des carburants.',
    loading: 'Chargement des prix en direct…',
    link: 'Ouvrir le comparatif carburants',
  },
};

function resolveLocale(locale: string): 'it' | 'en' | 'de' | 'fr' {
  if (locale === 'en' || locale === 'de' || locale === 'fr') return locale;
  return 'it';
}

function formatPriceChf(value: number, locale: string): string {
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUpdatedAt(value: string | null, locale: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function sourceLabel(row: InlineFuelPriceRow, provider: string, labels: LocalizedLabels, variant: InlineFuelPriceVariant): string {
  if (variant === 'fuel') return provider;
  if (row.sourceClass === 'derived') {
    return row.dieselSource === 'monthly_average' ? labels.monthlyAverageSource : labels.derived;
  }
  if (row.sourceClass === 'unknown') return labels.unknownSource;
  if (row.dieselSource === 'scraped') return `${provider} · ${labels.scrapedSource}`;
  return `${provider} · ${labels.feedSource}`;
}

function groupLabel(sourceClass: InlineFuelPriceSourceClass, labels: LocalizedLabels): string {
  if (sourceClass === 'observed') return labels.observedGroup;
  if (sourceClass === 'derived') return labels.derivedGroup;
  return labels.unknownGroup;
}

export default function InlineFuelPriceTable({ variant = 'fuel', maxRows = 10 }: InlineFuelPriceTableProps) {
  const { t: _t } = useTranslation();
  // Keep the widget attached to the i18n bootstrap used by the article surface.
  void _t;
  const [locale] = useLocale();
  const labels = LABELS[resolveLocale(locale)];
  const comparisonHref = buildFuelPriceComparisonHref(variant, locale);
  const comparisonLink = (
    <a href={comparisonHref} className="font-semibold text-link underline underline-offset-2">
      {labels.link} →
    </a>
  );

  const [dataset, setDataset] = useState<FuelPricesDataset | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    fetchFuelPrices()
      .then((data) => {
        if (cancelled) return;
        setDataset(data);
        setStatus('idle');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if ((status === 'loading' || status === 'idle') && !dataset) {
    return (
      <div
        data-testid="inline-fuel-price-table-loading"
        className="mt-6 rounded-xl border border-edge bg-surface-alt/60 p-4 text-sm text-subtle"
      >
        <p>
          <Fuel className="mr-2 inline-block align-text-bottom" size={16} aria-hidden="true" />
          {labels.loading}
        </p>
        <p className="mt-2">{comparisonLink}</p>
      </div>
    );
  }

  if (status === 'error' || !dataset) {
    return (
      <div
        data-testid="inline-fuel-price-table-error"
        className="mt-6 rounded-xl border border-warning-border/60 bg-warning-subtle/40 p-4 text-sm text-warning"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">{labels.errorTitle}</p>
            <p className="mt-1 text-subtle">{labels.errorBody}</p>
            <p className="mt-2">{comparisonLink}</p>
          </div>
        </div>
      </div>
    );
  }

  const sections = prepareInlineFuelPriceSections(dataset, variant, maxRows);
  const groups = [
    { sourceClass: 'observed' as const, rows: sections.observed },
    { sourceClass: 'derived' as const, rows: sections.derived },
    { sourceClass: 'unknown' as const, rows: sections.unknown },
  ].filter((group) => group.rows.length > 0);
  const provider = dataset.sources.switzerland.provider.trim() || labels.unknownSource;
  const heading = variant === 'diesel' ? labels.dieselHeading : labels.fuelHeading;
  const subtitle = variant === 'diesel'
    ? labels.dieselSubtitle
    : labels.fuelSubtitle.replace('{source}', provider);
  const note = variant === 'diesel' ? labels.dieselNote : labels.fuelNote;
  const priceLabel = variant === 'diesel' ? labels.dieselPrice : labels.fuelPrice;
  const updatedLabel = variant === 'diesel' ? labels.dieselUpdated : labels.fuelUpdated;

  return (
    <section
      data-testid="inline-fuel-price-table"
      data-fuel-variant={variant}
      aria-labelledby="inline-fuel-price-table-heading"
      className="mt-6 overflow-hidden rounded-xl border border-edge bg-surface-alt/60"
    >
      <header className="border-b border-edge p-4 sm:p-5">
        <h3
          id="inline-fuel-price-table-heading"
          className="flex items-center gap-2 text-lg font-bold font-display text-heading"
        >
          <Fuel size={20} className="text-accent" aria-hidden="true" />
          {heading}
        </h3>
        <p className="mt-2 text-sm text-subtle">{subtitle}</p>
        <p className="mt-1 text-xs italic text-muted">{note}</p>
        <p className="mt-2 inline-flex items-center gap-1 text-xs text-muted">
          <Clock size={12} aria-hidden="true" />
          {labels.datasetUpdated}: {formatUpdatedAt(dataset.generatedAt, locale)}
        </p>
      </header>

      {groups.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="inline-fuel-price-table-body">
            <thead className="bg-surface/80 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="px-3 py-2">#</th>
                <th scope="col" className="px-3 py-2">{labels.station}</th>
                <th scope="col" className="px-3 py-2 hidden sm:table-cell">{labels.brand}</th>
                <th scope="col" className="px-3 py-2 hidden md:table-cell">{labels.address}</th>
                <th scope="col" className="px-3 py-2">{labels.source}</th>
                <th scope="col" className="px-3 py-2 text-right">{priceLabel}</th>
                <th scope="col" className="px-3 py-2 hidden lg:table-cell">{updatedLabel}</th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.sourceClass} data-source-class={group.sourceClass}>
                <tr className="border-t border-edge bg-surface/50">
                  <th colSpan={7} scope="rowgroup" className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted">
                    {groupLabel(group.sourceClass, labels)}
                  </th>
                </tr>
                {group.rows.map((row, idx) => (
                  <tr key={`${row.station.id}-${group.sourceClass}`} className="border-t border-edge/60">
                    <td className="px-3 py-2 font-mono text-muted">{idx + 1}</td>
                    <td className="px-3 py-2 font-semibold text-body">
                      {row.station.name}
                      {row.station.nearestMunicipality && (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-muted">
                          <MapPin size={10} aria-hidden="true" />
                          {row.station.nearestMunicipality}
                        </span>
                      )}
                      <span className="mt-1 block text-xs font-normal text-muted lg:hidden">
                        {updatedLabel}: {formatUpdatedAt(row.updatedAt, locale)}
                      </span>
                    </td>
                    <td className="hidden px-3 py-2 text-subtle sm:table-cell">{row.station.brand || '—'}</td>
                    <td className="hidden px-3 py-2 text-subtle md:table-cell">{row.station.address || '—'}</td>
                    <td className="px-3 py-2 text-subtle">{sourceLabel(row, provider, labels, variant)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums text-strong">{formatPriceChf(row.priceChf, locale)}</td>
                    <td className="hidden px-3 py-2 text-muted lg:table-cell">{formatUpdatedAt(row.updatedAt, locale)}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : (
        <p className="p-4 text-sm text-subtle" data-testid="inline-fuel-price-table-empty">{labels.empty}</p>
      )}

      <footer className="border-t border-edge p-4 text-sm">{comparisonLink}</footer>
    </section>
  );
}
