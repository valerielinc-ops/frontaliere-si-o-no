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

// ─────────────────────────────────────────────────────────────────────────────
// Lidl Schweiz / Lidl Svizzera
// Source: https://www.lidl.ch (verified 2026-04)
// Canonical slug collapses all Lidl variants to "lidl" (see JobBoard).
// ─────────────────────────────────────────────────────────────────────────────

const LIDL: EmployerBrand = {
  brandKey: 'lidl',
  name: 'Lidl Svizzera',
  shortName: 'Lidl',
  fullName: 'Lidl Schweiz DL AG',
  website: 'https://www.lidl.ch',
  careersUrl: 'https://jobs.lidl.ch',
  locations: [
    'Sede centrale e centro di distribuzione Weinfelden (TG)',
    'Centro di distribuzione Sévaz (FR)',
    'Filiali in Ticino: Agno, Bellinzona, Biasca, Grancia, Lugano, Losone, Mendrisio, S. Antonino, Taverne, Tenero',
    'Oltre 170 filiali in tutta la Svizzera',
  ],
  headquarters: {
    streetAddress: 'Schaffhauserstrasse 5',
    postalCode: '8500',
    addressLocality: 'Weinfelden',
    addressRegion: 'TG',
    addressCountry: 'CH',
  },
  sameAs: [
    'https://www.linkedin.com/company/lidl-schweiz',
    'https://de.wikipedia.org/wiki/Lidl',
  ],
  copy: {
    it: {
      h1: 'Lavorare in Lidl Svizzera — filiali e logistica in Ticino',
      tagline: 'Offerte di lavoro Lidl in Ticino: cassa, scaffali, apprendistato, logistica. Stipendi, sedi, come candidarsi.',
      paragraphs: [
        "Lidl Svizzera (Lidl Schweiz DL AG) è la filiale elvetica del gruppo Schwarz, uno dei più grandi retailer alimentari d'Europa. Entrata nel mercato svizzero nel 2009, Lidl gestisce oggi oltre 170 filiali distribuite in tutti i cantoni, con la sede centrale a Weinfelden (Turgovia) e due centri logistici principali a Weinfelden e Sévaz (Friburgo). Il modello di business è quello del discount di qualità: assortimento compatto (circa 1'600 referenze), prezzi aggressivi, forte peso di prodotti a marca propria e crescente quota di referenze svizzere, biologiche e Fairtrade.",
        "In Ticino, Lidl gestisce una decina di filiali nelle principali località del cantone — Lugano, Mendrisio, Bellinzona, Locarno/Losone, Agno, Grancia, Biasca, S. Antonino, Taverne, Tenero — a cui si aggiungono le assunzioni di personale per le filiali del Moesano (GR) e del Sopraceneri. I punti vendita ticinesi sono al centro di un bacino di impiego naturale per i frontalieri italiani, con orari di apertura estesi e una presenza capillare lungo gli assi autostradali A2 e A13.",
        "I profili più ricercati sono Collaboratore/trice di filiale (cassa, scaffali, freschi), Sostituto/a Responsabile di filiale, Responsabile di filiale, apprendisti nel commercio al dettaglio, personale per la panetteria interna e autisti di camion con CQC per il centro logistico. A livello di gruppo, Lidl Svizzera assume anche profili di sede a Weinfelden (acquisti, controllo qualità, immobiliare, IT, marketing, HR) e a Sévaz (logistica, sicurezza, manutenzione). La maggior parte dei contratti sono a tempo indeterminato, con possibilità di part-time dal 40% al 100%.",
        "Per i frontalieri italiani Lidl è un datore di lavoro accessibile: le filiali del Mendrisiotto e del Luganese sono raggiungibili in 20-45 minuti dai principali comuni di confine, l'azienda accetta candidati con Permesso G senza richiedere esperienza pregressa nella grande distribuzione svizzera e la formazione iniziale è interamente a carico dell'azienda. Lidl Svizzera è firmataria di un contratto collettivo di lavoro (CCL) a livello nazionale che garantisce salari minimi sopra la media del settore retail e un pacchetto di prestazioni sociali completo.",
      ],
      sectionHeadings: {
        locations: 'Sedi e filiali Lidl in Ticino',
        benefits: 'Perché lavorare in Lidl',
        openRoles: 'Posizioni aperte oggi',
        howToApply: 'Come candidarsi in Lidl',
        faq: 'Domande frequenti',
        about: 'Chi è Lidl Svizzera',
      },
      howToApply: "Tutte le posizioni ufficiali Lidl Svizzera sono pubblicate su jobs.lidl.ch e monitorate quotidianamente da Frontaliere Ticino. Il processo prevede: (1) candidatura online con CV e lettera di motivazione tramite il portale; (2) screening iniziale entro 1-2 settimane da parte del team HR regionale; (3) colloquio presso la filiale o sede con il Responsabile di filiale / Responsabile di regione; (4) giornata di prova pagata per i ruoli di filiale, colloquio tecnico per i ruoli di sede; (5) offerta contrattuale con indicazione di stipendio, orario, sede e CCL applicabile. Per i ruoli di filiale la decisione è di norma rapida (2-4 settimane dalla candidatura alla firma).",
      benefits: [
        { title: '13ª mensilità contrattuale', desc: 'Stipendio di base su 13 mensilità secondo il CCL Lidl Svizzera, con revisione salariale annuale.' },
        { title: 'Sconto dipendente 10%', desc: 'Sconto del 10% su tutti gli acquisti nelle filiali Lidl Svizzera per collaboratori e familiari conviventi.' },
        { title: 'Formazione e carriera interna', desc: 'Percorsi strutturati di crescita da collaboratore a Sostituto Responsabile e Responsabile di filiale; academy interna e apprendistati AFC.' },
        { title: 'Orari pianificati in anticipo', desc: 'Pianificazione dei turni pubblicata con settimane di anticipo; possibilità di part-time dal 40% al 100%.' },
        { title: 'Previdenza professionale LPP', desc: 'Cassa pensione del gruppo Schwarz con contributi datoriali superiori al minimo legale; LAINF inclusa.' },
        { title: 'Frontalieri benvenuti', desc: 'Lidl assume regolarmente titolari di Permesso G per le filiali ticinesi senza richiedere esperienza pregressa.' },
      ],
      faqs: [
        { q: 'Lidl Svizzera assume frontalieri italiani?', a: "Sì. Le filiali ticinesi di Lidl Svizzera pubblicano regolarmente posizioni per collaboratori di filiale, sostituti responsabili e apprendisti aperte ai titolari di Permesso G. Per i ruoli di sede a Weinfelden il pendolarismo dall'Italia non è praticabile; per le filiali e il centro di distribuzione svizzero-italiano sì." },
        { q: 'Che stipendio paga Lidl in Svizzera?', a: "Lidl Svizzera applica un CCL con salari di base pubblicamente documentati tra i più alti del settore retail discount. Valori lordi indicativi (fonte: comunicazioni aziendali e portale jobs.lidl.ch): collaboratore di filiale debutante CHF 4'500-4'800/mese x 13, sostituto responsabile CHF 5'500-6'200 x 13, responsabile di filiale CHF 7'000-8'500 x 13, autista camion CQC CHF 5'200-6'000 x 13. Tredicesima e indennità serali inclusi." },
        { q: 'Quali permessi accetta Lidl?', a: 'Lidl accetta candidati con cittadinanza svizzera o permessi C, B, G e Li (UE/AELS). Per i ruoli di filiale in Ticino il Permesso G è pienamente supportato; la documentazione viene gestita dal team HR regionale al momento della firma.' },
        { q: 'Lidl offre apprendistato in Ticino?', a: "Sì. Lidl Svizzera è azienda formatrice riconosciuta per l'apprendistato di Impiegato/a del commercio al dettaglio AFC (3 anni) e Assistente del commercio al dettaglio AFC (2 anni). Ogni anno vengono assunti apprendisti nelle filiali ticinesi; le candidature si aprono in autunno per l'inizio dell'anno scolastico successivo." },
        { q: 'Come candidarsi spontaneamente in Lidl?', a: "Il portale jobs.lidl.ch permette candidature spontanee per profilo (filiale, logistica, sede) e regione. Le candidature restano in banca dati e vengono richiamate quando si apre una posizione compatibile nella zona indicata. Raccomandato aggiornare CV e preferenze ogni 6 mesi.",
        },
        { q: 'Quante filiali ha Lidl in Ticino?', a: 'Lidl è presente in Ticino con una decina di filiali distribuite tra Mendrisiotto, Luganese, Bellinzonese e Locarnese, oltre a punti vendita nel Moesano (GR) serviti dallo stesso team regionale. Il portafoglio viene esteso regolarmente con nuove aperture.' },
      ],
      locationsIntro: "Lidl Svizzera gestisce una rete capillare di filiali in tutto il Ticino. Puoi candidarti per la filiale più vicina al tuo comune di residenza e richiedere trasferimenti interni dopo il periodo di prova.",
      emptyStateNote: 'In questo momento non ci sono posizioni Lidl Svizzera attive nella nostra banca dati. Gli annunci vengono aggiornati ogni giorno dal crawler: torna domani oppure candidati sul portale ufficiale jobs.lidl.ch.',
      metaTitle: 'Lavorare in Lidl Svizzera | Offerte di lavoro Ticino',
      metaDescription: 'Lidl Svizzera: filiali in Ticino, stipendi, apprendistato, come candidarsi da frontaliere. Offerte aggiornate ogni giorno.',
    },
    en: {
      h1: 'Careers at Lidl Switzerland — stores and logistics across Ticino',
      tagline: 'Lidl jobs in Canton Ticino: store roles, apprenticeships, logistics. Salaries, sites, how to apply.',
      paragraphs: [
        "Lidl Switzerland (Lidl Schweiz DL AG) is the Swiss subsidiary of the Schwarz Group, one of Europe's largest food retailers. It entered the Swiss market in 2009 and today operates more than 170 stores across every canton, with headquarters in Weinfelden (Thurgau) and two main distribution centres in Weinfelden and Sévaz (Fribourg). The business model is quality discount: a compact assortment of around 1,600 products, aggressive pricing, strong private-label presence and a growing share of Swiss, organic and Fairtrade items.",
        'In Canton Ticino, Lidl operates about ten stores in the main locations — Lugano, Mendrisio, Bellinzona, Locarno/Losone, Agno, Grancia, Biasca, S. Antonino, Taverne, Tenero — plus roles in the Moesa valley (GR) and the Sopraceneri. Ticino stores sit inside a natural hiring catchment for Italian cross-border workers, with extended opening hours and dense coverage along the A2 and A13 motorways.',
        'The most sought-after profiles are Store Assistant (cashier, shelves, fresh produce), Assistant Store Manager, Store Manager, retail apprentices, in-store bakery staff and truck drivers with CQC for the distribution centre. At group level Lidl Switzerland also hires HQ profiles in Weinfelden (buying, quality, real estate, IT, marketing, HR) and Sévaz (logistics, safety, maintenance). Most contracts are permanent, with part-time options from 40% to 100%.',
        'For Italian cross-border workers Lidl is an accessible employer: Mendrisiotto and Luganese stores are 20–45 minutes from the main border towns, the company hires G-permit candidates without requiring prior Swiss retail experience, and initial training is fully paid for by the employer. Lidl Switzerland signs a national collective labour agreement (CLA) that guarantees starting salaries above the retail-sector average and a complete social-benefits package.',
      ],
      sectionHeadings: {
        locations: 'Lidl sites and stores in Ticino',
        benefits: 'Why work at Lidl',
        openRoles: 'Open positions today',
        howToApply: 'How to apply at Lidl',
        faq: 'Frequently asked questions',
        about: 'About Lidl Switzerland',
      },
      howToApply: 'All official Lidl Switzerland openings are published on jobs.lidl.ch and tracked daily by Frontaliere Ticino. The process: (1) online application with CV and cover letter through the portal; (2) initial screening within 1–2 weeks by the regional HR team; (3) interview at the store or office with the Store Manager / Regional Manager; (4) paid trial day for store roles, technical interview for HQ roles; (5) contract offer with salary, hours, site and applicable CLA. Store decisions are usually fast — 2 to 4 weeks from application to signature.',
      benefits: [
        { title: '13th-month salary (CLA)', desc: 'Base salary over 13 months under the Lidl Switzerland collective agreement, with annual salary review.' },
        { title: '10% employee discount', desc: '10% discount on all purchases in Lidl Switzerland stores for employees and cohabiting family members.' },
        { title: 'Training and internal career', desc: 'Structured growth path from Store Assistant to Assistant Store Manager and Store Manager; internal academy and Swiss AFC apprenticeships.' },
        { title: 'Schedules planned in advance', desc: 'Shift schedules published weeks ahead; part-time options from 40% to 100%.' },
        { title: 'LPP occupational pension', desc: 'Schwarz-group pension fund with employer contributions above the legal minimum; LAA accident insurance included.' },
        { title: 'Cross-border workers welcome', desc: 'Lidl regularly hires G-permit holders for Ticino stores without requiring previous experience.' },
      ],
      faqs: [
        { q: 'Does Lidl Switzerland hire Italian cross-border workers?', a: 'Yes. Ticino stores regularly post roles for store assistants, assistant managers and apprentices open to G-permit applicants. HQ roles in Weinfelden are not commutable from Italy; Ticino stores and the Sévaz logistics centre in Italian-speaking operations are.' },
        { q: 'What does Lidl pay in Switzerland?', a: 'Lidl Switzerland applies a national CLA with publicly documented starting salaries among the highest in discount retail. Indicative gross figures (source: company communications and jobs.lidl.ch): entry store assistant CHF 4,500–4,800/month × 13, assistant store manager CHF 5,500–6,200 × 13, store manager CHF 7,000–8,500 × 13, truck driver with CQC CHF 5,200–6,000 × 13. 13th-month and evening allowances included.' },
        { q: 'Which work permits does Lidl accept?', a: 'Lidl accepts Swiss citizens and C, B, G and Li (EU/EFTA) permits. For Ticino store roles the G permit is fully supported; paperwork is handled by regional HR at contract signature.' },
        { q: 'Does Lidl offer apprenticeships in Ticino?', a: 'Yes. Lidl Switzerland is an accredited apprenticeship employer for AFC Retail Employee (3 years) and AFC Retail Assistant (2 years). New apprentices are hired every year in Ticino stores; applications open in autumn for the following school year.' },
        { q: 'How do I submit a speculative application?', a: 'The jobs.lidl.ch portal accepts speculative applications by profile (store, logistics, HQ) and region. Applications stay in the database and are considered when a matching role opens in the preferred area. Refresh your CV and preferences every 6 months.' },
        { q: 'How many Lidl stores are there in Ticino?', a: 'Lidl operates about ten stores in Ticino across the Mendrisiotto, Luganese, Bellinzonese and Locarnese areas, plus stores in the Moesa valley (GR) served by the same regional team. The network is regularly extended with new openings.' },
      ],
      locationsIntro: 'Lidl Switzerland runs a dense store network across Ticino. Apply to the store closest to where you live and request internal transfers after the probation period.',
      emptyStateNote: 'No active Lidl Switzerland roles in our database right now. Listings refresh daily — come back tomorrow or apply on the official jobs.lidl.ch portal.',
      metaTitle: 'Jobs at Lidl Switzerland | Open roles in Canton Ticino',
      metaDescription: 'Lidl Switzerland: Ticino stores, salaries, apprenticeships, cross-border application guide. Refreshed daily.',
    },
    de: {
      h1: 'Arbeiten bei Lidl Schweiz — Filialen und Logistik im Tessin',
      tagline: 'Lidl-Stellen im Kanton Tessin: Kasse, Regale, Lehrstellen, Logistik. Löhne, Standorte, Bewerbung.',
      paragraphs: [
        "Lidl Schweiz (Lidl Schweiz DL AG) ist die Schweizer Tochter der Schwarz-Gruppe, einer der grössten Lebensmittelhändler Europas. Der Markteintritt erfolgte 2009; heute betreibt Lidl über 170 Filialen in allen Kantonen, mit Hauptsitz in Weinfelden (Thurgau) und zwei zentralen Logistikzentren in Weinfelden und Sévaz (Freiburg). Das Geschäftsmodell ist Qualitäts-Discount: kompaktes Sortiment von rund 1'600 Artikeln, aggressive Preise, starker Eigenmarkenanteil und steigender Anteil an Schweizer, Bio- und Fairtrade-Produkten.",
        'Im Tessin betreibt Lidl rund zehn Filialen an den wichtigsten Standorten — Lugano, Mendrisio, Bellinzona, Locarno/Losone, Agno, Grancia, Biasca, S. Antonino, Taverne, Tenero — dazu Stellen im Moesatal (GR) und Sopraceneri. Die Tessiner Filialen liegen im natürlichen Einzugsgebiet italienischer Grenzgänger, mit verlängerten Öffnungszeiten und dichter Abdeckung entlang der Autobahnen A2 und A13.',
        'Die gefragtesten Profile sind Filialmitarbeitende (Kasse, Regale, Frische), stellvertretende und Filialleitung, Lernende im Detailhandel, Personal für die interne Bäckerei sowie Lastwagenchauffeure mit CZV fürs Logistikzentrum. Auf Konzernebene stellt Lidl Schweiz zusätzlich HQ-Profile in Weinfelden (Einkauf, Qualität, Immobilien, IT, Marketing, HR) und Sévaz (Logistik, Sicherheit, Unterhalt) ein. Die meisten Verträge sind unbefristet, mit Teilzeit-Optionen von 40 bis 100 %.',
        'Für italienische Grenzgänger ist Lidl ein gut erreichbarer Arbeitgeber: Filialen im Mendrisiotto und Luganese liegen 20–45 Minuten von den wichtigsten Grenzgemeinden entfernt, Bewerbungen mit G-Bewilligung werden ohne Vorerfahrung im Schweizer Detailhandel berücksichtigt, und die Einarbeitung wird vollständig vom Arbeitgeber bezahlt. Lidl Schweiz ist Unterzeichner eines nationalen GAV, der Einstiegslöhne oberhalb des Branchendurchschnitts sowie ein vollständiges Sozialleistungspaket garantiert.',
      ],
      sectionHeadings: {
        locations: 'Lidl-Standorte und Filialen im Tessin',
        benefits: 'Warum bei Lidl arbeiten',
        openRoles: 'Offene Stellen heute',
        howToApply: 'Bewerbung bei Lidl',
        faq: 'Häufige Fragen',
        about: 'Über Lidl Schweiz',
      },
      howToApply: 'Alle offiziellen Lidl-Stellen werden auf jobs.lidl.ch veröffentlicht und von Frontaliere Ticino täglich erfasst. Der Ablauf: (1) Online-Bewerbung mit Lebenslauf und Motivationsschreiben; (2) Erstsichtung innerhalb 1–2 Wochen durch das regionale HR-Team; (3) Gespräch in der Filiale oder am Sitz mit der Filial- oder Regionalleitung; (4) bezahlter Schnuppertag für Filialrollen, Fachgespräch für HQ-Rollen; (5) Vertragsangebot mit Lohn, Arbeitszeit, Standort und GAV. Filialentscheide sind üblicherweise rasch — 2 bis 4 Wochen von der Bewerbung bis zur Unterschrift.',
      benefits: [
        { title: '13. Monatslohn (GAV)', desc: 'Grundlohn auf 13 Monate gemäss Lidl-GAV, mit jährlicher Lohnrunde.' },
        { title: '10 % Mitarbeiterrabatt', desc: '10 % Rabatt auf alle Einkäufe in Lidl-Schweiz-Filialen für Mitarbeitende und im Haushalt lebende Angehörige.' },
        { title: 'Ausbildung und interne Karriere', desc: 'Strukturierter Entwicklungspfad vom Filialmitarbeitenden zur stellvertretenden und Filialleitung; interne Academy und AFC-Lehrstellen.' },
        { title: 'Langfristige Schichtplanung', desc: 'Einsatzpläne werden Wochen im Voraus publiziert; Teilzeit-Optionen von 40 bis 100 %.' },
        { title: 'BVG-Pensionskasse', desc: 'Pensionskasse der Schwarz-Gruppe mit überobligatorischen Arbeitgeberbeiträgen; UVG inbegriffen.' },
        { title: 'Grenzgänger willkommen', desc: 'Lidl stellt für Tessiner Filialen regelmässig G-Bewilligungs-Inhaber ohne Vorerfahrung ein.' },
      ],
      faqs: [
        { q: 'Stellt Lidl Schweiz italienische Grenzgänger ein?', a: 'Ja. Tessiner Filialen schreiben regelmässig Stellen für Filialmitarbeitende, Stellvertretende Filialleitung und Lernende aus, die für G-Bewilligungs-Bewerbende offen sind. HQ-Rollen in Weinfelden sind aus Italien nicht pendelbar; Tessiner Filialen und der Logistikbetrieb schon.' },
        { q: 'Wie hoch sind die Lidl-Löhne in der Schweiz?', a: "Lidl Schweiz wendet einen nationalen GAV an, mit öffentlich dokumentierten Einstiegslöhnen an der Spitze des Discount-Detailhandels. Richtwerte brutto (Quelle: Unternehmenskommunikation, jobs.lidl.ch): Einstieg Filiale CHF 4'500–4'800/Monat × 13, Stellvertretung CHF 5'500–6'200 × 13, Filialleitung CHF 7'000–8'500 × 13, LKW-Chauffeur mit CZV CHF 5'200–6'000 × 13. 13. Monatslohn und Abendzulagen inbegriffen." },
        { q: 'Welche Bewilligungen akzeptiert Lidl?', a: 'Lidl stellt Schweizer Staatsangehörige und Inhaber der Bewilligungen C, B, G und Li (EU/EFTA) ein. Für Tessiner Filialrollen ist die G-Bewilligung vollständig unterstützt; die Administration erfolgt durch das regionale HR-Team bei Vertragsunterzeichnung.' },
        { q: 'Bietet Lidl Lehrstellen im Tessin?', a: 'Ja. Lidl Schweiz ist anerkannter Ausbildungsbetrieb für Detailhandelsfachfrau/-mann EFZ (3 Jahre) und Detailhandelsassistent/in EBA (2 Jahre). Jedes Jahr werden Lernende in Tessiner Filialen eingestellt; Bewerbungen öffnen im Herbst für das folgende Schuljahr.' },
        { q: 'Wie funktioniert eine Spontanbewerbung?', a: 'Das Portal jobs.lidl.ch erlaubt Spontanbewerbungen nach Profil (Filiale, Logistik, HQ) und Region. Die Bewerbungen bleiben in der Datenbank und werden bei passenden Öffnungen berücksichtigt. Lebenslauf und Präferenzen alle 6 Monate auffrischen.' },
        { q: 'Wie viele Lidl-Filialen gibt es im Tessin?', a: 'Lidl ist im Tessin mit rund zehn Filialen im Mendrisiotto, Luganese, Bellinzonese und Locarnese vertreten, dazu Standorte im Moesatal (GR), die vom selben Regionalteam betreut werden. Das Netz wird laufend mit neuen Eröffnungen erweitert.' },
      ],
      locationsIntro: 'Lidl Schweiz betreibt ein dichtes Filialnetz im ganzen Tessin. Bewerben Sie sich für die Filiale am nächsten zum Wohnort und beantragen Sie interne Wechsel nach der Probezeit.',
      emptyStateNote: 'Aktuell keine aktiven Lidl-Stellen in unserer Datenbank. Die Angebote werden täglich aktualisiert — schauen Sie morgen wieder vorbei oder bewerben Sie sich auf jobs.lidl.ch.',
      metaTitle: 'Jobs bei Lidl Schweiz | Offene Stellen Kanton Tessin',
      metaDescription: 'Lidl Schweiz: Tessiner Filialen, Löhne, Lehrstellen, Grenzgänger-Bewerbung. Täglich aktualisiert.',
    },
    fr: {
      h1: 'Travailler chez Lidl Suisse — magasins et logistique au Tessin',
      tagline: 'Emplois Lidl au Tessin : caisse, rayons, apprentissage, logistique. Salaires, sites, comment postuler.',
      paragraphs: [
        "Lidl Suisse (Lidl Schweiz DL AG) est la filiale suisse du groupe Schwarz, l'un des plus grands distributeurs alimentaires d'Europe. Entrée sur le marché suisse en 2009, Lidl exploite aujourd'hui plus de 170 magasins dans tous les cantons, avec siège central à Weinfelden (Thurgovie) et deux centres logistiques principaux à Weinfelden et à Sévaz (Fribourg). Le modèle d'affaires est celui du hard-discount qualitatif : assortiment compact d'environ 1'600 références, prix agressifs, forte part de marques propres et part croissante de produits suisses, biologiques et Fairtrade.",
        "Au Tessin, Lidl exploite une dizaine de magasins dans les principales localités — Lugano, Mendrisio, Bellinzona, Locarno/Losone, Agno, Grancia, Biasca, S. Antonino, Taverne, Tenero — avec également des postes dans la vallée de Mesolcina (GR) et le Sopraceneri. Les magasins tessinois sont dans le bassin d'emploi naturel des frontaliers italiens, avec des horaires d'ouverture étendus et une forte densité le long des autoroutes A2 et A13.",
        "Les profils les plus recherchés sont Collaborateur/trice de filiale (caisse, rayons, frais), Adjoint/e Responsable de filiale, Responsable de filiale, apprentis du commerce de détail, personnel pour la boulangerie interne et chauffeurs poids-lourds avec OACP pour le centre logistique. Au niveau groupe, Lidl Suisse recrute également des profils siège à Weinfelden (achats, qualité, immobilier, IT, marketing, RH) et à Sévaz (logistique, sécurité, maintenance). La majorité des contrats sont à durée indéterminée, avec temps partiel de 40 à 100 %.",
        'Pour les frontaliers italiens, Lidl est un employeur accessible : les magasins du Mendrisiotto et du Luganese sont à 20–45 minutes des principales communes frontalières, les candidatures avec Permis G sont acceptées sans exiger d\'expérience préalable dans la grande distribution suisse, et la formation initiale est entièrement à la charge de l\'employeur. Lidl Suisse est signataire d\'une CCL nationale qui garantit des salaires de départ au-dessus de la moyenne du secteur et un paquet social complet.',
      ],
      sectionHeadings: {
        locations: 'Sites et magasins Lidl au Tessin',
        benefits: 'Pourquoi travailler chez Lidl',
        openRoles: 'Postes ouverts aujourd\'hui',
        howToApply: 'Comment postuler chez Lidl',
        faq: 'Questions fréquentes',
        about: 'À propos de Lidl Suisse',
      },
      howToApply: "Toutes les offres officielles Lidl Suisse sont publiées sur jobs.lidl.ch et suivies chaque jour par Frontaliere Ticino. Le processus : (1) candidature en ligne avec CV et lettre de motivation ; (2) tri initial sous 1-2 semaines par l'équipe RH régionale ; (3) entretien en magasin ou au siège avec le Responsable de filiale / Responsable de région ; (4) journée d'essai rémunérée pour les rôles de filiale, entretien technique pour les rôles siège ; (5) offre contractuelle avec salaire, horaires, site et CCL applicable. Les décisions magasin sont rapides — 2 à 4 semaines entre candidature et signature.",
      benefits: [
        { title: '13e mois (CCL)', desc: 'Salaire de base sur 13 mois selon la CCL Lidl Suisse, avec revue salariale annuelle.' },
        { title: 'Rabais employé 10 %', desc: '10 % de rabais sur tous les achats dans les magasins Lidl Suisse pour les collaborateurs et les membres du ménage.' },
        { title: 'Formation et carrière interne', desc: 'Parcours structuré de collaborateur à Adjoint et Responsable de filiale ; academy interne et apprentissages AFC.' },
        { title: 'Plans de travail anticipés', desc: "Plannings d'horaires publiés plusieurs semaines à l'avance ; temps partiel de 40 à 100 %." },
        { title: 'Prévoyance LPP', desc: 'Caisse de pension du groupe Schwarz avec cotisations employeur au-dessus du minimum légal ; LAA comprise.' },
        { title: 'Frontaliers bienvenus', desc: 'Lidl engage régulièrement des titulaires de Permis G pour les magasins tessinois, sans exiger d\'expérience préalable.' },
      ],
      faqs: [
        { q: 'Lidl Suisse engage-t-il des frontaliers italiens ?', a: "Oui. Les magasins tessinois publient régulièrement des postes de collaborateurs, adjoints et apprentis ouverts aux candidats avec Permis G. Les rôles au siège de Weinfelden ne sont pas navettables depuis l'Italie ; les magasins tessinois et la logistique italophone le sont." },
        { q: 'Quels salaires paie Lidl en Suisse ?', a: "Lidl Suisse applique une CCL nationale avec des salaires d'entrée parmi les plus élevés du hard-discount. Valeurs brutes indicatives (source : communications de l'entreprise et jobs.lidl.ch) : collaborateur débutant CHF 4'500-4'800/mois × 13, adjoint CHF 5'500-6'200 × 13, responsable de filiale CHF 7'000-8'500 × 13, chauffeur PL OACP CHF 5'200-6'000 × 13. 13e et indemnités de soirée inclus." },
        { q: 'Quels permis Lidl accepte-t-il ?', a: "Lidl accepte citoyens suisses et titulaires de permis C, B, G et Li (UE/AELE). Pour les rôles magasin au Tessin, le Permis G est pleinement pris en charge ; l'administration est gérée par les RH régionales à la signature." },
        { q: 'Lidl propose-t-il des apprentissages au Tessin ?', a: "Oui. Lidl Suisse est entreprise formatrice reconnue pour l'Employé/e du commerce de détail CFC (3 ans) et l'Assistant/e du commerce de détail AFP (2 ans). Chaque année, des apprentis sont engagés dans les magasins tessinois ; les candidatures ouvrent en automne pour l'année scolaire suivante.",
        },
        { q: 'Comment faire une candidature spontanée ?', a: "Le portail jobs.lidl.ch permet des candidatures spontanées par profil (magasin, logistique, siège) et région. Elles restent en base et sont réexaminées à l'ouverture d'un poste compatible. Rafraîchir CV et préférences tous les 6 mois." },
        { q: 'Combien de magasins Lidl au Tessin ?', a: 'Lidl est présent au Tessin avec une dizaine de magasins dans le Mendrisiotto, Luganese, Bellinzonese et Locarnese, plus des points de vente dans la vallée de Mesolcina (GR) gérés par la même équipe régionale. Le réseau est régulièrement étendu.' },
      ],
      locationsIntro: "Lidl Suisse exploite un réseau dense de magasins dans tout le Tessin. Postulez au magasin le plus proche de chez vous et demandez des transferts internes après la période d'essai.",
      emptyStateNote: "Aucun poste Lidl Suisse actif dans notre base pour l'instant. Les annonces sont actualisées chaque jour — revenez demain ou postulez sur jobs.lidl.ch.",
      metaTitle: 'Emplois Lidl Suisse | Postes ouverts Canton du Tessin',
      metaDescription: 'Lidl Suisse : magasins du Tessin, salaires, apprentissage, candidature frontalière. Mis à jour chaque jour.',
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// ALDI SUISSE
// Source: https://www.aldi-suisse.ch (verified 2026-04)
// ─────────────────────────────────────────────────────────────────────────────

const ALDI: EmployerBrand = {
  brandKey: 'aldi-suisse',
  name: 'ALDI SUISSE',
  shortName: 'ALDI',
  fullName: 'ALDI SUISSE AG',
  website: 'https://www.aldi-suisse.ch',
  careersUrl: 'https://www.aldi-suisse.ch/de/karriere',
  locations: [
    'Sede centrale Schwarzenbach (SG)',
    'Centro di distribuzione regionale Schwarzenbach (SG)',
    'Centro di distribuzione regionale Perlen (LU)',
    'Centro di distribuzione regionale Domdidier (FR)',
    'Filiali in Ticino: Bellinzona, Biasca, Grancia, Lugano, Mendrisio, S. Antonino, Taverne',
    'Oltre 230 filiali in tutta la Svizzera',
  ],
  headquarters: {
    streetAddress: 'Niederstettenstrasse 3',
    postalCode: '9536',
    addressLocality: 'Schwarzenbach',
    addressRegion: 'SG',
    addressCountry: 'CH',
  },
  sameAs: [
    'https://www.linkedin.com/company/aldi-suisse',
    'https://de.wikipedia.org/wiki/Aldi_Suisse',
  ],
  copy: {
    it: {
      h1: 'Lavorare in ALDI SUISSE — filiali e logistica in Ticino',
      tagline: 'Offerte di lavoro ALDI in Ticino: cassa, scaffali, responsabili di filiale, logistica. Stipendi e candidatura.',
      paragraphs: [
        "ALDI SUISSE AG è la filiale elvetica di ALDI SÜD, parte del gruppo discount tedesco fondato dai fratelli Albrecht. Ha aperto la prima filiale svizzera nel 2005 a Schwarzenbach (San Gallo), dove si trova tuttora la sede centrale, e oggi gestisce oltre 230 filiali in tutto il Paese servite da tre centri di distribuzione regionali: Schwarzenbach (SG), Perlen (LU) e Domdidier (FR). Il modello ALDI è il discount classico: assortimento essenziale di circa 1'800 referenze, marchio proprio dominante, prezzi stabili e forte focus sulle referenze svizzere (dichiarato oltre il 60% del fatturato alimentare).",
        "In Ticino ALDI è presente con filiali nelle principali località del cantone — Lugano, Mendrisio, Bellinzona, Biasca, Grancia, S. Antonino, Taverne — nel bacino di spesa dei frontalieri italiani e dei residenti ticinesi. I punti vendita sono serviti dal centro logistico di Perlen (Lucerna) e in parte da quello di Domdidier, con consegne multiple quotidiane per garantire la freschezza dei prodotti food.",
        "I profili più ricercati in Ticino sono Collaboratore/trice di filiale, Sostituto/a Responsabile di filiale, Responsabile di filiale, apprendisti nel commercio al dettaglio e addetti alla panetteria. ALDI SUISSE assume anche profili di sede a Schwarzenbach (acquisti, immobiliare, finanza, IT, HR, legale) e personale logistico nei tre centri di distribuzione. I contratti sono prevalentemente a tempo indeterminato, con possibilità di part-time e orari distribuiti su turni del mattino / sera.",
        "Per i frontalieri italiani ALDI è un datore di lavoro interessante: le filiali ticinesi sono raggiungibili dai principali comuni di confine in 20-45 minuti, l'azienda accetta candidature con Permesso G, la formazione è on-the-job interamente a carico del datore di lavoro e il pacchetto salariale è pubblicamente documentato come uno dei più alti del settore discount svizzero. ALDI è firmataria del CCL del commercio al dettaglio e applica un modello di remunerazione uniforme in tutto il Paese, con differenze minime per regione.",
      ],
      sectionHeadings: {
        locations: 'Sedi e filiali ALDI in Ticino',
        benefits: 'Perché lavorare in ALDI',
        openRoles: 'Posizioni aperte oggi',
        howToApply: 'Come candidarsi in ALDI',
        faq: 'Domande frequenti',
        about: 'Chi è ALDI SUISSE',
      },
      howToApply: 'Tutte le posizioni ufficiali ALDI SUISSE sono pubblicate su aldi-suisse.ch/karriere e monitorate quotidianamente da Frontaliere Ticino. Il processo: (1) candidatura online con CV; (2) screening HR entro 1-2 settimane; (3) colloquio in filiale con il Responsabile di regione o il Responsabile di filiale; (4) giornata di prova pagata per i ruoli di filiale; (5) offerta contrattuale con stipendio, orario, sede e CCL applicabile. Per i ruoli di sede il processo include un secondo colloquio tecnico e può richiedere 4-6 settimane.',
      benefits: [
        { title: '13ª mensilità e revisione annuale', desc: 'Stipendio di base su 13 mensilità secondo il CCL, con revisione salariale annuale e indennità per ore serali e domenicali.' },
        { title: 'Stipendi trasparenti e uniformi', desc: 'ALDI pubblica stipendi minimi e applica la stessa griglia in tutto il Paese: nessuna negoziazione al ribasso.' },
        { title: 'Formazione on-the-job', desc: 'Inserimento strutturato a carico del datore di lavoro; nessuna esperienza retail richiesta per il ruolo di collaboratore.' },
        { title: 'Carriera veloce in filiale', desc: 'Percorsi rapidi da collaboratore a Sostituto Responsabile e Responsabile di filiale; programmi dedicati ai laureati e agli apprendisti.' },
        { title: 'Previdenza professionale LPP', desc: 'Cassa pensione ALDI con contributi datoriali superiori al minimo legale; LAINF inclusa.' },
        { title: 'Frontalieri benvenuti', desc: "L'azienda assume regolarmente titolari di Permesso G per le filiali ticinesi senza preclusioni." },
      ],
      faqs: [
        { q: 'ALDI SUISSE assume frontalieri italiani?', a: 'Sì. Le filiali ALDI in Ticino pubblicano regolarmente posizioni aperte ai titolari di Permesso G per ruoli di collaboratore, sostituto responsabile e apprendista. La distanza media dai comuni di confine è 20-45 minuti in auto.' },
        { q: 'Quanto paga ALDI in Svizzera?', a: "ALDI SUISSE pubblica ufficialmente stipendi di base tra i più alti del settore discount. Valori lordi indicativi (fonte: comunicazioni aziendali): collaboratore di filiale CHF 4'700-5'000/mese x 13, sostituto responsabile CHF 5'800-6'400 x 13, responsabile di filiale CHF 7'200-8'800 x 13. Tredicesima e indennità incluse. Stipendi uniformi a livello nazionale." },
        { q: 'Quali permessi accetta ALDI?', a: "Cittadini svizzeri e titolari di Permesso C, B, G e Li (UE/AELS). Per le filiali ticinesi il Permesso G è pienamente accettato; la documentazione è gestita dall'HR regionale alla firma del contratto." },
        { q: 'ALDI offre apprendistato?', a: "Sì. ALDI SUISSE è azienda formatrice riconosciuta per l'apprendistato di Impiegato/a del commercio al dettaglio AFC (3 anni) e per apprendistati logistici. Nuovi apprendisti vengono assunti ogni anno, anche in Ticino." },
        { q: 'Come candidarsi spontaneamente?', a: 'Il portale aldi-suisse.ch/karriere permette candidature spontanee per regione e profilo. Le candidature rimangono in database e vengono richiamate quando si apre una posizione compatibile. Raccomandato aggiornarle ogni 6 mesi.' },
        { q: 'Quante filiali ALDI ci sono in Ticino?', a: "ALDI è presente in Ticino con circa 7 filiali nei distretti principali (Luganese, Mendrisiotto, Bellinzonese, Tre Valli). Nuove aperture vengono annunciate regolarmente sul sito aziendale e sulla stampa locale." },
      ],
      locationsIntro: "ALDI SUISSE gestisce una rete nazionale con filiali presenti nelle principali località ticinesi. Puoi candidarti per la filiale più vicina al tuo comune e richiedere trasferimenti dopo il periodo di prova.",
      emptyStateNote: 'In questo momento non ci sono posizioni ALDI SUISSE attive nella nostra banca dati. Gli annunci vengono aggiornati ogni giorno dal crawler: torna domani oppure candidati sul portale ufficiale aldi-suisse.ch/karriere.',
      metaTitle: 'Lavorare in ALDI SUISSE | Offerte di lavoro Ticino',
      metaDescription: 'ALDI SUISSE: filiali in Ticino, stipendi, apprendistato, candidatura frontaliere. Offerte aggiornate ogni giorno.',
    },
    en: {
      h1: 'Careers at ALDI SUISSE — stores and logistics across Ticino',
      tagline: 'ALDI jobs in Canton Ticino: store roles, store managers, logistics. Salaries, sites, how to apply.',
      paragraphs: [
        'ALDI SUISSE AG is the Swiss subsidiary of ALDI SÜD, part of the German discount group founded by the Albrecht brothers. It opened its first Swiss store in Schwarzenbach (St. Gallen) in 2005, where the headquarters is still located, and today runs more than 230 stores countrywide served by three regional distribution centres: Schwarzenbach (SG), Perlen (LU) and Domdidier (FR). The ALDI model is classic discount: an essential assortment of around 1,800 items, dominant private label, stable pricing and a strong focus on Swiss sourcing (publicly stated above 60% of food sales).',
        'In Canton Ticino ALDI operates stores in the main locations — Lugano, Mendrisio, Bellinzona, Biasca, Grancia, S. Antonino, Taverne — inside the shopping catchment of Italian cross-border workers and Ticino residents. Stores are supplied mainly from the Perlen (Lucerne) distribution centre, with multiple daily deliveries to keep fresh produce stocked.',
        'The most sought-after Ticino profiles are Store Assistant, Assistant Store Manager, Store Manager, retail apprentices and in-store bakery staff. ALDI SUISSE also hires HQ profiles in Schwarzenbach (buying, real estate, finance, IT, HR, legal) and logistics staff at the three distribution centres. Contracts are mostly permanent, with part-time options and shifts on morning/evening rotations.',
        'For Italian cross-border workers ALDI is an attractive employer: Ticino stores are 20–45 minutes from the main border towns, G-permit applications are accepted, training is on-the-job and fully paid by the employer, and the pay package is publicly documented as one of the highest in Swiss discount retail. ALDI signs the national retail CLA and applies a uniform salary grid across the country, with minimal regional differences.',
      ],
      sectionHeadings: {
        locations: 'ALDI sites and stores in Ticino',
        benefits: 'Why work at ALDI',
        openRoles: 'Open positions today',
        howToApply: 'How to apply at ALDI',
        faq: 'Frequently asked questions',
        about: 'About ALDI SUISSE',
      },
      howToApply: 'All official ALDI SUISSE openings are published on aldi-suisse.ch/karriere and tracked daily by Frontaliere Ticino. The process: (1) online application with CV; (2) HR screening within 1–2 weeks; (3) store interview with the Regional or Store Manager; (4) paid trial day for store roles; (5) contract offer with salary, hours, site and applicable CLA. For HQ roles the process includes a second technical interview and can take 4–6 weeks.',
      benefits: [
        { title: '13th-month salary and annual review', desc: 'Base salary over 13 months under the national CLA, with annual salary review and evening/Sunday allowances.' },
        { title: 'Transparent, uniform salaries', desc: 'ALDI publishes its minimum salaries and applies the same grid nationwide — no downward negotiation.' },
        { title: 'On-the-job training', desc: 'Structured onboarding paid by the employer; no prior retail experience required for store assistants.' },
        { title: 'Fast internal career', desc: 'Fast-track paths from Store Assistant to Assistant Store Manager and Store Manager; dedicated graduate and apprentice programmes.' },
        { title: 'LPP occupational pension', desc: 'ALDI pension fund with employer contributions above the legal minimum; LAA accident insurance included.' },
        { title: 'Cross-border workers welcome', desc: 'ALDI regularly hires G-permit holders for Ticino stores without restrictions.' },
      ],
      faqs: [
        { q: 'Does ALDI SUISSE hire Italian cross-border workers?', a: 'Yes. ALDI Ticino stores regularly post roles open to G-permit applicants for store assistant, assistant manager and apprentice positions. The average drive from Italian border towns is 20–45 minutes.' },
        { q: 'What does ALDI pay in Switzerland?', a: 'ALDI SUISSE publishes official starting salaries among the highest in discount retail. Indicative gross figures (source: company communications): store assistant CHF 4,700–5,000/month × 13, assistant store manager CHF 5,800–6,400 × 13, store manager CHF 7,200–8,800 × 13. 13th-month and allowances included. Salaries are uniform nationwide.' },
        { q: 'Which work permits does ALDI accept?', a: 'Swiss citizens and holders of C, B, G and Li (EU/EFTA) permits. For Ticino stores the G permit is fully accepted; paperwork is handled by regional HR at contract signature.' },
        { q: 'Does ALDI offer apprenticeships?', a: 'Yes. ALDI SUISSE is an accredited apprenticeship employer for AFC Retail Employee (3 years) and logistics apprenticeships. New apprentices are hired every year, including in Ticino.' },
        { q: 'How do I submit a speculative application?', a: 'The aldi-suisse.ch/karriere portal accepts speculative applications by region and profile. Applications remain in the database and are considered when a matching role opens. Refresh every 6 months.' },
        { q: 'How many ALDI stores are there in Ticino?', a: 'ALDI operates about 7 Ticino stores across the main districts (Luganese, Mendrisiotto, Bellinzonese, Tre Valli). New openings are announced regularly on the company website and local press.' },
      ],
      locationsIntro: 'ALDI SUISSE runs a nationwide network with stores in all the main Ticino towns. Apply to the store closest to you and request transfers after probation.',
      emptyStateNote: 'No active ALDI SUISSE roles in our database right now. Listings refresh daily — come back tomorrow or apply on aldi-suisse.ch/karriere.',
      metaTitle: 'Jobs at ALDI SUISSE | Open roles in Canton Ticino',
      metaDescription: 'ALDI SUISSE: Ticino stores, salaries, apprenticeships, cross-border application. Refreshed daily.',
    },
    de: {
      h1: 'Arbeiten bei ALDI SUISSE — Filialen und Logistik im Tessin',
      tagline: 'ALDI-Stellen im Kanton Tessin: Kasse, Regale, Filialleitung, Logistik. Löhne und Bewerbung.',
      paragraphs: [
        "ALDI SUISSE AG ist die Schweizer Tochter von ALDI SÜD, Teil der von den Gebrüdern Albrecht gegründeten deutschen Discount-Gruppe. 2005 wurde die erste Filiale in Schwarzenbach (St. Gallen) eröffnet, wo sich bis heute der Hauptsitz befindet; mittlerweile werden über 230 Filialen landesweit aus drei regionalen Verteilzentren beliefert: Schwarzenbach (SG), Perlen (LU) und Domdidier (FR). Das ALDI-Modell ist klassischer Discount: essenzielles Sortiment von rund 1'800 Artikeln, dominierende Eigenmarke, stabile Preise und starker Fokus auf Schweizer Herkunft (öffentlich über 60 % des Lebensmittelumsatzes).",
        'Im Kanton Tessin betreibt ALDI Filialen an den wichtigsten Standorten — Lugano, Mendrisio, Bellinzona, Biasca, Grancia, S. Antonino, Taverne — im Einkaufsgebiet italienischer Grenzgänger und Tessiner Einwohner. Die Filialen werden hauptsächlich aus Perlen (LU) beliefert, mit mehreren täglichen Frischelieferungen.',
        'Gefragteste Tessiner Profile sind Filialmitarbeitende, stellvertretende und Filialleitung, Lernende im Detailhandel und Bäckereipersonal. ALDI SUISSE stellt zudem HQ-Profile in Schwarzenbach (Einkauf, Immobilien, Finanzen, IT, HR, Recht) und Logistikpersonal in den drei Verteilzentren ein. Die Verträge sind überwiegend unbefristet, mit Teilzeit-Optionen und Morgen-/Abendschichten.',
        'Für italienische Grenzgänger ist ALDI ein attraktiver Arbeitgeber: Tessiner Filialen sind 20–45 Minuten von den Grenzgemeinden entfernt, G-Bewilligungs-Bewerbungen werden akzeptiert, die Einarbeitung erfolgt on the job und voll zulasten des Arbeitgebers, und das Lohnpaket ist öffentlich dokumentiert als eines der höchsten im Schweizer Discount. ALDI unterzeichnet den nationalen Detailhandels-GAV und wendet eine einheitliche Lohntabelle im ganzen Land an, mit minimalen regionalen Unterschieden.',
      ],
      sectionHeadings: {
        locations: 'ALDI-Standorte und Filialen im Tessin',
        benefits: 'Warum bei ALDI arbeiten',
        openRoles: 'Offene Stellen heute',
        howToApply: 'Bewerbung bei ALDI',
        faq: 'Häufige Fragen',
        about: 'Über ALDI SUISSE',
      },
      howToApply: 'Alle offiziellen ALDI-SUISSE-Stellen werden auf aldi-suisse.ch/karriere publiziert und täglich von Frontaliere Ticino erfasst. Ablauf: (1) Online-Bewerbung mit Lebenslauf; (2) HR-Screening in 1–2 Wochen; (3) Filialgespräch mit Regional- oder Filialleitung; (4) bezahlter Schnuppertag für Filialrollen; (5) Vertragsangebot mit Lohn, Arbeitszeit, Standort und GAV. Für HQ-Rollen folgt ein zweites Fachgespräch; der Prozess kann 4–6 Wochen dauern.',
      benefits: [
        { title: '13. Monatslohn und jährliche Lohnrunde', desc: 'Grundlohn auf 13 Monate gemäss nationalem GAV, mit jährlicher Lohnanpassung sowie Abend- und Sonntagszulagen.' },
        { title: 'Transparente, einheitliche Löhne', desc: 'ALDI publiziert die Mindestlöhne und wendet landesweit dieselbe Tabelle an — keine Verhandlung nach unten.' },
        { title: 'Einarbeitung on the job', desc: 'Strukturierte Einführung zulasten des Arbeitgebers; keine Vorerfahrung im Detailhandel verlangt.' },
        { title: 'Schnelle interne Karriere', desc: 'Schnelle Entwicklungspfade vom Filialmitarbeitenden zur Stellvertretung und Filialleitung; dedizierte Graduate- und Lehrlingsprogramme.' },
        { title: 'BVG-Pensionskasse', desc: 'ALDI-Pensionskasse mit überobligatorischen Arbeitgeberbeiträgen; UVG inbegriffen.' },
        { title: 'Grenzgänger willkommen', desc: 'ALDI stellt regelmässig G-Bewilligungs-Inhaber für Tessiner Filialen ohne Einschränkung ein.' },
      ],
      faqs: [
        { q: 'Stellt ALDI SUISSE italienische Grenzgänger ein?', a: 'Ja. Tessiner ALDI-Filialen schreiben regelmässig Stellen für G-Bewilligungs-Bewerbende für Filialmitarbeit, Stellvertretung und Lehre aus. Der durchschnittliche Arbeitsweg aus italienischen Grenzgemeinden beträgt 20–45 Minuten.' },
        { q: 'Wie hoch sind die ALDI-Löhne in der Schweiz?', a: "ALDI SUISSE publiziert offizielle Einstiegslöhne an der Spitze des Discounts. Richtwerte brutto (Quelle: Unternehmenskommunikation): Filialmitarbeit CHF 4'700–5'000/Monat × 13, Stellvertretung CHF 5'800–6'400 × 13, Filialleitung CHF 7'200–8'800 × 13. 13. Monatslohn und Zulagen inbegriffen. Löhne landesweit einheitlich." },
        { q: 'Welche Bewilligungen akzeptiert ALDI?', a: 'Schweizer Staatsangehörige und Inhaber der Bewilligungen C, B, G und Li (EU/EFTA). Für Tessiner Filialen ist die G-Bewilligung vollständig akzeptiert; die Administration erfolgt durch das regionale HR-Team.' },
        { q: 'Bietet ALDI Lehrstellen an?', a: 'Ja. ALDI SUISSE ist anerkannter Ausbildungsbetrieb für Detailhandelsfachfrau/-mann EFZ (3 Jahre) sowie für Logistik-Lehrstellen. Jedes Jahr werden neue Lernende eingestellt, auch im Tessin.' },
        { q: 'Wie funktioniert eine Spontanbewerbung?', a: 'Das Portal aldi-suisse.ch/karriere nimmt Spontanbewerbungen nach Region und Profil entgegen. Die Bewerbungen bleiben in der Datenbank und werden bei passenden Öffnungen berücksichtigt. Alle 6 Monate auffrischen.' },
        { q: 'Wie viele ALDI-Filialen gibt es im Tessin?', a: 'ALDI betreibt rund 7 Tessiner Filialen in den Hauptbezirken (Luganese, Mendrisiotto, Bellinzonese, Tre Valli). Neue Eröffnungen werden regelmässig auf der Unternehmenswebsite und in der Lokalpresse angekündigt.' },
      ],
      locationsIntro: 'ALDI SUISSE betreibt ein landesweites Netz mit Filialen in allen wichtigen Tessiner Ortschaften. Bewerben Sie sich für die nächstgelegene Filiale und beantragen Sie Versetzungen nach der Probezeit.',
      emptyStateNote: 'Aktuell keine aktiven ALDI-SUISSE-Stellen in unserer Datenbank. Die Angebote werden täglich aktualisiert — schauen Sie morgen wieder vorbei oder bewerben Sie sich auf aldi-suisse.ch/karriere.',
      metaTitle: 'Jobs bei ALDI SUISSE | Offene Stellen Kanton Tessin',
      metaDescription: 'ALDI SUISSE: Tessiner Filialen, Löhne, Lehrstellen, Grenzgänger-Bewerbung. Täglich aktualisiert.',
    },
    fr: {
      h1: 'Travailler chez ALDI SUISSE — magasins et logistique au Tessin',
      tagline: 'Emplois ALDI au Tessin : caisse, rayons, responsables de filiale, logistique. Salaires et candidature.',
      paragraphs: [
        "ALDI SUISSE AG est la filiale suisse d'ALDI SÜD, faisant partie du groupe de discount allemand fondé par les frères Albrecht. Le premier magasin suisse a ouvert en 2005 à Schwarzenbach (Saint-Gall), où se trouve encore le siège, et le réseau compte aujourd'hui plus de 230 magasins dans tout le pays, approvisionnés par trois centres de distribution régionaux : Schwarzenbach (SG), Perlen (LU) et Domdidier (FR). Le modèle ALDI est le hard-discount classique : assortiment essentiel d'environ 1'800 références, marque propre dominante, prix stables et fort accent sur l'approvisionnement suisse (officiellement plus de 60 % du chiffre d'affaires alimentaire).",
        'Au Canton du Tessin, ALDI exploite des magasins dans les principales localités — Lugano, Mendrisio, Bellinzona, Biasca, Grancia, S. Antonino, Taverne — dans le bassin de consommation des frontaliers italiens et des résidents tessinois. Les magasins sont principalement approvisionnés par le centre de distribution de Perlen (LU), avec plusieurs livraisons quotidiennes.',
        "Les profils tessinois les plus recherchés sont Collaborateur/trice de filiale, Adjoint/e Responsable de filiale, Responsable de filiale, apprentis du commerce de détail et personnel de la boulangerie interne. ALDI SUISSE engage aussi des profils siège à Schwarzenbach (achats, immobilier, finance, IT, RH, juridique) et du personnel logistique dans les trois centres de distribution. Les contrats sont majoritairement à durée indéterminée, avec temps partiel et rotations matin/soir.",
        "Pour les frontaliers italiens, ALDI est un employeur attractif : les magasins tessinois sont à 20-45 minutes des communes frontalières, les candidatures avec Permis G sont acceptées, la formation est on-the-job et entièrement à la charge de l'employeur, et la grille salariale publique est parmi les plus élevées du hard-discount suisse. ALDI signe la CCL nationale du commerce de détail et applique la même grille dans tout le pays, avec des différences régionales minimes.",
      ],
      sectionHeadings: {
        locations: 'Sites et magasins ALDI au Tessin',
        benefits: 'Pourquoi travailler chez ALDI',
        openRoles: 'Postes ouverts aujourd\'hui',
        howToApply: 'Comment postuler chez ALDI',
        faq: 'Questions fréquentes',
        about: 'À propos d\'ALDI SUISSE',
      },
      howToApply: "Toutes les offres officielles ALDI SUISSE sont publiées sur aldi-suisse.ch/karriere et suivies chaque jour par Frontaliere Ticino. Processus : (1) candidature en ligne avec CV ; (2) tri RH sous 1-2 semaines ; (3) entretien en magasin avec le Responsable régional ou de filiale ; (4) journée d'essai rémunérée pour les rôles magasin ; (5) offre contractuelle avec salaire, horaires, site et CCL. Pour les rôles siège, un second entretien technique s'ajoute ; la durée est de 4-6 semaines.",
      benefits: [
        { title: '13e mois et revue annuelle', desc: 'Salaire de base sur 13 mois selon la CCL nationale, avec revue annuelle et indemnités de soirée/dimanche.' },
        { title: 'Salaires transparents et uniformes', desc: 'ALDI publie ses salaires minimums et applique la même grille dans tout le pays — pas de négociation à la baisse.' },
        { title: 'Formation on-the-job', desc: "Onboarding structuré à la charge de l'employeur ; pas d'expérience retail requise pour les collaborateurs." },
        { title: 'Carrière interne rapide', desc: 'Parcours rapides de collaborateur à adjoint puis responsable de filiale ; programmes dédiés graduates et apprentis.' },
        { title: 'Prévoyance LPP', desc: 'Caisse de pension ALDI avec cotisations employeur au-dessus du minimum légal ; LAA comprise.' },
        { title: 'Frontaliers bienvenus', desc: 'ALDI engage régulièrement des titulaires de Permis G pour les magasins tessinois, sans restriction.' },
      ],
      faqs: [
        { q: 'ALDI SUISSE engage-t-il des frontaliers italiens ?', a: 'Oui. Les magasins ALDI tessinois publient régulièrement des postes ouverts aux candidats avec Permis G pour collaborateur, adjoint et apprenti. Le trajet moyen depuis les communes frontalières est de 20-45 minutes en voiture.' },
        { q: 'Quels salaires paie ALDI en Suisse ?', a: "ALDI SUISSE publie officiellement des salaires d'entrée parmi les plus élevés du hard-discount. Valeurs brutes indicatives (source : communications de l'entreprise) : collaborateur CHF 4'700-5'000/mois × 13, adjoint CHF 5'800-6'400 × 13, responsable de filiale CHF 7'200-8'800 × 13. 13e mois et indemnités inclus. Salaires uniformes au niveau national." },
        { q: 'Quels permis ALDI accepte-t-il ?', a: "Citoyens suisses et titulaires de permis C, B, G et Li (UE/AELE). Pour les magasins tessinois, le Permis G est pleinement accepté ; l'administration est gérée par les RH régionales à la signature du contrat." },
        { q: 'ALDI propose-t-il des apprentissages ?', a: "Oui. ALDI SUISSE est entreprise formatrice reconnue pour l'Employé/e du commerce de détail CFC (3 ans) et pour des apprentissages logistiques. De nouveaux apprentis sont engagés chaque année, également au Tessin." },
        { q: 'Comment faire une candidature spontanée ?', a: "Le portail aldi-suisse.ch/karriere accepte les candidatures spontanées par région et profil. Elles restent en base et sont réexaminées à l'ouverture d'un poste compatible. Rafraîchir tous les 6 mois." },
        { q: "Combien de magasins ALDI au Tessin ?", a: "ALDI exploite environ 7 magasins tessinois dans les principaux districts (Luganese, Mendrisiotto, Bellinzonese, Tre Valli). Les nouvelles ouvertures sont annoncées régulièrement sur le site de l'entreprise et dans la presse locale." },
      ],
      locationsIntro: "ALDI SUISSE exploite un réseau national avec des magasins dans toutes les principales localités tessinoises. Postulez au magasin le plus proche de chez vous et demandez des transferts après la période d'essai.",
      emptyStateNote: "Aucun poste ALDI SUISSE actif dans notre base pour l'instant. Les annonces sont actualisées chaque jour — revenez demain ou postulez sur aldi-suisse.ch/karriere.",
      metaTitle: 'Emplois ALDI SUISSE | Postes ouverts Canton du Tessin',
      metaDescription: 'ALDI SUISSE : magasins du Tessin, salaires, apprentissage, candidature frontalière. Mis à jour chaque jour.',
    },
  },
};

export const EMPLOYER_BRANDS: Readonly<Record<string, EmployerBrand>> = {
  [EOC.brandKey]: EOC,
  [LIDL.brandKey]: LIDL,
  [ALDI.brandKey]: ALDI,
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
