import { BASE_URL } from './constants';
import { esc, H1_STYLE, H2_STYLE, H3_STYLE, LEDE_STYLE, BODY_STYLE, CARD_CLASS } from './shared/seoContentTokens';
import {
  buildItalyDutyWeekModel,
  currentItalyDutyWeekStart,
  formatItalyDutyDateTime,
  type ItalyDutyWeekModel,
} from '../services/pharmacies/italyDuty';
import { getDutyCoverageMatrixCopy, type DutyCoverageMatrixModel } from '../services/pharmacies/dutyCoverageMatrix';
import { pharmacyById, pharmacyCitySlug, provinceSlugForPharmacy } from '../services/pharmacies/data';
import { buildPharmacyPath, type PharmacyPath } from '../services/pharmacies/paths';
import type { Locale } from '../services/i18n';
import type { ItalyDutySnapshot } from '../services/pharmacies/italyRelease';

type ItalyDutyCopy = {
  italy: string;
  title: (weekStart: string) => string;
  lede: string;
  coverage: string;
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
};

export const ITALY_DUTY_COPY: Record<Locale, ItalyDutyCopy> = {
  it: {
    italy: 'Italia · province di confine',
    title: (weekStart) => `Farmacie di turno in Italia: settimana del ${weekStart}`,
    lede: 'Calendario settimanale separato per Como, Varese e Verbano-Cusio-Ossola. Gli intervalli compaiono solo dopo i controlli del release ufficiale italiano.',
    coverage: 'Release italiano completo, fresco e pubblicabile: gli intervalli verificati sono mostrati per tutte e tre le province.',
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
  },
  en: {
    italy: 'Italy · border provinces',
    title: (weekStart) => `On-duty pharmacies in Italy: week of ${weekStart}`,
    lede: 'Weekly schedule separated into Como, Varese and Verbano-Cusio-Ossola. Intervals appear only after the Italian official release passes every check.',
    coverage: 'Complete, fresh and publishable Italian release: verified intervals are shown for all three provinces.',
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
  },
  de: {
    italy: 'Italien · Grenzprovinzen',
    title: (weekStart) => `Notdienst-Apotheken in Italien: Woche ab ${weekStart}`,
    lede: 'Wochenplan getrennt für Como, Varese und Verbano-Cusio-Ossola. Zeiträume erscheinen erst, wenn der offizielle italienische Release alle Prüfungen besteht.',
    coverage: 'Vollständiger, frischer und veröffentlichbarer italienischer Release: Verifizierte Zeiträume werden für alle drei Provinzen angezeigt.',
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
  },
  fr: {
    italy: 'Italie · provinces frontalières',
    title: (weekStart) => `Pharmacies de garde en Italie : semaine du ${weekStart}`,
    lede: 'Planning hebdomadaire séparé pour Côme, Varèse et Verbano-Cusio-Ossola. Les intervalles apparaissent seulement après validation complète du release officiel italien.',
    coverage: 'Release italien complet, frais et publiable : les intervalles vérifiés sont affichés pour les trois provinces.',
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
  },
};

export function italyDutyWeekModel(
  weekStart?: string,
  now = new Date(),
  duties?: ItalyDutySnapshot,
  status?: ItalyDutySnapshot,
): ItalyDutyWeekModel {
  return buildItalyDutyWeekModel({
    now,
    weekStart: weekStart || currentItalyDutyWeekStart(now),
    duties,
    status,
  });
}

function italyPharmacyPath(pharmacyId: string, locale: Locale): PharmacyPath | null {
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

function italyWeekRange(model: ItalyDutyWeekModel, locale: Locale): string {
  if (!model.weekEnd) return model.weekStart;
  const end = new Date(`${model.weekEnd}T12:00:00.000Z`);
  if (!Number.isFinite(end.getTime())) return `${model.weekStart} – ${model.weekEnd}`;
  const formatted = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : locale, {
    dateStyle: 'medium',
    timeZone: 'Europe/Rome',
  }).format(end);
  return `${model.weekStart} – ${formatted}`;
}

export function renderItalyDutyWeek({
  pathValue,
  h1,
  now = new Date(),
  duties,
  status,
}: {
  pathValue: PharmacyPath;
  h1: string;
  now?: Date;
  duties?: ItalyDutySnapshot;
  status?: ItalyDutySnapshot;
}): string {
  const locale = pathValue.locale;
  const copy = ITALY_DUTY_COPY[locale];
  const model = italyDutyWeekModel(pathValue.weekStart, now, duties, status);
  const statusHtml = model.indexable
    ? `<p style="${LEDE_STYLE}">${esc(copy.coverage)}</p>`
    : `<aside style="${BODY_STYLE}"><strong>${esc(copy.unavailable)}</strong><br>${esc(model.reason)}<br>${esc(copy.noOperationalData)}</aside>`;
  const provinces = model.provinces.map((province) => {
    const rows = model.indexable && province.duties.length > 0
      ? province.duties.map((duty) => {
        const pharmacy = pharmacyById(duty.pharmacyId);
        const path = italyPharmacyPath(duty.pharmacyId, locale);
        const pharmacyLink = pharmacy && path
          ? `<a href="${esc(buildPharmacyPath(path, locale))}">${esc(pharmacy.name)}</a>`
          : esc(duty.pharmacyId);
        return `<tr data-duty-id="${esc(duty.id)}" data-duty-country="IT"><td>${esc(formatItalyDutyDateTime(duty.startsAt).slice(0, 10))}</td><td><time datetime="${esc(duty.startsAt)}">${esc(formatItalyDutyDateTime(duty.startsAt).slice(11))}</time> – <time datetime="${esc(duty.endsAt)}">${esc(formatItalyDutyDateTime(duty.endsAt))}</time></td><td><strong>${pharmacyLink}</strong></td><td><a href="${esc(duty.sourceUrl)}" rel="nofollow noopener">${esc(copy.source)}</a></td></tr>`;
      }).join('')
      : '';
    const source = model.publishable && province.sourceUrl
      ? ` <a href="${esc(province.sourceUrl)}" rel="nofollow noopener">${esc(copy.openSource)}</a>`
      : '';
    const fetched = model.indexable && province.fetchedAt
      ? `<p style="${BODY_STYLE}"><strong>${esc(copy.fetched)}:</strong> <time datetime="${esc(province.fetchedAt)}">${esc(formatItalyDutyDateTime(province.fetchedAt))}</time></p>`
      : '';
    const statusLabel = model.publishable ? copy.published : copy.notPublished;
    return `<section class="${CARD_CLASS}" data-italy-duty-province="${esc(province.code)}"${model.publishable ? ' data-italy-duty-published="true"' : ''}><h2 style="${H2_STYLE}">${esc(province.name)}</h2><p style="${BODY_STYLE}"><strong>${esc(statusLabel)}</strong>${source}</p>${fetched}${rows ? `<table style="${BODY_STYLE}"><thead><tr><th>${esc(copy.date)}</th><th>${esc(copy.hours)}</th><th>${esc(copy.pharmacy)}</th><th>${esc(copy.source)}</th></tr></thead><tbody>${rows}</tbody></table>` : `<p style="${BODY_STYLE}">${esc(model.indexable ? copy.noIntervals : copy.noOperationalData)}</p>`}</section>`;
  }).join('');
  return `<header><h1 style="${H1_STYLE}">${esc(h1)}</h1><p style="${LEDE_STYLE}">${esc(copy.lede)}</p><p style="${BODY_STYLE}"><strong>${esc(copy.week)}:</strong> ${esc(italyWeekRange(model, locale))}</p>${statusHtml}</header><div class="s-XENO3U">${provinces}</div><section><h2 style="${H2_STYLE}">${esc(copy.source)}</h2><p style="${BODY_STYLE}">${esc(copy.verify)}</p></section>`;
}

export function italyDutyWeekStructuredData(pathValue: PharmacyPath, title: string, model: ItalyDutyWeekModel): string {
  const duties = model.provinces.flatMap((province) => province.duties);
  const itemListElement = duties.slice(0, 10).flatMap((duty, index) => {
    const pharmacy = pharmacyById(duty.pharmacyId);
    const path = italyPharmacyPath(duty.pharmacyId, pathValue.locale);
    return pharmacy?.country === 'IT' && path
      ? [{
        '@type': 'ListItem',
        position: index + 1,
        name: `${pharmacy.name} — ${duty.coverageName}`,
        url: `${BASE_URL}${buildPharmacyPath(path, pathValue.locale)}`,
      }]
      : [];
  });
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: title,
    url: `${BASE_URL}${buildPharmacyPath(pathValue, pathValue.locale)}`,
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: duties.length,
      itemListElement,
    },
  });
}

export function renderItalyDutyCoverageSection(locale: Locale, matrix: DutyCoverageMatrixModel): string {
  const copy = getDutyCoverageMatrixCopy(locale);
  const provinces = matrix.italy.provinces.map((province) => {
    const rows = matrix.italy.indexable && province.duties.length > 0
      ? `<ul style="${BODY_STYLE}">${province.duties.map((duty) => {
        const pharmacy = pharmacyById(duty.pharmacyId);
        const path = italyPharmacyPath(duty.pharmacyId, locale);
        const link = pharmacy && path
          ? `<a href="${esc(buildPharmacyPath(path, locale))}">${esc(pharmacy.name)}</a>`
          : `<span>${esc(copy.notResolved)}</span>`;
        return `<li data-duty-id="${esc(duty.id)}" data-duty-country="IT"><strong>${esc(copy.pharmacy)}:</strong> ${link}<br><strong>${esc(copy.interval)}:</strong> <time datetime="${esc(duty.startsAt)}">${esc(formatItalyDutyDateTime(duty.startsAt))}</time> – <time datetime="${esc(duty.endsAt)}">${esc(formatItalyDutyDateTime(duty.endsAt))}</time></li>`;
      }).join('')}</ul>`
      : `<p style="${BODY_STYLE}">${esc(matrix.italy.indexable ? copy.noIntervals : copy.italyUnavailableNotice(matrix.italy.state))}</p>`;
    const source = matrix.italy.publishable && province.sourceUrl
      ? ` <a href="${esc(province.sourceUrl)}" rel="nofollow noopener">${esc(copy.openOfficialSource)}</a>`
      : '';
    return `<section data-coverage-kind="italy-province" data-province-code="${esc(province.code)}"${matrix.italy.publishable ? ' data-italy-duty-published="true"' : ''}><h3 style="${H3_STYLE}">${esc(province.name)}</h3><p style="${BODY_STYLE}"><strong>${esc(matrix.italy.publishable ? copy.italyPublishedLabel : copy.italyNotPublishedLabel)}</strong>${source}</p>${rows}</section>`;
  }).join('');
  const notice = matrix.italy.indexable ? copy.italyReadyNotice : `${copy.italyUnavailableNotice(matrix.italy.state)} ${matrix.italy.reason}`;
  return `<section data-coverage-kind="italy" data-italy-release-state="${esc(matrix.italy.state)}"><h2 style="${H2_STYLE}">${esc(copy.italyHeading)}</h2><p style="${LEDE_STYLE}">${esc(copy.italyLede)}</p><p style="${BODY_STYLE}" role="status">${esc(notice)}</p>${provinces}</section>`;
}
