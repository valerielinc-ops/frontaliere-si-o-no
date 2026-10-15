import { useEffect, useState } from 'react';
import { Fuel, MapPin, Clock, AlertTriangle } from 'lucide-react';
import { useTranslation, useLocale } from '@/services/i18n';
import { fetchFuelPrices, type FuelPricesDataset, type FuelStationSwitzerland } from '@/services/fuelPricesService';

interface InlineFuelPriceTableProps {
  variant?: 'diesel' | 'fuel';
  maxRows?: number;
}

interface LocalizedLabels {
  heading: string;
  subtitle: string;
  note: string;
  updated: string;
  station: string;
  brand: string;
  address: string;
  price: string;
  errorTitle: string;
  errorBody: string;
  loading: string;
  link: string;
}

const LABELS: Record<'it' | 'en' | 'de' | 'fr', LocalizedLabels> = {
  it: {
    heading: 'Prezzi carburante live — distributori svizzeri (SP95)',
    subtitle:
      'Top stazioni di servizio in Svizzera per prezzo (dati aggregati TCS). Il diesel mantiene storicamente un differenziale di circa +CHF 0,20/litro rispetto alla benzina.',
    note:
      'I prezzi ufficiali del diesel non sono pubblicati per stazione in Svizzera; questa tabella mostra i prezzi SP95 disponibili come indicatore di mercato.',
    updated: 'Aggiornato',
    station: 'Stazione',
    brand: 'Marchio',
    address: 'Indirizzo',
    price: 'SP95 CHF/L',
    errorTitle: 'Dati live non disponibili',
    errorBody: 'Riprova tra qualche minuto — nel frattempo puoi consultare la pagina Statistiche carburanti.',
    loading: 'Caricamento prezzi live…',
    link: 'Vedi confronto completo',
  },
  en: {
    heading: 'Live fuel prices — Swiss stations (SP95)',
    subtitle:
      'Top fueling stations in Switzerland by price (TCS aggregated data). Diesel historically trades at about +CHF 0.20/liter over petrol.',
    note:
      'Official per-station diesel prices are not published in Switzerland; this table shows SP95 data as a market indicator.',
    updated: 'Updated',
    station: 'Station',
    brand: 'Brand',
    address: 'Address',
    price: 'SP95 CHF/L',
    errorTitle: 'Live data not available',
    errorBody: 'Please retry later — in the meantime, visit the Fuel statistics page.',
    loading: 'Loading live prices…',
    link: 'See full comparison',
  },
  de: {
    heading: 'Live-Kraftstoffpreise — Schweizer Tankstellen (SP95)',
    subtitle:
      'Top-Tankstellen in der Schweiz nach Preis (TCS-Aggregatdaten). Diesel liegt historisch rund +CHF 0,20/Liter über Benzin.',
    note:
      'Offizielle Dieselpreise werden pro Station in der Schweiz nicht veröffentlicht; diese Tabelle zeigt SP95-Daten als Marktindikator.',
    updated: 'Aktualisiert',
    station: 'Tankstelle',
    brand: 'Marke',
    address: 'Adresse',
    price: 'SP95 CHF/L',
    errorTitle: 'Live-Daten nicht verfügbar',
    errorBody: 'Bitte später erneut versuchen — besuchen Sie inzwischen die Kraftstoff-Statistikseite.',
    loading: 'Live-Preise laden…',
    link: 'Vollständigen Vergleich ansehen',
  },
  fr: {
    heading: 'Prix carburant en direct — stations-service suisses (SP95)',
    subtitle:
      'Top des stations-service en Suisse par prix (données TCS agrégées). Le diesel est historiquement d\'environ +CHF 0,20/litre par rapport à l\'essence.',
    note:
      'Les prix officiels du diesel ne sont pas publiés par station en Suisse ; ce tableau présente les prix SP95 comme indicateur de marché.',
    updated: 'Mis à jour',
    station: 'Station',
    brand: 'Marque',
    address: 'Adresse',
    price: 'SP95 CHF/L',
    errorTitle: 'Données en direct indisponibles',
    errorBody: 'Réessayez plus tard — entre-temps, consultez la page Statistiques carburants.',
    loading: 'Chargement des prix en direct…',
    link: 'Voir la comparaison complète',
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

function pickCheapestStations(dataset: FuelPricesDataset, maxRows: number): FuelStationSwitzerland[] {
  const ranked = dataset.rankings?.cheapestSwissStations ?? [];
  if (ranked.length > 0) return ranked.slice(0, maxRows);

  // Fallback: dedupe by id across all municipalities' nearbyStations.
  const seen = new Map<string, FuelStationSwitzerland>();
  for (const row of dataset.municipalities ?? []) {
    for (const station of row.swiss?.nearbyStations ?? []) {
      if (!seen.has(station.id)) {
        seen.set(station.id, station);
      }
    }
  }
  return Array.from(seen.values())
    .sort((a, b) => a.sp95PriceChf - b.sp95PriceChf)
    .slice(0, maxRows);
}

export default function InlineFuelPriceTable({ maxRows = 10 }: InlineFuelPriceTableProps) {
  const { t: _t } = useTranslation();
  // _t is intentionally pulled to keep the component wired into the i18n bootstrap.
  void _t;
  const [locale] = useLocale();
  const labels = LABELS[resolveLocale(locale)];

  const [dataset, setDataset] = useState<FuelPricesDataset | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');

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

  if (status === 'loading' && !dataset) {
    return (
      <div
        data-testid="inline-fuel-price-table-loading"
        className="mt-6 rounded-xl border border-edge bg-surface-alt/60 p-4 text-sm text-subtle"
      >
        <Fuel className="inline-block mr-2 align-text-bottom" size={16} aria-hidden="true" />
        {labels.loading}
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
          <AlertTriangle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="font-semibold">{labels.errorTitle}</p>
            <p className="text-subtle mt-1">{labels.errorBody}</p>
          </div>
        </div>
      </div>
    );
  }

  const stations = pickCheapestStations(dataset, maxRows);
  if (stations.length === 0) {
    return null;
  }

  return (
    <section
      data-testid="inline-fuel-price-table"
      aria-labelledby="inline-fuel-price-table-heading"
      className="mt-6 rounded-xl border border-edge bg-surface-alt/60 overflow-hidden"
    >
      <header className="p-4 sm:p-5 border-b border-edge">
        <h3
          id="inline-fuel-price-table-heading"
          className="text-lg font-bold font-display text-heading flex items-center gap-2"
        >
          <Fuel size={20} className="text-accent" aria-hidden="true" />
          {labels.heading}
        </h3>
        <p className="mt-2 text-sm text-subtle">{labels.subtitle}</p>
        <p className="mt-1 text-xs text-muted italic">{labels.note}</p>
        <p className="mt-2 text-xs text-muted inline-flex items-center gap-1">
          <Clock size={12} aria-hidden="true" />
          {labels.updated}: {formatUpdatedAt(dataset.generatedAt, locale)}
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="inline-fuel-price-table-body">
          <thead className="bg-surface/80 text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-3 py-2">#</th>
              <th scope="col" className="px-3 py-2">{labels.station}</th>
              <th scope="col" className="px-3 py-2 hidden sm:table-cell">{labels.brand}</th>
              <th scope="col" className="px-3 py-2 hidden md:table-cell">{labels.address}</th>
              <th scope="col" className="px-3 py-2 text-right">{labels.price}</th>
              <th scope="col" className="px-3 py-2 hidden lg:table-cell">{labels.updated}</th>
            </tr>
          </thead>
          <tbody>
            {stations.map((station, idx) => (
              <tr key={station.id} className="border-t border-edge/60">
                <td className="px-3 py-2 text-muted font-mono">{idx + 1}</td>
                <td className="px-3 py-2 font-semibold text-body">
                  {station.name}
                  {station.nearestMunicipality && (
                    <span className="ml-1 text-xs text-muted inline-flex items-center gap-0.5">
                      <MapPin size={10} aria-hidden="true" />
                      {station.nearestMunicipality}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-subtle hidden sm:table-cell">{station.brand || '—'}</td>
                <td className="px-3 py-2 text-subtle hidden md:table-cell">{station.address}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-strong">
                  {formatPriceChf(station.sp95PriceChf, locale)}
                </td>
                <td className="px-3 py-2 text-muted hidden lg:table-cell">
                  {formatUpdatedAt(station.updatedAt, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
