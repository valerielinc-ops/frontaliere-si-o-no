/**
 * Cross-links between Ticino school-year landings. Kept out of
 * schoolCalendarData.ts so the SPA router, which imports the data module for
 * route matching, does not pull the HTML style tokens into its bundle.
 */
import { BODY_STYLE, H2_STYLE, LINK_ACCENT_STYLE } from './shared/seoContentTokensPure';
import {
  SCHOOL_CALENDARS,
  SCHOOL_CALENDAR_SOURCE_INDEX,
  buildSchoolCalendarPath,
  latestPublishedSchoolYear,
  schoolCalendarFor,
  schoolYearLabel,
  type SchoolLocale,
} from './schoolCalendarData';

const LINKS_COPY: Record<SchoolLocale, { heading: string; item: (label: string) => string; coverage: (latest: string) => string }> = {
  it: {
    heading: 'Altri anni scolastici',
    item: (l) => `Vacanze scolastiche ${l}`,
    coverage: (latest) => `Il DECS ha pubblicato i calendari scolastici fino all’anno ${latest}. Per gli anni successivi le date ufficiali non esistono ancora: non le stimiamo.`,
  },
  en: {
    heading: 'Other school years',
    item: (l) => `School holidays ${l}`,
    coverage: (latest) => `The DECS has published school calendars up to the ${latest} school year. Official dates for later years do not exist yet: we do not estimate them.`,
  },
  de: {
    heading: 'Weitere Schuljahre',
    item: (l) => `Schulferien ${l}`,
    coverage: (latest) => `Das DECS hat die Schulkalender bis zum Schuljahr ${latest} veröffentlicht. Für spätere Jahre gibt es noch keine offiziellen Daten: wir schätzen sie nicht.`,
  },
  fr: {
    heading: 'Autres années scolaires',
    item: (l) => `Vacances scolaires ${l}`,
    coverage: (latest) => `Le DECS a publié les calendriers scolaires jusqu’à l’année ${latest}. Pour les années suivantes, les dates officielles n’existent pas encore : nous ne les estimons pas.`,
  },
};

/**
 * Links to every other published DECS school year (the 2026/27 hand-written
 * page included) plus the coverage note. Shared by the generated landings and
 * the 2026/27 editorial page, so «next year» links follow the data instead of
 * a hard-coded URL.
 */
export function renderSchoolYearLinks(locale: SchoolLocale, currentStartYear: number | null): string {
  const c = LINKS_COPY[locale];
  const items = SCHOOL_CALENDARS
    .filter((cal) => cal.startYear !== currentStartYear)
    .map((cal) => `<li style="margin:4px 0"><a href="${buildSchoolCalendarPath(locale, cal.startYear)}" style="${LINK_ACCENT_STYLE}">${c.item(schoolYearLabel(cal.startYear))}</a></li>`)
    .join('');
  return `<section class="s-KZc0LQ"><h2 style="${H2_STYLE}">${c.heading}</h2><ul style="list-style:none;padding:0;margin:0">${items}</ul><p style="${BODY_STYLE}">${c.coverage(schoolYearLabel(latestPublishedSchoolYear()))}</p></section>`;
}

const SOURCE_LABEL: Record<SchoolLocale, (label: string) => string> = {
  it: (l) => `Fonte ufficiale: DECS, Calendario scolastico ${l} (PDF)`,
  en: (l) => `Official source: DECS, School calendar ${l} (PDF)`,
  de: (l) => `Offizielle Quelle: DECS, Schulkalender ${l} (PDF)`,
  fr: (l) => `Source officielle : DECS, Calendrier scolaire ${l} (PDF)`,
};

/** Link to the official DECS PDF of one school year, read from the data record. */
export function renderSchoolCalendarSource(locale: SchoolLocale, startYear: number): string {
  const cal = schoolCalendarFor(startYear);
  if (!cal) throw new Error(`[school-calendar] no DECS record for ${startYear}`);
  return `<p class="text-sm text-muted"><a href="${cal.sourcePdf}" rel="noopener" target="_blank" style="${LINK_ACCENT_STYLE}">${SOURCE_LABEL[locale](schoolYearLabel(startYear))}</a> · <a href="${SCHOOL_CALENDAR_SOURCE_INDEX}" rel="noopener" target="_blank" style="${LINK_ACCENT_STYLE}">ti.ch/decs</a></p>`;
}
