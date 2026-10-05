/**
 * professionCityInsights.ts — the page-specific block of the profession × city
 * landings (`/lavoro-{city}-{role}/` + en/de/fr), issue #11678.
 *
 * Perché esiste. La pagina è una cella di una griglia (una professione in una
 * città) e fino a questo blocco tutto ciò che la distingueva dalle sorelle era
 * NUMERICO: offerte attive, offerte recenti, il benchmark salariale. La
 * maschera n. 1 di `scripts/lib/informationGain.mjs` riduce ogni cifra a `#`
 * (senza, la metrica premierebbe il mail-merge), e i nomi dei datori stavano
 * solo in pillole sotto i 25 caratteri di `MIN_SEGMENT_CHARS`. Replay del
 * 2026-10-05 sul renderer con `data/jobs.json` reale: coorte italiana al
 * 14,5 %, quella inglese al 3,3 % e quella tedesca all'1,6 % con 17 pagine a
 * gain zero, perché in en/de il nome del cantone coincide con quello della
 * città e la maschera n. 2 piega anche l'unica frase cantonale.
 *
 * Cosa aggiunge, tutto letto dal corpus di annunci del build e niente scritto
 * a mano (stesso movimento di `shared/nearestMunicipalityComparison.ts`):
 *
 *   1. i titoli reali delle offerte di QUESTA coppia, con il datore che le
 *      pubblica — l'unico contenuto che per costruzione nessuna sorella ha;
 *   2. la stessa professione nelle altre città della famiglia, in ordine di
 *      offerte attive (cambia da professione a professione);
 *   3. le altre professioni con offerte nella stessa città, nello stesso
 *      ordine (cambia da città a città).
 *
 * Le frasi sono testo semplice dentro un solo elemento: l'auditor spezza il
 * testo ai confini dei tag, quindi un nome dentro un `<a>` in mezzo alla frase
 * la frantumerebbe in pezzi sotto la soglia. I link stanno in un elenco a
 * parte, e puntano solo a coppie sopra il floor, cioè a pagine vere e mai a un
 * bridge `noindex`.
 *
 * Fail-closed: una parte senza dati non viene emessa, e senza nessuna parte il
 * blocco è la stringa vuota — un titolo «altre città» senza città sarebbe una
 * promessa che la pagina non mantiene, e conterebbe come prosa template.
 *
 * Ordinamenti deterministici (pareggi rotti sulla chiave): il blocco emette
 * link interni, e un ordine instabile rimescolerebbe il grafo dei link a ogni
 * build.
 */
import type { CityHubKey } from './cityJobsHub';
import type { FeaturedJob, ProfessionJobsSnapshot } from './professionJobsAggregate';
import { PROFESSION_IDS, professionRoleKeyword, type ProfessionId, type ProfessionLocale } from './professionLandingsData';
import { PROFESSION_CITY_DEFS, buildProfessionCityPath } from './professionCityData';

/** Offer titles shown per page. The city hub (the page CTA) lists every offer. */
export const MAX_OFFER_TITLES = 12;
/** Other professions named per page. */
export const MAX_OTHER_PROFESSIONS = 8;

export type ProfessionCitySnapshots = Partial<Record<CityHubKey, Partial<Record<ProfessionId, ProfessionJobsSnapshot>>>>;

interface InsightsCopy {
  offersHeading: (role: string, city: string) => string;
  offersMore: (shown: number, total: number) => string;
  relatedHeading: string;
  otherCities: (role: string, list: string) => string;
  otherProfessions: (city: string, list: string) => string;
  and: string;
}

const COPY: Record<ProfessionLocale, InsightsCopy> = {
  it: {
    offersHeading: (r, c) => `Le offerte per ${r} a ${c}`,
    offersMore: (shown, total) => `Le ${shown} più recenti su ${total}: l'elenco completo è nelle offerte della città.`,
    relatedHeading: 'Altre città, altre professioni',
    otherCities: (r, list) => `Offerte attive per ${r} nelle altre città: ${list}.`,
    otherProfessions: (c, list) => `Altre professioni con offerte attive a ${c}: ${list}.`,
    and: ' e ',
  },
  en: {
    offersHeading: (r, c) => `${r} openings in ${c}`,
    offersMore: (shown, total) => `The ${shown} most recent of ${total}: the full list is on the city's openings page.`,
    relatedHeading: 'Other cities, other professions',
    otherCities: (r, list) => `Active ${r} openings in the other cities: ${list}.`,
    otherProfessions: (c, list) => `Other professions with active openings in ${c}: ${list}.`,
    and: ' and ',
  },
  de: {
    offersHeading: (r, c) => `${r}-Stellen in ${c}`,
    offersMore: (shown, total) => `Die ${shown} neuesten von ${total}: die vollständige Liste steht bei den Stellen der Stadt.`,
    relatedHeading: 'Andere Städte, andere Berufe',
    otherCities: (r, list) => `Aktive ${r}-Stellen in den anderen Städten: ${list}.`,
    otherProfessions: (c, list) => `Weitere Berufe mit aktiven Stellen in ${c}: ${list}.`,
    and: ' und ',
  },
  fr: {
    offersHeading: (r, c) => `Les offres ${r} à ${c}`,
    offersMore: (shown, total) => `Les ${shown} plus récentes sur ${total} : la liste complète est dans les offres de la ville.`,
    relatedHeading: 'Autres villes, autres professions',
    otherCities: (r, list) => `Offres actives pour ${r} dans les autres villes : ${list}.`,
    otherProfessions: (c, list) => `Autres professions avec des offres actives à ${c} : ${list}.`,
    and: ' et ',
  },
};

export const PROFESSION_CITY_INSIGHTS_COPY = COPY;

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const clean = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function professionLabel(locale: ProfessionLocale, id: ProfessionId): string {
  const role = professionRoleKeyword(locale, id).replace(/-/g, ' ');
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function joinNames(names: readonly string[], and: string): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')}${and}${names[names.length - 1]}`;
}

/**
 * One line per real offer: localized title, employer and — only when it is
 * not the page's own city — the locality. Identical lines (the same role
 * reposted by the same employer) are shown once.
 */
export function offerLines(
  jobs: readonly FeaturedJob[],
  locale: ProfessionLocale,
  cityDisplay: string,
  max: number = MAX_OFFER_TITLES,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const cityFolded = fold(cityDisplay);
  for (const job of jobs) {
    const title = clean(job.titleByLocale?.[locale] ?? job.title);
    if (!title) continue;
    const company = clean(job.company);
    const locality = clean(job.addressLocality ?? job.city);
    const parts = [title];
    if (company) parts.push(company);
    // «Basel BS», «Lugano TI»: a locality that names the page's own city adds nothing.
    if (locality && !fold(locality).includes(cityFolded)) parts.push(locality);
    const line = parts.join(' — ');
    const key = fold(line);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= max) break;
  }
  return out;
}

interface Ranked {
  key: string;
  name: string;
  href: string;
  count: number;
}

const byCountThenKey = (a: Ranked, b: Ranked): number => b.count - a.count || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function renderRankedLinks(rows: readonly Ranked[]): string {
  return `<ul class="flex flex-wrap gap-2 my-2">${rows
    .map((r) => `<li><a href="${esc(r.href)}" class="inline-block rounded-full bg-surface-alt px-3 py-1 text-sm text-accent hover:underline">${esc(r.name)} <span class="text-subtle">(${r.count})</span></a></li>`)
    .join('')}</ul>`;
}

export function renderProfessionCityInsights(opts: {
  locale: ProfessionLocale;
  cityKey: CityHubKey;
  id: ProfessionId;
  snapshot: ProfessionJobsSnapshot;
  /** Every (city, profession) snapshot of the build: the two peer axes. */
  byCity?: ProfessionCitySnapshots;
  /** Job floor a pair needs to have a real page (the emitter's MIN_JOBS). */
  minJobs: number;
}): string {
  const { locale, cityKey, id, snapshot, byCity, minJobs } = opts;
  const c = COPY[locale];
  const def = PROFESSION_CITY_DEFS.find((d) => d.key === cityKey);
  const cityDisplay = def?.display ?? cityKey;
  const role = professionLabel(locale, id);
  const sections: string[] = [];

  // 1. Real offer titles of this pair.
  const jobs = snapshot.jobs ?? snapshot.featured;
  const lines = offerLines(jobs, locale, cityDisplay);
  if (lines.length > 0) {
    const more = snapshot.liveCount > lines.length
      ? `<p class="mt-2 text-sm text-muted">${esc(c.offersMore(lines.length, snapshot.liveCount))}</p>`
      : '';
    sections.push(`<h2 class="text-xl font-bold text-heading">${esc(c.offersHeading(role, cityDisplay))}</h2>
<ul class="mt-3 space-y-1 text-sm text-body list-disc pl-5">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${more}`);
  }

  // 2. Same profession, other cities — and 3. other professions, same city.
  const related: string[] = [];
  if (byCity) {
    const otherCities: Ranked[] = PROFESSION_CITY_DEFS.flatMap((d) => {
      if (d.key === cityKey) return [];
      const n = byCity[d.key]?.[id]?.liveCount ?? 0;
      if (n < minJobs) return [];
      return [{ key: d.key, name: d.display, href: buildProfessionCityPath(locale, d.key, id), count: n }];
    }).sort(byCountThenKey);
    if (otherCities.length > 0) {
      const list = joinNames(otherCities.map((r) => `${r.name} (${r.count})`), c.and);
      related.push(`<p class="mt-2 text-sm text-body">${esc(c.otherCities(role, list))}</p>
${renderRankedLinks(otherCities)}`);
    }

    const cityProfessions = byCity[cityKey] ?? {};
    const otherProfessions: Ranked[] = PROFESSION_IDS.flatMap((other) => {
      if (other === id) return [];
      const n = cityProfessions[other]?.liveCount ?? 0;
      if (n < minJobs) return [];
      return [{ key: other, name: professionLabel(locale, other), href: buildProfessionCityPath(locale, cityKey, other), count: n }];
    }).sort(byCountThenKey).slice(0, MAX_OTHER_PROFESSIONS);
    if (otherProfessions.length > 0) {
      const list = joinNames(otherProfessions.map((r) => `${r.name} (${r.count})`), c.and);
      related.push(`<p class="mt-2 text-sm text-body">${esc(c.otherProfessions(cityDisplay, list))}</p>
${renderRankedLinks(otherProfessions)}`);
    }
  }
  if (related.length > 0) {
    sections.push(`<h2 class="mt-6 text-xl font-bold text-heading">${esc(c.relatedHeading)}</h2>
${related.join('\n')}`);
  }

  if (sections.length === 0) return '';
  return `<section data-profession-city-insights="1" class="mt-6 rounded-md border border-edge bg-surface p-5">
${sections.join('\n')}
</section>`;
}
