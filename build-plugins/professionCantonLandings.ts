/**
 * professionCantonLandings.ts — per-canton profession landing pages.
 *
 * Emits `/lavoro-{canton}-{role}/` (+ /en/jobs-, /de/arbeit-, /fr/travail-) for
 * each (canton, profession) pair that has at least MIN_JOBS real active jobs in
 * the corpus. Each page is data-driven from data/jobs.json via
 * aggregateProfessionJobsByCanton: REAL local top employers, real median salary
 * (corpus), live counts — plus the canton-aware SEO prose. The job-count gate
 * keeps thin/empty pages from being emitted (CLAUDE.md non-negotiable #4), so
 * only profession×canton pairs with genuine local demand ship.
 */
import type { Plugin } from 'vite';
import fs from 'node:fs';
import np from 'node:path';

import { BASE_URL, MIN_INDEXABLE_WORDS, countHtmlBodyWords, DRIVEBY_AD_SNIPPET } from './constants';
import { buildSeoPageHtml } from './shared/seoPageShell';
import { adSlotHtml, endOfContentMultiplexHtml } from './lib/adSlotHtml';
import { WriteCollector } from './batchWrite';
import { renderHreflangTags, type HreflangPaths } from './shared/hreflang';
import { buildDayStampIso } from './shared/buildDayStamp';
import { cleanSitemapFiles } from './shared/distNamespaceCleanup';
import { getCantonDisplayName, type CantonDisplayLocale } from './shared/cantonDisplay';
import {
  MIN_JOBS,
  PROFESSION_BRIDGE_COPY,
  professionLabel,
  renderProfessionBelowFloorBridge,
  meetsJobsFloor,
} from './shared/professionJobsFloor';
import {
  renderCantonSeoProse,
  buildCantonSeoProseFaqItems,
  type CantonSeoLocale,
} from './shared/cantonSeoProse';
import { cantonAnnualMedianChf } from './shared/cantonSalaryIndex';
import {
  aggregateProfessionJobsByCanton,
  type ProfessionJobsSnapshot,
} from './professionJobsAggregate';
import {
  ALL_CANTON_PROFESSION_IDS,
  PROFESSION_LOCALES,
  PROFESSION_LOCALE_PREFIX,
  professionRoleKeywordAny,
  type AnyProfessionId,
  type ProfessionLocale,
} from './professionLandingsData';
import {
  SALARY_STATS_CANTON_SLUGS,
  buildSalaryStatsPath,
} from './salaryStatsData';
import { buildProfessionCantonPath, PROFESSION_CANTON_KEYS } from './professionCantonData';
import { renderPeerComparison, type PeerRow } from './shared/peerCohortComparison';
import { isSalaryEligibleProfessionId, buildSalaryProfessionCantonPath } from './salaryProfessionCantonData';
import { resolveProfessionCantonsFlushed } from './shared/buildSignals';
import { composePlaceTitle, TITLE_MAX_CHARS } from './shared/titleSuffix';
import {
  H2_STYLE,
  BREADCRUMB_CLASS,
  BREADCRUMB_LINK_CLASS,
  CTA_PRIMARY_CLASS,
  renderStatGrid,
  pickStatTileTone,
  differentiateH1FromTitle,
} from './shared/seoContentTokens';

// MIN_JOBS, professionLabel and the below-floor bridge now come from
// shared/professionJobsFloor.ts — the single producer both this family and the
// legacy TI family (professionLandingsPlugin.ts) consult (#5322). They used to
// be private to this module, which is exactly why the legacy family shipped
// for months with no job floor at all: reusing them meant copying them.
const SITEMAP_FILE = 'sitemap-profession-cantons.xml';

const OG_LOCALE: Record<ProfessionLocale, string> = {
  it: 'it_CH', en: 'en_US', de: 'de_CH', fr: 'fr_CH',
};

interface Copy {
  eyebrow: string;
  h1: (role: string, canton: string) => string;
  lede: (count: number, role: string, canton: string) => string;
  tileLive: string;
  tileFresh: string;
  tileMedian: string;
  employersHeading: (canton: string) => string;
  noSalary: string;
  cta: (canton: string) => string;
  breadcrumbHome: string;
  breadcrumbCh: string;
  metaTitle: (role: string, canton: string) => string;
  metaDesc: (count: number, role: string, canton: string) => string;
  perYear: string;
  /** Cross-link to the salary-intent page (#4461), when the pair is eligible. */
  salaryLink: (role: string, canton: string) => string;
  /**
   * Peer-comparison block (#7596): this profession against the other
   * professions of the SAME canton. `peerMetric` is a bare plural noun — the
   * shared module takes it as an apposition, never as a verb's subject.
   */
  peerHeading: (canton: string) => string;
  peerMetric: string;
  peerNoun: string;
  peerSource: string;
  /**
   * The same profession across the other cantons — the second peer axis.
   * `cantonNoun` follows the same contract as `peerNoun` (dative plural in de).
   */
  crossCantonHeading: (role: string) => string;
  cantonNoun: string;
  /** Lead sentence of the employer list, so the names read as prose and not only as pills. */
  employersLead: (role: string, canton: string, list: string) => string;
}

const COPY: Record<ProfessionLocale, Copy> = {
  it: {
    eyebrow: 'Offerte di lavoro per professione',
    h1: (r, c) => `Lavoro come ${r} nel Canton ${c}`,
    lede: (n, r, c) => `${n} offerte attive per ${r} nel Canton ${c}, da datori di lavoro svizzeri reali.`,
    tileLive: 'Offerte attive',
    tileFresh: 'Pubblicate (30 gg)',
    tileMedian: 'Stipendio mediano lordo/anno',
    employersHeading: (c) => `Chi assume nel Canton ${c}`,
    noSalary: 'n/d',
    cta: (c) => `Vedi tutte le offerte nel Canton ${c}`,
    breadcrumbHome: 'Home',
    breadcrumbCh: 'Svizzera',
    metaTitle: (r, c) => `Lavoro ${r} Canton ${c} — offerte e stipendio`,
    metaDesc: (n, r, c) => `${n} offerte per ${r} nel Canton ${c}: datori reali, stipendio mediano e candidatura diretta. Aggiornato ogni 12 ore.`,
    perYear: '/anno',
    salaryLink: (r, c) => `Stipendio ${r} nel Canton ${c}: lordo, netto e confronto`,
    peerHeading: (c) => `Come si colloca fra le professioni del Canton ${c}`,
    peerMetric: 'offerte attive',
    peerNoun: 'professioni',
    peerSource: 'Conteggi dal corpus di annunci attivi, ricalcolati a ogni build.',
    crossCantonHeading: (r) => `${r}: il confronto con gli altri cantoni`,
    cantonNoun: 'cantoni',
    employersLead: (r, c, list) => `Datori di lavoro con più offerte attive per ${r} nel Canton ${c}: ${list}.`,
  },
  en: {
    eyebrow: 'Jobs by profession',
    h1: (r, c) => `${r} jobs in Canton ${c}`,
    lede: (n, r, c) => `${n} active ${r} openings in Canton ${c}, from real Swiss employers.`,
    tileLive: 'Active openings',
    tileFresh: 'Posted (30 days)',
    tileMedian: 'Median gross salary/year',
    employersHeading: (c) => `Who is hiring in Canton ${c}`,
    noSalary: 'n/a',
    cta: (c) => `See all openings in Canton ${c}`,
    breadcrumbHome: 'Home',
    breadcrumbCh: 'Switzerland',
    metaTitle: (r, c) => `${r} jobs Canton ${c} — openings and salary`,
    metaDesc: (n, r, c) => `${n} ${r} openings in Canton ${c}: real employers, median salary and direct apply. Updated every 12 hours.`,
    perYear: '/yr',
    salaryLink: (r, c) => `${r} salary in Canton ${c}: gross, net and comparison`,
    peerHeading: (c) => `How this ranks among the professions of Canton ${c}`,
    peerMetric: 'active openings',
    peerNoun: 'professions',
    peerSource: 'Counts from the live job corpus, recomputed on every build.',
    crossCantonHeading: (r) => `${r}: how the other cantons compare`,
    cantonNoun: 'cantons',
    employersLead: (r, c, list) => `Employers with the most active ${r} openings in Canton ${c}: ${list}.`,
  },
  de: {
    eyebrow: 'Stellen nach Beruf',
    h1: (r, c) => `${r}-Stellen im Kanton ${c}`,
    lede: (n, r, c) => `${n} aktive ${r}-Stellen im Kanton ${c}, von echten Schweizer Arbeitgebern.`,
    tileLive: 'Aktive Stellen',
    tileFresh: 'Veröffentlicht (30 Tage)',
    tileMedian: 'Medianlohn brutto/Jahr',
    employersHeading: (c) => `Wer im Kanton ${c} einstellt`,
    noSalary: 'k.A.',
    cta: (c) => `Alle Stellen im Kanton ${c} ansehen`,
    breadcrumbHome: 'Home',
    breadcrumbCh: 'Schweiz',
    metaTitle: (r, c) => `${r} Stellen Kanton ${c} — Angebote und Lohn`,
    metaDesc: (n, r, c) => `${n} ${r}-Stellen im Kanton ${c}: echte Arbeitgeber, Medianlohn und Direktbewerbung. Alle 12 Stunden aktualisiert.`,
    perYear: '/Jahr',
    salaryLink: (r, c) => `${r}-Lohn im Kanton ${c}: brutto, netto und Vergleich`,
    peerHeading: (c) => `Im Vergleich mit den Berufen im Kanton ${c}`,
    peerMetric: 'aktive Stellen',
    // Dativo plurale: il template DE del modulo condiviso lo consuma dentro
    // «Von N vergleichbaren …», sintagma preposizionale che regge il dativo.
    peerNoun: 'Berufen',
    peerSource: 'Zahlen aus dem Bestand aktiver Stellen, bei jedem Build neu berechnet.',
    crossCantonHeading: (r) => `${r}: der Vergleich mit den anderen Kantonen`,
    // Dativo plurale, stesso contratto di `peerNoun`.
    cantonNoun: 'Kantonen',
    employersLead: (r, c, list) => `Arbeitgeber mit den meisten aktiven ${r}-Stellen im Kanton ${c}: ${list}.`,
  },
  fr: {
    eyebrow: 'Emplois par profession',
    h1: (r, c) => `Emploi ${r} dans le canton ${c}`,
    lede: (n, r, c) => `${n} offres actives pour ${r} dans le canton ${c}, d'employeurs suisses réels.`,
    tileLive: 'Offres actives',
    tileFresh: 'Publiées (30 j)',
    tileMedian: 'Salaire médian brut/an',
    employersHeading: (c) => `Qui recrute dans le canton ${c}`,
    noSalary: 'n/d',
    cta: (c) => `Voir toutes les offres dans le canton ${c}`,
    breadcrumbHome: 'Accueil',
    breadcrumbCh: 'Suisse',
    metaTitle: (r, c) => `Emploi ${r} canton ${c} — offres et salaire`,
    metaDesc: (n, r, c) => `${n} offres ${r} dans le canton ${c} : employeurs réels, salaire médian et candidature directe. Mis à jour toutes les 12 heures.`,
    perYear: '/an',
    salaryLink: (r, c) => `Salaire ${r} dans le canton ${c} : brut, net et comparaison`,
    peerHeading: (c) => `Face aux professions du canton ${c}`,
    peerMetric: 'offres actives',
    peerNoun: 'professions',
    peerSource: 'Comptages issus des offres actives, recalculés à chaque build.',
    crossCantonHeading: (r) => `${r} : la comparaison avec les autres cantons`,
    cantonNoun: 'cantons',
    employersLead: (r, c, list) => `Employeurs avec le plus d'offres actives pour ${r} dans le canton ${c} : ${list}.`,
  },
};

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtChf(n: number, locale: ProfessionLocale): string {
  const sep = locale === 'en' ? ',' : locale === 'fr' ? ' ' : "'";
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

export function renderProfessionCantonPage(opts: {
  locale: ProfessionLocale;
  cantonKey: string;
  id: AnyProfessionId;
  snapshot: ProfessionJobsSnapshot;
  /**
   * Every profession snapshot of THIS canton, i.e. the page's peer cohort
   * (#7596). Optional so a caller that only wants one page keeps working: the
   * comparison block then renders empty, exactly as it does for a canton with
   * fewer than three above-floor professions.
   */
  cantonProfessions?: Partial<Record<AnyProfessionId, ProfessionJobsSnapshot>>;
  /**
   * The SAME profession in every canton (canton key → snapshot): the page's
   * second peer cohort. Optional for the same reason as `cantonProfessions`.
   */
  professionAcrossCantons?: Partial<Record<string, ProfessionJobsSnapshot>>;
  distDir: string;
}): { html: string; words: number } {
  const { locale, cantonKey, id, snapshot, cantonProfessions, professionAcrossCantons, distDir } = opts;
  const c = COPY[locale];
  const cantonName = getCantonDisplayName(cantonKey, locale as CantonDisplayLocale);
  const role = professionLabel(locale, id);
  const canonicalPath = buildProfessionCantonPath(locale, cantonKey, id);
  const homeHref = locale === 'it' ? '/' : `${PROFESSION_LOCALE_PREFIX[locale]}/`;

  // Real corpus median for this canton+profession; fall back to the canton's
  // BFS annual median when the matched jobs carry no salary data.
  const median = snapshot.medianSalaryChf > 0 ? snapshot.medianSalaryChf : cantonAnnualMedianChf(cantonKey);
  const medianStr = median > 0 ? `CHF ${fmtChf(median, locale)}` : c.noSalary;

  const breadcrumb = `<nav aria-label="breadcrumb" class="${BREADCRUMB_CLASS}">
  <a href="${homeHref}" class="${BREADCRUMB_LINK_CLASS}">${esc(c.breadcrumbHome)}</a>
  <span aria-hidden="true">›</span>
  <a href="${homeHref}" class="${BREADCRUMB_LINK_CLASS}">${esc(c.breadcrumbCh)}</a>
  <span aria-hidden="true">›</span>
  <span aria-current="page">${esc(role)} · ${esc(cantonName)}</span>
</nav>`;

  // Headline tiles via the shared styled+animated grid (dark-mode safe, staggered
  // rise + hover pop under `cl-fun`). Tones carry meaning: openings count green
  // when plentiful, "new in 30 days" green when >0, the median is the accent
  // headline. (The previous markup passed `class="${H1_STYLE}"` etc. — a CSS
  // string in a `class=` slot, silently ignored by the browser → bare header.)
  const tiles = renderStatGrid([
    { label: c.tileLive, value: String(snapshot.liveCount), tone: pickStatTileTone('openings', snapshot.liveCount) },
    { label: c.tileFresh, value: String(snapshot.fresh30Count), tone: pickStatTileTone('fresh', snapshot.fresh30Count) },
    { label: c.tileMedian, value: median > 0 ? `${medianStr}${c.perYear}` : medianStr, tone: 'accent' },
  ]);

  const andWord = { it: ' e ', en: ' and ', de: ' und ', fr: ' et ' }[locale];
  const employerNames = snapshot.topEmployers.map((e) => `${e.name} (${e.count})`);
  const employerList = employerNames.length <= 1
    ? employerNames.join('')
    : `${employerNames.slice(0, -1).join(', ')}${andWord}${employerNames[employerNames.length - 1]}`;
  const employers = snapshot.topEmployers.length > 0
    ? `<h2 style="${H2_STYLE}">${esc(c.employersHeading(cantonName))}</h2>
<p class="my-2">${esc(c.employersLead(role, cantonName, employerList))}</p>
<ul class="flex flex-wrap gap-2 my-2">${snapshot.topEmployers
        .map((e) => `<li class="rounded-full bg-surface-alt px-3 py-1 text-sm">${esc(e.name)} <span class="text-subtle">(${e.count})</span></li>`)
        .join('')}</ul>`
    : '';

  // ── Il confronto con le professioni pari dello stesso cantone (#7596) ──
  //
  // Perche' esiste: questa pagina e' UNA cella di una griglia (una professione
  // in un cantone) e tutto cio' che la distingue dalle sorelle e' una CIFRA —
  // offerte attive, offerte fresche, mediana salariale. La maschera n. 1 di
  // `scripts/lib/informationGain.mjs` riduce ogni cifra a `#`, per una ragione
  // che non e' negoziabile (senza, la metrica premierebbe il mail-merge), e
  // dopo quella maschera sulla pagina non resta un segmento che le appartenga:
  // 3,0 % di IGS mediano sulla coorte italiana, 12 pagine su 85 a gain ZERO,
  // sotto il floor del 5 % (misura del 2026-09-05, issue #7596).
  //
  // Cosa aggiunge: frasi che NOMINANO le professioni vicine in classifica nel
  // suo stesso cantone. La maschera n. 2 folda solo i token identitari della
  // pagina corrente (il suo `<title>`, il suo `<h1>`), quindi i nomi delle
  // sorelle restano in piedi — ed e' l'unico contenuto che cambia davvero da
  // una cella all'altra, perche' la finestra scorre con la posizione.
  //
  // Perche' la finestra e non la classifica intera: una tabella di tutte le
  // professioni del cantone sarebbe byte-identica su tutte le pagine di quel
  // cantone, quindi a gain zero, e concentrerebbe link equity su chi sta in
  // cima — lo stesso difetto che #5107 ha rimosso dagli articoli.
  const peerRows: PeerRow[] = ALL_CANTON_PROFESSION_IDS.flatMap((peerId) => {
    const peer = cantonProfessions?.[peerId];
    // Solo le professioni sopra il floor: sono quelle che hanno una pagina
    // vera in questo cantone, quindi il link non porta mai a un bridge noindex.
    if (!peer || !meetsJobsFloor({ liveCount: peer.liveCount }).meetsFloor) return [];
    return [{
      key: peerId,
      name: professionLabel(locale, peerId),
      href: buildProfessionCantonPath(locale, cantonKey, peerId),
      value: peer.liveCount,
    }];
  });
  const peerComparison = renderPeerComparison({
    locale,
    currentKey: id,
    rows: peerRows,
    labels: { heading: c.peerHeading(cantonName), metricLabel: c.peerMetric, peerNoun: c.peerNoun },
    formatValue: (value) => String(value),
    sourceNote: c.peerSource,
  });

  // Compare recency separately from the stock of active listings. Both counts
  // come from the same profession/canton snapshot; no hiring rate is inferred.
  const recencyCopy = {
    it: { heading: 'Quanto sono recenti le offerte delle professioni vicine?', metric: 'quota di annunci recenti', source: 'Ogni nome riporta annunci recenti / annunci attivi. Recenti significa data di pubblicazione, o prima rilevazione quando è assente o non valida, negli ultimi 30 giorni. È una misura del campione di annunci, non delle assunzioni o della probabilità di ottenere il posto.' },
    en: { heading: 'How recent are the openings in nearby professions?', metric: 'share of recent listings', source: 'Each name shows recent / active listings. Recent uses the publication date, or first observation when absent or invalid, in the last 30 days. This measures the listing sample, not hires or the chance of getting a job.' },
    de: { heading: 'Wie aktuell sind die Angebote benachbarter Berufe?', metric: 'Anteil aktueller Inserate', source: 'Bei jedem Namen stehen aktuelle / aktive Inserate. Aktuell bedeutet Veröffentlichung oder, falls diese fehlt oder ungültig ist, erste Erfassung in den letzten 30 Tagen. Dies beschreibt die Inseratsstichprobe, keine Einstellungen oder Bewerbungschancen.' },
    fr: { heading: 'Quelle est la récence des offres des professions voisines ?', metric: 'part des annonces récentes', source: 'Chaque nom indique annonces récentes / annonces actives. La récence utilise la publication ou, si elle est absente ou invalide, la première observation dans les 30 derniers jours. Elle décrit cet échantillon d’annonces, pas les embauches ni les chances de recrutement.' },
  }[locale];
  const recentRows: PeerRow[] = ALL_CANTON_PROFESSION_IDS.flatMap((peerId) => {
    const peer = cantonProfessions?.[peerId];
    if (!peer || !meetsJobsFloor({ liveCount: peer.liveCount }).meetsFloor
      || !Number.isInteger(peer.liveCount) || !Number.isInteger(peer.fresh30Count) || peer.fresh30Count < 0
      || peer.fresh30Count > peer.liveCount) return [];
    return [{
      key: peerId,
      name: `${professionLabel(locale, peerId)} (${peer.fresh30Count}/${peer.liveCount})`,
      href: buildProfessionCantonPath(locale, cantonKey, peerId),
      value: peer.fresh30Count / peer.liveCount * 100,
    }];
  });
  const recentComparison = renderPeerComparison({
    locale, currentKey: id, rows: recentRows,
    labels: { heading: recencyCopy.heading, metricLabel: recencyCopy.metric, peerNoun: c.peerNoun },
    formatValue: (value) => `${value.toFixed(1)}%`,
    sourceNote: recencyCopy.source,
  });

  // ── Lo stesso mestiere negli altri cantoni ──────────────────────────────
  //
  // Il confronto qui sopra mette la professione fra le sorelle del SUO
  // cantone; questo mette il cantone fra gli altri per la STESSA professione.
  // È la domanda di chi cerca lavoro da frontaliere («dove c'è più domanda per
  // il mio mestiere?») ed è l'unico asse che distingue fra loro due pagine
  // dello stesso cantone: la classifica dei cantoni cambia da un mestiere
  // all'altro. Misura del 2026-10-02 (run 36977215802): le coorti
  // `de:/de/arbeit-st-gallen-` e `en:/en/jobs-st-gallen-` — un cantone solo,
  // quindi tutta la prosa cantonale è template per costruzione — stavano al
  // 4,3-4,8 %, con 3-4 segmenti propri su ~90.
  const crossCantonRows: PeerRow[] = PROFESSION_CANTON_KEYS.flatMap((otherCanton) => {
    const other = professionAcrossCantons?.[otherCanton];
    // Solo i cantoni sopra il floor: hanno una pagina vera, mai un bridge noindex.
    if (!other || !meetsJobsFloor({ liveCount: other.liveCount }).meetsFloor) return [];
    return [{
      key: otherCanton,
      name: getCantonDisplayName(otherCanton, locale as CantonDisplayLocale),
      href: buildProfessionCantonPath(locale, otherCanton, id),
      value: other.liveCount,
    }];
  });
  const crossCantonComparison = renderPeerComparison({
    locale,
    currentKey: cantonKey,
    rows: crossCantonRows,
    labels: { heading: c.crossCantonHeading(role), metricLabel: c.peerMetric, peerNoun: c.cantonNoun },
    formatValue: (value) => String(value),
    sourceNote: c.peerSource,
  });

  const roleKw = professionRoleKeywordAny(locale, id);
  const cantonSlug = SALARY_STATS_CANTON_SLUGS[cantonKey][locale];
  // Link to the per-canton salary stats landing (shipped in PR #2085) + the
  // job board filtered by this role.
  const ctaHref = buildSalaryStatsPath(locale, cantonSlug);

  const prose = renderCantonSeoProse({
    locale: locale as CantonSeoLocale,
    cantonDisplay: cantonName,
    slot: 'canton-hub',
    entityName: role,
    countHint: snapshot.liveCount,
    ctaHref,
    ctaLabel: c.cta(cantonName),
  });

  const professionCantonInlineAd = `<div class="ad-unit">${adSlotHtml('ARTICLE_INLINE_MOBILE')}</div>`;

  // ── Il <title> va calcolato PRIMA dell'H1, non dopo ────────────────────
  //
  // `composePlaceTitle` sceglie il primo candidato che sta nei 66 caratteri.
  // Il secondo candidato e' `PROFESSION_BRIDGE_COPY[locale].title`, e per DUE
  // locali quel template e' **byte per byte lo stesso** di `COPY[locale].h1`:
  //
  //   en   h1 `${r} jobs in Canton ${c}`      ==  bridge title, identico
  //   de   h1 `${r}-Stellen im Kanton ${c}`   ==  bridge title, identico
  //   it   h1 `Lavoro come ${r} nel Canton ${c}`  vs `Lavoro ${r} Canton ${c}`
  //   fr   h1 `Emploi ${r} dans le canton ${c}`   vs `Emplois ${r} dans …`
  //
  // Quindi ogni volta che `metaTitle` sfora il cap, le pagine de/en escono con
  // `<title>` e `<h1>` uguali. Non e' un'ipotesi: e' esattamente la coppia che
  // il seed full-corpus del 2026-08-07 (run 31197413400) misura come gli unici
  // due offender `profession-canton` di `audit:h1-title-duplicates` —
  // `de/arbeit-schaffhausen-optiker-optometrist/` e
  // `en/jobs-schaffhausen-optician-optometrist/`, dove
  // «Optiker optometrist» + «Schaffhausen» porta il metaTitle a 67 caratteri.
  //
  // Il rimedio e' quello che #5337 ha applicato alle altre cinque famiglie:
  // differenziare l'**H1**, mai il `<title>` — `shared/titleSuffix.ts` impone
  // che un headline lungo si riscriva alla fonte invece di tagliarlo, e il
  // titolo tiene le sue keyword in entrambi i casi. Non ritocco i due template
  // di copy perche' curerebbe questa coppia e lascerebbe la classe: qualunque
  // professione o cantone piu' lungo la ricrea. Cosi' invece la collisione non
  // puo' piu' uscire dal renderer, quale che sia il candidato scelto.
  //
  // Ambito: il solo elemento `<h1>`. La coda del breadcrumb e il
  // BreadcrumbList JSON-LD tengono l'headline non taggato — stessa
  // separazione di `bfsSalaryLandingsPlugin.ts` (`h1Display`).
  const pageTitle = composePlaceTitle(
    [c.metaTitle(role, cantonName), PROFESSION_BRIDGE_COPY[locale].title(role, cantonName)],
    TITLE_MAX_CHARS,
    (s) => esc(s).length,
  );
  const h1Display = differentiateH1FromTitle(c.h1(role, cantonName), pageTitle, locale);

  const header = `<header class="sx-hero"><p class="sx-kick text-sm font-semibold text-accent"><span class="lh-emoji" aria-hidden="true">💼</span>${esc(c.eyebrow)} · ${esc(cantonName)}</p><h1 class="text-2xl sm:text-3xl font-display font-bold text-heading mt-2">${esc(h1Display)}</h1><p class="text-base text-body mt-2 max-w-prose">${esc(c.lede(snapshot.liveCount, role, cantonName))}</p></header>`;

  // Cross-link to the salary-intent page (#4461) for the pairs it emits — the
  // job-intent → salary-intent direction of the bidirectional hub-spoke rule
  // (docs/SALARY-INTENT-CANONICAL-PLAN.md §4.2). Only the 8 preset-backed
  // professions get a salary page; the pair is at/above the shared MIN_JOBS
  // floor here (this renderer only runs above floor), so the salary page always
  // has a live URL (full page or noindex bridge) — never a dead link.
  const salaryLink = isSalaryEligibleProfessionId(id) && snapshot.liveCount >= MIN_JOBS
    ? `<p class="my-3"><a href="${esc(buildSalaryProfessionCantonPath(locale, cantonKey, id))}" class="text-accent font-semibold underline">${esc(c.salaryLink(role, cantonName))} →</a></p>`
    : '';

  // `cl-fun` wrapper enables the shared micro-interaction layer (tile rise +
  // hover pop, CTA glow, emoji wave), all gated behind prefers-reduced-motion.
  const main = `<div class="cl-fun">${breadcrumb}
${header}
${tiles}
${DRIVEBY_AD_SNIPPET}
${employers}
${peerComparison}
${recentComparison}
${crossCantonComparison}
<p class="my-4"><a href="${esc(ctaHref)}" class="${CTA_PRIMARY_CLASS}">${esc(c.cta(cantonName))} →</a></p>
${salaryLink}
${professionCantonInlineAd}
${prose}${endOfContentMultiplexHtml({ indexable: true })}</div>`;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: c.breadcrumbHome, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 2, name: c.breadcrumbCh, item: `${BASE_URL}${homeHref}` },
      { '@type': 'ListItem', position: 3, name: c.h1(role, cantonName), item: `${BASE_URL}${canonicalPath}` },
    ],
  };
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: buildCantonSeoProseFaqItems({ locale: locale as CantonSeoLocale, cantonDisplay: cantonName, slot: 'canton-hub' }),
  };

  const hreflangPaths = {
    it: buildProfessionCantonPath('it', cantonKey, id),
    en: buildProfessionCantonPath('en', cantonKey, id),
    de: buildProfessionCantonPath('de', cantonKey, id),
    fr: buildProfessionCantonPath('fr', cantonKey, id),
  } as HreflangPaths;

  // Budget-aware cascade — same fix/rationale as professionCityLandings.ts's
  // renderProfessionCityPage: `metaTitle` (with "Canton "/"Kanton " +
  // "— offerte e stipendio" suffix) is the longest of any profession-landing
  // template in the codebase; a longer role keyword + longer canton name
  // (e.g. DE "Graubünden") can clear TITLE_MAX_CHARS (66) with no fallback
  // before this fix (audit:title-length regression #4593).
  //
  // Calcolato sopra come `pageTitle`, prima dell'header: l'H1 deve poter
  // confrontarsi con la stringa ESATTA che finisce nel `<title>`. Confrontarlo
  // con `c.metaTitle(...)` compilerebbe e non scatterebbe mai, perche' il caso
  // che collide e' proprio quello in cui il metaTitle viene scartato.
  const html = buildSeoPageHtml({
    locale,
    title: pageTitle,
    description: c.metaDesc(snapshot.liveCount, role, cantonName),
    canonicalUrl: `${BASE_URL}${canonicalPath}`,
    hreflangHtml: renderHreflangTags(hreflangPaths),
    bodyHtml: main,
    jsonLdScripts: [JSON.stringify(breadcrumbLd), JSON.stringify(faqLd)],
    ogLocale: OG_LOCALE[locale],
    robots: 'index,follow',
    distDir,
  });

  return { html, words: countHtmlBodyWords(html) };
}

export interface ProfessionCantonEmitResult {
  pagesWritten: number;
  pagesSkippedForJobs: number;
  pagesSkippedForWordCount: number;
  /** Below-floor pairs bridged to the salary-stats hub instead of left to 404. */
  bridgesWritten: number;
  emittedPaths: string[];
}

function buildSitemap(paths: readonly string[], dateStamp: string): string {
  const entries = paths
    .map((p) => `  <url>\n    <loc>${BASE_URL}${p}</loc>\n    <lastmod>${dateStamp}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.6</priority>\n  </url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

function patchSitemapIndex(distDir: string, dateStamp: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    let idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes(SITEMAP_FILE)) {
      idx = idx.replace('</sitemapindex>', `  <sitemap>\n    <loc>${BASE_URL}/${SITEMAP_FILE}</loc>\n    <lastmod>${dateStamp}</lastmod>\n  </sitemap>\n</sitemapindex>`);
    } else {
      idx = idx.replace(
        new RegExp(`(<loc>${BASE_URL.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/${SITEMAP_FILE}</loc>\\s*<lastmod>)\\d{4}-\\d{2}-\\d{2}(</lastmod>)`),
        `$1${dateStamp}$2`,
      );
    }
    fs.writeFileSync(indexPath, idx, 'utf-8');
  } catch (err) {
    console.warn('[profession-cantons] failed to patch sitemap index', err);
  }
}

/** Drop the <sitemap> entry for this family from the index (zero-emit build). */
function removeSitemapFromIndex(distDir: string): void {
  const indexPath = np.join(distDir, 'sitemap.xml');
  if (!fs.existsSync(indexPath)) return;
  try {
    const idx = fs.readFileSync(indexPath, 'utf-8');
    if (!idx.includes(SITEMAP_FILE)) return;
    const cleaned = idx.replace(
      new RegExp(`\\s*<sitemap>\\s*<loc>[^<]*${SITEMAP_FILE}</loc>\\s*<lastmod>[^<]*</lastmod>\\s*</sitemap>`),
      '',
    );
    fs.writeFileSync(indexPath, cleaned, 'utf-8');
  } catch (err) {
    console.warn('[profession-cantons] failed to prune sitemap index', err);
  }
}

export async function emitProfessionCantonPages(opts: { rootDir: string; distDir: string }): Promise<ProfessionCantonEmitResult> {
  const result: ProfessionCantonEmitResult = { pagesWritten: 0, pagesSkippedForJobs: 0, pagesSkippedForWordCount: 0, bridgesWritten: 0, emittedPaths: [] };
  const byCanton = aggregateProfessionJobsByCanton(opts.rootDir);
  const collector = new WriteCollector({ distDir: opts.distDir, pluginName: 'professionCantonLandings' });

  for (const cantonKey of PROFESSION_CANTON_KEYS) {
    // No early `continue` on a missing canton bucket: a canton with zero
    // matched jobs this build (data gap, not just one profession dipping
    // below floor) must still get bridges for every profession, or a
    // previously-live page in that canton would 404 with no recovery path.
    const perProfession = byCanton[cantonKey];
    for (const id of ALL_CANTON_PROFESSION_IDS) {
      const snapshot = perProfession?.[id];
      // Same shared predicate the legacy TI family calls (#5322). This family
      // passes NO grace window (`recentlyExpiredCount` defaults to 0), so the
      // verdict is byte-identical to the previous `liveCount < MIN_JOBS`: a
      // below-floor pair here has essentially never had a full page to lose,
      // whereas every legacy TI page is already indexed and ranking. See the
      // asymmetry note in shared/professionJobsFloor.ts.
      if (!snapshot || !meetsJobsFloor({ liveCount: snapshot.liveCount }).meetsFloor) {
        result.pagesSkippedForJobs++;
        for (const locale of PROFESSION_LOCALES) {
          const canonicalPath = buildProfessionCantonPath(locale, cantonKey, id);
          const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderProfessionBelowFloorBridge(locale, cantonKey, id));
          result.bridgesWritten++;
        }
        continue;
      }
      // Render all 4 locales first and emit ALL-OR-NOTHING: every emitted page
      // links its 4-locale hreflang cluster, so a single locale dropping below
      // the words gate while the others ship would dangle hreflang at a missing
      // target. With liveCount≥MIN_JOBS the templated prose clears the gate on
      // every locale in practice; this guard makes it safe regardless.
      const rendered = PROFESSION_LOCALES.map((locale) => ({
        locale,
        ...renderProfessionCantonPage({
          locale,
          cantonKey,
          id,
          snapshot,
          cantonProfessions: perProfession,
          professionAcrossCantons: Object.fromEntries(
            PROFESSION_CANTON_KEYS.flatMap((k) => (byCanton[k]?.[id] ? [[k, byCanton[k][id]]] : [])),
          ),
          distDir: opts.distDir,
        }),
      }));
      if (rendered.some((r) => r.words < MIN_INDEXABLE_WORDS)) {
        result.pagesSkippedForWordCount += PROFESSION_LOCALES.length;
        // Same below-floor-bridge treatment as the liveCount<MIN_JOBS branch
        // above: a bare `continue` here leaves the page's disk slot empty for
        // this plugin's own sitemap check but not for a locale-partitioned CI
        // build (scripts/ci/prune-locale-shard.mjs), which reruns this same
        // gate independently per locale and can reach a different verdict for
        // the same (canton, profession) pair — the "winning" shard's stale/
        // foreign content then sits at a URL another shard's sitemap lists as
        // self-canonical, failing audit:sitemap-canonicals downstream.
        for (const locale of PROFESSION_LOCALES) {
          const canonicalPath = buildProfessionCantonPath(locale, cantonKey, id);
          const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
          collector.add(np.join(outDir, 'index.html'), renderProfessionBelowFloorBridge(locale, cantonKey, id));
          result.bridgesWritten++;
        }
        continue;
      }
      for (const r of rendered) {
        const canonicalPath = buildProfessionCantonPath(r.locale, cantonKey, id);
        const outDir = np.join(opts.distDir, canonicalPath.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), r.html);
        result.pagesWritten++;
        result.emittedPaths.push(canonicalPath);
      }
    }
  }

  await collector.flush();

  cleanSitemapFiles(opts.distDir, [SITEMAP_FILE]);
  const dateStamp = buildDayStampIso();
  if (result.emittedPaths.length > 0) {
    fs.writeFileSync(np.join(opts.distDir, SITEMAP_FILE), buildSitemap(result.emittedPaths, dateStamp), 'utf-8');
    patchSitemapIndex(opts.distDir, dateStamp);
  } else {
    // Zero pages this build: drop any dangling <loc> a prior build left in the
    // sitemap index (the .xml itself was just removed by cleanSitemapFiles).
    removeSitemapFromIndex(opts.distDir);
  }
  return result;
}

export function professionCantonLandings(rootDir: string): Plugin {
  return {
    name: 'profession-canton-landings',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      if (process.env.SKIP_PROFESSION_CANTONS === '1') {
        // Unblock the downstream links injector — nothing to link this build.
        resolveProfessionCantonsFlushed([]);
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      const res = await emitProfessionCantonPages({ rootDir, distDir });
      // eslint-disable-next-line no-console
      console.log(`[profession-cantons] emitted ${res.pagesWritten} pages, ${res.bridgesWritten} below-floor bridges (${res.pagesSkippedForJobs} pairs below job floor, ${res.pagesSkippedForWordCount} below word gate)`);
      // Hand the emitted canonical paths to professionCantonLandingsLinksPlugin
      // so it can de-orphan exactly the pages that shipped (CLAUDE.md regola #5:
      // close orphans with real internal links, not by relaxing the gate).
      resolveProfessionCantonsFlushed(res.emittedPaths);
    },
  };
}
