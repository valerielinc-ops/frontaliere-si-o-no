/**
 * Employer Brand Registry.
 *
 * Curated editorial metadata for top-searched Ticino employers.
 * Used to enrich the company landing pages under
 * `/cerca-lavoro-ticino/azienda-{slug}/` with brand-specific content:
 * - Long-form description (avoids thin content warnings)
 * - Benefits / locations / FAQ sections
 * - JSON-LD Organization + FAQPage in the static HTML
 *
 * Adding a new brand (e.g. Lidl, Aldi, Manor):
 *   1. Pick a `brandKey` matching `canonicalCompanyRouteSlug(company, companyKey)`.
 *      See `components/community/JobBoard.tsx::canonicalCompanyRouteSlug`.
 *   2. Fill all 4 locales with *real* content (no TODOs). Target: each locale
 *      `description` + FAQs + benefits combined >= 400 words so the page body
 *      comfortably clears the "thin content" threshold (50 words, per
 *      CLAUDE.md NON-NEGOTIABLE rule #4).
 *   3. Use only verifiable data points — link to the official site instead of
 *      inventing numbers.
 *   4. Register under `EMPLOYER_BRANDS` and add a test case in
 *      `tests/components/EmployerBrandHub.test.tsx`.
 */

import type { Locale } from './i18n';

export interface EmployerBenefit {
  /** Short label, e.g. "Formazione continua" */
  readonly title: string;
  /** One-sentence explanation. */
  readonly desc: string;
}

export interface EmployerFaq {
  readonly q: string;
  readonly a: string;
}

export interface EmployerBrandCopy {
  /** H1 / display name in this locale. */
  readonly h1: string;
  /** Short one-line subtitle under the H1. */
  readonly tagline: string;
  /** Long-form description, 3-5 paragraphs, first paragraph ~100 words. */
  readonly paragraphs: readonly string[];
  /** Section headings per locale. */
  readonly sectionHeadings: {
    readonly locations: string;
    readonly benefits: string;
    readonly openRoles: string;
    readonly howToApply: string;
    readonly faq: string;
    readonly about: string;
  };
  /** "Come candidarsi" body copy. */
  readonly howToApply: string;
  /** 4-8 key benefits. */
  readonly benefits: readonly EmployerBenefit[];
  /** 4-8 FAQs. */
  readonly faqs: readonly EmployerFaq[];
  /** Locations list intro sentence. */
  readonly locationsIntro: string;
  /** "Non ci sono posizioni aperte" fallback copy. */
  readonly emptyStateNote: string;
  /** Meta title template (<=65 chars). */
  readonly metaTitle: string;
  /** Meta description (<=160 chars). */
  readonly metaDescription: string;
}

export interface EmployerBrand {
  /** Canonical slug key — matches `canonicalCompanyRouteSlug(company, companyKey)`. */
  readonly brandKey: string;
  /** Display name, e.g. "EOC – Ente Ospedaliero Cantonale". */
  readonly name: string;
  /** Compact brand name, e.g. "EOC". */
  readonly shortName: string;
  /** Full legal / descriptive name. */
  readonly fullName: string;
  /** Official website. */
  readonly website: string;
  /** Official careers portal (used for "Candidati" CTA). */
  readonly careersUrl: string;
  /** Physical operating locations / sites (display labels). */
  readonly locations: readonly string[];
  /** Headquarters address (used for Organization JSON-LD). */
  readonly headquarters: {
    readonly streetAddress: string;
    readonly postalCode: string;
    readonly addressLocality: string;
    readonly addressRegion: string;
    readonly addressCountry: string;
  };
  /** Other URLs for `sameAs` (LinkedIn, Wikipedia…). Optional. */
  readonly sameAs?: readonly string[];
  /** Localized editorial copy. All 4 locales required. */
  readonly copy: Readonly<Record<Locale, EmployerBrandCopy>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// EOC — Ente Ospedaliero Cantonale
// Source: https://www.eoc.ch (verified 2026-04)
// ─────────────────────────────────────────────────────────────────────────────

const EOC: EmployerBrand = {
  brandKey: 'eoc-ente-ospedaliero-cantonale',
  name: 'EOC – Ente Ospedaliero Cantonale',
  shortName: 'EOC',
  fullName: 'Ente Ospedaliero Cantonale',
  website: 'https://www.eoc.ch',
  careersUrl: 'https://www.eoc.ch/it/carriere/offerte-di-lavoro.html',
  locations: [
    'Ospedale Regionale di Bellinzona e Valli (Bellinzona, Acquarossa, Faido)',
    'Ospedale Regionale di Lugano (Civico e Italiano)',
    'Ospedale Regionale di Locarno (La Carità)',
    'Ospedale Regionale di Mendrisio (Beata Vergine)',
    'Istituto Oncologico della Svizzera Italiana (IOSI)',
    'Cardiocentro Ticino Institute (Lugano)',
    'Clinica di Riabilitazione EOC (Novaggio, Faido)',
  ],
  headquarters: {
    streetAddress: 'Viale Officina 3',
    postalCode: '6500',
    addressLocality: 'Bellinzona',
    addressRegion: 'TI',
    addressCountry: 'CH',
  },
  sameAs: [
    'https://www.linkedin.com/company/ente-ospedaliero-cantonale',
    'https://it.wikipedia.org/wiki/Ente_ospedaliero_cantonale',
  ],
  copy: {
    it: {
      h1: 'Lavorare in EOC — Ente Ospedaliero Cantonale del Canton Ticino',
      tagline: 'Carriera nella sanità pubblica ticinese: offerte di lavoro aperte, stipendi, sedi, come candidarsi.',
      paragraphs: [
        "L'Ente Ospedaliero Cantonale (EOC) è la principale azienda sanitaria pubblica del Canton Ticino: un ente di diritto pubblico che gestisce la rete degli ospedali cantonali multisito e coordina l'offerta di cure ospedaliere per tutta la Svizzera italiana. Con oltre 41'000 pazienti degenti e quasi 700'000 visite ambulatoriali all'anno, EOC è al contempo il maggior datore di lavoro del settore sanitario in Ticino e uno dei principali datori di lavoro del cantone tout court, con circa 5'000 collaboratrici e collaboratori.",
        "La rete ospedaliera EOC riunisce le strutture pubbliche dei quattro poli regionali — Bellinzona e Valli, Lugano, Locarno, Mendrisio — oltre a cliniche di riabilitazione, all'Istituto Oncologico della Svizzera Italiana (IOSI) e al Cardiocentro Ticino Institute. Ogni struttura ha specialità proprie ma condivide standard clinici, sistemi informativi e procedure HR, il che rende possibile per i collaboratori muoversi tra sedi in base a progetti, formazione e bisogni personali.",
        "EOC assume con regolarità sia personale sanitario (medici assistenti, capi clinica, infermieri, operatori socio-sanitari, tecnici di radiologia e di laboratorio, fisioterapisti, ostetriche, farmacisti, psicologi) sia profili non clinici: amministrazione, logistica, informatica, ingegneria clinica, facility management, comunicazione e project management. La maggior parte dei contratti è a tempo indeterminato, pieno o parziale, con possibilità di turni fissi o rotanti a seconda del servizio.",
        "Per i frontalieri italiani, EOC rappresenta una delle destinazioni più accessibili del cantone: i poli di Mendrisio e Lugano sono raggiungibili entro 30-45 minuti dai principali comuni italiani di confine (Como, Varese, Luino), mentre Bellinzona e Locarno sono serviti dalla linea ferroviaria TILO. L'ente accetta regolarmente candidature da frontalieri con Permesso G e valuta titoli di studio italiani con equipollenze gestite attraverso la Conferenza svizzera dei direttori cantonali della sanità (CDS).",
      ],
      sectionHeadings: {
        locations: 'Sedi e ospedali EOC',
        benefits: 'Perché lavorare in EOC',
        openRoles: 'Posizioni aperte oggi',
        howToApply: 'Come candidarsi in EOC',
        faq: 'Domande frequenti',
        about: "Chi è EOC",
      },
      howToApply: "Tutte le posizioni ufficiali di EOC sono pubblicate sul portale carriere eoc.ch/carriere e monitorate quotidianamente da Frontaliere Ticino. Il processo standard prevede: (1) candidatura online con CV aggiornato, lettera di motivazione e diplomi/equipollenze; (2) screening HR entro 2-3 settimane; (3) primo colloquio con HR e capo servizio; (4) secondo colloquio tecnico e/o prova pratica per ruoli clinici; (5) offerta contrattuale con indicazione di CCL/GAV applicabile, stipendio, orario e sede. Per professioni sanitarie regolamentate (medici, infermieri, ostetriche) è necessario il riconoscimento MEBEKO o della Croce Rossa Svizzera prima dell'assunzione.",
      benefits: [
        { title: '13ª mensilità + indennità', desc: 'Stipendio base su 13 mensilità, più indennità per turni notturni, festivi e di picchetto secondo CCL.' },
        { title: 'Previdenza professionale LPP', desc: 'Cassa pensione EOC con contributi datoriali superiori al minimo legale; copertura AVS/AI/IPG e infortuni LAINF.' },
        { title: 'Formazione continua finanziata', desc: 'Giorni e budget annuali per corsi, congressi, specializzazioni post-diploma e Master; programmi interni di mentoring.' },
        { title: 'Orario flessibile e part-time', desc: 'Percentuali dal 50% al 100% su molti ruoli; flessibilità per conciliazione famiglia-lavoro.' },
        { title: 'Mobilità tra sedi', desc: 'Possibilità di trasferirsi tra Bellinzona, Lugano, Locarno, Mendrisio o cliniche di riabilitazione durante il percorso professionale.' },
        { title: 'Ristorante aziendale convenzionato', desc: 'Mense interne a prezzi calmierati; sconti su assicurazioni malattia complementari e abbonamenti di trasporto.' },
        { title: 'Frontalieri benvenuti', desc: "L'ente gestisce contratti con Permesso G per collaboratori residenti in Italia e fornisce supporto per l'iter di equipollenza dei titoli.",
        },
        { title: 'Impatto sul territorio', desc: 'Medicina pubblica per tutta la popolazione del Ticino: un lavoro con senso, non orientato al profitto.' },
      ],
      faqs: [
        { q: 'EOC assume frontalieri italiani?', a: "Sì. EOC pubblica regolarmente offerte aperte a candidati con Permesso G, in particolare per infermieri, operatori socio-sanitari, medici assistenti e profili tecnici. L'ente supporta la procedura di equipollenza dei titoli italiani tramite la Croce Rossa Svizzera (professioni sanitarie non universitarie) o MEBEKO (medici) prima della firma del contratto." },
        { q: 'Quali sono gli stipendi medi in EOC?', a: 'Le retribuzioni seguono il contratto collettivo della sanità ticinese. Valori lordi annui indicativi (dati pubblici 2024-2025): infermiere diplomato 75-95 mila CHF, medico assistente 90-105 mila CHF, capo clinica 140-180 mila CHF, operatore socio-sanitario 60-72 mila CHF, tecnico di radiologia 80-95 mila CHF, amministrativo 65-80 mila CHF. Tredicesima mensilità inclusa. Usa il nostro simulatore fiscale per stimare il netto da frontaliere.' },
        { q: 'Che permessi di lavoro accetta EOC?', a: 'EOC assume cittadini svizzeri e titolari di Permesso C (domiciliato), B (soggiorno), G (frontaliere) e Li (cittadini UE/AELS). Per i ruoli sanitari regolamentati è richiesto il riconoscimento federale del titolo; EOC affianca il candidato nella procedura ma il riconoscimento deve essere ottenuto dal lavoratore.' },
        { q: 'Come candidarsi spontaneamente in EOC?', a: 'Il portale eoc.ch/carriere permette candidature spontanee per profilo (ad esempio "Cure infermieristiche" o "Amministrazione"). Queste candidature restano in banca dati e vengono riprese quando si apre una posizione compatibile. Consigliato aggiornarle ogni 6 mesi.' },
        { q: 'EOC offre posti di apprendistato o stage?', a: "Sì. EOC è formatrice riconosciuta per operatori socio-sanitari (OSS), operatori sociosanitari con attestato federale (AFC), impiegati di commercio, tecnici in assistenza farmaceutica e informatica. Offre inoltre stage per studenti di medicina, infermieristica SUPSI e università italiane in convenzione." },
        { q: 'Quanti dipendenti ha EOC?', a: "EOC impiega circa 5'000 collaboratori nelle sue strutture, distribuiti tra personale sanitario (infermieri, medici, terapisti), amministrativo, tecnico e di supporto. È il maggior datore di lavoro del Canton Ticino nel settore pubblico." },
        { q: "Dove sono gli ospedali EOC?", a: "EOC gestisce ospedali pubblici a Bellinzona (Ospedale San Giovanni e Acquarossa), Lugano (Ospedali Civico e Italiano), Locarno (Ospedale La Carità) e Mendrisio (Ospedale Beata Vergine), oltre alla Clinica di Riabilitazione di Novaggio e Faido e all'Istituto Oncologico della Svizzera Italiana (IOSI)." },
      ],
      locationsIntro: 'EOC gestisce una rete cantonale multisito: puoi scegliere la sede più vicina al tuo comune di residenza (anche italiano) o spostarti tra i presidi nel corso della carriera.',
      emptyStateNote: 'In questo momento non ci sono posizioni EOC attive nella nostra banca dati. Gli annunci vengono aggiornati ogni giorno dal crawler: torna domani oppure candidati spontaneamente sul portale ufficiale.',
      metaTitle: 'Lavorare in EOC | Offerte di lavoro Ente Ospedaliero Cantonale Ticino',
      metaDescription: 'EOC Ticino: posizioni aperte, stipendi, sedi (Bellinzona, Lugano, Locarno, Mendrisio), come candidarsi da frontaliere. Aggiornato ogni giorno.',
    },
    en: {
      h1: 'Careers at EOC — Ente Ospedaliero Cantonale, Canton Ticino',
      tagline: 'Public healthcare jobs in southern Switzerland: open roles, salaries, locations, how to apply.',
      paragraphs: [
        "Ente Ospedaliero Cantonale (EOC) is the main public healthcare provider for Canton Ticino, the Italian-speaking region of Switzerland. As a cantonal public-law body it runs the multi-site network of public hospitals and coordinates inpatient care for the whole of Italian Switzerland, handling more than 41,000 inpatients and nearly 700,000 outpatient visits every year. With about 5,000 staff, EOC is the largest healthcare employer in Ticino and one of the largest public employers in the canton.",
        "The EOC network brings together the four regional hospitals — Bellinzona e Valli, Lugano, Locarno and Mendrisio — together with rehabilitation clinics, the Oncology Institute of Southern Switzerland (IOSI) and the Cardiocentro Ticino Institute. Each site has its own specialties but shares clinical standards, information systems and HR procedures, so employees can move between sites during their career for projects, training or personal reasons.",
        "EOC hires both clinical staff (junior and senior doctors, nurses, healthcare assistants, radiology and lab technicians, physiotherapists, midwives, pharmacists, psychologists) and non-clinical profiles: administration, logistics, IT, clinical engineering, facility management, communications and project management. Most contracts are permanent, full or part time, with fixed or rotating shifts depending on the service.",
        "For Italian cross-border workers, EOC is one of the most accessible employers in Ticino: Mendrisio and Lugano are within 30–45 minutes of the main Italian border towns (Como, Varese, Luino), while Bellinzona and Locarno are served by the TILO cross-border train network. EOC regularly hires applicants with a Swiss G permit and supports the recognition of Italian qualifications via the Swiss Conference of Cantonal Health Directors (CDS).",
      ],
      sectionHeadings: {
        locations: 'EOC sites and hospitals',
        benefits: 'Why work at EOC',
        openRoles: 'Open positions today',
        howToApply: 'How to apply at EOC',
        faq: 'Frequently asked questions',
        about: 'About EOC',
      },
      howToApply: "All official EOC openings are published on the eoc.ch/careers portal and tracked daily by Frontaliere Ticino. The standard process is: (1) online application with up-to-date CV, cover letter and diplomas/equivalence papers; (2) HR screening within 2–3 weeks; (3) first interview with HR and department head; (4) second technical interview and/or practical test for clinical roles; (5) contract offer with applicable CCL/GAV collective agreement, salary, working hours and site. For regulated healthcare professions (doctors, nurses, midwives) federal recognition by MEBEKO or the Swiss Red Cross is required before starting.",
      benefits: [
        { title: '13th-month salary + allowances', desc: 'Base salary paid over 13 months plus night, weekend and on-call allowances under the applicable collective agreement.' },
        { title: 'LPP occupational pension', desc: 'EOC pension fund with employer contributions above the legal minimum; AHV/AI/IPG coverage and LAA accident insurance included.' },
        { title: 'Funded continuing education', desc: 'Annual days and budget for courses, congresses, post-graduate specialisations and master programmes; internal mentoring.' },
        { title: 'Flexible hours and part-time', desc: 'Many roles open at 50%–100% workload; flexibility for family-work balance.' },
        { title: 'Mobility between sites', desc: 'Option to move between Bellinzona, Lugano, Locarno, Mendrisio or rehabilitation clinics throughout your career.' },
        { title: 'Staff canteen and discounts', desc: 'In-house subsidised restaurants, discounts on supplementary health insurance and public-transport season tickets.' },
        { title: 'Cross-border workers welcome', desc: 'EOC issues G-permit contracts for employees living in Italy and supports the recognition of Italian qualifications.' },
        { title: 'Real public-health impact', desc: 'Public medicine for the entire Ticino population: meaningful, non-profit-driven work.' },
      ],
      faqs: [
        { q: 'Does EOC hire Italian cross-border workers?', a: 'Yes. EOC regularly posts roles open to G-permit applicants, especially for nurses, healthcare assistants, junior doctors and technical profiles. The employer supports the recognition of Italian qualifications via the Swiss Red Cross (non-university health professions) or MEBEKO (doctors) before the contract is signed.' },
        { q: 'What are typical EOC salaries?', a: 'Salaries follow the Ticino healthcare collective agreement. Indicative gross annual figures (2024–2025 public data): registered nurse CHF 75–95k, junior doctor CHF 90–105k, head physician CHF 140–180k, healthcare assistant CHF 60–72k, radiology technician CHF 80–95k, administrative staff CHF 65–80k. 13th month included. Use our tax simulator to estimate the net figure as a cross-border worker.' },
        { q: 'Which work permits does EOC accept?', a: 'EOC hires Swiss citizens and holders of C (settlement), B (residence), G (cross-border) and Li (EU/EFTA citizens) permits. Regulated clinical roles require federal recognition of the qualification; EOC supports the process but recognition must be obtained by the candidate.' },
        { q: 'How do I submit a speculative application?', a: 'The eoc.ch/careers portal lets you apply speculatively by profile (for example "Nursing" or "Administration"). These applications stay in the database and are considered when a matching role opens. Refresh them every 6 months.' },
        { q: 'Does EOC offer apprenticeships or internships?', a: 'Yes. EOC is an accredited training employer for healthcare assistants (AFC), commercial apprentices, pharmacy and IT technicians. It also offers placements for medical, SUPSI nursing and Italian university students under convention.' },
        { q: 'How large is EOC?', a: 'EOC employs about 5,000 staff across its facilities — clinical (nurses, doctors, therapists), administrative, technical and support. It is the largest public-sector employer in Canton Ticino.' },
        { q: 'Where are EOC hospitals located?', a: 'EOC operates public hospitals in Bellinzona (San Giovanni and Acquarossa), Lugano (Civico and Italiano), Locarno (La Carità) and Mendrisio (Beata Vergine), plus the Novaggio and Faido rehabilitation clinics and the IOSI oncology institute.' },
      ],
      locationsIntro: 'EOC runs a cantonal multi-site network: choose the location closest to where you live (including Italian border towns) or move between sites during your career.',
      emptyStateNote: 'No active EOC roles in our database right now. Listings refresh daily — come back tomorrow or apply speculatively on the official portal.',
      metaTitle: 'Jobs at EOC Ticino | Ente Ospedaliero Cantonale Careers Switzerland',
      metaDescription: 'EOC Ticino: open roles, salaries, sites (Bellinzona, Lugano, Locarno, Mendrisio), cross-border application guide. Refreshed daily.',
    },
    de: {
      h1: 'Arbeiten beim EOC — Ente Ospedaliero Cantonale, Kanton Tessin',
      tagline: 'Öffentliche Spitalmedizin im Südtessin: offene Stellen, Gehälter, Standorte, Bewerbung.',
      paragraphs: [
        "Das Ente Ospedaliero Cantonale (EOC) ist der wichtigste öffentliche Gesundheitsversorger im Kanton Tessin, der italienischsprachigen Region der Schweiz. Als kantonale Körperschaft öffentlichen Rechts betreibt es das Multi-Site-Netz der öffentlichen Spitäler und koordiniert die stationäre Versorgung für die gesamte italienische Schweiz, mit über 41'000 stationären Patientinnen und Patienten und fast 700'000 ambulanten Besuchen pro Jahr. Mit rund 5'000 Mitarbeitenden ist das EOC der grösste Gesundheitsarbeitgeber im Tessin und einer der grössten öffentlichen Arbeitgeber des Kantons.",
        'Das EOC-Netz umfasst die vier Regionalspitäler — Bellinzona e Valli, Lugano, Locarno und Mendrisio — sowie Rehabilitationskliniken, das Onkologieinstitut der italienischen Schweiz (IOSI) und das Cardiocentro Ticino Institute. Jeder Standort hat eigene Spezialitäten, teilt aber klinische Standards, Informationssysteme und HR-Prozesse, sodass Mitarbeitende während ihrer Karriere zwischen den Standorten wechseln können.',
        'Das EOC stellt sowohl klinisches Personal (Assistenz- und Kaderärzte, Pflegefachpersonen, Fachangestellte Gesundheit, Radiologie- und Laborfachpersonen, Physiotherapeuten, Hebammen, Apothekerinnen, Psychologinnen) als auch nicht-klinische Profile ein: Administration, Logistik, IT, klinische Technik, Facility Management, Kommunikation und Projektmanagement. Die meisten Verträge sind unbefristet, Voll- oder Teilzeit, mit festen oder rotierenden Diensten je nach Abteilung.',
        'Für italienische Grenzgängerinnen und Grenzgänger ist das EOC einer der am besten erreichbaren Arbeitgeber des Kantons: Mendrisio und Lugano liegen 30–45 Minuten von den wichtigsten italienischen Grenzstädten (Como, Varese, Luino) entfernt, während Bellinzona und Locarno an das TILO-Grenzgängernetz angeschlossen sind. Das EOC stellt regelmässig Kandidierende mit G-Bewilligung ein und unterstützt die Anerkennung italienischer Abschlüsse über die Schweizerische Konferenz der kantonalen Gesundheitsdirektorinnen und -direktoren (GDK).',
      ],
      sectionHeadings: {
        locations: 'EOC-Standorte und Spitäler',
        benefits: 'Warum beim EOC arbeiten',
        openRoles: 'Offene Stellen heute',
        howToApply: 'Bewerbung beim EOC',
        faq: 'Häufige Fragen',
        about: 'Über das EOC',
      },
      howToApply: "Alle offiziellen EOC-Stellen sind auf eoc.ch/carriere publiziert und werden von Frontaliere Ticino täglich erfasst. Der Standardablauf: (1) Online-Bewerbung mit aktuellem Lebenslauf, Motivationsschreiben und Diplomen/Anerkennungen; (2) HR-Screening innerhalb von 2–3 Wochen; (3) Erstgespräch mit HR und Abteilungsleitung; (4) technisches Zweitgespräch und/oder Probetag für klinische Rollen; (5) Vertragsangebot mit anwendbarem GAV/CCL, Lohn, Arbeitszeit und Standort. Für reglementierte Gesundheitsberufe (Ärzte, Pflegefachpersonen, Hebammen) ist vor Stellenantritt die eidgenössische Anerkennung durch MEBEKO oder das Schweizerische Rote Kreuz erforderlich.",
      benefits: [
        { title: '13. Monatslohn + Zulagen', desc: 'Grundgehalt auf 13 Monate, zusätzlich Nacht-, Wochenend- und Pikettzulagen gemäss GAV.' },
        { title: 'BVG-Pensionskasse', desc: 'EOC-Pensionskasse mit überobligatorischen Arbeitgeberbeiträgen; AHV/IV/EO und UVG inbegriffen.' },
        { title: 'Finanzierte Weiterbildung', desc: 'Jährliche Tage und Budget für Kurse, Kongresse, Nachdiplom-Spezialisierungen und Master; internes Mentoring.' },
        { title: 'Flexible Arbeitszeiten und Teilzeit', desc: 'Viele Rollen mit 50–100 % Pensum offen; Flexibilität für Vereinbarkeit von Familie und Beruf.' },
        { title: 'Mobilität zwischen Standorten', desc: 'Wechselmöglichkeit zwischen Bellinzona, Lugano, Locarno, Mendrisio oder Reha-Kliniken im Laufe der Karriere.' },
        { title: 'Betriebsrestaurant und Vergünstigungen', desc: 'Hausinterne Kantinen zu subventionierten Preisen, Rabatte auf Zusatzkrankenversicherungen und ÖV-Abos.' },
        { title: 'Grenzgänger willkommen', desc: 'Das EOC stellt G-Bewilligungs-Verträge für in Italien wohnhafte Mitarbeitende aus und unterstützt die Anerkennung italienischer Abschlüsse.' },
        { title: 'Gesellschaftlicher Impact', desc: 'Öffentliche Medizin für die gesamte Tessiner Bevölkerung: sinnstiftende, nicht gewinnorientierte Arbeit.' },
      ],
      faqs: [
        { q: 'Stellt das EOC italienische Grenzgänger ein?', a: 'Ja. Das EOC schreibt regelmässig Stellen aus, die für G-Bewilligungs-Bewerbende offen sind, insbesondere für Pflegefachpersonen, Fachangestellte Gesundheit, Assistenzärzte und technische Profile. Die Anerkennung italienischer Abschlüsse erfolgt über das Schweizerische Rote Kreuz (nicht-universitäre Berufe) oder MEBEKO (Ärzte) und wird vom Arbeitgeber unterstützt.' },
        { q: 'Wie hoch sind die EOC-Löhne?', a: "Die Löhne folgen dem Tessiner Gesundheits-GAV. Richtwerte brutto/Jahr (öffentliche Daten 2024–2025): dipl. Pflegefachperson 75–95 Tsd. CHF, Assistenzarzt 90–105 Tsd. CHF, Oberarzt 140–180 Tsd. CHF, Fachangestellte Gesundheit 60–72 Tsd. CHF, MTRA 80–95 Tsd. CHF, Verwaltung 65–80 Tsd. CHF. 13. Monatslohn inbegriffen. Nutzen Sie unseren Steuersimulator zur Berechnung des Nettos als Grenzgänger." },
        { q: 'Welche Aufenthaltsbewilligungen akzeptiert das EOC?', a: 'Das EOC stellt Schweizer Staatsangehörige sowie Inhaber der Bewilligungen C (Niederlassung), B (Aufenthalt), G (Grenzgänger) und Li (EU/EFTA) ein. Für reglementierte klinische Rollen ist die eidgenössische Diplomanerkennung erforderlich; der Arbeitgeber unterstützt, die Anerkennung selbst muss vom Bewerber eingeholt werden.' },
        { q: 'Wie funktioniert eine Spontanbewerbung?', a: 'Das Portal eoc.ch/carriere erlaubt Spontanbewerbungen nach Profil (z. B. "Pflege" oder "Verwaltung"). Diese bleiben in der Datenbank und werden bei passenden Öffnungen berücksichtigt. Empfohlene Auffrischung alle 6 Monate.' },
        { q: 'Bietet das EOC Lehrstellen oder Praktika?', a: 'Ja. Das EOC ist anerkannter Ausbildungsbetrieb für Fachangestellte Gesundheit (FaGe), Kaufmännische Angestellte, Pharmaassistentinnen und IT-Lernende. Zusätzlich Praktika für Medizin-, SUPSI-Pflege- und italienische Universitätsstudierende.' },
        { q: 'Wie viele Mitarbeitende hat das EOC?', a: "Das EOC beschäftigt rund 5'000 Personen an seinen Standorten — klinisches (Pflege, Ärzte, Therapeuten), administratives, technisches und unterstützendes Personal. Es ist der grösste öffentliche Arbeitgeber des Kantons Tessin." },
        { q: 'Wo befinden sich die EOC-Spitäler?', a: 'Das EOC betreibt öffentliche Spitäler in Bellinzona (San Giovanni, Acquarossa), Lugano (Civico und Italiano), Locarno (La Carità) und Mendrisio (Beata Vergine), dazu die Rehakliniken Novaggio und Faido sowie das Onkologieinstitut IOSI.' },
      ],
      locationsIntro: 'Das EOC betreibt ein kantonales Multi-Site-Netz: Wählen Sie den Standort, der am nächsten zu Ihrem Wohnort liegt (auch italienische Grenzgemeinden), oder wechseln Sie im Verlauf Ihrer Karriere.',
      emptyStateNote: 'Aktuell keine aktiven EOC-Stellen in unserer Datenbank. Die Angebote werden täglich aktualisiert — schauen Sie morgen wieder vorbei oder bewerben Sie sich spontan auf dem offiziellen Portal.',
      metaTitle: 'Jobs beim EOC Tessin | Ente Ospedaliero Cantonale Karriere',
      metaDescription: 'EOC Tessin: offene Stellen, Löhne, Standorte (Bellinzona, Lugano, Locarno, Mendrisio), Bewerbung als Grenzgänger. Täglich aktualisiert.',
    },
    fr: {
      h1: "Travailler à l'EOC — Ente Ospedaliero Cantonale, Canton du Tessin",
      tagline: 'Soins hospitaliers publics en Suisse italienne : postes ouverts, salaires, sites, comment postuler.',
      paragraphs: [
        "L'Ente Ospedaliero Cantonale (EOC) est le principal prestataire public de soins du Canton du Tessin, la région italophone de la Suisse. Organisme cantonal de droit public, il gère le réseau multi-sites des hôpitaux publics et coordonne les soins hospitaliers pour toute la Suisse italienne, avec plus de 41'000 patients hospitalisés et près de 700'000 visites ambulatoires par an. Avec environ 5'000 collaboratrices et collaborateurs, l'EOC est le plus grand employeur de santé du Tessin et l'un des principaux employeurs publics du canton.",
        "Le réseau EOC regroupe les quatre hôpitaux régionaux — Bellinzona e Valli, Lugano, Locarno et Mendrisio — ainsi que des cliniques de réadaptation, l'Istituto Oncologico della Svizzera Italiana (IOSI) et le Cardiocentro Ticino Institute. Chaque site dispose de ses propres spécialités mais partage des standards cliniques, des systèmes d'information et des procédures RH, ce qui permet aux employés de passer d'un site à l'autre au cours de leur carrière.",
        "L'EOC recrute à la fois du personnel clinique (médecins assistants et cadres, infirmières, assistants en soins, techniciens en radiologie et laboratoire, physiothérapeutes, sages-femmes, pharmaciennes, psychologues) et des profils non cliniques : administration, logistique, informatique, ingénierie clinique, facility management, communication et gestion de projet. La plupart des contrats sont à durée indéterminée, à temps plein ou partiel, avec des horaires fixes ou tournants selon le service.",
        "Pour les frontaliers italiens, l'EOC est l'un des employeurs les plus accessibles du canton : Mendrisio et Lugano sont à 30-45 minutes des principales villes frontalières italiennes (Côme, Varèse, Luino), tandis que Bellinzona et Locarno sont desservies par le réseau TILO. L'EOC engage régulièrement des candidats avec Permis G et accompagne la reconnaissance des titres italiens via la Conférence suisse des directrices et directeurs cantonaux de la santé (CDS).",
      ],
      sectionHeadings: {
        locations: 'Sites et hôpitaux EOC',
        benefits: "Pourquoi travailler à l'EOC",
        openRoles: 'Postes ouverts aujourd\'hui',
        howToApply: "Comment postuler à l'EOC",
        faq: 'Questions fréquentes',
        about: "À propos de l'EOC",
      },
      howToApply: "Toutes les offres officielles de l'EOC sont publiées sur eoc.ch/carriere et suivies quotidiennement par Frontaliere Ticino. Le processus standard : (1) candidature en ligne avec CV à jour, lettre de motivation et diplômes/équivalences ; (2) tri RH sous 2-3 semaines ; (3) premier entretien avec les RH et le chef de service ; (4) deuxième entretien technique et/ou essai pratique pour les rôles cliniques ; (5) offre contractuelle mentionnant la CCL/GAV applicable, le salaire, l'horaire et le site. Pour les professions de santé réglementées (médecins, infirmiers, sages-femmes), la reconnaissance fédérale par MEBEKO ou la Croix-Rouge suisse est requise avant l'entrée en fonction.",
      benefits: [
        { title: '13e mois + indemnités', desc: 'Salaire de base sur 13 mois, plus indemnités de nuit, week-end et piquet selon CCL.' },
        { title: 'Prévoyance LPP', desc: 'Caisse de pension EOC avec cotisations employeur supérieures au minimum légal ; AVS/AI/APG et LAA compris.' },
        { title: 'Formation continue financée', desc: 'Jours et budget annuels pour cours, congrès, spécialisations post-diplôme et Masters ; mentorat interne.' },
        { title: 'Horaires flexibles et temps partiel', desc: 'Nombreux rôles ouverts à 50-100% ; flexibilité famille-travail.' },
        { title: 'Mobilité entre sites', desc: 'Possibilité de changer entre Bellinzona, Lugano, Locarno, Mendrisio ou cliniques de réadaptation au fil de la carrière.' },
        { title: 'Restaurant d\'entreprise et avantages', desc: 'Cantines internes à tarif préférentiel, rabais sur assurances-maladie complémentaires et abonnements de transport.' },
        { title: 'Frontaliers bienvenus', desc: "L'EOC établit des contrats Permis G pour les collaborateurs résidant en Italie et accompagne la reconnaissance des titres italiens." },
        { title: 'Impact sur la santé publique', desc: "Médecine publique pour toute la population tessinoise : un travail porteur de sens, hors logique de profit.",
        },
      ],
      faqs: [
        { q: "L'EOC engage-t-il des frontaliers italiens ?", a: "Oui. L'EOC publie régulièrement des postes ouverts aux candidats avec Permis G, notamment pour infirmiers, assistants en soins, médecins assistants et profils techniques. L'employeur accompagne la reconnaissance des titres italiens via la Croix-Rouge suisse (professions non universitaires) ou MEBEKO (médecins) avant la signature." },
        { q: 'Quels sont les salaires chez EOC ?', a: 'Les salaires suivent la CCL de la santé tessinoise. Valeurs brutes annuelles indicatives (données publiques 2024-2025) : infirmière diplômée 75-95 kCHF, médecin assistant 90-105 kCHF, médecin-chef 140-180 kCHF, assistante en soins 60-72 kCHF, TRM 80-95 kCHF, administratif 65-80 kCHF. 13e mois inclus. Utilisez notre simulateur fiscal pour estimer le net frontalier.' },
        { q: "Quels permis l'EOC accepte-t-il ?", a: "L'EOC engage des citoyens suisses et des titulaires de permis C (établissement), B (séjour), G (frontalier) et Li (UE/AELE). Les rôles cliniques réglementés exigent la reconnaissance fédérale ; l'EOC accompagne la démarche mais elle est obtenue par le candidat." },
        { q: 'Comment faire une candidature spontanée ?', a: "Le portail eoc.ch/carriere permet des candidatures spontanées par profil (par exemple « Soins » ou « Administration »). Elles restent en base et sont réexaminées à l'ouverture d'un poste compatible. Rafraîchir tous les 6 mois.",
        },
        { q: "L'EOC propose-t-il apprentissages et stages ?", a: "Oui. L'EOC est entreprise formatrice reconnue pour les assistants en soins (AFC), employés de commerce, assistants en pharmacie et informatique. Stages également pour étudiants en médecine, soins SUPSI et universités italiennes conventionnées." },
        { q: "Combien l'EOC compte-t-il de collaborateurs ?", a: "L'EOC emploie environ 5'000 personnes — personnel clinique (infirmiers, médecins, thérapeutes), administratif, technique et de soutien. C'est le plus grand employeur public du Canton du Tessin." },
        { q: "Où se trouvent les hôpitaux EOC ?", a: "L'EOC exploite des hôpitaux publics à Bellinzona (San Giovanni et Acquarossa), Lugano (Civico et Italiano), Locarno (La Carità) et Mendrisio (Beata Vergine), ainsi que les cliniques de réadaptation de Novaggio et Faido et l'institut d'oncologie IOSI." },
      ],
      locationsIntro: "L'EOC gère un réseau cantonal multi-sites : choisissez le site le plus proche de votre domicile (villes frontalières italiennes incluses) ou changez de site au cours de votre carrière.",
      emptyStateNote: "Aucun poste EOC actif dans notre base pour le moment. Les annonces sont actualisées quotidiennement — revenez demain ou postulez spontanément sur le portail officiel.",
      metaTitle: 'Emplois EOC Tessin | Carrières Ente Ospedaliero Cantonale',
      metaDescription: 'EOC Tessin : postes ouverts, salaires, sites (Bellinzona, Lugano, Locarno, Mendrisio), candidature frontalière. Mis à jour chaque jour.',
    },
  },
};

export const EMPLOYER_BRANDS: Readonly<Record<string, EmployerBrand>> = {
  [EOC.brandKey]: EOC,
} as const;

/**
 * Canonical slug helper — mirrors the logic in
 * `components/community/JobBoard.tsx::canonicalCompanyRouteSlug` and
 * `build-plugins/jobsSeoPagesPlugin.ts::canonicalCompanySlugBuild`.
 *
 * Kept here (rather than imported) to avoid a cycle with JobBoard while
 * keeping the registry usable from both client components and build plugins.
 */
export function canonicalEmployerBrandKey(company: string, companyKey?: string): string {
  const norm = (s: string): string =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const keyNorm = norm(String(companyKey || ''));
  const nameNorm = norm(String(company || ''));
  if (keyNorm.includes('lidl') || nameNorm.includes('lidl')) return 'lidl';
  return String(company || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();
}

export function getEmployerBrandBySlug(slug: string): EmployerBrand | null {
  if (!slug) return null;
  return EMPLOYER_BRANDS[slug] ?? null;
}

export function getEmployerBrandForCompany(
  company: string | undefined,
  companyKey?: string | undefined,
): EmployerBrand | null {
  const slug = canonicalEmployerBrandKey(String(company || ''), companyKey);
  return getEmployerBrandBySlug(slug);
}

export function listEmployerBrandKeys(): readonly string[] {
  return Object.keys(EMPLOYER_BRANDS);
}
