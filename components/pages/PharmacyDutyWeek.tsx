import React from 'react';
import { ExternalLink } from 'lucide-react';
import {
  buildDutyWeekModel,
  currentDutyWeekStart,
  formatDutyDateTime,
} from '@/services/pharmacies/dutyWeek';
import {
  pharmacyById,
  pharmacyCitySlug,
} from '@/services/pharmacies/data';
import { buildPharmacyPath, type PharmacyPath } from '@/services/pharmacies/paths';
import type { Locale } from '@/services/i18n';
import type { Pharmacy, PharmacyCatalogueDataset, PharmacyDutiesDataset } from '@/services/pharmacies/types';
import dutiesJson from '@/data/pharmacy-duties-ticino.json';
import completeTicinoJson from '@/data/pharmacies-ticino-complete.json';

const DUTIES = dutiesJson as PharmacyDutiesDataset;
const COMPLETE_TICINO = completeTicinoJson as unknown as PharmacyCatalogueDataset;
const DUTY_SOURCE = 'https://www.ofct.ch/farmacieturno/';

type DutyWeekCopy = {
  title: (weekStart: string) => string;
  lede: string;
  coverage: string;
  unavailable: string;
  source: string;
  fetched: string;
  interval: string;
  date: string;
  hours: string;
  pharmacy: string;
  verify: string;
  swiss: string;
};

const COPY: Record<Locale, DutyWeekCopy> = {
  it: {
    title: (weekStart) => `Farmacie di turno in Ticino: settimana del ${weekStart}`,
    lede: 'Calendario settimanale delle aree ticinesi con intervalli verificati. Non è una copertura di tutti i cantoni né delle farmacie italiane di confine.',
    coverage: 'Questa edizione copre cinque regioni ticinesi: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli e Locarnese.',
    unavailable: 'Questa settimana non supera il controllo di pubblicazione: il contenuto resta visibile per trasparenza ma non è una fonte valida per un turno attivo.',
    source: 'Fonte verificata',
    fetched: 'Ultimo recupero',
    interval: 'Intervallo',
    date: 'Data',
    hours: 'Orario',
    pharmacy: 'Farmacia',
    verify: 'Turni e orari possono cambiare. Chiama sempre la farmacia o controlla la fonte ufficiale prima di partire, soprattutto in caso di urgenza.',
    swiss: 'Svizzera · Ticino',
  },
  en: {
    title: (weekStart) => `On-duty pharmacies in Ticino: week of ${weekStart}`,
    lede: 'Weekly schedule for Ticino areas with verified intervals only. This is not coverage for every Swiss canton or for Italian border pharmacies.',
    coverage: 'This edition covers five Ticino regions: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli and Locarnese.',
    unavailable: 'This week did not pass the publication check: it remains visible for transparency but is not a valid source for an active duty.',
    source: 'Verified source',
    fetched: 'Last retrieved',
    interval: 'Interval',
    date: 'Date',
    hours: 'Hours',
    pharmacy: 'Pharmacy',
    verify: 'Duties and opening hours can change. Always call the pharmacy or check the official source before travelling, especially in an emergency.',
    swiss: 'Switzerland · Ticino',
  },
  de: {
    title: (weekStart) => `Notdienst-Apotheken im Tessin: Woche ab ${weekStart}`,
    lede: 'Wochenplan nur für Tessiner Gebiete mit verifizierten Zeiträumen. Dies ist keine Abdeckung aller Schweizer Kantone oder der italienischen Grenzapotheken.',
    coverage: 'Diese Ausgabe deckt fünf Tessiner Regionen ab: Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli und Locarnese.',
    unavailable: 'Diese Woche hat die Veröffentlichungskontrolle nicht bestanden: Sie bleibt aus Transparenzgründen sichtbar, ist aber keine gültige Quelle für einen aktiven Notdienst.',
    source: 'Verifizierte Quelle',
    fetched: 'Letzter Abruf',
    interval: 'Zeitraum',
    date: 'Datum',
    hours: 'Uhrzeit',
    pharmacy: 'Apotheke',
    verify: 'Notdienste und Öffnungszeiten können sich ändern. Vor der Fahrt immer telefonisch oder bei der offiziellen Quelle prüfen, besonders im Notfall.',
    swiss: 'Schweiz · Tessin',
  },
  fr: {
    title: (weekStart) => `Pharmacies de garde au Tessin : semaine du ${weekStart}`,
    lede: 'Planning hebdomadaire limité aux zones tessinoises dont les intervalles sont vérifiés. Il ne couvre pas tous les cantons suisses ni les pharmacies italiennes de la frontière.',
    coverage: 'Cette édition couvre cinq régions tessinoises : Mendrisiotto, Luganese, Bellinzonese, Biasca e Valli et Locarnese.',
    unavailable: 'Cette semaine n’a pas passé le contrôle de publication : elle reste visible par transparence mais ne constitue pas une source valide pour une garde active.',
    source: 'Source vérifiée',
    fetched: 'Dernière collecte',
    interval: 'Intervalle',
    date: 'Date',
    hours: 'Horaires',
    pharmacy: 'Pharmacie',
    verify: 'Les gardes et les horaires peuvent changer. Appelez toujours la pharmacie ou consultez la source officielle avant de partir, surtout en cas d’urgence.',
    swiss: 'Suisse · Tessin',
  },
};

function formatDate(iso: string | null, locale: Locale): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Zurich',
  }).format(date);
}

function detailPath(pharmacy: Pharmacy, locale: Locale): PharmacyPath {
  return {
    kind: 'pharmacy',
    locale,
    country: 'CH',
    citySlug: pharmacyCitySlug(pharmacy.city),
    pharmacySlug: pharmacy.slug,
  };
}

function dutyWeekRange(weekStart: string, weekEnd: string, locale: Locale): string {
  if (!weekEnd) return weekStart;
  const end = new Date(`${weekEnd}T00:00:00+01:00`);
  if (!Number.isFinite(end.getTime())) return `${weekStart} – ${weekEnd}`;
  return `${weekStart} – ${new Intl.DateTimeFormat(locale === 'it' ? 'it-CH' : locale, { dateStyle: 'medium', timeZone: 'Europe/Zurich' }).format(end)}`;
}

export default function PharmacyDutyWeek({ page }: { page: PharmacyPath }) {
  const locale = page.locale;
  const copy = COPY[locale];
  const weekStart = page.weekStart || currentDutyWeekStart();
  const model = buildDutyWeekModel(DUTIES, weekStart, {
    catalogue: COMPLETE_TICINO,
  });

  return <div className="mx-auto max-w-6xl space-y-8">
    <header className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">{copy.swiss}</p>
      <h1 className="font-display text-3xl font-bold tracking-tight text-heading sm:text-4xl">{copy.title(model.weekStart)}</h1>
      <p className="max-w-3xl text-base leading-7 text-muted">{copy.lede}</p>
      <p className="text-sm leading-6 text-body"><strong>{copy.interval}:</strong> {dutyWeekRange(model.weekStart, model.weekEnd, locale)}<br /><strong>{copy.fetched}:</strong> {formatDate(model.fetchedAt, locale)}<br /><strong>{copy.source}:</strong> <a className="text-link underline" href={model.sourceUrl || DUTY_SOURCE} rel="nofollow noopener">{model.sourceUrl || DUTY_SOURCE}</a></p>
      {model.indexable ? <p className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm leading-6 text-emerald-900" role="status">{copy.coverage}</p> : <aside className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950" role="status"><strong>{copy.unavailable}</strong><p className="mt-1">{model.reason}</p></aside>}
    </header>

    <div className="grid gap-5 md:grid-cols-2">
      {model.regions.map((region) => <section key={region.key} className="rounded-2xl border border-edge bg-surface p-5 shadow-sm" aria-labelledby={`duty-week-${region.key}`}>
        <h2 id={`duty-week-${region.key}`} className="font-display text-xl font-bold text-heading">{region.name}</h2>
        {model.indexable && region.duties.length > 0 ? <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[34rem] border-collapse text-left text-sm leading-6 text-body"><thead className="border-y border-edge text-xs uppercase tracking-wide text-muted"><tr><th className="py-2 pr-3 font-semibold">{copy.date}</th><th className="py-2 pr-3 font-semibold">{copy.hours}</th><th className="py-2 pr-3 font-semibold">{copy.pharmacy}</th><th className="py-2 font-semibold">{copy.source}</th></tr></thead><tbody>{region.duties.map((duty) => {
          const pharmacy = pharmacyById(duty.pharmacyId);
          const startsAt = formatDutyDateTime(duty.startsAt);
          const endsAt = formatDutyDateTime(duty.endsAt);
          return <tr key={duty.id} className="border-b border-edge align-top"><td className="py-3 pr-3 whitespace-nowrap">{startsAt.slice(0, 10)}</td><td className="py-3 pr-3 whitespace-nowrap">{startsAt.slice(11)} – {endsAt}</td><td className="py-3 pr-3 font-semibold text-heading">{pharmacy ? <a className="text-link underline" href={buildPharmacyPath(detailPath(pharmacy, locale), locale)}>{pharmacy.name}</a> : duty.pharmacyId}</td><td className="py-3"><a className="inline-flex items-center gap-1 text-link underline" href={duty.sourceUrl || DUTY_SOURCE} rel="nofollow noopener">{copy.source}<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></a></td></tr>;
        })}</tbody></table></div> : <p className="mt-4 rounded-xl border border-edge bg-surface-alt p-4 text-sm text-muted">{copy.unavailable}</p>}
      </section>)}
    </div>

    <aside className="rounded-2xl border border-accent/30 bg-accent-subtle p-5 text-sm leading-6 text-body"><strong className="text-heading">{copy.source}</strong><p className="mt-2 text-muted">{copy.verify}</p></aside>
  </div>;
}
