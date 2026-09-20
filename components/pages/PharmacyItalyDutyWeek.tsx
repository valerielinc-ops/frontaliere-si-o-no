import React from 'react';
import { ExternalLink } from 'lucide-react';
import {
  buildItalyDutyWeekModel,
  currentItalyDutyWeekStart,
  formatItalyDutyDateTime,
  type ItalyDutySourceRegistry,
  type ItalyDutyWeekModel,
} from '@/services/pharmacies/italyDuty';
import { pharmacyById, pharmacyCitySlug, provinceSlugForPharmacy } from '@/services/pharmacies/data';
import { buildPharmacyPath, type PharmacyPath } from '@/services/pharmacies/paths';
import type { Locale } from '@/services/i18n';
import type { ItalyDutySnapshot } from '@/services/pharmacies/italyRelease';

type ItalyDutyWeekCopy = {
  italy: string;
  title: (weekStart: string) => string;
  lede: string;
  coverage: string;
  partial: string;
  unavailable: string;
  week: string;
  fetched: string;
  interval: string;
  date: string;
  hours: string;
  pharmacy: string;
  source: string;
  openSource: string;
  published: string;
  notPublished: string;
  noIntervals: string;
  noOperationalData: string;
  verify: string;
  hub: string;
  swissDuty: string;
};

const COPY: Record<Locale, ItalyDutyWeekCopy> = {
  it: {
    italy: 'Italia · province di confine',
    title: (weekStart) => `Farmacie di turno in Italia: settimana del ${weekStart}`,
    lede: 'Calendario settimanale separato per Como, Varese e Verbano-Cusio-Ossola. Gli intervalli compaiono solo dopo i controlli del release ufficiale italiano.',
    coverage: 'Release italiano completo, fresco e pubblicabile: gli intervalli verificati sono mostrati per tutte e tre le province.',
    partial: 'Release italiano parziale: mostriamo solo le province con dati verificati; la pagina resta fuori indice finché il calendario non è completo.',
    unavailable: 'I turni italiani non sono pubblicabili in questa versione.',
    week: 'Settimana',
    fetched: 'Ultimo recupero',
    interval: 'Intervallo',
    date: 'Data',
    hours: 'Orario',
    pharmacy: 'Farmacia',
    source: 'Fonte ufficiale',
    openSource: 'Apri fonte ufficiale',
    published: 'Release italiano pubblicato',
    notPublished: 'Release italiano non pubblicabile',
    noIntervals: 'Nessun intervallo verificato per questa provincia nella settimana selezionata.',
    noOperationalData: 'Non mostriamo farmacie, intervalli, timestamp o badge operativi finché il release non supera tutti i controlli.',
    verify: 'Turni e orari possono cambiare. Chiama sempre la farmacia o controlla la fonte ufficiale prima di partire, soprattutto in caso di urgenza.',
    hub: 'Tutti i turni italiani',
    swissDuty: 'Turni in Ticino',
  },
  en: {
    italy: 'Italy · border provinces',
    title: (weekStart) => `On-duty pharmacies in Italy: week of ${weekStart}`,
    lede: 'Weekly schedule separated into Como, Varese and Verbano-Cusio-Ossola. Intervals appear only after the Italian official release passes every check.',
    coverage: 'Complete, fresh and publishable Italian release: verified intervals are shown for all three provinces.',
    partial: 'Partial Italian release: only provinces with verified data are shown; the page remains out of the index until the calendar is complete.',
    unavailable: 'Italian duties are not publishable in this release.',
    week: 'Week',
    fetched: 'Last retrieved',
    interval: 'Interval',
    date: 'Date',
    hours: 'Hours',
    pharmacy: 'Pharmacy',
    source: 'Official source',
    openSource: 'Open official source',
    published: 'Published Italian release',
    notPublished: 'Italian release not publishable',
    noIntervals: 'No verified interval for this province in the selected week.',
    noOperationalData: 'Pharmacies, intervals, timestamps and operational badges remain hidden until every release check passes.',
    verify: 'Duties and opening hours can change. Always call the pharmacy or check the official source before travelling, especially in an emergency.',
    hub: 'All Italian duties',
    swissDuty: 'Duties in Ticino',
  },
  de: {
    italy: 'Italien · Grenzprovinzen',
    title: (weekStart) => `Notdienst-Apotheken in Italien: Woche ab ${weekStart}`,
    lede: 'Wochenplan getrennt für Como, Varese und Verbano-Cusio-Ossola. Zeiträume erscheinen erst, wenn der offizielle italienische Release alle Prüfungen besteht.',
    coverage: 'Vollständiger, frischer und veröffentlichbarer italienischer Release: Verifizierte Zeiträume werden für alle drei Provinzen angezeigt.',
    partial: 'Teilweiser italienischer Release: Nur Provinzen mit verifizierten Daten werden angezeigt; die Seite bleibt bis zur Vollständigkeit aus dem Index.',
    unavailable: 'Italienische Notdienste sind in diesem Release nicht veröffentlichbar.',
    week: 'Woche',
    fetched: 'Letzter Abruf',
    interval: 'Zeitraum',
    date: 'Datum',
    hours: 'Uhrzeit',
    pharmacy: 'Apotheke',
    source: 'Offizielle Quelle',
    openSource: 'Offizielle Quelle öffnen',
    published: 'Italienischer Release veröffentlicht',
    notPublished: 'Italienischer Release nicht veröffentlichbar',
    noIntervals: 'Kein verifizierter Zeitraum für diese Provinz in der ausgewählten Woche.',
    noOperationalData: 'Apotheken, Zeiträume, Zeitstempel und operative Kennzeichen bleiben verborgen, bis alle Release-Prüfungen bestanden sind.',
    verify: 'Notdienste und Öffnungszeiten können sich ändern. Vor der Fahrt immer telefonisch oder bei der offiziellen Quelle prüfen, besonders im Notfall.',
    hub: 'Alle italienischen Notdienste',
    swissDuty: 'Notdienste im Tessin',
  },
  fr: {
    italy: 'Italie · provinces frontalières',
    title: (weekStart) => `Pharmacies de garde en Italie : semaine du ${weekStart}`,
    lede: 'Planning hebdomadaire séparé pour Côme, Varèse et Verbano-Cusio-Ossola. Les intervalles apparaissent seulement après validation complète du release officiel italien.',
    coverage: 'Release italien complet, frais et publiable : les intervalles vérifiés sont affichés pour les trois provinces.',
    partial: 'Release italien partiel : seules les provinces avec des données vérifiées sont affichées ; la page reste hors index jusqu’à la complétude du calendrier.',
    unavailable: 'Les gardes italiennes ne sont pas publiables dans ce release.',
    week: 'Semaine',
    fetched: 'Dernière collecte',
    interval: 'Intervalle',
    date: 'Date',
    hours: 'Horaires',
    pharmacy: 'Pharmacie',
    source: 'Source officielle',
    openSource: 'Ouvrir la source officielle',
    published: 'Release italien publié',
    notPublished: 'Release italien non publiable',
    noIntervals: 'Aucun intervalle vérifié pour cette province pendant la semaine sélectionnée.',
    noOperationalData: 'Les pharmacies, intervalles, horodatages et badges opérationnels restent masqués tant que tous les contrôles ne sont pas passés.',
    verify: 'Les gardes et les horaires peuvent changer. Appelez toujours la pharmacie ou consultez la source officielle avant de partir, surtout en cas d’urgence.',
    hub: 'Toutes les gardes italiennes',
    swissDuty: 'Gardes au Tessin',
  },
};

function formatWeekRange(model: ItalyDutyWeekModel, locale: Locale): string {
  if (!model.weekEnd) return model.weekStart;
  const end = new Date(`${model.weekEnd}T12:00:00.000Z`);
  if (!Number.isFinite(end.getTime())) return `${model.weekStart} – ${model.weekEnd}`;
  const formatted = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : locale, {
    dateStyle: 'medium',
    timeZone: 'Europe/Rome',
  }).format(end);
  return `${model.weekStart} – ${formatted}`;
}

function detailPath(pharmacyId: string, locale: Locale): PharmacyPath | null {
  const pharmacy = pharmacyById(pharmacyId);
  const areaSlug = pharmacy ? provinceSlugForPharmacy(pharmacy) : undefined;
  return pharmacy?.country === 'IT' && areaSlug
    ? {
      kind: 'pharmacy',
      country: 'IT',
      areaSlug,
      citySlug: pharmacyCitySlug(pharmacy.city),
      pharmacySlug: pharmacy.slug,
      locale,
    }
    : null;
}

export interface PharmacyItalyDutyWeekProps {
  page: PharmacyPath;
  now?: Date;
  duties?: ItalyDutySnapshot;
  status?: ItalyDutySnapshot;
  sources?: ItalyDutySourceRegistry;
}

export default function PharmacyItalyDutyWeek({ page, now, duties, status, sources }: PharmacyItalyDutyWeekProps) {
  const locale = page.locale;
  const copy = COPY[locale];
  const model = buildItalyDutyWeekModel({
    now,
    weekStart: page.weekStart || currentItalyDutyWeekStart(now),
    duties,
    status,
    sources,
  });
  const hubPath = buildPharmacyPath({ kind: 'italy-duty-hub', country: 'IT', locale }, locale);
  const swissDutyPath = buildPharmacyPath({ kind: 'duty-hub', locale }, locale);

  return <div className="mx-auto max-w-6xl space-y-8" data-italy-duty-week="true" data-italy-release-state={model.state} data-italy-publishable={String(model.publishable)} data-italy-indexable={String(model.indexable)}>
    <header className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{copy.italy}</p>
      <h1 className="font-display text-3xl font-bold tracking-tight text-heading sm:text-4xl">{copy.title(model.weekStart)}</h1>
      <p className="max-w-3xl text-base leading-7 text-muted">{copy.lede}</p>
      <p className="text-sm leading-6 text-body"><strong>{copy.week}:</strong> {formatWeekRange(model, locale)}</p>
      {model.indexable
        ? <p className="rounded-xl border border-success-border bg-success-subtle p-4 text-sm leading-6 text-success" role="status">{copy.coverage}</p>
        : model.publishable
          ? <aside className="rounded-xl border border-warning-border bg-warning-subtle p-4 text-sm leading-6 text-warning" role="status"><strong>{copy.partial}</strong><p className="mt-1">{model.reason}</p></aside>
          : <aside className="rounded-xl border border-warning-border bg-warning-subtle p-4 text-sm leading-6 text-warning" role="status"><strong>{copy.unavailable}</strong><p className="mt-1">{model.reason}</p><p className="mt-1">{copy.noOperationalData}</p></aside>}
      <nav className="flex flex-wrap gap-2 pt-2" aria-label={copy.italy}>
        <a className="inline-flex min-h-11 items-center rounded-full border border-accent/40 bg-accent-subtle px-4 py-2 text-sm font-semibold text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={hubPath}>{copy.hub}</a>
        <a className="inline-flex min-h-11 items-center rounded-full border border-edge bg-surface px-4 py-2 text-sm text-body hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={swissDutyPath}>{copy.swissDuty}</a>
      </nav>
    </header>

    <div className="grid gap-5 md:grid-cols-2">
      {model.provinces.map((province) => <section key={province.code} className="rounded-2xl border border-edge bg-surface p-5 shadow-sm" data-italy-duty-province={province.code} {...(province.publishable ? { 'data-italy-duty-published': 'true' } : {})}>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-bold text-heading">{province.name}</h2>
            <p className={`text-xs font-semibold uppercase tracking-wide ${province.publishable ? 'text-success' : 'text-warning'}`}>{province.publishable ? copy.published : copy.notPublished}</p>
          </div>
          {province.sourceUrl && <a className="inline-flex items-center gap-1 text-sm font-semibold text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={province.sourceUrl} rel="nofollow noopener">{copy.openSource}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></a>}
        </header>
        {province.publishable && province.duties.length > 0
          ? <div className="mt-4 space-y-3"><p className="text-xs text-muted"><strong>{copy.fetched}:</strong> {province.fetchedAt ? <time dateTime={province.fetchedAt}>{province.fetchedAt}</time> : '—'}</p><div className="overflow-x-auto"><table className="w-full min-w-[34rem] border-collapse text-left text-sm leading-6 text-body"><thead className="border-y border-edge text-xs uppercase tracking-wide text-muted"><tr><th className="py-2 pr-3 font-semibold">{copy.date}</th><th className="py-2 pr-3 font-semibold">{copy.hours}</th><th className="py-2 pr-3 font-semibold">{copy.pharmacy}</th><th className="py-2 font-semibold">{copy.source}</th></tr></thead><tbody>{province.duties.map((duty) => {
            const pharmacy = pharmacyById(duty.pharmacyId);
            const path = detailPath(duty.pharmacyId, locale);
            return <tr key={duty.id} className="border-b border-edge align-top" data-duty-id={duty.id} data-duty-country="IT"><td className="py-3 pr-3 whitespace-nowrap">{formatItalyDutyDateTime(duty.startsAt).slice(0, 10)}</td><td className="py-3 pr-3 whitespace-nowrap"><time dateTime={duty.startsAt}>{formatItalyDutyDateTime(duty.startsAt).slice(11)}</time> – <time dateTime={duty.endsAt}>{formatItalyDutyDateTime(duty.endsAt)}</time></td><td className="py-3 pr-3 font-semibold text-heading">{pharmacy && path ? <a className="text-link underline" href={buildPharmacyPath(path, locale)}>{pharmacy.name}</a> : duty.pharmacyId}</td><td className="py-3"><a className="inline-flex items-center gap-1 text-link underline" href={province.sourceUrl || duty.sourceUrl} rel="nofollow noopener">{copy.source}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></a></td></tr>;
          })}</tbody></table></div></div>
          : <p className="mt-4 rounded-xl border border-edge bg-surface-alt p-4 text-sm text-muted">{province.publishable ? copy.noIntervals : copy.noOperationalData}</p>}
      </section>)}
    </div>

    <aside className="rounded-2xl border border-accent/30 bg-accent-subtle p-5 text-sm leading-6 text-body"><strong className="text-heading">{copy.source}</strong><p className="mt-2 text-muted">{copy.verify}</p></aside>
  </div>;
}
