/**
 * healthFacilitiesCopy.ts — hand-written, per-locale copy for the
 * health-facilities hub (epic #4455 / sub #4457 + #4458).
 *
 * Pure content module (no fs, no logic beyond string composition). The build
 * plugin passes the facility record + live snapshot; these builders return the
 * localized strings for the page, the below-floor bridge and the "facilities
 * hiring near you" cross-link block injected on the nursing landings.
 */

import type { HealthFacilityLocale } from './healthFacilitiesData';
import type { HealthFacilityCategory } from './healthFacilitiesMatch';
import type { HealthcareRole } from './healthFacilitiesMatch';

// ── Category + role labels ──────────────────────────────────────────────────

export const CATEGORY_LABEL: Record<HealthFacilityLocale, Record<HealthFacilityCategory, string>> = {
  it: { acute: 'Ospedale acuto', rehab: 'Clinica di riabilitazione', psychiatry: 'Clinica psichiatrica', birth: 'Casa maternità', other: 'Struttura sanitaria' },
  en: { acute: 'Acute-care hospital', rehab: 'Rehabilitation clinic', psychiatry: 'Psychiatric clinic', birth: 'Birth centre', other: 'Healthcare facility' },
  de: { acute: 'Akutspital', rehab: 'Rehabilitationsklinik', psychiatry: 'Psychiatrische Klinik', birth: 'Geburtshaus', other: 'Gesundheitseinrichtung' },
  fr: { acute: 'Hôpital de soins aigus', rehab: 'Clinique de réadaptation', psychiatry: 'Clinique psychiatrique', birth: 'Maison de naissance', other: 'Établissement de santé' },
};

export const ROLE_LABEL: Record<HealthFacilityLocale, Record<HealthcareRole, string>> = {
  it: { infermiere: 'Infermieri', oss: 'OSS / operatori socio-sanitari', medico: 'Medici', terapista: 'Terapisti', ostetrica: 'Ostetriche', tecnico: 'Tecnici sanitari', altro: 'Altri ruoli sanitari' },
  en: { infermiere: 'Nurses', oss: 'Care assistants', medico: 'Doctors', terapista: 'Therapists', ostetrica: 'Midwives', tecnico: 'Medical technicians', altro: 'Other clinical roles' },
  de: { infermiere: 'Pflegefachpersonen', oss: 'Betreuungsassistenz', medico: 'Ärztinnen und Ärzte', terapista: 'Therapeutinnen', ostetrica: 'Hebammen', tecnico: 'Medizintechnik', altro: 'Weitere Gesundheitsberufe' },
  fr: { infermiere: 'Infirmiers', oss: 'Assistants en soins', medico: 'Médecins', terapista: 'Thérapeutes', ostetrica: 'Sages-femmes', tecnico: 'Techniciens médicaux', altro: 'Autres métiers de la santé' },
};

// ── Locale plumbing ─────────────────────────────────────────────────────────

export const BREADCRUMB_HOME: Record<HealthFacilityLocale, string> = {
  it: 'Home', en: 'Home', de: 'Startseite', fr: 'Accueil',
};

export const SECTION_LABEL: Record<HealthFacilityLocale, string> = {
  it: 'Strutture sanitarie',
  en: 'Healthcare facilities',
  de: 'Gesundheitseinrichtungen',
  fr: 'Établissements de santé',
};

export interface FacilityCopyInput {
  readonly name: string;
  readonly category: HealthFacilityCategory;
  readonly canton: string;
  readonly cantonName: string;
  readonly city: string;
  readonly liveCount: number;
  readonly healthcareCount: number;
  readonly fresh30Count: number;
  readonly medianSalaryChf: number | null;
  readonly siteCount: number;
  readonly topRoles: readonly { role: HealthcareRole; count: number }[];
  readonly commuterLabel: string; // pre-formatted, e.g. "Como e Varese" (may be '')
}

function fmtChf(n: number, locale: HealthFacilityLocale): string {
  const loc = locale === 'it' ? 'it-CH' : locale === 'de' ? 'de-CH' : locale === 'fr' ? 'fr-CH' : 'en-CH';
  return new Intl.NumberFormat(loc, { maximumFractionDigits: 0 }).format(n);
}

export interface FacilityComposedCopy {
  readonly eyebrow: string;
  readonly h1: string;
  readonly lede: string;
  readonly metaTitle: string;
  readonly metaDesc: string;
  readonly tileOpenings: string;
  readonly tileMedian: string;
  readonly tileFresh: string;
  readonly noSalary: string;
  readonly ctaJobsLabel: string;
  readonly featuredTitle: string;
  readonly featuredEmpty: string;
  readonly rolesTitle: string;
  readonly infoTitle: string;
  readonly infoCategory: string;
  readonly infoCanton: string;
  readonly infoCity: string;
  readonly infoSites: string;
  readonly funnelTitle: string;
  readonly relatedTitle: string;
  readonly prose: readonly { title: string; paragraphs: readonly string[] }[];
  readonly faqTitle: string;
  readonly faqs: readonly { question: string; answer: string }[];
  readonly commuterSentence: string;
}

export function buildFacilityCopy(
  locale: HealthFacilityLocale,
  f: FacilityCopyInput,
): FacilityComposedCopy {
  const cat = CATEGORY_LABEL[locale][f.category];
  const median = f.medianSalaryChf ? `CHF ${fmtChf(f.medianSalaryChf, locale)}` : '';
  const rolesText = f.topRoles.map((r) => ROLE_LABEL[locale][r.role].toLowerCase()).slice(0, 3).join(', ');

  switch (locale) {
    case 'en':
      return {
        eyebrow: `${cat} · ${f.cantonName}`,
        h1: `Jobs at ${f.name}`,
        lede: `${f.liveCount} live openings at ${f.name}, ${f.cantonName} — nursing, care and clinical roles for Italian cross-border workers.`,
        metaTitle: `${f.name} jobs — open positions & salaries`,
        metaDesc: `${f.liveCount} open jobs at ${f.name} (${cat}, ${f.cantonName}). Nursing and healthcare roles${median ? `, median salary ${median}` : ''}. Apply as a cross-border worker.`,
        tileOpenings: 'Open positions',
        tileMedian: 'Median salary',
        tileFresh: 'New in 30 days',
        noSalary: 'On request',
        ctaJobsLabel: `See all ${f.name} jobs`,
        featuredTitle: 'Latest openings',
        featuredEmpty: 'No live openings right now — check back soon or browse the job board.',
        rolesTitle: 'Healthcare roles hiring now',
        infoTitle: 'About this facility',
        infoCategory: 'Type', infoCanton: 'Canton', infoCity: 'Main location', infoSites: 'Sites',
        funnelTitle: 'Healthcare career resources',
        relatedTitle: 'Related searches',
        prose: [
          { title: `Working at ${f.name}`, paragraphs: [
            `${f.name} is ${enArticle(cat)} in ${f.city || f.cantonName}${f.siteCount > 1 ? `, operating ${f.siteCount} sites` : ''}. It regularly hires nurses, care assistants and clinical staff${rolesText ? ` — currently ${rolesText}` : ''}, and is a realistic employer for Italian cross-border workers commuting into ${f.cantonName}.`,
            `This page tracks the ${f.liveCount} openings currently indexed for ${f.name} and refreshes as new positions are crawled. ${median ? `The median salary across its healthcare roles is around ${median} per year.` : 'Salaries follow the cantonal collective agreements for the sector.'}`,
          ] },
          { title: 'How to apply as a cross-border worker', paragraphs: [
            `Swiss healthcare employers hire cross-border workers with a G permit. You will typically need recognition of your qualification (SRK/MEBEKO for regulated roles) and, for patient-facing jobs, a working command of the local language. Use the salary calculator to estimate your net cross-border pay before applying.`,
          ] },
        ],
        faqTitle: 'Frequently asked questions',
        faqs: [
          { question: `How many jobs are open at ${f.name}?`, answer: `${f.liveCount} positions are currently indexed, ${f.fresh30Count} of them posted in the last 30 days.` },
          { question: `Does ${f.name} hire cross-border workers?`, answer: `Yes — like most ${f.cantonName} healthcare employers it hires G-permit cross-border workers for nursing, care and clinical roles subject to qualification recognition.` },
        ],
        commuterSentence: f.commuterLabel ? `Convenient for cross-border workers commuting from ${f.commuterLabel}.` : '',
      };
    case 'de':
      return {
        eyebrow: `${cat} · ${f.cantonName}`,
        h1: `Stellen bei ${f.name}`,
        lede: `${f.liveCount} offene Stellen bei ${f.name}, ${f.cantonName} — Pflege-, Betreuungs- und klinische Berufe für italienische Grenzgänger.`,
        metaTitle: `${f.name} Jobs — offene Stellen & Löhne`,
        metaDesc: `${f.liveCount} offene Stellen bei ${f.name} (${cat}, ${f.cantonName}). Pflege- und Gesundheitsberufe${median ? `, Medianlohn ${median}` : ''}. Bewerbung als Grenzgänger.`,
        tileOpenings: 'Offene Stellen',
        tileMedian: 'Medianlohn',
        tileFresh: 'Neu in 30 Tagen',
        noSalary: 'Auf Anfrage',
        ctaJobsLabel: `Alle Stellen bei ${f.name}`,
        featuredTitle: 'Neueste Stellen',
        featuredEmpty: 'Aktuell keine offenen Stellen — bald wieder vorbeischauen oder die Jobbörse durchsuchen.',
        rolesTitle: 'Gesundheitsberufe mit offenen Stellen',
        infoTitle: 'Über diese Einrichtung',
        infoCategory: 'Typ', infoCanton: 'Kanton', infoCity: 'Hauptstandort', infoSites: 'Standorte',
        funnelTitle: 'Ressourcen für Gesundheitsberufe',
        relatedTitle: 'Verwandte Suchen',
        prose: [
          { title: `Arbeiten bei ${f.name}`, paragraphs: [
            `${f.name} ist ${deArticle(cat)} in ${f.city || f.cantonName}${f.siteCount > 1 ? ` mit ${f.siteCount} Standorten` : ''}. Die Einrichtung stellt regelmässig Pflegefachpersonen, Betreuungs- und klinisches Personal ein${rolesText ? ` — aktuell ${rolesText}` : ''} und ist ein realistischer Arbeitgeber für italienische Grenzgänger im Kanton ${f.cantonName}.`,
            `Diese Seite verfolgt die ${f.liveCount} aktuell indexierten Stellen bei ${f.name} und wird laufend aktualisiert. ${median ? `Der Medianlohn über die Gesundheitsberufe liegt bei rund ${median} pro Jahr.` : 'Die Löhne folgen den kantonalen Gesamtarbeitsverträgen der Branche.'}`,
          ] },
          { title: 'Bewerbung als Grenzgänger', paragraphs: [
            `Schweizer Gesundheitsarbeitgeber stellen Grenzgänger mit G-Bewilligung ein. In der Regel benötigen Sie die Anerkennung Ihres Abschlusses (SRK/MEBEKO für regulierte Berufe) und für patientennahe Stellen ausreichende Sprachkenntnisse. Nutzen Sie den Lohnrechner, um Ihren Netto-Grenzgängerlohn abzuschätzen.`,
          ] },
        ],
        faqTitle: 'Häufige Fragen',
        faqs: [
          { question: `Wie viele Stellen sind bei ${f.name} offen?`, answer: `${f.liveCount} Stellen sind aktuell indexiert, davon ${f.fresh30Count} in den letzten 30 Tagen ausgeschrieben.` },
          { question: `Stellt ${f.name} Grenzgänger ein?`, answer: `Ja — wie die meisten Gesundheitsarbeitgeber im Kanton ${f.cantonName} stellt die Einrichtung G-Grenzgänger für Pflege-, Betreuungs- und klinische Berufe ein, vorbehältlich der Diplomanerkennung.` },
        ],
        commuterSentence: f.commuterLabel ? `Gut erreichbar für Grenzgänger aus ${f.commuterLabel}.` : '',
      };
    case 'fr':
      return {
        eyebrow: `${cat} · ${f.cantonName}`,
        h1: `Emplois chez ${f.name}`,
        lede: `${f.liveCount} postes ouverts chez ${f.name}, ${f.cantonName} — soins infirmiers, assistance et métiers cliniques pour les frontaliers italiens.`,
        metaTitle: `${f.name} emplois — postes ouverts & salaires`,
        metaDesc: `${f.liveCount} postes ouverts chez ${f.name} (${cat}, ${f.cantonName}). Métiers infirmiers et de la santé${median ? `, salaire médian ${median}` : ''}. Candidature comme frontalier.`,
        tileOpenings: 'Postes ouverts',
        tileMedian: 'Salaire médian',
        tileFresh: 'Nouveaux en 30 jours',
        noSalary: 'Sur demande',
        ctaJobsLabel: `Voir tous les emplois chez ${f.name}`,
        featuredTitle: 'Derniers postes',
        featuredEmpty: 'Aucun poste ouvert pour le moment — revenez bientôt ou parcourez les offres.',
        rolesTitle: 'Métiers de la santé qui recrutent',
        infoTitle: 'À propos de cet établissement',
        infoCategory: 'Type', infoCanton: 'Canton', infoCity: 'Site principal', infoSites: 'Sites',
        funnelTitle: 'Ressources carrière santé',
        relatedTitle: 'Recherches associées',
        prose: [
          { title: `Travailler chez ${f.name}`, paragraphs: [
            `${f.name} est ${frArticle(cat)} à ${f.city || f.cantonName}${f.siteCount > 1 ? `, avec ${f.siteCount} sites` : ''}. L'établissement recrute régulièrement des infirmiers, des assistants en soins et du personnel clinique${rolesText ? ` — actuellement ${rolesText}` : ''}, et constitue un employeur réaliste pour les frontaliers italiens au canton ${f.cantonName}.`,
            `Cette page suit les ${f.liveCount} postes actuellement indexés chez ${f.name} et se met à jour au fil des annonces. ${median ? `Le salaire médian des métiers de la santé y est d'environ ${median} par an.` : 'Les salaires suivent les conventions collectives cantonales du secteur.'}`,
          ] },
          { title: 'Comment postuler en tant que frontalier', paragraphs: [
            `Les employeurs de santé suisses recrutent des frontaliers avec un permis G. Il faut généralement la reconnaissance de votre diplôme (CRS/MEBEKO pour les métiers réglementés) et, pour les postes au contact des patients, une bonne maîtrise de la langue. Utilisez le calculateur pour estimer votre salaire net de frontalier.`,
          ] },
        ],
        faqTitle: 'Questions fréquentes',
        faqs: [
          { question: `Combien de postes sont ouverts chez ${f.name} ?`, answer: `${f.liveCount} postes sont actuellement indexés, dont ${f.fresh30Count} publiés au cours des 30 derniers jours.` },
          { question: `${f.name} recrute-t-il des frontaliers ?`, answer: `Oui — comme la plupart des employeurs de santé du canton ${f.cantonName}, il recrute des frontaliers avec permis G pour les métiers infirmiers, d'assistance et cliniques, sous réserve de la reconnaissance du diplôme.` },
        ],
        commuterSentence: f.commuterLabel ? `Pratique pour les frontaliers de ${f.commuterLabel}.` : '',
      };
    case 'it':
    default:
      return {
        eyebrow: `${cat} · ${f.cantonName}`,
        h1: `Offerte di lavoro ${f.name}`,
        lede: `${f.liveCount} posizioni aperte presso ${f.name}, ${f.cantonName} — ruoli infermieristici, socio-sanitari e clinici per frontalieri italiani.`,
        metaTitle: `${f.name}: offerte di lavoro e stipendi`,
        metaDesc: `${f.liveCount} offerte di lavoro presso ${f.name} (${cat}, ${f.cantonName}). Ruoli sanitari e infermieristici${median ? `, stipendio mediano ${median}` : ''}. Candidati come frontaliere.`,
        tileOpenings: 'Posizioni aperte',
        tileMedian: 'Stipendio mediano',
        tileFresh: 'Nuove in 30 giorni',
        noSalary: 'Su richiesta',
        ctaJobsLabel: `Vedi tutte le offerte di ${f.name}`,
        featuredTitle: 'Ultime offerte',
        featuredEmpty: 'Nessuna posizione aperta al momento — riprova presto o sfoglia la bacheca offerte.',
        rolesTitle: 'Ruoli sanitari che assumono ora',
        infoTitle: 'Informazioni sulla struttura',
        infoCategory: 'Tipo', infoCanton: 'Cantone', infoCity: 'Sede principale', infoSites: 'Sedi',
        funnelTitle: 'Risorse per la carriera sanitaria',
        relatedTitle: 'Ricerche correlate',
        prose: [
          { title: `Lavorare presso ${f.name}`, paragraphs: [
            `${f.name} è ${itArticle(cat)} a ${f.city || f.cantonName}${f.siteCount > 1 ? `, con ${f.siteCount} sedi` : ''}. La struttura assume regolarmente infermieri, operatori socio-sanitari e personale clinico${rolesText ? ` — attualmente ${rolesText}` : ''}, ed è un datore di lavoro concreto per i frontalieri italiani che lavorano nel Cantone ${f.cantonName}.`,
            `Questa pagina segue le ${f.liveCount} offerte attualmente indicizzate per ${f.name} e si aggiorna man mano che vengono pubblicate nuove posizioni. ${median ? `Lo stipendio mediano dei ruoli sanitari è di circa ${median} all'anno.` : 'Gli stipendi seguono i contratti collettivi cantonali del settore.'}`,
          ] },
          { title: 'Come candidarsi da frontaliere', paragraphs: [
            `I datori di lavoro sanitari svizzeri assumono frontalieri con permesso G. In genere serve il riconoscimento del titolo (SRK/MEBEKO per le professioni regolamentate) e, per i ruoli a contatto con i pazienti, una buona padronanza della lingua. Usa il calcolatore per stimare lo stipendio netto da frontaliere prima di candidarti.`,
          ] },
        ],
        faqTitle: 'Domande frequenti',
        faqs: [
          { question: `Quante offerte di lavoro ci sono presso ${f.name}?`, answer: `${f.liveCount} posizioni sono attualmente indicizzate, di cui ${f.fresh30Count} pubblicate negli ultimi 30 giorni.` },
          { question: `${f.name} assume frontalieri?`, answer: `Sì — come la maggior parte dei datori di lavoro sanitari del Cantone ${f.cantonName}, assume frontalieri con permesso G per ruoli infermieristici, socio-sanitari e clinici, previo riconoscimento del titolo.` },
        ],
        commuterSentence: f.commuterLabel ? `Comoda per i frontalieri di ${f.commuterLabel}.` : '',
      };
  }
}

function itArticle(cat: string): string { return `un/a ${cat.toLowerCase()}`; }
function enArticle(cat: string): string { return `a ${cat.toLowerCase()}`; }
function deArticle(cat: string): string { return `eine ${cat}`; }
function frArticle(cat: string): string { return `un ${cat.toLowerCase()}`; }

// ── Below-floor bridge copy ─────────────────────────────────────────────────

export interface BridgeCopy {
  readonly metaTitle: string;
  readonly metaDesc: string;
  readonly h1: string;
  readonly body: string;
  readonly ctaLabel: string;
}

export function buildBridgeCopy(
  locale: HealthFacilityLocale,
  name: string,
  cantonName: string,
): BridgeCopy {
  switch (locale) {
    case 'en':
      return {
        metaTitle: `${name} jobs`,
        metaDesc: `${name} has no live openings tracked right now. Browse healthcare and nursing jobs in ${cantonName} and across Switzerland.`,
        h1: `Jobs at ${name}`,
        body: `${name} currently has no live openings indexed on our platform. New positions are crawled continuously, so this page will fill again as ${name} posts new roles. In the meantime, browse healthcare and nursing openings across Switzerland and set up your cross-border application — thousands of care positions at Swiss employers are indexed every day.`,
        ctaLabel: `Browse nursing and healthcare jobs`,
      };
    case 'de':
      return {
        metaTitle: `${name} Jobs`,
        metaDesc: `${name} hat aktuell keine offenen Stellen. Durchsuchen Sie Gesundheits- und Pflegestellen im Kanton ${cantonName} und in der ganzen Schweiz.`,
        h1: `Stellen bei ${name}`,
        body: `${name} hat derzeit keine auf unserer Plattform indexierten offenen Stellen. Neue Positionen werden laufend erfasst, sodass sich diese Seite wieder füllt, sobald ${name} neue Stellen ausschreibt. Durchsuchen Sie in der Zwischenzeit Gesundheits- und Pflegestellen in der ganzen Schweiz — täglich werden tausende Pflegepositionen bei Schweizer Arbeitgebern indexiert.`,
        ctaLabel: `Pflege- und Gesundheitsstellen durchsuchen`,
      };
    case 'fr':
      return {
        metaTitle: `${name} emplois`,
        metaDesc: `${name} n'a aucun poste ouvert pour le moment. Parcourez les emplois de santé et de soins au canton ${cantonName} et dans toute la Suisse.`,
        h1: `Emplois chez ${name}`,
        body: `${name} n'a actuellement aucun poste ouvert indexé sur notre plateforme. De nouvelles positions sont collectées en continu, cette page se remplira donc à nouveau dès que ${name} publiera de nouveaux postes. En attendant, parcourez les emplois de santé et de soins dans toute la Suisse — des milliers de postes de soins auprès d'employeurs suisses sont indexés chaque jour.`,
        ctaLabel: `Parcourir les emplois infirmiers et de santé`,
      };
    case 'it':
    default:
      return {
        metaTitle: `${name}: offerte di lavoro`,
        metaDesc: `${name} non ha offerte attive al momento. Sfoglia le offerte sanitarie e infermieristiche nel Cantone ${cantonName} e in tutta la Svizzera.`,
        h1: `Offerte di lavoro ${name}`,
        body: `${name} al momento non ha offerte di lavoro indicizzate sulla nostra piattaforma. Le nuove posizioni vengono raccolte di continuo, quindi questa pagina tornerà a popolarsi non appena ${name} pubblicherà nuovi ruoli. Nel frattempo, sfoglia le offerte sanitarie e infermieristiche in tutta la Svizzera e prepara la tua candidatura da frontaliere: ogni giorno indicizziamo migliaia di posizioni sanitarie presso datori di lavoro svizzeri.`,
        ctaLabel: `Sfoglia le offerte per infermieri e sanitari`,
      };
  }
}

// ── "Facilities hiring near you" injected block (#4458) ─────────────────────

export const NEAR_YOU_BLOCK: Record<HealthFacilityLocale, { title: string; intro: string }> = {
  it: {
    title: 'Strutture sanitarie che assumono',
    intro: 'Ospedali e cliniche svizzeri con offerte attive per infermieri, OSS e ruoli sanitari, con stipendi mediani reali.',
  },
  en: {
    title: 'Healthcare facilities hiring now',
    intro: 'Swiss hospitals and clinics with live openings for nurses, care assistants and clinical roles, with real median salaries.',
  },
  de: {
    title: 'Gesundheitseinrichtungen mit offenen Stellen',
    intro: 'Schweizer Spitäler und Kliniken mit offenen Stellen für Pflege, Betreuung und klinische Berufe, mit realen Medianlöhnen.',
  },
  fr: {
    title: 'Établissements de santé qui recrutent',
    intro: 'Hôpitaux et cliniques suisses avec des postes ouverts pour infirmiers, assistants en soins et métiers cliniques, avec des salaires médians réels.',
  },
};

// ── Complete facility index on the HTML sitemap page (#5434) ────────────────
// NEAR_YOU_BLOCK above is a CURATED, capped shortlist on three nursing
// landings. This one is the opposite by design: the whole emitted family, on
// the one page per locale that is main-nav reachable. See the header of
// healthFacilitiesLinksPlugin.ts for the measurement that made it necessary.

export const FACILITY_INDEX_BLOCK: Record<HealthFacilityLocale, { title: string; intro: string }> = {
  it: {
    title: 'Tutte le strutture sanitarie',
    intro: 'Indice completo delle strutture sanitarie svizzere con offerte di lavoro indicizzate.',
  },
  en: {
    title: 'All healthcare facilities',
    intro: 'Complete index of the Swiss healthcare facilities with indexed job openings.',
  },
  de: {
    title: 'Alle Gesundheitseinrichtungen',
    intro: 'Vollständiges Verzeichnis der Schweizer Gesundheitseinrichtungen mit indexierten Stellenangeboten.',
  },
  fr: {
    title: 'Tous les établissements de santé',
    intro: 'Index complet des établissements de santé suisses avec des offres d’emploi indexées.',
  },
};
