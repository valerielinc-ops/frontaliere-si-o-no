/**
 * borderCrossingGuideDetail — the fact sheet of ONE crossing on its guide page.
 *
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * `/guida-frontaliere/tempi-attesa-dogana/<valico>/` (and the en/de/fr
 * equivalents under `cross-border-guide/border-waiting-times/`,
 * `grenzgaenger-ratgeber/wartezeiten-grenze/`, `guide-frontalier/
 * temps-attente-douane/`) is one SSG page per crossing — 143 crossings × 4
 * locales — whose body was the section editorial of the guide, identical on
 * every crossing, with only the name in the `<h1>` changing. On a French or a
 * German crossing that shared text even talked about «controlli doganali
 * italiani». `audit:information-gain` on run 36977215802 (2026-10-02) measured
 * every gated cohort of the family at 0 % median: 13-18 segments per page, not
 * one of them the page's own.
 *
 * Everything that makes a crossing different from the next one is already in
 * the repo:
 *   - `data/borderCrossings.ts` — foreign side, province/district, canton,
 *     road type, 24h opening, customs presence, typical waits where measured;
 *   - `services/locales/<locale>-core.ts` — the per-crossing tip
 *     (`border.tips.<id>`) translated in all four locales, the same string the
 *     SPA guide shows;
 *   - `borderWaitComparison.getBorderComparisonCandidates` — the nearest
 *     crossings of the same corridor, by real distance.
 * This module puts them on the page, in the page's language.
 *
 * Nothing is generated: each sentence is a dataset field or a shipped
 * translation, and a field the dataset does not have for a crossing is
 * omitted, never filled in.
 */

import { borderCrossings, type BorderCrossing } from '../../data/borderCrossings';
import { slugifyCrossingName } from '../../services/borderCrossingSlug';
import itCore from '../../services/locales/it-core';
import enCore from '../../services/locales/en-core';
import deCore from '../../services/locales/de-core';
import frCore from '../../services/locales/fr-core';
import { getBorderComparisonCandidates } from '../borderWaitComparison';
import { BORDER_CROSSING_DISPLAY, buildOggiPath, type BorderCrossingSlug } from '../borderWaitData';
import { formatDistanceKm } from './nearestMunicipalityComparison';
import { getCantonDisplayName } from './cantonDisplay';

export type CrossingGuideLocale = 'it' | 'en' | 'de' | 'fr';

const CORE: Record<CrossingGuideLocale, Record<string, string>> = {
  it: itCore,
  en: enCore,
  de: deCore,
  fr: frCore,
};

const BY_SLUG: ReadonlyMap<string, BorderCrossing> = new Map(
  borderCrossings.map((c) => [slugifyCrossingName(c.name), c] as const),
);

export function crossingForGuideSlug(slug: string): BorderCrossing | undefined {
  return BY_SLUG.get(slug);
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sentence = (s: string): string => (/[.!?…)]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const COUNTRY: Record<CrossingGuideLocale, Record<BorderCrossing['country'], string>> = {
  it: { IT: 'Italia', FR: 'Francia', DE: 'Germania', AT: 'Austria', LI: 'Liechtenstein' },
  en: { IT: 'Italy', FR: 'France', DE: 'Germany', AT: 'Austria', LI: 'Liechtenstein' },
  de: { IT: 'Italien', FR: 'Frankreich', DE: 'Deutschland', AT: 'Österreich', LI: 'Liechtenstein' },
  fr: { IT: 'Italie', FR: 'France', DE: 'Allemagne', AT: 'Autriche', LI: 'Liechtenstein' },
};

/** Italian province codes as they appear in the dataset; every other value is already a name. */
const ITALIAN_PROVINCE: Record<string, string> = {
  CO: 'Como',
  VA: 'Varese',
  VB: 'Verbano-Cusio-Ossola',
  SO: 'Sondrio',
  AO: 'Aosta',
};

function provinceLabel(raw: string): string {
  if (ITALIAN_PROVINCE[raw]) return ITALIAN_PROVINCE[raw];
  // French départements are stored upper-case («HAUTE-SAVOIE»).
  if (raw === raw.toUpperCase()) {
    return raw.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);
  }
  return raw;
}

const ROAD: Record<CrossingGuideLocale, Record<string, string>> = {
  it: { autostrada: 'autostradale', statale: 'su strada principale', locale: 'su strada locale' },
  en: { autostrada: 'a motorway crossing', statale: 'a main-road crossing', locale: 'a local-road crossing' },
  de: { autostrada: 'ein Autobahnübergang', statale: 'ein Übergang an einer Hauptstrasse', locale: 'ein Übergang an einer Nebenstrasse' },
  fr: { autostrada: 'un passage autoroutier', statale: 'un passage sur route principale', locale: 'un passage sur route locale' },
};

const COPY = {
  heading: {
    it: 'Scheda del valico',
    en: 'Crossing fact sheet',
    de: 'Steckbrief des Grenzübergangs',
    fr: 'Fiche du passage',
  },
  // The foreign side often carries its own parenthesis («Sauverny (Gex)»), so
  // the province and the country follow after commas, never in a second pair.
  // French takes «canton : X» because the article before a canton name varies
  // (du Tessin, des Grisons, de Genève) and a wrong one reads as broken French.
  location: {
    it: (canton: string, foreign: string, place: string, country: string) =>
      `Il valico collega il Canton ${canton} con ${foreign}, ${place === '' ? '' : `${place}, `}${country}.`,
    en: (canton: string, foreign: string, place: string, country: string) =>
      `The crossing links the canton of ${canton} with ${foreign}, ${place === '' ? '' : `${place}, `}${country}.`,
    de: (canton: string, foreign: string, place: string, country: string) =>
      `Der Übergang verbindet den Kanton ${canton} mit ${foreign}, ${place === '' ? '' : `${place}, `}${country}.`,
    fr: (canton: string, foreign: string, place: string, country: string) =>
      `Le passage relie la Suisse (canton : ${canton}) à ${foreign}, ${place === '' ? '' : `${place}, `}${country}.`,
  },
  road: {
    it: (road: string, open24h: boolean, customs: boolean) =>
      `È un valico ${road}, ${open24h ? 'aperto 24 ore su 24' : 'con orari di apertura limitati'} e ${customs ? 'con presidio doganale' : 'senza presidio doganale fisso'}.`,
    en: (road: string, open24h: boolean, customs: boolean) =>
      `It is ${road}, ${open24h ? 'open around the clock' : 'with restricted opening hours'} and ${customs ? 'with a staffed customs post' : 'without a permanently staffed customs post'}.`,
    de: (road: string, open24h: boolean, customs: boolean) =>
      `Es ist ${road}, ${open24h ? 'rund um die Uhr geöffnet' : 'mit eingeschränkten Öffnungszeiten'} und ${customs ? 'mit besetzter Zollstelle' : 'ohne ständig besetzte Zollstelle'}.`,
    fr: (road: string, open24h: boolean, customs: boolean) =>
      `C’est ${road}, ${open24h ? 'ouvert 24 heures sur 24' : 'aux horaires d’ouverture restreints'} et ${customs ? 'avec un poste de douane occupé' : 'sans poste de douane occupé en permanence'}.`,
  },
  hours: {
    it: (h: string) => `Orari secondo il nostro registro dei valichi: ${h}.`,
    en: (h: string) => `Opening hours in our crossing register: ${h}.`,
    de: (h: string) => `Öffnungszeiten laut unserem Übergangsregister: ${h}.`,
    fr: (h: string) => `Horaires selon notre registre des passages : ${h}.`,
  },
  typicalWait: {
    it: (m: string, e: string) => `Attesa tipica rilevata: ${m} al mattino, ${e} la sera.`,
    en: (m: string, e: string) => `Typical recorded wait: ${m} in the morning, ${e} in the evening.`,
    de: (m: string, e: string) => `Typische erfasste Wartezeit: ${m} am Morgen, ${e} am Abend.`,
    fr: (m: string, e: string) => `Attente typique relevée : ${m} le matin, ${e} le soir.`,
  },
  trafficNote: {
    it: (p: string) => `Traffico abituale secondo il registro: ${p.toLowerCase()}.`,
    en: (p: string) => `Usual traffic according to the register: ${p.toLowerCase()}.`,
    de: (p: string) => `Üblicher Verkehr laut Register: ${p}.`,
    fr: (p: string) => `Trafic habituel selon le registre : ${p.toLowerCase()}.`,
  },
  peak: {
    it: (p: string) => `Fasce di punta: ${p}.`,
    en: (p: string) => `Peak windows: ${p}.`,
    de: (p: string) => `Stosszeiten: ${p}.`,
    fr: (p: string) => `Heures de pointe : ${p}.`,
  },
  nearest: {
    it: (list: string) => `I valichi più vicini sullo stesso tratto di confine sono ${list}.`,
    en: (list: string) => `The nearest crossings on the same stretch of border are ${list}.`,
    de: (list: string) => `Die nächstgelegenen Übergänge am selben Grenzabschnitt sind ${list}.`,
    fr: (list: string) => `Les passages les plus proches sur le même tronçon de frontière sont ${list}.`,
  },
  live: {
    it: 'Attesa in tempo reale e andamento orario di questo valico',
    en: 'Live wait and hourly pattern for this crossing',
    de: 'Wartezeit in Echtzeit und Stundenverlauf dieses Übergangs',
    fr: 'Attente en temps réel et profil horaire de ce passage',
  },
  conjunction: { it: ' e ', en: ' and ', de: ' und ', fr: ' et ' },
} as const;

function joinList(items: string[], locale: CrossingGuideLocale): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')}${COPY.conjunction[locale]}${items[items.length - 1]}`;
}

/** A dataset string that may be a translation key (`border.*`) or a literal. */
function resolveField(value: string | undefined, locale: CrossingGuideLocale): string | null {
  if (!value) return null;
  if (value.startsWith('border.')) return CORE[locale][value] ?? null;
  return value;
}

const isMeasured = (v: string | undefined): v is string => Boolean(v && !/^-+$/.test(v.trim()));

/**
 * Editorial blocks (raw HTML, block-level tags first) for one crossing's guide
 * page. `hrefFor` resolves a peer crossing to its guide page in the same
 * locale; when it has no answer the link falls back to the live
 * `/traffico-dogane/<slug>/oggi/` page, which every crossing of
 * `BORDER_WAIT_CROSSINGS` has.
 */
export function renderBorderCrossingGuideDetail(params: {
  locale: CrossingGuideLocale;
  slug: string;
  hrefFor?: (slug: BorderCrossingSlug) => string | undefined;
}): string[] {
  const { locale, slug } = params;
  const crossing = crossingForGuideSlug(slug);
  if (!crossing) return [];
  const hrefFor = (s: BorderCrossingSlug): string => params.hrefFor?.(s) ?? buildOggiPath(locale, s);
  const sentences: string[] = [];

  const canton = getCantonDisplayName(crossing.canton, locale);
  const place = provinceLabel(crossing.province);
  // A province equal to the foreign side (Liechtenstein municipalities) adds nothing.
  const placePart = place && place !== crossing.foreignSide ? place : '';
  sentences.push(COPY.location[locale](canton, crossing.foreignSide, placePart, COUNTRY[locale][crossing.country]));

  const road = ROAD[locale][crossing.type];
  if (road) sentences.push(COPY.road[locale](road, crossing.open24h, crossing.customsPresent));

  // The free-text hours are Italian-only in the register; a translated key
  // (`border.hours.*`) is shown in every locale.
  const hours = crossing.hours.startsWith('border.') || locale === 'it' ? resolveField(crossing.hours, locale) : null;
  if (hours && hours !== '24h') {
    // Mid-sentence the register value loses its capital — except in German, where it is a noun.
    const inline = locale === 'de' ? hours : hours.charAt(0).toLowerCase() + hours.slice(1);
    sentences.push(COPY.hours[locale](inline.replace(/[.]$/, '')));
  }

  const tip = resolveField(crossing.tips, locale);
  if (tip && tip !== crossing.tips) sentences.push(sentence(tip));

  if (isMeasured(crossing.avgWaitMorning) && isMeasured(crossing.avgWaitEvening)) {
    sentences.push(COPY.typicalWait[locale](crossing.avgWaitMorning, crossing.avgWaitEvening));
  }
  if (isMeasured(crossing.peak)) {
    // `border.peak.*` keys are a traffic level («Poco traffico»), not a time window.
    const peak = resolveField(crossing.peak, locale);
    if (peak) {
      const text = peak.replace(/[.]$/, '');
      sentences.push(crossing.peak.startsWith('border.') ? COPY.trafficNote[locale](text) : COPY.peak[locale](text));
    }
  }

  const peers = getBorderComparisonCandidates(slug as BorderCrossingSlug, 3);
  const blocks: string[] = [
    `<h2 class="s-o3IET6">${esc(COPY.heading[locale])}</h2>`,
    ...sentences.map((s) => `<p class="s-F2hp6o">${esc(s)}</p>`),
  ];
  if (peers.length > 0) {
    const list = peers.map((p) => `${BORDER_CROSSING_DISPLAY[p.slug]} (${formatDistanceKm(p.distanceKm, locale)})`);
    blocks.push(`<p class="s-F2hp6o">${esc(COPY.nearest[locale](joinList(list, locale)))}</p>`);
    blocks.push(
      `<ul class="s-4FiAM7">${peers
        .map((p) => `<li><a class="s-ku_ryy" href="${esc(hrefFor(p.slug))}">${esc(BORDER_CROSSING_DISPLAY[p.slug])}</a></li>`)
        .join('')}</ul>`,
    );
  }
  blocks.push(
    `<p class="s-F2hp6o"><a class="s-U9K6Vf" href="${esc(buildOggiPath(locale, slug as BorderCrossingSlug))}">${esc(COPY.live[locale])} →</a></p>`,
  );
  return blocks;
}
