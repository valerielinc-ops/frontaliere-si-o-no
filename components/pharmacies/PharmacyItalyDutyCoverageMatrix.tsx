import React from 'react';
import { ExternalLink } from 'lucide-react';
import {
  buildItalyDutyWeekModel,
  currentItalyDutyWeekStart,
  formatItalyDutyDateTime,
  type ItalyDutySourceRegistry,
} from '@/services/pharmacies/italyDuty';
import { pharmacyById, pharmacyCitySlug, provinceSlugForPharmacy } from '@/services/pharmacies/data';
import { buildPharmacyPath, type PharmacyPath } from '@/services/pharmacies/paths';
import type { Locale } from '@/services/i18n';
import type { ItalyDutySnapshot } from '@/services/pharmacies/italyRelease';

type Copy = {
  eyebrow: string;
  title: string;
  lede: string;
  coverageHeading: string;
  weekLink: string;
  ready: string;
  partial: string;
  unavailable: string;
  sourceOnlyHeading: string;
  sourceOnlyLede: string;
  sourceOnlyLabel: string;
  status: string;
  freshness: string;
  coverage: string;
  fetched: string;
  date: string;
  hours: string;
  pharmacy: string;
  source: string;
  sourceLink: string;
  noIntervals: string;
  verifyHeading: string;
  verify: string;
  state: (value: string) => string;
  freshnessState: (value: string) => string;
  coverageState: (value: string) => string;
};

const LABELS: Record<Locale, Record<string, string>> = {
  it: {
    fresh: 'fresca', stale: 'scaduta', partial: 'parziale', not_published: 'non pubblicata', conflicting: 'in conflitto', unknown: 'sconosciuta',
    covered: 'completa', not_published_coverage: 'non pubblicata', partial_coverage: 'parziale', unknown_coverage: 'non verificabile',
  },
  en: {
    fresh: 'fresh', stale: 'stale', partial: 'partial', not_published: 'not published', conflicting: 'conflicting', unknown: 'unknown',
    covered: 'complete', not_published_coverage: 'not published', partial_coverage: 'partial', unknown_coverage: 'unknown',
  },
  de: {
    fresh: 'aktuell', stale: 'veraltet', partial: 'unvollständig', not_published: 'nicht veröffentlicht', conflicting: 'widersprüchlich', unknown: 'unbekannt',
    covered: 'vollständig', not_published_coverage: 'nicht veröffentlicht', partial_coverage: 'unvollständig', unknown_coverage: 'unbekannt',
  },
  fr: {
    fresh: 'récente', stale: 'obsolète', partial: 'partielle', not_published: 'non publiée', conflicting: 'contradictoire', unknown: 'inconnue',
    covered: 'complète', not_published_coverage: 'non publiée', partial_coverage: 'partielle', unknown_coverage: 'non vérifiable',
  },
};

const COPY: Record<Locale, Copy> = {
  it: {
    eyebrow: 'Italia · province di confine',
    title: 'Farmacie di turno in Como, Varese e VCO',
    lede: 'Calendario provinciale italiano con intervalli verificati in Europe/Rome. Le righe operative compaiono solo dopo i controlli del release ufficiale.',
    coverageHeading: 'Copertura provinciale',
    weekLink: 'Apri il calendario settimanale',
    ready: 'Release completo e fresco: sono mostrati gli intervalli verificati della settimana corrente.',
    partial: 'Release parziale: mostriamo solo le province con dati verificati e teniamo la pagina fuori indice.',
    unavailable: 'I turni operativi restano nascosti: il release italiano non è completo e fresco.',
    sourceOnlyHeading: 'Fonti provinciali · solo fonte',
    sourceOnlyLede: 'Per le province non pubblicabili mostriamo soltanto stato, freschezza, copertura, ultimo recupero e fonte ufficiale. Non pubblichiamo farmacie, date o orari.',
    sourceOnlyLabel: 'Solo fonte', status: 'Stato release', freshness: 'Aggiornamento fonte', coverage: 'Copertura calendario', fetched: 'Ultimo recupero',
    date: 'Data', hours: 'Orario', pharmacy: 'Farmacia', source: 'Fonte ufficiale', sourceLink: 'Apri fonte ufficiale',
    noIntervals: 'Nessun intervallo verificato per questa provincia nella settimana corrente.', verifyHeading: 'Verifica prima di partire',
    verify: 'Turni e orari possono cambiare. Chiama sempre la farmacia o controlla la fonte ufficiale prima di partire, soprattutto in caso di urgenza.',
    state: (value) => LABELS.it[value] || 'non verificabile', freshnessState: (value) => LABELS.it[value] || 'non verificabile', coverageState: (value) => LABELS.it[`${value}_coverage`] || 'non verificabile',
  },
  en: {
    eyebrow: 'Italy · border provinces',
    title: 'On-duty pharmacies in Como, Varese and VCO',
    lede: 'Italian provincial schedule with verified Europe/Rome intervals. Operational rows appear only after the official release passes its checks.',
    coverageHeading: 'Provincial coverage', weekLink: 'Open the weekly schedule',
    ready: 'Complete and fresh release: verified intervals for the current week are shown.',
    partial: 'Partial release: only provinces with verified data are shown and the page remains out of the index.',
    unavailable: 'Operational duties stay hidden: the Italian release is not complete and fresh.',
    sourceOnlyHeading: 'Provincial sources · source only',
    sourceOnlyLede: 'For unpublished provinces we show only status, freshness, coverage, last retrieval and the official source. No pharmacies, dates or hours are published.',
    sourceOnlyLabel: 'Source only', status: 'Release status', freshness: 'Source freshness', coverage: 'Calendar coverage', fetched: 'Last retrieved',
    date: 'Date', hours: 'Hours', pharmacy: 'Pharmacy', source: 'Official source', sourceLink: 'Open official source',
    noIntervals: 'No verified interval is available for this province in the current week.', verifyHeading: 'Check before travelling',
    verify: 'Duties and hours can change. Always call the pharmacy or check the official source before travelling, especially in an emergency.',
    state: (value) => LABELS.en[value] || 'unknown', freshnessState: (value) => LABELS.en[value] || 'unknown', coverageState: (value) => LABELS.en[`${value}_coverage`] || 'unknown',
  },
  de: {
    eyebrow: 'Italien · Grenzprovinzen',
    title: 'Notdienst-Apotheken in Como, Varese und VCO',
    lede: 'Italienischer Provinzkalender mit verifizierten Zeiträumen in Europe/Rome. Operative Zeilen erscheinen erst nach den Prüfungen des offiziellen Releases.',
    coverageHeading: 'Provinzielle Abdeckung', weekLink: 'Wochenplan öffnen',
    ready: 'Vollständiger und aktueller Release: Verifizierte Zeiträume der laufenden Woche werden angezeigt.',
    partial: 'Teilweiser Release: Nur Provinzen mit verifizierten Daten werden angezeigt; die Seite bleibt aus dem Index.',
    unavailable: 'Operative Notdienste bleiben verborgen: Der italienische Release ist nicht vollständig und aktuell.',
    sourceOnlyHeading: 'Provinzielle Quellen · nur Quelle',
    sourceOnlyLede: 'Für nicht veröffentlichbare Provinzen zeigen wir nur Status, Aktualität, Abdeckung, letzten Abruf und die offizielle Quelle. Keine Apotheken, Daten oder Uhrzeiten werden veröffentlicht.',
    sourceOnlyLabel: 'Nur Quelle', status: 'Release-Status', freshness: 'Aktualität der Quelle', coverage: 'Kalenderabdeckung', fetched: 'Letzter Abruf',
    date: 'Datum', hours: 'Uhrzeit', pharmacy: 'Apotheke', source: 'Offizielle Quelle', sourceLink: 'Offizielle Quelle öffnen',
    noIntervals: 'Kein verifizierter Zeitraum für diese Provinz in der laufenden Woche.', verifyHeading: 'Vor der Fahrt prüfen',
    verify: 'Notdienste und Öffnungszeiten können sich ändern. Vor der Fahrt immer telefonisch oder bei der offiziellen Quelle prüfen, besonders im Notfall.',
    state: (value) => LABELS.de[value] || 'unbekannt', freshnessState: (value) => LABELS.de[value] || 'unbekannt', coverageState: (value) => LABELS.de[`${value}_coverage`] || 'unbekannt',
  },
  fr: {
    eyebrow: 'Italie · provinces frontalières',
    title: 'Pharmacies de garde à Côme, Varèse et VCO',
    lede: 'Calendrier provincial italien avec intervalles vérifiés en Europe/Rome. Les lignes opérationnelles apparaissent seulement après les contrôles du release officiel.',
    coverageHeading: 'Couverture provinciale', weekLink: 'Ouvrir le planning hebdomadaire',
    ready: 'Release complet et récent : les intervalles vérifiés de la semaine courante sont affichés.',
    partial: 'Release partiel : seules les provinces avec des données vérifiées sont affichées et la page reste hors index.',
    unavailable: 'Les gardes opérationnelles restent masquées : le release italien n’est pas complet et récent.',
    sourceOnlyHeading: 'Sources provinciales · source uniquement',
    sourceOnlyLede: 'Pour les provinces non publiables, nous affichons uniquement le statut, la fraîcheur, la couverture, la dernière collecte et la source officielle. Aucune pharmacie, date ou heure n’est publiée.',
    sourceOnlyLabel: 'Source uniquement', status: 'Statut du release', freshness: 'Fraîcheur de la source', coverage: 'Couverture du calendrier', fetched: 'Dernière collecte',
    date: 'Date', hours: 'Horaires', pharmacy: 'Pharmacie', source: 'Source officielle', sourceLink: 'Ouvrir la source officielle',
    noIntervals: 'Aucun intervalle vérifié pour cette province pendant la semaine courante.', verifyHeading: 'Vérifiez avant de partir',
    verify: 'Les gardes et les horaires peuvent changer. Appelez toujours la pharmacie ou consultez la source officielle avant de partir, surtout en cas d’urgence.',
    state: (value) => LABELS.fr[value] || 'inconnue', freshnessState: (value) => LABELS.fr[value] || 'inconnue', coverageState: (value) => LABELS.fr[`${value}_coverage`] || 'non vérifiable',
  },
};

function sourceLink(url: string | null, label: string): React.ReactNode {
  return url
    ? <a className="inline-flex items-center gap-1 text-link underline" href={url} rel="nofollow noopener">{label}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></a>
    : <span>{label}</span>;
}

function detailPath(pharmacyId: string, locale: Locale): PharmacyPath | null {
  const pharmacy = pharmacyById(pharmacyId);
  const areaSlug = pharmacy ? provinceSlugForPharmacy(pharmacy) : undefined;
  return pharmacy?.country === 'IT' && areaSlug
    ? { kind: 'pharmacy', country: 'IT', areaSlug, citySlug: pharmacyCitySlug(pharmacy.city), pharmacySlug: pharmacy.slug, locale }
    : null;
}

export interface PharmacyItalyDutyCoverageMatrixProps {
  locale: Locale;
  now?: Date;
  duties?: ItalyDutySnapshot;
  status?: ItalyDutySnapshot;
  sources?: ItalyDutySourceRegistry;
  pharmacyIds?: ReadonlySet<string>;
}

export default function PharmacyItalyDutyCoverageMatrix({ locale, now, duties, status, sources, pharmacyIds }: PharmacyItalyDutyCoverageMatrixProps) {
  const copy = COPY[locale];
  const resolvedNow = now ?? new Date();
  const model = buildItalyDutyWeekModel({
    now: resolvedNow,
    weekStart: currentItalyDutyWeekStart(resolvedNow),
    duties,
    status,
    sources,
    pharmacyIds,
  });
  const weekPath: PharmacyPath = { kind: 'duty-week', country: 'IT', locale, weekStart: model.weekStart };
  const sourceOnlyCodes = new Set(model.provinces.filter((province) => !province.publishable).map((province) => province.code));

  return <div className="mx-auto max-w-6xl space-y-8" data-italy-duty-coverage="true" data-release-ready={String(model.publishable)} data-week-ready={String(model.indexable)} data-italy-release-state={model.state} data-italy-publishable={String(model.publishable)} data-italy-indexable={String(model.indexable)}>
    <header className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{copy.eyebrow}</p>
      <h1 className="font-display text-3xl font-bold tracking-tight text-heading sm:text-4xl">{copy.title}</h1>
      <p className="max-w-3xl text-base leading-7 text-muted">{copy.lede}</p>
      <p><a className="inline-flex min-h-11 items-center rounded-full border border-accent/40 bg-accent-subtle px-4 py-2 text-sm font-semibold text-link hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={buildPharmacyPath(weekPath, locale)}>{copy.weekLink}</a></p>
      {model.indexable
        ? <p className="rounded-xl border border-success-border bg-success-subtle p-4 text-sm leading-6 text-success" role="status">{copy.ready}</p>
        : model.publishable
          ? <aside className="rounded-xl border border-warning-border bg-warning-subtle p-4 text-sm leading-6 text-warning" role="status"><strong>{copy.partial}</strong><p className="mt-1">{model.reason}</p></aside>
          : <aside className="rounded-xl border border-warning-border bg-warning-subtle p-4 text-sm leading-6 text-warning" role="status"><strong>{copy.unavailable}</strong><p className="mt-1">{model.reason}</p></aside>}
    </header>

    <section className="space-y-4" aria-labelledby="italy-duty-matrix-heading">
      <h2 id="italy-duty-matrix-heading" className="font-display text-2xl font-bold text-heading">{copy.coverageHeading}</h2>
      <div className="grid gap-5 md:grid-cols-3">
        {model.provinces.map((province) => <section key={province.code} className="rounded-2xl border border-edge bg-surface p-5 shadow-sm" data-coverage-kind="italy-province" data-province-code={province.code} data-italy-duty-published={province.publishable ? 'true' : undefined}>
          <h3 className="font-display text-xl font-bold text-heading">{province.name}</h3>
          {province.publishable && province.duties.length > 0
            ? <div className="mt-4 space-y-3">{province.duties.map((duty) => {
              const pharmacy = pharmacyById(duty.pharmacyId);
              const path = detailPath(duty.pharmacyId, locale);
              if (!pharmacy || !path) return null;
              return <article key={duty.id} className="border-t border-edge pt-3 text-sm leading-6 text-body" data-duty-id={duty.id} data-duty-country="IT"><strong className="text-heading"><a className="text-link underline" href={buildPharmacyPath(path, locale)}>{pharmacy.name}</a></strong><br /><time dateTime={duty.startsAt}>{formatItalyDutyDateTime(duty.startsAt)}</time> – <time dateTime={duty.endsAt}>{formatItalyDutyDateTime(duty.endsAt)}</time><br />{sourceLink(province.sourceUrl || duty.sourceUrl, copy.source)}</article>;
            })}</div>
            : <p className="mt-4 rounded-xl border border-edge bg-surface-alt p-4 text-sm text-muted">{copy.noIntervals}</p>}
        </section>)}
      </div>
    </section>

    <section className="space-y-4" aria-labelledby="italy-duty-source-only-heading">
      <h2 id="italy-duty-source-only-heading" className="font-display text-2xl font-bold text-heading">{copy.sourceOnlyHeading}</h2>
      <p className="max-w-3xl text-sm leading-6 text-muted">{copy.sourceOnlyLede}</p>
      <div className="grid gap-4 md:grid-cols-3">
        {model.sourceOnly.filter((province) => sourceOnlyCodes.has(province.code)).map((province) => <article key={province.code} className="rounded-2xl border border-edge bg-surface p-5" data-source-only-province={province.code}>
          <h3 className="font-display text-lg font-bold text-heading">{province.name}</h3>
          <p className="mt-2 text-sm font-semibold text-accent">{copy.sourceOnlyLabel}</p>
          <dl className="mt-3 space-y-2 text-sm leading-6 text-body"><div><dt className="font-semibold">{copy.status}</dt><dd>{copy.state(province.state)}</dd></div><div><dt className="font-semibold">{copy.freshness}</dt><dd>{copy.freshnessState(province.freshness)}</dd></div><div><dt className="font-semibold">{copy.coverage}</dt><dd>{copy.coverageState(province.coverage)}</dd></div><div><dt className="font-semibold">{copy.fetched}</dt><dd>{province.fetchedAt || '—'}</dd></div><div><dt className="font-semibold">{copy.source}</dt><dd>{sourceLink(province.sourceUrl, copy.sourceLink)}</dd></div></dl>
        </article>)}
      </div>
    </section>

    <aside className="rounded-2xl border border-accent/30 bg-accent-subtle p-5 text-sm leading-6 text-body"><strong className="text-heading">{copy.verifyHeading}</strong><p className="mt-2 text-muted">{copy.verify}</p></aside>
  </div>;
}
