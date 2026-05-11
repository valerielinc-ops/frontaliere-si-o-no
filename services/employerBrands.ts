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
      // SEO target: query "eoc offerte di lavoro" (rank ~3.1). H1 leads with
      // the exact query phrase verbatim; meta-title also keyword-first so the
      // SERP snippet shows the phrase immediately.
      h1: 'EOC offerte di lavoro — Ente Ospedaliero Cantonale del Canton Ticino',
      tagline: 'EOC offerte di lavoro aperte oggi: stipendi, sedi (Bellinzona, Lugano, Locarno, Mendrisio) e come candidarsi da frontaliere.',
      paragraphs: [
        "EOC offerte di lavoro: l'Ente Ospedaliero Cantonale è la principale azienda sanitaria pubblica del Canton Ticino, un ente di diritto pubblico che gestisce la rete degli ospedali cantonali multisito e coordina l'offerta di cure ospedaliere per tutta la Svizzera italiana. Con oltre 41'000 pazienti degenti e quasi 700'000 visite ambulatoriali all'anno, EOC è al contempo il maggior datore di lavoro del settore sanitario in Ticino e uno dei principali datori di lavoro del cantone tout court, con circa 5'000 collaboratrici e collaboratori. In questa pagina trovi tutte le offerte di lavoro EOC attualmente aperte, aggiornate ogni giorno dai nostri crawler, con link diretto alla candidatura ufficiale sul portale eoc.ch/carriere.",
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
      metaTitle: 'EOC offerte di lavoro Ticino: posizioni aperte oggi | Frontaliere Ticino',
      metaDescription: 'EOC offerte di lavoro: posizioni aperte all\'Ente Ospedaliero Cantonale (Bellinzona, Lugano, Locarno, Mendrisio), stipendi e come candidarsi da frontaliere.',
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

// ─────────────────────────────────────────────────────────────────────────────
// McDonald's Switzerland
// Source: https://www.mcdonalds.ch (verified 2026-04)
// ─────────────────────────────────────────────────────────────────────────────

const MCDONALDS: EmployerBrand = {
  brandKey: 'mcdonald-s-switzerland',
  name: "McDonald's Switzerland",
  shortName: "McDonald's",
  fullName: 'McDonald\'s Suisse Restaurants Sàrl',
  website: 'https://www.mcdonalds.ch',
  careersUrl: 'https://www.mcdonalds.ch/it/carriera',
  locations: [
    "Sede centrale McDonald's Suisse — Crissier (VD)",
    'Ristoranti in Ticino: Lugano (Via Vedeggio, Stazione FFS, Cassarate), Mendrisio, Bellinzona (S. Antonino), Locarno, Chiasso, Grancia, Tenero',
    "Oltre 175 ristoranti in tutta la Svizzera",
  ],
  headquarters: {
    streetAddress: 'Route de Crissier 33',
    postalCode: '1023',
    addressLocality: 'Crissier',
    addressRegion: 'VD',
    addressCountry: 'CH',
  },
  sameAs: [
    'https://www.linkedin.com/company/mcdonald-s-suisse',
    'https://de.wikipedia.org/wiki/McDonald%E2%80%99s_Suisse',
  ],
  copy: {
    it: {
      h1: "Lavorare in McDonald's Svizzera — ristoranti in Ticino",
      tagline: "Offerte di lavoro McDonald's in Ticino: crew, manager, apprendistato. Stipendi, orari, come candidarsi.",
      paragraphs: [
        "McDonald's Suisse opera in Svizzera dal 1976, quando ha aperto il primo ristorante a Ginevra. Oggi la catena conta oltre 175 ristoranti in tutto il Paese, con sede centrale a Crissier (Vaud). La maggior parte dei ristoranti è gestita in franchising da imprenditori locali, mentre una parte opera come Company-operated. Ogni anno McDonald's Svizzera serve oltre 110 milioni di ospiti ed è tra i più grandi datori di lavoro della ristorazione elvetica, con circa 7'500 collaboratori di oltre 100 nazionalità diverse.",
        "In Ticino, McDonald's è presente con ristoranti nelle principali località — Lugano (Via Vedeggio, Stazione FFS, Cassarate), Mendrisio, Bellinzona/S. Antonino, Locarno, Chiasso, Grancia, Tenero — gestiti da franchisee ticinesi. I ristoranti sono aperti 7 giorni su 7 con orari estesi (prima colazione, pranzo, cena, servizio serale e McDrive), il che crea una domanda continua di personale su turni del mattino, pomeriggio, sera e notte.",
        "I profili più ricercati sono Crew (addetto alla preparazione, servizio e cassa), Trainer (crew senior con responsabilità formativa), Shift Manager, Assistant Manager e Restaurant Manager. McDonald's Svizzera è anche una delle maggiori aziende formatrici del settore gastronomia, con apprendistati AFC di Impiegato/a di ristorazione (3 anni) e Cuoco/a in sistema (3 anni). Le opportunità di carriera interna sono strutturate: il percorso standard porta dal primo turno da Crew al ruolo di Restaurant Manager in 5-8 anni per chi decide di investire sul lungo periodo.",
        "Per i frontalieri italiani i ristoranti McDonald's in Ticino sono particolarmente accessibili: i punti di Chiasso, Mendrisio, Grancia e Lugano sono raggiungibili in 15-40 minuti dai principali comuni di confine, gli orari rotanti permettono di pianificare il pendolarismo in funzione del traffico, e la formazione iniziale è interamente erogata dal ristorante senza richiedere esperienza pregressa. I franchisee ticinesi accettano regolarmente candidati con Permesso G.",
      ],
      sectionHeadings: {
        locations: "Ristoranti McDonald's in Ticino",
        benefits: "Perché lavorare in McDonald's",
        openRoles: 'Posizioni aperte oggi',
        howToApply: "Come candidarsi in McDonald's",
        faq: 'Domande frequenti',
        about: "Chi è McDonald's Svizzera",
      },
      howToApply: "Tutte le posizioni ufficiali McDonald's Svizzera sono pubblicate su mcdonalds.ch/carriera e monitorate quotidianamente da Frontaliere Ticino. Il processo di selezione per i ruoli di crew è molto rapido: (1) candidatura online o direttamente in ristorante; (2) colloquio conoscitivo con il manager del ristorante entro pochi giorni; (3) prova pratica in ristorante di 2-4 ore; (4) firma del contratto con indicazione di ore settimanali garantite, turni, stipendio e periodo di prova. Per i ruoli manageriali il processo include un secondo colloquio con il franchisee o il Supervisore di zona.",
      benefits: [
        { title: 'Formazione completa pagata', desc: "Onboarding strutturato (Crew Training, Safe & Respectful Workplace, Food Safety) completamente a carico del datore di lavoro." },
        { title: 'Orari flessibili su turni', desc: 'Turni del mattino, pomeriggio, sera, notte e weekend: compatibili con studio, famiglia e pendolarismo da frontaliere.' },
        { title: 'Pasto dipendente scontato', desc: "Sconto significativo sul menu durante i turni e possibilità di pasto gratuito secondo politiche del franchisee." },
        { title: 'Carriera interna strutturata', desc: 'Percorso ufficiale Crew → Trainer → Shift Manager → Assistant Manager → Restaurant Manager con corsi Hamburger University.' },
        { title: 'Apprendistato AFC riconosciuto', desc: "Apprendistati di Impiegato/a di ristorazione AFC e Cuoco/a in sistema AFC presso i ristoranti ticinesi, con titolo di studio federale al termine." },
        { title: 'Frontalieri benvenuti', desc: 'I franchisee ticinesi assumono regolarmente candidati con Permesso G per tutti i ruoli del ristorante.' },
      ],
      faqs: [
        { q: "McDonald's in Ticino assume frontalieri?", a: "Sì. I ristoranti McDonald's ticinesi sono gestiti da franchisee locali che assumono regolarmente titolari di Permesso G, in particolare per i ruoli di crew, trainer e shift manager. Nessuna esperienza pregressa nella ristorazione è richiesta per i ruoli di crew." },
        { q: "Quanto paga McDonald's in Svizzera?", a: "I salari sono fissati dal CCL della ristorazione sistemica svizzera (L-GAV / Café-Restaurant) e dalle policy interne. Valori lordi indicativi per il Ticino: crew debutante CHF 22-24/ora (circa CHF 4'000-4'400 al 100%) x 13, trainer CHF 24-26/ora, shift manager CHF 4'600-5'200/mese x 13, assistant manager CHF 5'500-6'500 x 13, restaurant manager CHF 7'500-10'000 x 13. Tredicesima inclusa." },
        { q: 'Quali permessi sono accettati?', a: "Cittadini svizzeri e titolari di Permesso C, B, G e Li (UE/AELS). Per i ristoranti ticinesi il Permesso G è pienamente supportato; alcuni franchisee offrono anche sponsorship per Permesso B per ruoli manageriali." },
        { q: "McDonald's offre apprendistato in Ticino?", a: "Sì. I ristoranti ticinesi formano ogni anno apprendisti Impiegato/a di ristorazione AFC e Cuoco/a in sistema AFC. Le candidature per l'apprendistato si aprono in autunno per l'inizio dell'anno scolastico successivo; requisito minimo 15 anni compiuti alla data di assunzione." },
        { q: 'Si può lavorare part-time?', a: "Sì. La maggioranza dei collaboratori crew lavora part-time tra il 20% e il 80%. Gli orari si pianificano di settimana in settimana in base a disponibilità e carico del ristorante; particolarmente adatto a studenti e persone con responsabilità familiari." },
        { q: "Come candidarsi direttamente al ristorante?", a: "Oltre al portale mcdonalds.ch/carriera è possibile presentare CV direttamente al manager del ristorante durante gli orari non di picco (10-11 o 14-16). Questa modalità è molto comune in Ticino e spesso porta a un colloquio entro la stessa settimana." },
      ],
      locationsIntro: "McDonald's è presente in Ticino con ristoranti nelle principali località del cantone. I franchisee locali assumono autonomamente: puoi candidarti al ristorante più vicino al tuo comune di residenza.",
      emptyStateNote: "In questo momento non ci sono posizioni McDonald's Svizzera attive nella nostra banca dati. Le posizioni crew spesso non vengono pubblicate online: candidati direttamente al ristorante più vicino.",
      metaTitle: "Lavorare in McDonald's Svizzera | Offerte di lavoro Ticino",
      metaDescription: "McDonald's Svizzera: ristoranti in Ticino, stipendi, apprendistato, turni e come candidarsi da frontaliere. Aggiornato ogni giorno.",
    },
    en: {
      h1: "Careers at McDonald's Switzerland — restaurants across Ticino",
      tagline: "McDonald's jobs in Canton Ticino: crew, managers, apprenticeships. Salaries, shifts, how to apply.",
      paragraphs: [
        "McDonald's Suisse has operated in Switzerland since 1976, when the first restaurant opened in Geneva. The chain now runs more than 175 restaurants countrywide, with headquarters in Crissier (Vaud). Most restaurants are operated as franchises by local entrepreneurs, while a smaller share is company-operated. Every year McDonald's Switzerland serves over 110 million guests and is among the largest restaurant-sector employers in the country, with around 7,500 staff from more than 100 nationalities.",
        "In Canton Ticino McDonald's runs restaurants in the main locations — Lugano (Via Vedeggio, main station, Cassarate), Mendrisio, Bellinzona/S. Antonino, Locarno, Chiasso, Grancia, Tenero — operated by Ticino-based franchisees. Restaurants are open 7 days a week with extended hours (breakfast, lunch, dinner, evening service and McDrive), creating continuous demand for morning, afternoon, evening and night-shift staff.",
        "The most sought-after profiles are Crew (prep, service and cashier), Trainer (senior crew with training duties), Shift Manager, Assistant Manager and Restaurant Manager. McDonald's Switzerland is also one of the largest training employers in the hospitality sector, with AFC apprenticeships in Restaurant Employee (3 years) and System Cook (3 years). Internal career paths are structured: the standard track takes from entry Crew to Restaurant Manager in 5–8 years for those who invest long term.",
        "For Italian cross-border workers, Ticino McDonald's restaurants are very accessible: Chiasso, Mendrisio, Grancia and Lugano are 15–40 minutes from the main border towns, rotating shifts let you plan the commute around traffic, and initial training is fully provided on site without requiring prior experience. Ticino franchisees regularly hire G-permit applicants.",
      ],
      sectionHeadings: {
        locations: "McDonald's restaurants in Ticino",
        benefits: "Why work at McDonald's",
        openRoles: 'Open positions today',
        howToApply: "How to apply at McDonald's",
        faq: 'Frequently asked questions',
        about: "About McDonald's Switzerland",
      },
      howToApply: "All official McDonald's Switzerland openings are published on mcdonalds.ch/carriera and tracked daily by Frontaliere Ticino. The selection process for crew roles is very fast: (1) online application or drop-in at the restaurant; (2) informal interview with the restaurant manager within a few days; (3) 2–4 hour practical trial on site; (4) contract signature specifying weekly guaranteed hours, shifts, pay and probation. For manager roles the process adds a second interview with the franchisee or Area Supervisor.",
      benefits: [
        { title: 'Full paid training', desc: 'Structured onboarding (Crew Training, Safe & Respectful Workplace, Food Safety) fully paid by the employer.' },
        { title: 'Flexible shift hours', desc: 'Morning, afternoon, evening, night and weekend shifts: compatible with studying, family and cross-border commuting.' },
        { title: 'Discounted employee meal', desc: 'Significant menu discount during shifts and the option of a free meal depending on franchisee policy.' },
        { title: 'Structured internal career', desc: 'Official Crew → Trainer → Shift Manager → Assistant Manager → Restaurant Manager path with Hamburger University courses.' },
        { title: 'Recognised AFC apprenticeship', desc: 'Restaurant Employee AFC and System Cook AFC apprenticeships at Ticino restaurants, with a federal diploma at the end.' },
        { title: 'Cross-border workers welcome', desc: 'Ticino franchisees regularly hire G-permit applicants for every restaurant role.' },
      ],
      faqs: [
        { q: "Do Ticino McDonald's restaurants hire cross-border workers?", a: "Yes. Ticino McDonald's restaurants are run by local franchisees who regularly hire G-permit holders, especially as crew, trainers and shift managers. No previous restaurant experience is required for crew roles." },
        { q: "What does McDonald's pay in Switzerland?", a: "Salaries follow the national hospitality CLA (L-GAV) and internal policy. Indicative Ticino gross figures: entry crew CHF 22–24/hour (about CHF 4,000–4,400 at 100%) × 13, trainer CHF 24–26/hour, shift manager CHF 4,600–5,200/month × 13, assistant manager CHF 5,500–6,500 × 13, restaurant manager CHF 7,500–10,000 × 13. 13th-month included." },
        { q: 'Which permits are accepted?', a: "Swiss citizens and holders of C, B, G and Li (EU/EFTA) permits. For Ticino restaurants the G permit is fully supported; some franchisees also offer B-permit sponsorship for manager roles." },
        { q: "Does McDonald's offer apprenticeships in Ticino?", a: "Yes. Ticino restaurants train apprentices every year as Restaurant Employee AFC and System Cook AFC. Applications open in autumn for the following school year; minimum age is 15 at start date." },
        { q: 'Can I work part-time?', a: "Yes. Most crew members work part-time between 20% and 80%. Schedules are planned weekly based on availability and restaurant demand — well suited to students and people with family commitments." },
        { q: 'How do I apply directly to a restaurant?', a: "Besides the mcdonalds.ch/carriera portal you can drop your CV at the restaurant during off-peak hours (10–11 or 14–16). This is very common in Ticino and often leads to an interview within the same week." },
      ],
      locationsIntro: "McDonald's has restaurants in all the main Ticino locations. Local franchisees hire independently: apply to the restaurant closest to where you live.",
      emptyStateNote: "No active McDonald's Switzerland roles in our database right now. Crew roles often aren't posted online — apply directly at the nearest restaurant.",
      metaTitle: "Jobs at McDonald's Switzerland | Open roles in Canton Ticino",
      metaDescription: "McDonald's Switzerland: Ticino restaurants, salaries, apprenticeships, shifts and cross-border application guide. Refreshed daily.",
    },
    de: {
      h1: "Arbeiten bei McDonald's Schweiz — Restaurants im Tessin",
      tagline: "McDonald's-Stellen im Kanton Tessin: Crew, Manager, Lehrstellen. Löhne, Arbeitszeiten, Bewerbung.",
      paragraphs: [
        "McDonald's Suisse ist seit 1976 in der Schweiz tätig — das erste Restaurant öffnete damals in Genf. Heute betreibt die Kette über 175 Restaurants landesweit, mit Hauptsitz in Crissier (VD). Die meisten Restaurants werden von lokalen Unternehmerinnen und Unternehmern als Franchise betrieben, ein kleinerer Teil Company-operated. Jährlich werden über 110 Millionen Gäste bedient; McDonald's Schweiz zählt zu den grössten Arbeitgebern der Gastronomie mit rund 7'500 Mitarbeitenden aus über 100 Nationen.",
        "Im Tessin betreibt McDonald's Restaurants an den wichtigsten Standorten — Lugano (Via Vedeggio, Bahnhof, Cassarate), Mendrisio, Bellinzona/S. Antonino, Locarno, Chiasso, Grancia, Tenero — im Franchise lokaler Unternehmer. Die Restaurants sind 7 Tage pro Woche mit erweiterten Öffnungszeiten (Frühstück, Mittag, Abend, Abendservice und McDrive) geöffnet, was eine kontinuierliche Nachfrage nach Personal für Morgen-, Mittag-, Abend- und Nachtschichten schafft.",
        "Die gefragtesten Profile sind Crew (Zubereitung, Service, Kasse), Trainer (Senior Crew mit Ausbildungsaufgaben), Shift Manager, Assistant Manager und Restaurant Manager. McDonald's Schweiz ist zudem einer der grössten Ausbildungsbetriebe der Gastronomie, mit AFC-Lehrstellen für Restaurationsfachfrau/-mann und Systemgastronomie-Koch/Köchin. Der interne Karrierepfad ist strukturiert: vom Crew-Einstieg bis zur Restaurant-Leitung typisch 5–8 Jahre für langfristig Engagierte.",
        "Für italienische Grenzgänger sind Tessiner McDonald's-Restaurants besonders gut erreichbar: Chiasso, Mendrisio, Grancia und Lugano liegen 15–40 Minuten von den Hauptgrenzgemeinden entfernt, rotierende Schichten erlauben eine verkehrsgerechte Planung des Arbeitswegs, und die Einarbeitung erfolgt vollständig vor Ort ohne Vorerfahrung. Tessiner Franchisenehmer stellen regelmässig Bewerbende mit G-Bewilligung ein.",
      ],
      sectionHeadings: {
        locations: "McDonald's-Restaurants im Tessin",
        benefits: "Warum bei McDonald's arbeiten",
        openRoles: 'Offene Stellen heute',
        howToApply: "Bewerbung bei McDonald's",
        faq: 'Häufige Fragen',
        about: "Über McDonald's Schweiz",
      },
      howToApply: "Alle offiziellen McDonald's-Schweiz-Stellen werden auf mcdonalds.ch/carriera publiziert und täglich von Frontaliere Ticino erfasst. Der Auswahlprozess für Crew-Stellen ist sehr schnell: (1) Online-Bewerbung oder direkt im Restaurant; (2) informelles Gespräch mit der Restaurantleitung innert weniger Tage; (3) praktischer Probetag von 2–4 Stunden; (4) Vertragsunterzeichnung mit garantierten Wochenstunden, Schichten, Lohn und Probezeit. Für Managerrollen folgt ein zweites Gespräch mit dem Franchisenehmer oder der Area Supervision.",
      benefits: [
        { title: 'Vollständig bezahlte Ausbildung', desc: 'Strukturiertes Onboarding (Crew Training, Safe & Respectful Workplace, Food Safety) vollständig zulasten des Arbeitgebers.' },
        { title: 'Flexible Schichtzeiten', desc: 'Morgen-, Mittag-, Abend-, Nacht- und Wochenendschichten: vereinbar mit Studium, Familie und Grenzpendlertum.' },
        { title: 'Vergünstigte Personalverpflegung', desc: 'Signifikanter Rabatt auf das Menü während der Schichten, je nach Franchisenehmer auch kostenlose Mahlzeit möglich.' },
        { title: 'Strukturierte interne Karriere', desc: 'Offizieller Pfad Crew → Trainer → Shift Manager → Assistant Manager → Restaurant Manager mit Kursen an der Hamburger University.' },
        { title: 'Anerkannte AFC-Lehre', desc: 'Lehren als Restaurationsfachfrau/-mann EFZ und Systemgastronomie-Koch/Köchin EFZ in Tessiner Restaurants — mit eidgenössischem Abschluss.' },
        { title: 'Grenzgänger willkommen', desc: 'Tessiner Franchisenehmer stellen regelmässig G-Bewilligungs-Bewerbende für alle Rollen ein.' },
      ],
      faqs: [
        { q: "Stellen Tessiner McDonald's Grenzgänger ein?", a: "Ja. Tessiner McDonald's-Restaurants werden von lokalen Franchisenehmern betrieben, die regelmässig G-Bewilligungs-Inhaber einstellen, insbesondere als Crew, Trainer und Shift Manager. Keine Vorerfahrung in der Gastronomie nötig." },
        { q: "Wie viel zahlt McDonald's in der Schweiz?", a: "Die Löhne richten sich nach dem L-GAV und interner Policy. Richtwerte brutto im Tessin: Crew-Einstieg CHF 22–24/Stunde (ca. CHF 4'000–4'400 bei 100 %) × 13, Trainer CHF 24–26/Stunde, Shift Manager CHF 4'600–5'200/Monat × 13, Assistant Manager CHF 5'500–6'500 × 13, Restaurant Manager CHF 7'500–10'000 × 13. 13. Monatslohn inbegriffen." },
        { q: 'Welche Bewilligungen werden akzeptiert?', a: "Schweizer Staatsangehörige sowie Inhaber der Bewilligungen C, B, G und Li (EU/EFTA). Für Tessiner Restaurants ist die G-Bewilligung vollständig unterstützt; einige Franchisenehmer bieten für Managerrollen auch B-Bewilligungs-Sponsoring." },
        { q: "Bietet McDonald's Lehrstellen im Tessin?", a: "Ja. Tessiner Restaurants bilden jährlich Lernende zur/zum Restaurationsfachfrau/-mann EFZ und Systemgastronomie-Koch/Köchin EFZ aus. Bewerbungen öffnen im Herbst für das folgende Schuljahr; Mindestalter 15 Jahre bei Stellenantritt." },
        { q: 'Ist Teilzeit möglich?', a: "Ja. Die Mehrheit der Crew arbeitet Teilzeit zwischen 20 % und 80 %. Die Planung erfolgt wöchentlich nach Verfügbarkeit und Auslastung — gut geeignet für Studierende und Eltern." },
        { q: 'Wie bewerbe ich mich direkt im Restaurant?', a: "Neben mcdonalds.ch/carriera können Sie Ihren Lebenslauf direkt im Restaurant zu Randzeiten (10–11 oder 14–16 Uhr) abgeben. Im Tessin sehr verbreitet und führt oft innert einer Woche zum Gespräch." },
      ],
      locationsIntro: "McDonald's ist im Tessin in allen grösseren Ortschaften vertreten. Lokale Franchisenehmer stellen eigenständig ein: bewerben Sie sich beim Restaurant am nächsten zum Wohnort.",
      emptyStateNote: "Aktuell keine aktiven McDonald's-Schweiz-Stellen in unserer Datenbank. Crew-Stellen werden oft nicht online publiziert — direkt am nächstgelegenen Restaurant bewerben.",
      metaTitle: "Jobs bei McDonald's Schweiz | Offene Stellen Kanton Tessin",
      metaDescription: "McDonald's Schweiz: Tessiner Restaurants, Löhne, Lehrstellen, Schichten und Grenzgänger-Bewerbung. Täglich aktualisiert.",
    },
    fr: {
      h1: "Travailler chez McDonald's Suisse — restaurants au Tessin",
      tagline: "Emplois McDonald's au Tessin : équipier, managers, apprentissage. Salaires, horaires, comment postuler.",
      paragraphs: [
        "McDonald's Suisse est active en Suisse depuis 1976, année de l'ouverture du premier restaurant à Genève. La chaîne compte aujourd'hui plus de 175 restaurants dans tout le pays, avec siège à Crissier (VD). La majorité des restaurants est exploitée en franchise par des entrepreneurs locaux, une partie plus réduite en Company-operated. Chaque année, McDonald's Suisse sert plus de 110 millions de clients et figure parmi les plus grands employeurs de la restauration avec environ 7'500 collaborateurs de plus de 100 nationalités.",
        "Au Tessin, McDonald's est présent dans les principales localités — Lugano (Via Vedeggio, Gare, Cassarate), Mendrisio, Bellinzona/S. Antonino, Locarno, Chiasso, Grancia, Tenero — en franchise auprès d'entrepreneurs tessinois. Les restaurants sont ouverts 7 jours sur 7 avec des horaires étendus (petit-déjeuner, midi, soir, service de soirée et McDrive), créant une demande continue de personnel en matin, après-midi, soirée et nuit.",
        "Les profils les plus recherchés sont Équipier/ère (préparation, service et caisse), Trainer (équipier senior avec responsabilité formative), Shift Manager, Assistant Manager et Restaurant Manager. McDonald's Suisse est aussi l'un des plus grands formateurs de la gastronomie, avec des apprentissages CFC d'Employé/e en restauration (3 ans) et de Cuisinier/ère en restauration de système (3 ans). Le parcours interne typique va de l'entrée équipier à la direction de restaurant en 5-8 ans pour ceux qui s'investissent sur le long terme.",
        "Pour les frontaliers italiens, les restaurants McDonald's du Tessin sont très accessibles : Chiasso, Mendrisio, Grancia et Lugano sont à 15-40 minutes des principales communes frontalières, les horaires tournants permettent d'adapter le trajet au trafic, et la formation initiale est entièrement assurée sur place sans expérience préalable. Les franchisés tessinois engagent régulièrement des candidats avec Permis G.",
      ],
      sectionHeadings: {
        locations: "Restaurants McDonald's au Tessin",
        benefits: "Pourquoi travailler chez McDonald's",
        openRoles: 'Postes ouverts aujourd\'hui',
        howToApply: "Comment postuler chez McDonald's",
        faq: 'Questions fréquentes',
        about: "À propos de McDonald's Suisse",
      },
      howToApply: "Toutes les offres officielles McDonald's Suisse sont publiées sur mcdonalds.ch/carriera et suivies quotidiennement par Frontaliere Ticino. Le processus pour les rôles équipier est très rapide : (1) candidature en ligne ou directement au restaurant ; (2) entretien informel avec le manager du restaurant sous quelques jours ; (3) essai pratique de 2-4 heures sur site ; (4) signature du contrat avec heures hebdomadaires garanties, horaires, salaire et période d'essai. Pour les rôles de manager, un second entretien avec le franchisé ou le superviseur de zone est ajouté.",
      benefits: [
        { title: "Formation complète payée", desc: "Onboarding structuré (Crew Training, Safe & Respectful Workplace, Food Safety) entièrement à la charge de l'employeur." },
        { title: 'Horaires de travail flexibles', desc: 'Shifts matin, après-midi, soir, nuit et week-end : compatibles avec études, famille et navette frontalière.' },
        { title: 'Repas collaborateur à prix réduit', desc: 'Rabais significatif sur le menu pendant les shifts et possibilité de repas gratuit selon politique du franchisé.' },
        { title: 'Carrière interne structurée', desc: 'Parcours officiel Équipier → Trainer → Shift Manager → Assistant Manager → Restaurant Manager avec cours à la Hamburger University.' },
        { title: 'Apprentissage CFC reconnu', desc: "Apprentissages d'Employé/e en restauration CFC et de Cuisinier/ère en restauration de système CFC dans les restaurants tessinois, avec diplôme fédéral à la clé." },
        { title: 'Frontaliers bienvenus', desc: 'Les franchisés tessinois engagent régulièrement des titulaires de Permis G pour tous les rôles du restaurant.' },
      ],
      faqs: [
        { q: "Les McDonald's du Tessin engagent-ils des frontaliers ?", a: "Oui. Les restaurants tessinois sont exploités par des franchisés locaux qui engagent régulièrement des titulaires de Permis G, en particulier comme équipier, trainer et shift manager. Aucune expérience préalable en restauration n'est requise pour les rôles équipier." },
        { q: "Quels salaires paie McDonald's en Suisse ?", a: "Les salaires suivent la CCL nationale de l'hôtellerie-restauration (CCNT/L-GAV) et les politiques internes. Valeurs brutes indicatives au Tessin : équipier débutant CHF 22-24/heure (env. CHF 4'000-4'400 à 100 %) × 13, trainer CHF 24-26/heure, shift manager CHF 4'600-5'200/mois × 13, assistant manager CHF 5'500-6'500 × 13, restaurant manager CHF 7'500-10'000 × 13. 13e mois inclus." },
        { q: 'Quels permis sont acceptés ?', a: "Citoyens suisses et titulaires de permis C, B, G et Li (UE/AELE). Pour les restaurants tessinois, le Permis G est pleinement pris en charge ; certains franchisés offrent aussi un sponsoring Permis B pour les rôles de manager." },
        { q: "McDonald's propose-t-il des apprentissages au Tessin ?", a: "Oui. Les restaurants tessinois forment chaque année des apprentis Employé/e en restauration CFC et Cuisinier/ère en restauration de système CFC. Les candidatures ouvrent en automne pour l'année scolaire suivante ; âge minimum 15 ans à l'engagement." },
        { q: 'Le temps partiel est-il possible ?', a: "Oui. La majorité des équipiers travaille à temps partiel entre 20 % et 80 %. Les plannings sont établis chaque semaine en fonction des disponibilités et de l'affluence — particulièrement adapté aux étudiants et aux parents." },
        { q: 'Comment postuler directement au restaurant ?', a: "En plus du portail mcdonalds.ch/carriera, vous pouvez déposer votre CV directement au restaurant en dehors des heures de pointe (10-11 ou 14-16). Très courant au Tessin et permet souvent un entretien dans la semaine." },
      ],
      locationsIntro: "McDonald's est présent au Tessin dans toutes les principales localités. Les franchisés locaux engagent de manière autonome : postulez au restaurant le plus proche de chez vous.",
      emptyStateNote: "Aucun poste McDonald's Suisse actif dans notre base pour l'instant. Les postes équipier ne sont souvent pas publiés en ligne — postulez directement au restaurant le plus proche.",
      metaTitle: "Emplois McDonald's Suisse | Postes ouverts Canton du Tessin",
      metaDescription: "McDonald's Suisse : restaurants du Tessin, salaires, apprentissage, horaires et candidature frontalière. Mis à jour chaque jour.",
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LIS — Lugano Istituti Sociali
// Source: https://www.lugano-lis.ch (verified 2026-04)
// Ente Autonomo di diritto pubblico della Città di Lugano; cura anziani +
// educazione infanzia. Careers: https://lavoraconnoi.lugano-lis.ch
// ─────────────────────────────────────────────────────────────────────────────

const LIS: EmployerBrand = {
  brandKey: 'lis-lugano-istituti-sociali',
  name: 'LIS – Lugano Istituti Sociali',
  shortName: 'LIS',
  fullName: 'Ente Autonomo di diritto pubblico Lugano Istituti Sociali',
  website: 'https://www.lugano-lis.ch',
  careersUrl: 'https://lavoraconnoi.lugano-lis.ch',
  locations: [
    'Sede amministrativa e Centro Residenziale Gemmo — Pregassona (Lugano)',
    'Casa Serena — Lugano',
    'Casa Girasole — Breganzona (Lugano)',
    'Casa Cigno — Viganello (Lugano)',
    "Nidi d'infanzia e servizi per la prima infanzia della Città di Lugano",
    'Servizi esterni di animazione socioculturale sul territorio cittadino',
  ],
  headquarters: {
    streetAddress: 'Via alla Bozzoreda 46',
    postalCode: '6963',
    addressLocality: 'Pregassona',
    addressRegion: 'TI',
    addressCountry: 'CH',
  },
  sameAs: [
    'https://www.linkedin.com/company/lugano-istituti-sociali',
  ],
  copy: {
    it: {
      h1: 'Lavorare in LIS — Lugano Istituti Sociali',
      tagline: 'Offerte di lavoro LIS Lugano: cure a lungo termine, educazione infanzia, animazione. Stipendi, sedi, candidatura.',
      paragraphs: [
        "LIS — Lugano Istituti Sociali è l'Ente Autonomo di diritto pubblico della Città di Lugano che gestisce i servizi sociali di competenza comunale: cure a lungo termine per anziani in case per anziani e centri residenziali, servizi per la prima infanzia (nidi e asili nido) e animazione socioculturale sul territorio. L'ente copre un bacino che serve Lugano e i comuni aggregati e rappresenta, accanto a EOC, uno dei principali datori di lavoro del settore sociosanitario e socioeducativo del Luganese.",
        "La struttura LIS più articolata è il Centro Residenziale Gemmo di Pregassona, che ospita reparti di cura per anziani (lungodegenti, dementi, cure palliative) insieme a spazi di riabilitazione geriatrica; il Centro Gemmo funge anche da sede amministrativa dell'ente. Alla rete Gemmo si affiancano Casa Serena a Lugano città, Casa Girasole a Breganzona e Casa Cigno a Viganello, oltre a nidi comunali, spazi di ritrovo per famiglie e servizi di animazione. Complessivamente LIS gestisce diverse centinaia di posti letto di cura e decine di posti di accoglienza della prima infanzia.",
        "Le assunzioni seguono il formato tipico dell'ente pubblico cantonale: concorsi pubblici pubblicati sul portale lavoraconnoi.lugano-lis.ch con indicazione della classe stipendio, del regolamento organico applicabile e della sede di lavoro. I profili ricorrenti sono infermieri, operatori sociosanitari (OSS), assistenti di cura, capireparto, fisioterapisti ed ergoterapisti, operatori settore animazione, educatori sociali, educatori dell'infanzia e operatori socioassistenziali per la prima infanzia, oltre a profili di supporto (cucina, pulizie, amministrazione, manutenzione).",
        "Per i frontalieri italiani LIS è un datore di lavoro particolarmente accessibile: tutte le sedi operative sono a Lugano o nei quartieri cittadini, raggiungibili in 25-40 minuti dai principali comuni di confine (Como, Varese, Porto Ceresio) in auto o con i treni TILO fino a Lugano. I concorsi pubblici accettano candidature da titolari di Permesso G; per i ruoli sanitari regolamentati è richiesto il riconoscimento federale del titolo italiano, gestito tramite Croce Rossa Svizzera o MEBEKO con il supporto dell'ente.",
      ],
      sectionHeadings: {
        locations: 'Sedi LIS a Lugano',
        benefits: 'Perché lavorare in LIS',
        openRoles: 'Posizioni aperte oggi',
        howToApply: 'Come candidarsi in LIS',
        faq: 'Domande frequenti',
        about: 'Chi è LIS',
      },
      howToApply: "Tutte le posizioni ufficiali LIS sono pubblicate sul portale lavoraconnoi.lugano-lis.ch sotto forma di concorsi pubblici annuali validi per l'anno di riferimento e monitorate quotidianamente da Frontaliere Ticino. Il processo standard: (1) candidatura online con CV aggiornato, lettera di motivazione, diplomi e certificato penale; (2) screening HR entro 2-4 settimane; (3) primo colloquio con il capo servizio; (4) secondo colloquio tecnico e/o giornata di osservazione per i ruoli di cura/educativi; (5) decisione di assunzione del Consiglio di Amministrazione con indicazione di classe stipendio, percentuale di lavoro e sede. Per le professioni sanitarie regolamentate è necessario il riconoscimento del titolo prima della firma.",
      benefits: [
        { title: '13ª mensilità secondo regolamento organico', desc: 'Stipendio su 13 mensilità secondo il Regolamento Organico dei Dipendenti della Città di Lugano applicato a LIS.' },
        { title: 'Previdenza e sicurezza del settore pubblico', desc: 'Cassa pensione pubblica con contributi superiori al minimo LPP; copertura AVS/AI/IPG e LAINF; ferie regolamentari 4-5 settimane.' },
        { title: 'Formazione continua finanziata', desc: "Giorni e budget per formazione continua in cura geriatrica, cure palliative, educazione dell'infanzia e animazione socioculturale." },
        { title: 'Part-time e conciliazione famiglia-lavoro', desc: 'Molti ruoli aperti dal 50% al 100%; possibilità di conciliazione tramite servizi interni per la prima infanzia.' },
        { title: "Sedi accessibili dall'Italia", desc: 'Tutte le sedi LIS sono in città o nei quartieri di Lugano, raggiungibili in 25-40 minuti dai comuni di confine italiani.' },
        { title: 'Lavoro con significato', desc: "Servizio pubblico al territorio: cura degli anziani, accompagnamento educativo dei più piccoli, animazione di comunità. Impatto concreto sulla qualità di vita dei cittadini di Lugano." },
      ],
      faqs: [
        { q: 'LIS assume frontalieri italiani?', a: "Sì. I concorsi pubblici LIS sono aperti a candidati con Permesso G. Per i ruoli sanitari (infermieri, OSS, fisioterapisti, ergoterapisti) è richiesto il riconoscimento federale del titolo italiano tramite Croce Rossa Svizzera; LIS supporta la procedura ma il riconoscimento va avviato dal candidato." },
        { q: 'Quali sono gli stipendi in LIS?', a: "Le retribuzioni seguono il Regolamento Organico dei Dipendenti della Città di Lugano, con classi stipendio pubbliche. Valori lordi annui indicativi: operatore sociosanitario 60-72 mila CHF, infermiere diplomato 75-95 mila CHF, fisioterapista 80-95 mila CHF, educatore dell'infanzia 65-80 mila CHF, capireparto 90-110 mila CHF. Tredicesima mensilità e indennità turni inclusi." },
        { q: 'Quali permessi accetta LIS?', a: "LIS, come ente pubblico del Canton Ticino, assume cittadini svizzeri e titolari di Permesso C, B, G e Li (UE/AELS). Per il Permesso G non sono richieste esperienze pregresse in enti svizzeri; la documentazione viene gestita dall'HR al momento dell'assunzione." },
        { q: 'Quali strutture gestisce LIS?', a: "LIS gestisce il Centro Residenziale Gemmo di Pregassona (sede principale e reparti cura anziani), Casa Serena (Lugano), Casa Girasole (Breganzona), Casa Cigno (Viganello), i nidi d'infanzia comunali della Città di Lugano e i servizi di animazione socioculturale sul territorio cittadino." },
        { q: 'Come funzionano i concorsi pubblici LIS?', a: "Ogni anno il Consiglio di Amministrazione LIS apre concorsi pubblici validi per l'anno di riferimento per diverse categorie professionali (es. infermieri, OSS, assistenti di cura, educatori). Le candidature vanno presentate tramite lavoraconnoi.lugano-lis.ch; la graduatoria viene utilizzata per le assunzioni durante tutto l'anno." },
        { q: 'LIS offre stage o tirocini?', a: "Sì. LIS accoglie regolarmente stagisti e tirocinanti da SUPSI (cure infermieristiche, fisioterapia, ergoterapia, lavoro sociale), dai centri di formazione OSS ticinesi e da scuole italiane in convenzione. La candidatura passa attraverso la scuola di provenienza o, per stage spontanei, attraverso il portale lavoraconnoi." },
      ],
      locationsIntro: "Le sedi LIS sono tutte a Lugano, distribuite tra Pregassona (Centro Gemmo), Breganzona, Viganello e il centro città. Puoi candidarti per la sede più vicina al tuo percorso di pendolarismo.",
      emptyStateNote: "In questo momento non ci sono posizioni LIS attive nella nostra banca dati. Gli annunci vengono aggiornati ogni giorno dal crawler: torna domani oppure consulta i concorsi pubblici in corso su lavoraconnoi.lugano-lis.ch.",
      metaTitle: 'Lavorare in LIS Lugano Istituti Sociali | Offerte di lavoro',
      metaDescription: "LIS Lugano: cura anziani, educazione infanzia, animazione. Stipendi, sedi (Pregassona, Breganzona, Viganello), candidatura frontaliere.",
    },
    en: {
      h1: 'Careers at LIS — Lugano Istituti Sociali',
      tagline: 'LIS Lugano jobs: long-term care, early-years education, community outreach. Salaries, sites, how to apply.',
      paragraphs: [
        "LIS — Lugano Istituti Sociali is the autonomous public-law body of the City of Lugano that runs the municipal social services: long-term care for seniors in care homes and residential centres, early-years services (municipal crèches and nurseries) and community outreach programmes. LIS serves Lugano and its merged neighbourhoods, and alongside EOC is one of the main employers in the Luganese social and healthcare sector.",
        'The flagship LIS facility is the Centro Residenziale Gemmo in Pregassona, with long-stay geriatric wards (dementia, palliative care) and geriatric rehabilitation, which also houses the LIS headquarters. The Gemmo network is complemented by Casa Serena in Lugano city, Casa Girasole in Breganzona and Casa Cigno in Viganello, together with municipal crèches, family-drop-in spaces and outreach services. In total LIS runs several hundred care beds and dozens of early-years places.',
        "Recruitment follows the format of a Ticino public body: public competitions (concorsi pubblici) published on lavoraconnoi.lugano-lis.ch stating the salary class, the applicable service regulation and the site. Recurring profiles are registered nurses, healthcare assistants (OSS), care assistants, ward leaders, physiotherapists and occupational therapists, activity leaders, social educators, early-years educators and early-years assistants, plus support profiles (kitchen, housekeeping, administration, maintenance).",
        "For Italian cross-border workers LIS is a very accessible employer: all sites are in Lugano city or the city neighbourhoods, 25–40 minutes from the main border towns (Como, Varese, Porto Ceresio) by car or TILO train. Public competitions accept G-permit applicants; regulated healthcare roles require federal recognition of the Italian qualification, handled via the Swiss Red Cross or MEBEKO with LIS support.",
      ],
      sectionHeadings: {
        locations: 'LIS sites in Lugano',
        benefits: 'Why work at LIS',
        openRoles: 'Open positions today',
        howToApply: 'How to apply at LIS',
        faq: 'Frequently asked questions',
        about: 'About LIS',
      },
      howToApply: 'All official LIS openings are published on lavoraconnoi.lugano-lis.ch as annual public competitions valid for the reference year, and tracked daily by Frontaliere Ticino. The standard process: (1) online application with CV, cover letter, diplomas and extract from the criminal record; (2) HR screening within 2–4 weeks; (3) first interview with the department head; (4) second technical interview and/or observation day for care/education roles; (5) hiring decision by the Board with salary class, workload and site. Regulated healthcare roles require recognition of the qualification before signature.',
      benefits: [
        { title: '13th-month salary under service regulation', desc: 'Salary over 13 months under the City of Lugano Employee Service Regulation applied to LIS.' },
        { title: 'Public-sector social protection', desc: 'Public pension fund with contributions above the LPP minimum; AHV/AI/IPG and LAA coverage; statutory 4–5 weeks of leave.' },
        { title: 'Funded continuing education', desc: 'Days and budget for continuing education in geriatric care, palliative care, early-years education and outreach.' },
        { title: 'Part-time and work-life balance', desc: 'Many roles open from 50% to 100%; work-life balance supported by in-house early-years services.' },
        { title: 'Sites accessible from Italy', desc: 'All LIS sites are in central Lugano or city neighbourhoods, 25–40 minutes from the main Italian border towns.' },
        { title: 'Meaningful work', desc: "Public service to the community: caring for seniors, educating the youngest children, animating city neighbourhoods. Concrete impact on Lugano residents' quality of life." },
      ],
      faqs: [
        { q: 'Does LIS hire Italian cross-border workers?', a: 'Yes. LIS public competitions are open to G-permit candidates. Healthcare roles (nurses, OSS, physiotherapists, occupational therapists) require federal recognition of the Italian qualification via the Swiss Red Cross; LIS supports the process but recognition must be started by the candidate.' },
        { q: 'What are typical LIS salaries?', a: 'Salaries follow the City of Lugano Employee Service Regulation, with public salary classes. Indicative gross annual figures: healthcare assistant CHF 60–72k, registered nurse CHF 75–95k, physiotherapist CHF 80–95k, early-years educator CHF 65–80k, ward leader CHF 90–110k. 13th-month and shift allowances included.' },
        { q: 'Which permits does LIS accept?', a: 'LIS, as a Ticino public body, hires Swiss citizens and holders of C, B, G and Li (EU/EFTA) permits. G-permit applicants do not need prior Swiss experience; paperwork is handled by HR at hiring.' },
        { q: 'Which facilities does LIS operate?', a: 'LIS operates the Centro Residenziale Gemmo in Pregassona (main site and senior-care wards), Casa Serena (Lugano), Casa Girasole (Breganzona), Casa Cigno (Viganello), the municipal early-years services of the City of Lugano and city outreach services.' },
        { q: 'How do LIS public competitions work?', a: 'Every year the LIS Board opens annual public competitions by professional category (nurses, OSS, care assistants, educators, etc.). Applications are submitted on lavoraconnoi.lugano-lis.ch; the resulting shortlist is used for hiring throughout the year.' },
        { q: 'Does LIS offer internships?', a: 'Yes. LIS regularly hosts interns and trainees from SUPSI (nursing, physiotherapy, occupational therapy, social work), Ticino OSS training centres and Italian schools under convention. Applications go through the sending school, or via lavoraconnoi for spontaneous internships.' },
      ],
      locationsIntro: 'All LIS sites are in Lugano, across Pregassona (Centro Gemmo), Breganzona, Viganello and the city centre. Apply to the site closest to your commute.',
      emptyStateNote: 'No active LIS roles in our database right now. Listings refresh daily — come back tomorrow or check current public competitions on lavoraconnoi.lugano-lis.ch.',
      metaTitle: 'Jobs at LIS Lugano Istituti Sociali | Open positions',
      metaDescription: 'LIS Lugano: senior care, early-years education, outreach. Salaries, sites (Pregassona, Breganzona, Viganello), cross-border application.',
    },
    de: {
      h1: 'Arbeiten bei LIS — Lugano Istituti Sociali',
      tagline: 'LIS Lugano Stellen: Langzeitpflege, Kinderbetreuung, soziokulturelle Animation. Löhne, Standorte, Bewerbung.',
      paragraphs: [
        "LIS — Lugano Istituti Sociali ist die autonome öffentlich-rechtliche Körperschaft der Stadt Lugano, die die kommunalen Sozialdienste betreibt: Langzeitpflege für Betagte in Alters- und Pflegeheimen, Früherziehungsdienste (Kitas, Kinderkrippen) und soziokulturelle Animation im Quartier. LIS bedient Lugano und seine eingemeindeten Quartiere und zählt neben dem EOC zu den wichtigsten Arbeitgebern des Sozial- und Gesundheitswesens im Luganese.",
        'Die bedeutendste LIS-Einrichtung ist das Centro Residenziale Gemmo in Pregassona, mit Langzeitpflege-Abteilungen (Demenz, Palliative Care) und geriatrischer Rehabilitation; das Centro Gemmo dient auch als Verwaltungssitz. Ergänzt wird es von Casa Serena in der Stadt Lugano, Casa Girasole in Breganzona und Casa Cigno in Viganello, dazu kommen städtische Kitas, Familientreffpunkte und Animationsdienste. Insgesamt betreibt LIS mehrere hundert Pflegebetten und Dutzende Plätze in der frühkindlichen Betreuung.',
        "Einstellungen folgen dem Format einer Tessiner öffentlichen Körperschaft: öffentliche Ausschreibungen (concorsi pubblici) auf lavoraconnoi.lugano-lis.ch mit Angabe der Lohnklasse, des anwendbaren Dienstreglements und des Einsatzorts. Wiederkehrende Profile sind diplomierte Pflegefachpersonen, Fachangestellte Gesundheit (OSS), Pflegeassistierende, Stationsleitung, Physio- und Ergotherapeuten, Animation, Sozialpädagogen, Früherzieherinnen und Früherzieher, dazu Support-Profile (Küche, Hauswirtschaft, Verwaltung, Technik).",
        'Für italienische Grenzgänger ist LIS ein gut erreichbarer Arbeitgeber: alle Standorte liegen in Lugano oder den Stadtquartieren, 25–40 Minuten von den Hauptgrenzgemeinden (Como, Varese, Porto Ceresio) per Auto oder TILO-Zug. Die öffentlichen Ausschreibungen akzeptieren G-Bewilligungs-Bewerbende; für reglementierte Gesundheitsrollen ist die eidgenössische Anerkennung des italienischen Abschlusses über das Schweizerische Rote Kreuz oder MEBEKO nötig; LIS unterstützt die Einleitung.',
      ],
      sectionHeadings: {
        locations: 'LIS-Standorte in Lugano',
        benefits: 'Warum bei LIS arbeiten',
        openRoles: 'Offene Stellen heute',
        howToApply: 'Bewerbung bei LIS',
        faq: 'Häufige Fragen',
        about: 'Über LIS',
      },
      howToApply: 'Alle offiziellen LIS-Stellen werden auf lavoraconnoi.lugano-lis.ch als jährliche öffentliche Ausschreibungen publiziert und täglich von Frontaliere Ticino erfasst. Standardablauf: (1) Online-Bewerbung mit Lebenslauf, Motivationsschreiben, Diplomen und Strafregisterauszug; (2) HR-Screening in 2–4 Wochen; (3) Erstgespräch mit der Abteilungsleitung; (4) Fachgespräch und/oder Hospitationstag für Pflege-/Erziehungsrollen; (5) Anstellungsentscheid des Verwaltungsrats mit Lohnklasse, Pensum und Standort. Reglementierte Gesundheitsrollen benötigen die Diplomanerkennung vor Unterzeichnung.',
      benefits: [
        { title: '13. Monatslohn nach Dienstreglement', desc: 'Lohn auf 13 Monate gemäss Dienstreglement der Stadt Lugano, auf LIS angewandt.' },
        { title: 'Öffentlich-rechtliche Sozialversicherung', desc: 'Öffentliche Pensionskasse mit überobligatorischen Beiträgen; AHV/IV/EO und UVG; gesetzlich 4–5 Wochen Ferien.' },
        { title: 'Finanzierte Weiterbildung', desc: 'Tage und Budget für Weiterbildung in Geriatrie, Palliative Care, Früherziehung und Animation.' },
        { title: 'Teilzeit und Work-Life-Balance', desc: 'Viele Rollen mit 50–100 % Pensum offen; Vereinbarkeit durch hauseigene Kita-Angebote unterstützt.' },
        { title: 'Aus Italien erreichbare Standorte', desc: 'Alle LIS-Standorte liegen in der Stadt Lugano oder den Quartieren, 25–40 Minuten von den italienischen Grenzgemeinden.' },
        { title: 'Sinnvolle Arbeit', desc: 'Öffentlicher Dienst für die Stadt: Pflege älterer Menschen, Erziehung der Kleinsten, Quartierarbeit. Konkreter Impact auf die Lebensqualität der Luganesen.' },
      ],
      faqs: [
        { q: 'Stellt LIS italienische Grenzgänger ein?', a: 'Ja. Die öffentlichen LIS-Ausschreibungen sind für G-Bewilligungs-Bewerbende offen. Für Gesundheitsrollen (Pflege, OSS, Physio, Ergo) ist die eidgenössische Anerkennung des italienischen Abschlusses über das Schweizerische Rote Kreuz erforderlich; LIS unterstützt, muss aber vom Kandidaten gestartet werden.' },
        { q: 'Wie hoch sind die LIS-Löhne?', a: 'Die Löhne richten sich nach dem Dienstreglement der Stadt Lugano mit öffentlichen Lohnklassen. Richtwerte brutto/Jahr: Fachangestellte Gesundheit 60–72 Tsd. CHF, diplomierte Pflegefachperson 75–95 Tsd. CHF, Physiotherapeut 80–95 Tsd. CHF, Früherzieher 65–80 Tsd. CHF, Stationsleitung 90–110 Tsd. CHF. 13. Monatslohn und Schichtzulagen inbegriffen.' },
        { q: 'Welche Bewilligungen akzeptiert LIS?', a: 'LIS als Tessiner öffentliche Körperschaft stellt Schweizer Staatsangehörige und Inhaber der Bewilligungen C, B, G und Li (EU/EFTA) ein. G-Bewilligungs-Bewerbende benötigen keine Vorerfahrung in Schweizer Einrichtungen.' },
        { q: 'Welche Einrichtungen betreibt LIS?', a: 'LIS betreibt das Centro Residenziale Gemmo in Pregassona (Hauptsitz und Betagtenpflege), Casa Serena (Lugano), Casa Girasole (Breganzona), Casa Cigno (Viganello), die städtischen Kindertagesstätten der Stadt Lugano und die soziokulturellen Quartierdienste.' },
        { q: 'Wie funktionieren die öffentlichen LIS-Ausschreibungen?', a: 'Jedes Jahr eröffnet der LIS-Verwaltungsrat jährliche öffentliche Ausschreibungen nach Berufskategorie (Pflege, OSS, Pflegeassistierende, Erzieher). Bewerbungen erfolgen über lavoraconnoi.lugano-lis.ch; die resultierende Rangliste wird für Einstellungen während des ganzen Jahres genutzt.' },
        { q: 'Bietet LIS Praktika an?', a: 'Ja. LIS nimmt regelmässig Praktikanten von SUPSI (Pflege, Physio, Ergo, Sozialarbeit), Tessiner OSS-Schulen und italienischen Partnerschulen auf. Anmeldung über die Herkunftsschule oder für Spontanpraktika über lavoraconnoi.' },
      ],
      locationsIntro: 'Alle LIS-Standorte liegen in Lugano, verteilt auf Pregassona (Centro Gemmo), Breganzona, Viganello und das Stadtzentrum. Bewerben Sie sich für den Standort, der am besten zu Ihrem Arbeitsweg passt.',
      emptyStateNote: 'Aktuell keine aktiven LIS-Stellen in unserer Datenbank. Die Angebote werden täglich aktualisiert — schauen Sie morgen wieder vorbei oder prüfen Sie die laufenden Ausschreibungen auf lavoraconnoi.lugano-lis.ch.',
      metaTitle: 'Jobs bei LIS Lugano Istituti Sociali | Offene Stellen',
      metaDescription: 'LIS Lugano: Altenpflege, Frühbetreuung, Animation. Löhne, Standorte (Pregassona, Breganzona, Viganello), Grenzgänger-Bewerbung.',
    },
    fr: {
      h1: 'Travailler à LIS — Lugano Istituti Sociali',
      tagline: 'Emplois LIS Lugano : soins de longue durée, petite enfance, animation socioculturelle. Salaires, sites, candidature.',
      paragraphs: [
        "LIS — Lugano Istituti Sociali est l'organisme autonome de droit public de la Ville de Lugano qui gère les services sociaux communaux : soins de longue durée pour les aînés en EMS et centres résidentiels, services de la petite enfance (crèches et garderies municipales) et animation socioculturelle de quartier. LIS dessert Lugano et ses quartiers fusionnés et, aux côtés de l'EOC, figure parmi les principaux employeurs du secteur social et sanitaire du Luganese.",
        "La structure LIS la plus importante est le Centro Residenziale Gemmo à Pregassona, avec des unités de soins de longue durée (démence, soins palliatifs) et de réadaptation gériatrique ; le Centro Gemmo abrite aussi le siège administratif de LIS. Le réseau Gemmo est complété par Casa Serena à Lugano, Casa Girasole à Breganzona et Casa Cigno à Viganello, ainsi que par les crèches municipales, les espaces familles et les services d'animation. Au total, LIS exploite plusieurs centaines de lits de soins et des dizaines de places de petite enfance.",
        "Les engagements suivent le format d'un organisme public tessinois : concours publics publiés sur lavoraconnoi.lugano-lis.ch avec indication de la classe salariale, du règlement organique applicable et du site. Profils récurrents : infirmiers diplômés, assistants en soins (OSS), assistants de soins, chefs de service, physiothérapeutes et ergothérapeutes, animateurs, éducateurs sociaux, éducateurs de la petite enfance et assistants socioéducatifs, plus des profils support (cuisine, nettoyage, administration, entretien).",
        "Pour les frontaliers italiens, LIS est un employeur très accessible : tous les sites sont à Lugano ou dans les quartiers, à 25-40 minutes des principales communes frontalières (Côme, Varèse, Porto Ceresio) en voiture ou en TILO. Les concours publics acceptent les candidatures Permis G ; pour les rôles de santé réglementés, la reconnaissance fédérale du titre italien via la Croix-Rouge suisse ou MEBEKO est nécessaire, avec le soutien de LIS.",
      ],
      sectionHeadings: {
        locations: 'Sites LIS à Lugano',
        benefits: 'Pourquoi travailler à LIS',
        openRoles: 'Postes ouverts aujourd\'hui',
        howToApply: 'Comment postuler à LIS',
        faq: 'Questions fréquentes',
        about: 'À propos de LIS',
      },
      howToApply: "Toutes les offres officielles LIS sont publiées sur lavoraconnoi.lugano-lis.ch sous forme de concours publics annuels valables pour l'année de référence, et suivies chaque jour par Frontaliere Ticino. Processus standard : (1) candidature en ligne avec CV, lettre de motivation, diplômes et extrait de casier judiciaire ; (2) tri RH sous 2-4 semaines ; (3) premier entretien avec le chef de service ; (4) entretien technique et/ou journée d'observation pour les rôles de soins/éducatifs ; (5) décision d'engagement du Conseil d'Administration avec classe salariale, taux et site. Les rôles de santé réglementés exigent la reconnaissance du titre avant signature.",
      benefits: [
        { title: '13e mois selon règlement organique', desc: 'Salaire sur 13 mois selon le Règlement organique des employés de la Ville de Lugano appliqué à LIS.' },
        { title: 'Protection sociale du secteur public', desc: 'Caisse de pension publique avec cotisations supérieures au minimum LPP ; AVS/AI/APG et LAA ; 4-5 semaines de congés légales.' },
        { title: 'Formation continue financée', desc: 'Jours et budget pour formation continue en gériatrie, soins palliatifs, petite enfance et animation socioculturelle.' },
        { title: 'Temps partiel et conciliation', desc: 'Nombreux rôles de 50 à 100 % ; conciliation famille-travail facilitée par les services internes de petite enfance.' },
        { title: "Sites accessibles depuis l'Italie", desc: 'Tous les sites LIS sont à Lugano ou dans les quartiers, 25-40 minutes des principales communes frontalières italiennes.' },
        { title: 'Travail qui a du sens', desc: "Service public à la cité : prendre soin des aînés, accompagner les plus petits, animer les quartiers. Impact concret sur la qualité de vie des Luganais." },
      ],
      faqs: [
        { q: 'LIS engage-t-il des frontaliers italiens ?', a: "Oui. Les concours publics LIS sont ouverts aux candidats avec Permis G. Pour les rôles de santé (infirmiers, OSS, physio, ergo), la reconnaissance fédérale du titre italien via la Croix-Rouge suisse est requise ; LIS accompagne mais le candidat doit initier la démarche." },
        { q: 'Quels salaires à LIS ?', a: "Les salaires suivent le Règlement organique de la Ville de Lugano, avec classes publiques. Valeurs brutes annuelles indicatives : assistant en soins 60-72 kCHF, infirmier diplômé 75-95 kCHF, physio 80-95 kCHF, éducateur de la petite enfance 65-80 kCHF, chef de service 90-110 kCHF. 13e mois et indemnités de shift inclus." },
        { q: 'Quels permis LIS accepte-t-il ?', a: "LIS, organisme public tessinois, engage citoyens suisses et titulaires de permis C, B, G et Li (UE/AELE). Aucun antécédent suisse requis pour les candidats Permis G ; l'administration est gérée par les RH à l'engagement." },
        { q: 'Quelles structures LIS exploite-t-il ?', a: "LIS exploite le Centro Residenziale Gemmo de Pregassona (siège et unités de soins pour aînés), Casa Serena (Lugano), Casa Girasole (Breganzona), Casa Cigno (Viganello), les crèches municipales de la Ville de Lugano et les services d'animation socioculturelle." },
        { q: 'Comment fonctionnent les concours publics LIS ?', a: "Chaque année, le Conseil d'Administration LIS ouvre des concours publics annuels par catégorie professionnelle (infirmiers, OSS, assistants de soins, éducateurs, etc.). Les candidatures se font sur lavoraconnoi.lugano-lis.ch ; la liste qui en résulte est utilisée pour les engagements tout au long de l'année." },
        { q: 'LIS propose-t-il des stages ?', a: "Oui. LIS accueille régulièrement des stagiaires de la SUPSI (soins, physio, ergo, travail social), des centres de formation OSS tessinois et des écoles italiennes conventionnées. Candidature via l'école d'origine ou, pour stages spontanés, via lavoraconnoi." },
      ],
      locationsIntro: "Tous les sites LIS sont à Lugano, répartis entre Pregassona (Centro Gemmo), Breganzona, Viganello et le centre-ville. Postulez au site le plus proche de votre trajet domicile-travail.",
      emptyStateNote: "Aucun poste LIS actif dans notre base pour l'instant. Les annonces sont actualisées chaque jour — revenez demain ou consultez les concours publics en cours sur lavoraconnoi.lugano-lis.ch.",
      metaTitle: 'Emplois LIS Lugano Istituti Sociali | Postes ouverts',
      metaDescription: 'LIS Lugano : soins aux aînés, petite enfance, animation. Salaires, sites (Pregassona, Breganzona, Viganello), candidature frontalière.',
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Manor AG — Swiss department-store chain
// Source: https://www.manor.ch (verified 2026-04)
// ─────────────────────────────────────────────────────────────────────────────

const MANOR: EmployerBrand = {
  brandKey: 'manor-ag',
  name: 'Manor AG',
  shortName: 'Manor',
  fullName: 'Manor AG',
  website: 'https://www.manor.ch',
  careersUrl: 'https://corporate.manor.ch/it/carriera',
  locations: [
    'Sede centrale Basilea (BS)',
    'Manor Food, Manor Sport, Manor Restaurant',
    'Grandi magazzini Manor in Ticino: Lugano, Locarno, Bellinzona, Biasca, Mendrisio',
    'Oltre 59 grandi magazzini in tutta la Svizzera',
  ],
  headquarters: {
    streetAddress: 'Rebgasse 34',
    postalCode: '4005',
    addressLocality: 'Basel',
    addressRegion: 'BS',
    addressCountry: 'CH',
  },
  sameAs: [
    'https://www.linkedin.com/company/manor-ag',
    'https://it.wikipedia.org/wiki/Manor_(azienda)',
  ],
  copy: {
    it: {
      h1: 'Lavorare in Manor — grandi magazzini e ristorazione in Ticino',
      tagline: 'Offerte di lavoro Manor in Ticino: vendita, Manor Food, Manor Restaurant, sede, logistica. Stipendi e candidatura.',
      paragraphs: [
        "Manor AG è la principale catena svizzera di grandi magazzini, con sede a Basilea e oltre 59 filiali in tutto il Paese. Fondata nel 1902, l'azienda è controllata dal gruppo Maus Frères e impiega circa 7'500 collaboratori in Svizzera. Il modello Manor combina il formato department store — moda, casa, bellezza, giocattoli, elettronica — con l'alimentare (Manor Food), la ristorazione (Manor Restaurant) e un'ampia gamma di servizi cliente, carte fedeltà e marketplace online manor.ch.",
        "In Ticino Manor è presente con grandi magazzini nelle principali località del cantone: Lugano (via Nassa e centro commerciale), Locarno, Bellinzona, Biasca e Mendrisio (centro commerciale Serfontana). I punti vendita ticinesi offrono reparti di moda, articoli per la casa, Manor Food e, nella maggior parte dei casi, un Manor Restaurant con cucina svizzera e internazionale. Manor è uno dei datori di lavoro storici del commercio ticinese.",
        "I profili più ricercati in Ticino sono addetti alla vendita (moda, casa, profumeria, giocattoli), cassieri, personale di Manor Food (macelleria, panetteria, pescheria, gastronomia), personale di Manor Restaurant (cuochi, sous-chef, commis, personale di servizio, lavapiatti), visual merchandiser, responsabili di reparto e apprendisti del commercio al dettaglio e della ristorazione. A livello di sede e logistica Manor assume profili di acquisti, finanza, marketing, IT, HR e supply chain.",
        "Per i frontalieri italiani Manor è un datore di lavoro interessante: i grandi magazzini del Mendrisiotto, del Luganese e del Sottoceneri sono raggiungibili entro 20-40 minuti dai principali comuni italiani di confine. L'azienda accetta candidature con Permesso G per la quasi totalità dei ruoli operativi, applica il CCL svizzero del commercio al dettaglio e della ristorazione L-GAV per i ristoranti, offre formazione on-the-job e valuta equipollenze per i titoli italiani nei profili di apprendistato e tecnici.",
      ],
      sectionHeadings: {
        locations: 'Sedi e filiali Manor in Ticino',
        benefits: 'Perché lavorare in Manor',
        openRoles: 'Posizioni aperte oggi',
        howToApply: 'Come candidarsi in Manor',
        faq: 'Domande frequenti',
        about: 'Chi è Manor',
      },
      howToApply: 'Tutte le posizioni ufficiali Manor sono pubblicate su corporate.manor.ch/carriera e monitorate quotidianamente da Frontaliere Ticino. Processo standard: (1) candidatura online con CV aggiornato e lettera di motivazione; (2) screening HR entro 1-2 settimane; (3) colloquio in filiale con Capo Reparto e Direttore di filiale; (4) giornata di prova pagata per i ruoli di vendita e ristorazione; (5) offerta contrattuale con stipendio, orario (part-time o full-time), sede e CCL applicabile. Per i ruoli di sede a Basilea il processo include un secondo colloquio tecnico e può richiedere 4-6 settimane.',
      benefits: [
        { title: '13ª mensilità e CCL', desc: 'Stipendio di base su 13 mensilità secondo il CCL del commercio al dettaglio e L-GAV per la ristorazione; indennità per ore serali e domenicali.' },
        { title: 'Sconti personale', desc: 'Sconto dipendenti sui prodotti Manor e Manor Food; convenzioni con partner di assicurazione e tempo libero.' },
        { title: 'Formazione e apprendistato', desc: "Azienda formatrice riconosciuta per apprendistati AFC nel commercio al dettaglio, logistica, ristorazione e decorazione vetrine; programmi di sviluppo interno." },
        { title: 'Previdenza professionale LPP', desc: 'Cassa pensione Manor con contributi datoriali; copertura AVS/AI/IPG e infortuni LAINF inclusa.' },
        { title: 'Orari flessibili e part-time', desc: 'Molti ruoli disponibili con percentuali dal 40% al 100%; orari su turni per conciliare lavoro e famiglia.' },
        { title: 'Frontalieri benvenuti', desc: "L'azienda assume regolarmente titolari di Permesso G per le filiali ticinesi, in particolare nei reparti vendita, cassa, Manor Food e Manor Restaurant." },
      ],
      faqs: [
        { q: 'Manor assume frontalieri italiani?', a: "Sì. Le filiali Manor in Ticino pubblicano regolarmente posizioni aperte ai titolari di Permesso G per ruoli di vendita, cassa, Manor Food, Manor Restaurant e apprendistato. Le filiali di Mendrisio, Lugano, Locarno, Bellinzona e Biasca sono raggiungibili entro 20-40 minuti dai principali comuni italiani di confine." },
        { q: 'Quanto paga Manor in Svizzera?', a: "Le retribuzioni seguono il CCL del commercio al dettaglio e il L-GAV per la ristorazione. Valori lordi indicativi (dati pubblici): addetto/a alla vendita CHF 4'200-4'800/mese × 13, cassiere/a CHF 4'200-4'600 × 13, personale Manor Food CHF 4'300-5'000 × 13, cuoco Manor Restaurant CHF 4'500-5'500 × 13, responsabile di reparto CHF 5'800-7'500 × 13. Tredicesima inclusa. Usa il nostro simulatore fiscale per stimare il netto da frontaliere." },
        { q: 'Quali permessi di lavoro accetta Manor?', a: 'Manor assume cittadini svizzeri e titolari di Permesso C (domiciliato), B (soggiorno), G (frontaliere) e Li (cittadini UE/AELS). Per i ruoli operativi in Ticino il Permesso G è pienamente accettato; la documentazione è gestita dal servizio HR regionale alla firma del contratto.' },
        { q: 'Manor offre apprendistato?', a: "Sì. Manor è azienda formatrice riconosciuta per diversi apprendistati AFC: Impiegato/a del commercio al dettaglio (3 anni), Logistica, Cuoco/a, Impiegato/a di ristorazione, Decoratore/trice vetrine. Nuovi apprendisti vengono assunti ogni anno, anche nelle filiali ticinesi." },
        { q: 'Che tipo di contratti offre Manor?', a: "Manor offre contratti a tempo indeterminato (la maggior parte), a tempo determinato (stagionali, sostituzioni maternità), apprendistato AFC e stage. Le percentuali vanno dal 40% al 100%; molti ruoli di vendita e cassa sono disponibili in part-time per conciliare orari familiari." },
        { q: 'Come candidarsi spontaneamente in Manor?', a: 'Il portale corporate.manor.ch/carriera permette candidature spontanee per filiale e area funzionale. È consigliato indicare chiaramente sede preferita, percentuale desiderata e disponibilità oraria. Le candidature rimangono in database e vengono richiamate quando si apre una posizione compatibile.' },
      ],
      locationsIntro: "Manor gestisce una rete nazionale di grandi magazzini con filiali presenti nelle principali località ticinesi. Puoi candidarti per la filiale più vicina al tuo comune e richiedere trasferimenti interni dopo il periodo di prova.",
      emptyStateNote: 'In questo momento non ci sono posizioni Manor attive nella nostra banca dati. Gli annunci vengono aggiornati ogni giorno dal crawler: torna domani oppure candidati sul portale ufficiale corporate.manor.ch/carriera.',
      metaTitle: 'Lavorare in Manor | Offerte di lavoro Ticino',
      metaDescription: 'Manor: grandi magazzini in Ticino, Manor Food, Manor Restaurant, stipendi, apprendistato, candidatura frontaliere. Offerte aggiornate ogni giorno.',
    },
    en: {
      h1: 'Careers at Manor — department stores and restaurants across Ticino',
      tagline: 'Manor jobs in Canton Ticino: sales, Manor Food, Manor Restaurant, HQ, logistics. Salaries, sites, how to apply.',
      paragraphs: [
        'Manor AG is the leading Swiss department-store chain, headquartered in Basel with more than 59 stores nationwide. Founded in 1902 and owned by the Maus Frères group, the company employs around 7,500 people in Switzerland. The Manor model combines the traditional department-store format — fashion, home, beauty, toys, electronics — with food retail (Manor Food), restaurants (Manor Restaurant) and a growing range of customer services, loyalty programmes and the manor.ch online marketplace.',
        'In Canton Ticino Manor operates department stores in the main locations: Lugano (via Nassa and shopping centre), Locarno, Bellinzona, Biasca and Mendrisio (Serfontana shopping centre). Ticino stores feature fashion and home departments, Manor Food supermarkets and, in most cases, a Manor Restaurant serving Swiss and international cuisine. Manor is one of the historic employers of Ticino retail.',
        "Most sought-after Ticino profiles are sales assistants (fashion, home, perfumery, toys), cashiers, Manor Food staff (butchery, bakery, fish counter, deli), Manor Restaurant staff (chefs, sous-chefs, commis, service, dishwashers), visual merchandisers, department managers and retail and hospitality apprentices. At HQ and in logistics, Manor also hires profiles in buying, finance, marketing, IT, HR and supply chain.",
        'For Italian cross-border workers, Manor is an attractive employer: department stores in Mendrisiotto, Luganese and Sottoceneri are 20–40 minutes from the main Italian border towns. G-permit applications are accepted for almost all operational roles, the Swiss retail CLA and the hospitality L-GAV apply, training is provided on the job, and Italian qualifications are recognised for apprenticeships and technical profiles where equivalence applies.',
      ],
      sectionHeadings: {
        locations: 'Manor sites and stores in Ticino',
        benefits: 'Why work at Manor',
        openRoles: 'Open positions today',
        howToApply: 'How to apply at Manor',
        faq: 'Frequently asked questions',
        about: 'About Manor',
      },
      howToApply: 'All official Manor openings are published on corporate.manor.ch/career and tracked daily by Frontaliere Ticino. Standard process: (1) online application with up-to-date CV and cover letter; (2) HR screening within 1–2 weeks; (3) store interview with department manager and store director; (4) paid trial day for sales and hospitality roles; (5) contract offer with salary, hours (part-time or full-time), site and applicable CLA. For HQ roles in Basel, the process includes a second technical interview and can take 4–6 weeks.',
      benefits: [
        { title: '13th-month salary and CLA', desc: 'Base salary over 13 months under the Swiss retail CLA and the hospitality L-GAV for restaurants; evening and Sunday allowances.' },
        { title: 'Employee discount', desc: 'Staff discount on Manor and Manor Food products; partnerships with insurers and leisure providers.' },
        { title: 'Training and apprenticeships', desc: 'Accredited training company for AFC apprenticeships in retail, logistics, hospitality and window decoration; internal development programmes.' },
        { title: 'LPP occupational pension', desc: 'Manor pension fund with employer contributions; AVS/AI/IPG social security and LAA accident cover included.' },
        { title: 'Flexible hours and part-time', desc: 'Many roles available from 40% to 100%; shift-based schedules to balance work and family.' },
        { title: 'Cross-border workers welcome', desc: 'Manor regularly hires G-permit holders for Ticino stores, especially in sales, cashier, Manor Food and Manor Restaurant departments.' },
      ],
      faqs: [
        { q: 'Does Manor hire Italian cross-border workers?', a: 'Yes. Manor Ticino stores regularly post roles open to G-permit applicants in sales, cashier, Manor Food, Manor Restaurant and apprenticeships. The Mendrisio, Lugano, Locarno, Bellinzona and Biasca stores are 20–40 minutes from the main Italian border towns.' },
        { q: 'What does Manor pay in Switzerland?', a: 'Salaries follow the retail CLA and the L-GAV hospitality agreement. Indicative gross figures (public data): sales assistant CHF 4,200–4,800/month × 13, cashier CHF 4,200–4,600 × 13, Manor Food staff CHF 4,300–5,000 × 13, Manor Restaurant chef CHF 4,500–5,500 × 13, department manager CHF 5,800–7,500 × 13. 13th-month included. Use our fiscal simulator to estimate net pay as a cross-border worker.' },
        { q: 'Which work permits does Manor accept?', a: 'Swiss citizens and holders of C (settled), B (resident), G (cross-border) and Li (EU/EFTA) permits. For Ticino operational roles the G permit is fully accepted; paperwork is handled by regional HR at contract signature.' },
        { q: 'Does Manor offer apprenticeships?', a: 'Yes. Manor is an accredited training company for several AFC apprenticeships: retail employee (3 years), logistics, chef, hospitality employee, window decorator. New apprentices are hired every year, including in Ticino stores.' },
        { q: 'What types of contracts does Manor offer?', a: 'Manor offers permanent contracts (most roles), fixed-term (seasonal, maternity cover), AFC apprenticeships and internships. Percentages range from 40% to 100%; many sales and cashier roles are available part-time for family-friendly scheduling.' },
        { q: 'How do I submit a speculative application to Manor?', a: 'The corporate.manor.ch/career portal accepts speculative applications by store and function. It is recommended to specify preferred site, target percentage and time availability. Applications stay in the database and are retrieved when a matching role opens.' },
      ],
      locationsIntro: 'Manor runs a nationwide department-store network with stores in all the main Ticino towns. Apply to the store closest to you and request internal transfers after probation.',
      emptyStateNote: 'No active Manor roles in our database right now. Listings refresh daily — come back tomorrow or apply on corporate.manor.ch/career.',
      metaTitle: 'Jobs at Manor | Open roles in Canton Ticino',
      metaDescription: 'Manor: Ticino department stores, Manor Food, Manor Restaurant, salaries, apprenticeships, cross-border application. Refreshed daily.',
    },
    de: {
      h1: 'Arbeiten bei Manor — Warenhäuser und Restaurants im Tessin',
      tagline: 'Manor-Stellen im Kanton Tessin: Verkauf, Manor Food, Manor Restaurant, Hauptsitz, Logistik. Löhne und Bewerbung.',
      paragraphs: [
        "Manor AG ist die führende Schweizer Warenhauskette mit Hauptsitz in Basel und über 59 Filialen landesweit. 1902 gegründet und im Besitz der Gruppe Maus Frères, beschäftigt das Unternehmen rund 7'500 Mitarbeitende in der Schweiz. Das Manor-Modell verbindet das klassische Warenhaus — Mode, Wohnen, Beauty, Spielwaren, Elektronik — mit Lebensmitteln (Manor Food), Gastronomie (Manor Restaurant) sowie Kundendienstleistungen, Treueprogrammen und dem Online-Marktplatz manor.ch.",
        'Im Kanton Tessin betreibt Manor Warenhäuser an den wichtigsten Standorten: Lugano (Via Nassa und Einkaufszentrum), Locarno, Bellinzona, Biasca und Mendrisio (Einkaufszentrum Serfontana). Die Tessiner Filialen bieten Mode- und Wohnabteilungen, Manor-Food-Supermärkte und in den meisten Fällen ein Manor Restaurant mit Schweizer und internationaler Küche. Manor ist einer der traditionsreichsten Arbeitgeber im Tessiner Detailhandel.',
        'Gefragteste Tessiner Profile sind Verkaufspersonal (Mode, Wohnen, Parfümerie, Spielwaren), Kassenpersonal, Manor-Food-Mitarbeitende (Metzgerei, Bäckerei, Fischtheke, Gastronomie), Manor-Restaurant-Personal (Köche, Sous-Chefs, Commis, Service, Spülküche), Visual Merchandiser, Abteilungsleitungen sowie Lernende im Detailhandel und in der Gastronomie. Am Hauptsitz und in der Logistik stellt Manor Profile in Einkauf, Finanzen, Marketing, IT, HR und Supply Chain ein.',
        'Für italienische Grenzgänger ist Manor ein attraktiver Arbeitgeber: Warenhäuser im Mendrisiotto, Luganese und Sottoceneri sind 20–40 Minuten von den italienischen Grenzgemeinden entfernt. G-Bewilligungs-Bewerbungen werden für fast alle operativen Rollen akzeptiert, der nationale Detailhandels-GAV und der L-GAV für die Gastronomie gelten, die Einarbeitung erfolgt on the job, und italienische Abschlüsse werden bei Lehrstellen und technischen Profilen bei Äquivalenz anerkannt.',
      ],
      sectionHeadings: {
        locations: 'Manor-Standorte und Filialen im Tessin',
        benefits: 'Warum bei Manor arbeiten',
        openRoles: 'Offene Stellen heute',
        howToApply: 'Bewerbung bei Manor',
        faq: 'Häufige Fragen',
        about: 'Über Manor',
      },
      howToApply: 'Alle offiziellen Manor-Stellen werden auf corporate.manor.ch/karriere publiziert und täglich von Frontaliere Ticino erfasst. Ablauf: (1) Online-Bewerbung mit aktuellem Lebenslauf und Motivationsschreiben; (2) HR-Screening in 1–2 Wochen; (3) Filialgespräch mit Abteilungsleitung und Filialdirektion; (4) bezahlter Schnuppertag für Verkauf und Gastronomie; (5) Vertragsangebot mit Lohn, Arbeitszeit (Teilzeit oder Vollzeit), Standort und GAV. Für Hauptsitz-Rollen in Basel folgt ein zweites Fachgespräch; der Prozess dauert 4–6 Wochen.',
      benefits: [
        { title: '13. Monatslohn und GAV', desc: 'Grundlohn auf 13 Monate gemäss Detailhandels-GAV und L-GAV für die Gastronomie; Abend- und Sonntagszulagen.' },
        { title: 'Personalrabatt', desc: 'Mitarbeiterrabatt auf Manor- und Manor-Food-Produkte; Vergünstigungen bei Versicherungs- und Freizeitpartnern.' },
        { title: 'Ausbildung und Lehrstellen', desc: 'Anerkannter Ausbildungsbetrieb für EFZ-Lehrstellen im Detailhandel, Logistik, Gastronomie und Schaufensterdekoration; interne Entwicklungsprogramme.' },
        { title: 'BVG-Pensionskasse', desc: 'Manor-Pensionskasse mit Arbeitgeberbeiträgen; AHV/IV/EO und UVG inbegriffen.' },
        { title: 'Flexible Arbeitszeiten und Teilzeit', desc: 'Viele Rollen von 40 % bis 100 %; Schichtpläne zur Vereinbarkeit von Beruf und Familie.' },
        { title: 'Grenzgänger willkommen', desc: 'Manor stellt regelmässig G-Bewilligungs-Inhaber für Tessiner Filialen ein, insbesondere in Verkauf, Kasse, Manor Food und Manor Restaurant.' },
      ],
      faqs: [
        { q: 'Stellt Manor italienische Grenzgänger ein?', a: 'Ja. Tessiner Manor-Warenhäuser schreiben regelmässig Stellen für G-Bewilligungs-Bewerbende aus — Verkauf, Kasse, Manor Food, Manor Restaurant und Lehrstellen. Die Filialen in Mendrisio, Lugano, Locarno, Bellinzona und Biasca sind 20–40 Minuten von den italienischen Grenzgemeinden entfernt.' },
        { q: 'Wie hoch sind die Manor-Löhne in der Schweiz?', a: "Die Löhne richten sich nach dem Detailhandels-GAV und dem L-GAV für die Gastronomie. Richtwerte brutto (öffentliche Daten): Verkauf CHF 4'200–4'800/Monat × 13, Kasse CHF 4'200–4'600 × 13, Manor-Food-Personal CHF 4'300–5'000 × 13, Manor-Restaurant-Koch CHF 4'500–5'500 × 13, Abteilungsleitung CHF 5'800–7'500 × 13. 13. Monatslohn inbegriffen. Mit unserem Steuerrechner den Grenzgänger-Nettolohn schätzen." },
        { q: 'Welche Bewilligungen akzeptiert Manor?', a: 'Schweizer Staatsangehörige und Inhaber der Bewilligungen C (niedergelassen), B (Aufenthalt), G (Grenzgänger) und Li (EU/EFTA). Für operative Rollen im Tessin ist die G-Bewilligung vollständig akzeptiert; die Administration übernimmt das regionale HR-Team.' },
        { q: 'Bietet Manor Lehrstellen an?', a: 'Ja. Manor ist anerkannter Ausbildungsbetrieb für mehrere EFZ-Lehren: Detailhandelsfachfrau/-mann (3 Jahre), Logistik, Koch/Köchin, Restaurationsfachfrau/-mann, Gestalter/in Schaufenster. Jedes Jahr werden neue Lernende eingestellt, auch in den Tessiner Filialen.' },
        { q: 'Welche Vertragsarten bietet Manor?', a: 'Manor bietet unbefristete Verträge (Mehrheit), befristete Verträge (saisonal, Mutterschaftsvertretung), EFZ-Lehrstellen und Praktika. Pensen von 40 % bis 100 %; viele Verkaufs- und Kassenrollen stehen in Teilzeit zur Verfügung, um Familie und Beruf zu vereinbaren.' },
        { q: 'Wie funktioniert eine Spontanbewerbung bei Manor?', a: 'Das Portal corporate.manor.ch/karriere nimmt Spontanbewerbungen nach Filiale und Bereich entgegen. Empfohlen wird, Wunschstandort, Pensum und zeitliche Verfügbarkeit klar anzugeben. Die Bewerbungen bleiben in der Datenbank und werden bei passenden Öffnungen wiederverwendet.' },
      ],
      locationsIntro: 'Manor betreibt ein landesweites Warenhausnetz mit Filialen in allen wichtigen Tessiner Ortschaften. Bewerben Sie sich für die nächstgelegene Filiale und beantragen Sie interne Versetzungen nach der Probezeit.',
      emptyStateNote: 'Aktuell keine aktiven Manor-Stellen in unserer Datenbank. Die Angebote werden täglich aktualisiert — schauen Sie morgen wieder vorbei oder bewerben Sie sich auf corporate.manor.ch/karriere.',
      metaTitle: 'Jobs bei Manor | Offene Stellen Kanton Tessin',
      metaDescription: 'Manor: Tessiner Warenhäuser, Manor Food, Manor Restaurant, Löhne, Lehrstellen, Grenzgänger-Bewerbung. Täglich aktualisiert.',
    },
    fr: {
      h1: 'Travailler chez Manor — grands magasins et restaurants au Tessin',
      tagline: 'Emplois Manor au Tessin : vente, Manor Food, Manor Restaurant, siège, logistique. Salaires et candidature.',
      paragraphs: [
        "Manor AG est la principale chaîne suisse de grands magasins, dont le siège est à Bâle et qui compte plus de 59 filiales dans tout le pays. Fondée en 1902 et détenue par le groupe Maus Frères, l'entreprise emploie environ 7'500 collaborateurs en Suisse. Le modèle Manor combine le format traditionnel du grand magasin — mode, maison, beauté, jouets, électronique — avec l'alimentaire (Manor Food), la restauration (Manor Restaurant) et une gamme croissante de services, programmes de fidélité et la marketplace en ligne manor.ch.",
        'Au Canton du Tessin, Manor exploite des grands magasins dans les principales localités : Lugano (via Nassa et centre commercial), Locarno, Bellinzona, Biasca et Mendrisio (centre commercial Serfontana). Les filiales tessinoises comprennent des rayons mode et maison, des supermarchés Manor Food et, dans la plupart des cas, un Manor Restaurant proposant une cuisine suisse et internationale. Manor est l’un des employeurs historiques du commerce de détail tessinois.',
        "Les profils tessinois les plus recherchés sont les vendeurs/ses (mode, maison, parfumerie, jouets), caissiers/ères, personnel Manor Food (boucherie, boulangerie, poissonnerie, traiteur), personnel Manor Restaurant (cuisiniers, sous-chefs, commis, service, plonge), visual merchandisers, responsables de rayon et apprentis du commerce et de la restauration. Au siège et en logistique, Manor engage aussi des profils en achats, finance, marketing, IT, RH et supply chain.",
        "Pour les frontaliers italiens, Manor est un employeur attractif : les grands magasins du Mendrisiotto, du Luganese et du Sottoceneri se trouvent à 20-40 minutes des principales communes frontalières italiennes. Les candidatures avec Permis G sont acceptées pour la quasi-totalité des postes opérationnels, la CCL suisse du commerce de détail et la CCNT/L-GAV de l'hôtellerie-restauration s'appliquent, la formation est dispensée sur le poste, et les diplômes italiens sont reconnus pour les apprentissages et les profils techniques en cas d'équivalence.",
      ],
      sectionHeadings: {
        locations: 'Sites et magasins Manor au Tessin',
        benefits: 'Pourquoi travailler chez Manor',
        openRoles: 'Postes ouverts aujourd\'hui',
        howToApply: 'Comment postuler chez Manor',
        faq: 'Questions fréquentes',
        about: 'À propos de Manor',
      },
      howToApply: "Toutes les offres officielles Manor sont publiées sur corporate.manor.ch/carriere et suivies chaque jour par Frontaliere Ticino. Processus standard : (1) candidature en ligne avec CV à jour et lettre de motivation ; (2) tri RH sous 1-2 semaines ; (3) entretien en magasin avec responsable de rayon et directeur de filiale ; (4) journée d'essai rémunérée pour les rôles de vente et de restauration ; (5) offre contractuelle avec salaire, horaires (temps partiel ou plein), site et CCL applicable. Pour les rôles du siège à Bâle, un second entretien technique s'ajoute ; le processus prend 4-6 semaines.",
      benefits: [
        { title: '13e mois et CCL', desc: 'Salaire de base sur 13 mois selon la CCL du commerce de détail et la CCNT/L-GAV de la restauration ; indemnités de soirée et de dimanche.' },
        { title: 'Rabais personnel', desc: 'Rabais collaborateurs sur les produits Manor et Manor Food ; partenariats avec assureurs et prestataires loisirs.' },
        { title: 'Formation et apprentissages', desc: "Entreprise formatrice reconnue pour plusieurs apprentissages CFC : commerce de détail, logistique, restauration et décoration de vitrines ; programmes de développement internes." },
        { title: 'Prévoyance LPP', desc: 'Caisse de pension Manor avec cotisations employeur ; AVS/AI/APG et LAA inclus.' },
        { title: 'Horaires flexibles et temps partiel', desc: 'Nombreux rôles disponibles de 40 % à 100 % ; planning en équipes pour concilier vie pro et vie de famille.' },
        { title: 'Frontaliers bienvenus', desc: 'Manor engage régulièrement des titulaires de Permis G pour les magasins tessinois, notamment en vente, caisse, Manor Food et Manor Restaurant.' },
      ],
      faqs: [
        { q: 'Manor engage-t-il des frontaliers italiens ?', a: 'Oui. Les grands magasins Manor tessinois publient régulièrement des postes ouverts aux candidats avec Permis G pour la vente, la caisse, Manor Food, Manor Restaurant et les apprentissages. Les filiales de Mendrisio, Lugano, Locarno, Bellinzona et Biasca se trouvent à 20-40 minutes des principales communes frontalières italiennes.' },
        { q: 'Quels salaires paie Manor en Suisse ?', a: "Les salaires suivent la CCL du commerce de détail et la CCNT/L-GAV de la restauration. Valeurs brutes indicatives (données publiques) : vendeur/se CHF 4'200-4'800/mois × 13, caissier/ère CHF 4'200-4'600 × 13, personnel Manor Food CHF 4'300-5'000 × 13, cuisinier Manor Restaurant CHF 4'500-5'500 × 13, responsable de rayon CHF 5'800-7'500 × 13. 13e mois inclus. Utilisez notre simulateur fiscal pour estimer le net frontalier." },
        { q: 'Quels permis Manor accepte-t-il ?', a: "Citoyens suisses et titulaires de permis C (établi), B (séjour), G (frontalier) et Li (UE/AELE). Pour les rôles opérationnels au Tessin, le Permis G est pleinement accepté ; l'administration est gérée par les RH régionales à la signature du contrat." },
        { q: 'Manor propose-t-il des apprentissages ?', a: "Oui. Manor est entreprise formatrice reconnue pour plusieurs apprentissages CFC : gestionnaire du commerce de détail (3 ans), logistique, cuisinier, employé/e en restauration, décorateur/trice de vitrines. De nouveaux apprentis sont engagés chaque année, y compris dans les filiales tessinoises." },
        { q: 'Quels types de contrats propose Manor ?', a: 'Manor propose des contrats à durée indéterminée (majorité), à durée déterminée (saisonniers, remplacements maternité), apprentissages CFC et stages. Les pourcentages vont de 40 % à 100 % ; de nombreux postes de vente et de caisse sont disponibles en temps partiel pour concilier horaires et famille.' },
        { q: 'Comment faire une candidature spontanée chez Manor ?', a: 'Le portail corporate.manor.ch/carriere accepte les candidatures spontanées par filiale et domaine. Il est conseillé de préciser le site souhaité, le pourcentage visé et la disponibilité horaire. Les candidatures restent en base et sont réutilisées lorsque un poste compatible se libère.' },
      ],
      locationsIntro: 'Manor exploite un réseau national de grands magasins avec des filiales dans toutes les principales localités tessinoises. Postulez au magasin le plus proche de chez vous et demandez des transferts internes après la période d’essai.',
      emptyStateNote: "Aucun poste Manor actif dans notre base pour l'instant. Les annonces sont actualisées chaque jour — revenez demain ou postulez sur corporate.manor.ch/carriere.",
      metaTitle: 'Emplois Manor | Postes ouverts Canton du Tessin',
      metaDescription: 'Manor : grands magasins du Tessin, Manor Food, Manor Restaurant, salaires, apprentissage, candidature frontalière. Mis à jour chaque jour.',
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MEDACTA — Medacta International SA (B.4)
// Castel San Pietro (Mendrisio). Orthopedic medical devices, listed on SIX
// Swiss Exchange, one of Ticino's top private-sector employers. The crawler
// regularly picks up openings at medacta.com/careers; this registry entry
// lets the hub render the moment those jobs flow in.
// ─────────────────────────────────────────────────────────────────────────────
const MEDACTA: EmployerBrand = {
  brandKey: 'medacta-international-sa',
  name: 'Medacta International SA',
  shortName: 'Medacta',
  fullName: 'Medacta International SA',
  website: 'https://www.medacta.com',
  careersUrl: 'https://www.medacta.com/careers',
  locations: [
    'Sede centrale Castel San Pietro (TI)',
    'Stabilimento produttivo Castel San Pietro',
    'Medacta Education Lab (Rancate)',
    'Filiali commerciali in oltre 40 Paesi',
  ],
  headquarters: {
    streetAddress: 'Strada Regina 34',
    postalCode: '6874',
    addressLocality: 'Castel San Pietro',
    addressRegion: 'TI',
    addressCountry: 'CH',
  },
  sameAs: [
    'https://www.linkedin.com/company/medacta-international-sa',
    'https://it.wikipedia.org/wiki/Medacta',
    'https://www.six-group.com/en/market-data/shares/share-explorer/share-details.CH0468525222CHF4.html',
  ],
  copy: {
    it: {
      h1: 'Lavorare in Medacta — medical device e ortopedia in Ticino',
      tagline: 'Posizioni aperte Medacta a Castel San Pietro: produzione, R&D, regulatory, qualità. Stipendi, benefit e candidatura frontaliere.',
      paragraphs: [
        "Medacta International SA è un'azienda svizzera fondata nel 1999 dalla famiglia Siccardi e quotata dal 2019 a SIX Swiss Exchange (MOVE). La sede centrale e lo stabilimento produttivo si trovano a Castel San Pietro, nel Mendrisiotto, a pochi chilometri dal confine italiano. Medacta progetta, produce e distribuisce protesi ortopediche di anca, ginocchio, spalla e colonna vertebrale, oltre a tecniche chirurgiche mini-invasive (MySpine, MyHip, MyKnee, MyShoulder) e piattaforme di navigazione NextAR. Impiega oltre 1'900 persone a livello globale, di cui circa 800 in Ticino.",
        "Il campus di Castel San Pietro integra R&D, ingegneria, produzione in camera bianca, regulatory affairs, clinical research, supply chain, marketing e funzioni corporate. Medacta Education Lab, il centro di formazione chirurgica dedicato, ospita ogni anno centinaia di chirurghi da tutto il mondo per workshop e cadaver lab. L'azienda investe costantemente in automazione, additive manufacturing e digitalizzazione, e ha espanso negli ultimi anni lo stabilimento con nuove linee produttive e un polo logistico.",
        "I profili più ricercati a Castel San Pietro sono ingegneri di processo, ingegneri biomedici e meccanici, tecnici di produzione CNC, operatori di camera bianca, quality engineer (ISO 13485, MDR), regulatory affairs specialist, clinical research associate, data analyst, sviluppatori software (navigazione, robotica, AR), progettisti meccanici (SolidWorks, CATIA), supply chain planner, addetti al magazzino e ruoli corporate in finance, HR, IT, legal e marketing. Medacta pubblica posizioni anche per apprendisti e stagisti.",
        "Per i frontalieri italiani Medacta è uno dei datori di lavoro più attrattivi del Mendrisiotto: Castel San Pietro è a 5-15 minuti dai comuni di confine italiani (Como, Varese, Bizzarone, Stabio, Chiasso). L'azienda accetta candidature con Permesso G per tutti i ruoli operativi e tecnici, applica contratti aziendali con 13ª, previdenza LPP sopra il minimo di legge, e valuta titoli e diplomi italiani secondo equipollenza. È richiesto un buon livello di italiano per i ruoli di produzione e almeno B2 di inglese per i ruoli tecnici e corporate.",
      ],
      sectionHeadings: {
        locations: 'Sedi Medacta in Ticino',
        benefits: 'Perché lavorare in Medacta',
        openRoles: 'Posizioni aperte oggi',
        howToApply: 'Come candidarsi in Medacta',
        faq: 'Domande frequenti',
        about: 'Chi è Medacta',
      },
      howToApply: "Tutte le posizioni ufficiali Medacta sono pubblicate su medacta.com/careers e monitorate quotidianamente dal nostro crawler. Processo standard: (1) candidatura online con CV in inglese o italiano; (2) screening HR entro 2 settimane; (3) primo colloquio HR + hiring manager (spesso da remoto per profili internazionali); (4) colloquio tecnico con case study o prova pratica per ingegneri, quality e regulatory; (5) visita di sito a Castel San Pietro con tour dello stabilimento; (6) offerta con stipendio annuo lordo × 13, bonus variabile, LPP, buoni mensa e benefit. Il processo per ruoli corporate dura tipicamente 4-8 settimane; produzione e magazzino 2-4 settimane.",
      benefits: [
        { title: '13ª e bonus variabile', desc: 'Stipendio di base su 13 mensilità + MBO individuale legato a obiettivi annuali e risultati aziendali; stock plan per ruoli manageriali.' },
        { title: 'Formazione continua', desc: 'Accesso al Medacta Education Lab, formazione tecnica interna, percorsi MBA e master finanziati, training ISO 13485 / MDR / FDA.' },
        { title: 'Previdenza LPP sopra il minimo', desc: 'Cassa pensione con contributi datoriali superiori al minimo legale; copertura AVS/AI/IPG e infortunio LAINF inclusa.' },
        { title: 'Mensa aziendale e navetta', desc: "Servizio mensa sovvenzionato presso il campus di Castel San Pietro; servizio navetta dalla stazione di Mendrisio e parcheggio gratuito per chi viene in auto." },
        { title: 'Ambiente R&D internazionale', desc: 'Lavoro con team multidisciplinari in 40+ Paesi, lingua di lavoro italiano + inglese, possibilità di mobilità internazionale verso filiali (USA, UK, Cina, Giappone).' },
        { title: 'Frontalieri benvenuti', desc: "L'azienda assume regolarmente titolari di Permesso G per produzione, R&D, quality e funzioni corporate. Castel San Pietro è 5-15 minuti dal confine italiano (Como/Varese)." },
      ],
      faqs: [
        { q: 'Medacta assume frontalieri italiani?', a: "Sì. Lo stabilimento di Castel San Pietro è a pochi chilometri dal confine italiano e Medacta assume regolarmente titolari di Permesso G in produzione, magazzino, quality, regulatory, R&D e ruoli corporate. La lingua di lavoro è italiano per produzione e inglese per i ruoli tecnici internazionali." },
        { q: 'Quanto paga Medacta in Svizzera?', a: "Gli stipendi seguono il mercato ticinese dei medical device. Valori lordi indicativi (dati di mercato pubblici): operatore di produzione CNC CHF 60'000-75'000 × 13, tecnico camera bianca CHF 58'000-72'000 × 13, quality engineer CHF 85'000-110'000 × 13, regulatory affairs specialist CHF 90'000-120'000 × 13, ingegnere R&D CHF 95'000-130'000 × 13, senior engineer CHF 120'000-160'000 × 13. Tredicesima inclusa + bonus. Usa il simulatore Frontaliere Ticino per stimare il netto." },
        { q: 'Quali permessi di lavoro accetta Medacta?', a: 'Medacta assume cittadini svizzeri e titolari di Permesso C, B, G e Li. Per i ruoli di produzione e tecnici il Permesso G è pienamente accettato. Per alcuni ruoli R&D e corporate può essere preferito il Permesso B con residenza in Svizzera, ma non è un requisito obbligatorio. La documentazione è gestita dal servizio HR a Castel San Pietro.' },
        { q: 'Medacta offre stage e apprendistato?', a: "Sì. L'azienda è datore di formazione riconosciuto per apprendisti del settore meccanico, polimeccanico, laboratorista e impiegato di commercio. Offre stage curricolari e tesi di laurea con università svizzere e italiane (SUPSI, USI, Politecnico di Milano, Bicocca). Gli stage retribuiti durano 3-6 mesi." },
        { q: 'Che tipo di contratti offre Medacta?', a: "Medacta offre contratti a tempo indeterminato (la maggior parte), a tempo determinato per progetti specifici, apprendistato AFC, stage e tesi. Le percentuali sono prevalentemente full-time (100%) per produzione e ruoli tecnici; alcune funzioni corporate (HR, finance, marketing) sono disponibili anche in part-time 80%." },
        { q: 'Che lingue servono per lavorare in Medacta?', a: "Italiano fluente è richiesto per produzione, magazzino e ruoli operativi. Per R&D, regulatory, clinical research, quality, marketing e corporate è richiesto anche inglese (livello B2-C1). Tedesco e francese sono un plus per ruoli commerciali internazionali ma non obbligatori in Ticino." },
      ],
      locationsIntro: "Medacta opera principalmente dal campus di Castel San Pietro (sede centrale + produzione + R&D + Education Lab) con alcune funzioni distribuite a Rancate. Il sito è raggiungibile in auto da Como (15 min), Chiasso (5 min), Varese (25 min) e Stabio (10 min), oppure in navetta dalla stazione FFS di Mendrisio.",
      emptyStateNote: 'Al momento non ci sono posizioni Medacta attive nella nostra banca dati. Gli annunci vengono aggiornati ogni giorno: torna domani oppure candidati sul portale ufficiale medacta.com/careers, dove puoi anche inviare una candidatura spontanea.',
      metaTitle: 'Lavorare in Medacta | Posizioni aperte Ticino',
      metaDescription: 'Medacta International SA, Castel San Pietro: lavoro ortopedia, medical device, R&D, produzione, quality. Stipendi e candidatura frontaliere aggiornati ogni giorno.',
    },
    en: {
      h1: 'Careers at Medacta — orthopedic medical devices in Ticino',
      tagline: 'Open Medacta roles in Castel San Pietro: manufacturing, R&D, regulatory, quality. Salaries, benefits, cross-border application.',
      paragraphs: [
        "Medacta International SA is a Swiss company founded in 1999 by the Siccardi family and listed on SIX Swiss Exchange since 2019 (MOVE). Its headquarters and main production site are in Castel San Pietro, in the Mendrisiotto region of Canton Ticino, just a few kilometres from the Italian border. Medacta designs, manufactures and distributes orthopedic implants for hip, knee, shoulder and spine, alongside minimally invasive surgical techniques (MySpine, MyHip, MyKnee, MyShoulder) and the NextAR navigation platform. The group employs more than 1,900 people worldwide, with around 800 based in Ticino.",
        "The Castel San Pietro campus brings together R&D, engineering, cleanroom production, regulatory affairs, clinical research, supply chain, marketing and corporate functions. Medacta Education Lab — the dedicated surgical training centre — hosts hundreds of surgeons from all over the world every year for workshops and cadaver labs. The company invests steadily in automation, additive manufacturing and digitalisation, and has recently expanded its plant with new production lines and a logistics hub.",
        "Most sought-after roles in Castel San Pietro include process engineers, biomedical and mechanical engineers, CNC production technicians, cleanroom operators, quality engineers (ISO 13485, MDR), regulatory affairs specialists, clinical research associates, data analysts, software developers (navigation, robotics, AR), mechanical designers (SolidWorks, CATIA), supply-chain planners, warehouse operators and corporate profiles in finance, HR, IT, legal and marketing. Medacta also hires apprentices and interns.",
        'For Italian cross-border workers, Medacta is one of the most attractive employers in Mendrisiotto: Castel San Pietro is 5–15 minutes from the main Italian border towns (Como, Varese, Bizzarone, Stabio, Chiasso). G-permit applications are accepted for all operational and technical roles, company agreements include 13th-month pay, LPP pension above the legal minimum, and Italian qualifications are recognised by equivalence. Fluent Italian is required for production roles and at least B2 English for technical and corporate positions.',
      ],
      sectionHeadings: {
        locations: 'Medacta sites in Canton Ticino',
        benefits: 'Why work at Medacta',
        openRoles: 'Open positions today',
        howToApply: 'How to apply at Medacta',
        faq: 'Frequently asked questions',
        about: 'About Medacta',
      },
      howToApply: 'All official Medacta openings are published on medacta.com/careers and tracked daily by our crawler. Standard process: (1) online application with CV in English or Italian; (2) HR screening within 2 weeks; (3) first interview with HR + hiring manager (often remote for international profiles); (4) technical interview with a case study or practical test for engineering, quality and regulatory; (5) on-site visit to Castel San Pietro with a plant tour; (6) offer with annual gross salary × 13, variable bonus, LPP, meal vouchers and benefits. Corporate roles typically take 4–8 weeks, production and warehouse 2–4 weeks.',
      benefits: [
        { title: '13th month and variable bonus', desc: 'Base salary over 13 months + individual MBO linked to annual targets and company results; stock plan for managerial roles.' },
        { title: 'Continuous learning', desc: 'Access to Medacta Education Lab, internal technical training, funded MBA and Master programmes, ISO 13485 / MDR / FDA training.' },
        { title: 'LPP pension above the minimum', desc: 'Pension fund with employer contributions higher than the legal minimum; AVS/AI/IPG social security and LAA accident cover included.' },
        { title: 'Canteen and shuttle', desc: 'Subsidised canteen at the Castel San Pietro campus; shuttle from Mendrisio railway station and free parking for commuters.' },
        { title: 'International R&D environment', desc: 'Work with multidisciplinary teams across 40+ countries; working languages Italian + English; international mobility to subsidiaries (USA, UK, China, Japan) available.' },
        { title: 'Cross-border workers welcome', desc: 'G-permit holders regularly hired in production, R&D, quality and corporate. Castel San Pietro is 5–15 minutes from the Italian border (Como/Varese).' },
      ],
      faqs: [
        { q: 'Does Medacta hire Italian cross-border workers?', a: 'Yes. The Castel San Pietro plant is just a few kilometres from the Italian border and Medacta regularly hires G-permit applicants in production, warehousing, quality, regulatory, R&D and corporate roles. Italian is the working language in production, English in technical international roles.' },
        { q: 'What does Medacta pay in Switzerland?', a: 'Salaries follow the Ticino medical-device market. Indicative gross figures (public market data): CNC production operator CHF 60,000–75,000 × 13, cleanroom technician CHF 58,000–72,000 × 13, quality engineer CHF 85,000–110,000 × 13, regulatory affairs specialist CHF 90,000–120,000 × 13, R&D engineer CHF 95,000–130,000 × 13, senior engineer CHF 120,000–160,000 × 13. 13th-month included + bonus. Use the Frontaliere Ticino simulator to estimate net pay.' },
        { q: 'Which work permits does Medacta accept?', a: 'Swiss citizens and holders of C, B, G and Li permits. For production and technical roles the G permit is fully accepted. For some R&D and corporate roles a B permit with Swiss residency may be preferred but is not a strict requirement. Paperwork is handled by HR at Castel San Pietro.' },
        { q: 'Does Medacta offer internships and apprenticeships?', a: 'Yes. Medacta is an accredited training company for apprentices in mechanics, polymechanics, laboratory and commercial employee. It offers curricular internships and thesis projects with Swiss and Italian universities (SUPSI, USI, Politecnico di Milano, Bicocca). Paid internships last 3–6 months.' },
        { q: 'What types of contracts does Medacta offer?', a: 'Medacta offers permanent contracts (most roles), fixed-term contracts for specific projects, AFC apprenticeships, internships and thesis placements. Most roles are full-time (100%); some corporate functions (HR, finance, marketing) are also available at 80% part-time.' },
        { q: 'What languages are needed to work at Medacta?', a: 'Fluent Italian is required for production, warehouse and operational roles. R&D, regulatory, clinical research, quality, marketing and corporate roles also require English (B2–C1). German and French are a plus for international commercial roles but are not mandatory in Ticino.' },
      ],
      locationsIntro: 'Medacta operates mainly from the Castel San Pietro campus (HQ + production + R&D + Education Lab) with some functions in Rancate. The site is reachable by car from Como (15 min), Chiasso (5 min), Varese (25 min) and Stabio (10 min), or by shuttle from Mendrisio railway station.',
      emptyStateNote: 'No active Medacta roles in our database right now. Listings refresh daily — come back tomorrow or apply on medacta.com/careers, where speculative applications are also welcome.',
      metaTitle: 'Jobs at Medacta | Open roles in Canton Ticino',
      metaDescription: 'Medacta International SA, Castel San Pietro: orthopedic jobs, medical devices, R&D, manufacturing, quality. Cross-border salaries and applications, daily updates.',
    },
    de: {
      h1: 'Arbeiten bei Medacta — Medizintechnik und Orthopädie im Tessin',
      tagline: 'Offene Medacta-Stellen in Castel San Pietro: Produktion, R&D, Regulatory, Qualität. Löhne, Benefits und Bewerbung für Grenzgänger.',
      paragraphs: [
        "Medacta International SA ist ein 1999 von der Familie Siccardi gegründetes Schweizer Unternehmen und seit 2019 an der SIX Swiss Exchange notiert (MOVE). Hauptsitz und Produktionsstätte befinden sich in Castel San Pietro im Mendrisiotto (Kanton Tessin), wenige Kilometer von der italienischen Grenze entfernt. Medacta entwickelt, produziert und vertreibt orthopädische Implantate für Hüfte, Knie, Schulter und Wirbelsäule sowie minimalinvasive Operationstechniken (MySpine, MyHip, MyKnee, MyShoulder) und die Navigationsplattform NextAR. Weltweit beschäftigt die Gruppe über 1'900 Mitarbeitende, rund 800 davon im Tessin.",
        "Der Campus Castel San Pietro vereint R&D, Engineering, Reinraumproduktion, Regulatory Affairs, Clinical Research, Supply Chain, Marketing und Corporate-Funktionen. Das Medacta Education Lab — das hauseigene chirurgische Schulungszentrum — empfängt jedes Jahr Hunderte von Chirurgen aus der ganzen Welt für Workshops und Kadaverlabore. Medacta investiert laufend in Automatisierung, Additive Manufacturing und Digitalisierung und hat den Standort zuletzt mit neuen Produktionslinien und einem Logistikzentrum erweitert.",
        "Gefragteste Tessiner Profile sind Prozessingenieure, Biomedizin- und Maschinenbauingenieure, CNC-Produktionstechniker, Reinraumoperateure, Quality Engineers (ISO 13485, MDR), Regulatory-Affairs-Spezialisten, Clinical Research Associates, Data Analysts, Softwareentwickler (Navigation, Robotik, AR), mechanische Konstrukteure (SolidWorks, CATIA), Supply-Chain-Planer, Lagermitarbeitende und Corporate-Profile in Finance, HR, IT, Legal und Marketing. Medacta stellt auch Lernende und Praktikanten ein.",
        'Für italienische Grenzgänger ist Medacta einer der attraktivsten Arbeitgeber im Mendrisiotto: Castel San Pietro ist 5–15 Minuten von den italienischen Grenzorten (Como, Varese, Bizzarone, Stabio, Chiasso) entfernt. G-Bewilligungs-Bewerbungen werden für alle operativen und technischen Rollen akzeptiert, es gelten Firmenverträge mit 13. Monatslohn und überobligatorischer BVG-Vorsorge, italienische Abschlüsse werden nach Äquivalenz anerkannt. Für Produktion wird fliessendes Italienisch verlangt, für technische und Corporate-Rollen mindestens B2-Englisch.',
      ],
      sectionHeadings: {
        locations: 'Medacta-Standorte im Tessin',
        benefits: 'Warum bei Medacta arbeiten',
        openRoles: 'Offene Stellen heute',
        howToApply: 'Bewerbung bei Medacta',
        faq: 'Häufige Fragen',
        about: 'Über Medacta',
      },
      howToApply: 'Alle offiziellen Medacta-Stellen werden auf medacta.com/careers publiziert und täglich von unserem Crawler erfasst. Ablauf: (1) Online-Bewerbung mit Lebenslauf in Englisch oder Italienisch; (2) HR-Screening in 2 Wochen; (3) Erstgespräch mit HR + Hiring Manager (oft remote für internationale Profile); (4) Fachgespräch mit Case Study oder Praxisaufgabe für Engineering, Quality und Regulatory; (5) Vor-Ort-Besuch in Castel San Pietro mit Werksführung; (6) Angebot mit Jahresbruttolohn × 13, variablem Bonus, BVG, Essensgutscheinen und Benefits. Corporate-Rollen dauern in der Regel 4–8 Wochen, Produktion und Lager 2–4 Wochen.',
      benefits: [
        { title: '13. Monatslohn und variabler Bonus', desc: 'Grundlohn auf 13 Monate + individueller MBO an Jahresziele und Unternehmensergebnisse gekoppelt; Aktienplan für Führungsrollen.' },
        { title: 'Kontinuierliche Weiterbildung', desc: 'Zugang zum Medacta Education Lab, interne Fachschulungen, finanzierte MBA- und Master-Programme, ISO 13485 / MDR / FDA Training.' },
        { title: 'Überobligatorische BVG', desc: 'Pensionskasse mit überobligatorischen Arbeitgeberbeiträgen; AHV/IV/EO und UVG inbegriffen.' },
        { title: 'Betriebskantine und Shuttle', desc: 'Subventionierte Kantine auf dem Campus Castel San Pietro; Shuttle ab SBB-Bahnhof Mendrisio und kostenlose Parkplätze.' },
        { title: 'Internationales R&D-Umfeld', desc: 'Arbeit in multidisziplinären Teams in 40+ Ländern; Arbeitssprachen Italienisch + Englisch; internationale Mobilität zu Tochtergesellschaften (USA, UK, China, Japan).' },
        { title: 'Grenzgänger willkommen', desc: 'G-Bewilligungs-Inhaber werden regelmässig in Produktion, R&D, Quality und Corporate eingestellt. Castel San Pietro ist 5–15 Minuten von der italienischen Grenze (Como/Varese).' },
      ],
      faqs: [
        { q: 'Stellt Medacta italienische Grenzgänger ein?', a: 'Ja. Die Produktionsstätte in Castel San Pietro liegt wenige Kilometer von der italienischen Grenze entfernt und Medacta stellt regelmässig G-Bewilligungs-Bewerbende in Produktion, Lager, Quality, Regulatory, R&D und Corporate ein. Arbeitssprache in der Produktion ist Italienisch, in technischen internationalen Rollen Englisch.' },
        { q: 'Wie hoch sind die Medacta-Löhne in der Schweiz?', a: "Die Löhne orientieren sich am Tessiner Medical-Device-Markt. Richtwerte brutto (öffentliche Marktdaten): CNC-Produktionsoperator CHF 60'000–75'000 × 13, Reinraumtechniker CHF 58'000–72'000 × 13, Quality Engineer CHF 85'000–110'000 × 13, Regulatory-Affairs-Spezialist CHF 90'000–120'000 × 13, R&D-Ingenieur CHF 95'000–130'000 × 13, Senior Engineer CHF 120'000–160'000 × 13. 13. Monatslohn inbegriffen + Bonus. Mit dem Frontaliere-Ticino-Rechner den Nettolohn schätzen." },
        { q: 'Welche Bewilligungen akzeptiert Medacta?', a: 'Schweizer Staatsangehörige und Inhaber von C-, B-, G- und Li-Bewilligungen. Für Produktion und technische Rollen ist die G-Bewilligung vollständig akzeptiert. Für einige R&D- und Corporate-Rollen kann eine B-Bewilligung mit Schweizer Wohnsitz bevorzugt sein, ist aber keine strenge Voraussetzung. Die Administration übernimmt HR in Castel San Pietro.' },
        { q: 'Bietet Medacta Praktika und Lehrstellen?', a: 'Ja. Medacta ist anerkannter Ausbildungsbetrieb für Lernende in Mechanik, Polymechanik, Labor und Kaufmann/Kauffrau. Das Unternehmen bietet curriculare Praktika und Diplomarbeiten mit Schweizer und italienischen Universitäten (SUPSI, USI, Politecnico di Milano, Bicocca). Bezahlte Praktika dauern 3–6 Monate.' },
        { q: 'Welche Vertragsarten bietet Medacta?', a: 'Medacta bietet unbefristete Verträge (Mehrheit), befristete Verträge für spezifische Projekte, EFZ-Lehrstellen, Praktika und Diplomarbeiten. Die meisten Rollen sind Vollzeit (100%); einige Corporate-Funktionen (HR, Finance, Marketing) sind auch mit 80% Teilzeit verfügbar.' },
        { q: 'Welche Sprachen sind bei Medacta nötig?', a: 'Fliessendes Italienisch ist für Produktion, Lager und operative Rollen erforderlich. R&D, Regulatory, Clinical Research, Quality, Marketing und Corporate-Rollen erfordern zusätzlich Englisch (B2–C1). Deutsch und Französisch sind für internationale kommerzielle Rollen ein Plus, aber im Tessin nicht obligatorisch.' },
      ],
      locationsIntro: 'Medacta arbeitet hauptsächlich vom Campus Castel San Pietro (Hauptsitz + Produktion + R&D + Education Lab), mit einigen Funktionen in Rancate. Der Standort ist mit dem Auto von Como (15 Min.), Chiasso (5 Min.), Varese (25 Min.) und Stabio (10 Min.) erreichbar oder per Shuttle ab SBB-Bahnhof Mendrisio.',
      emptyStateNote: 'Derzeit keine aktiven Medacta-Stellen in unserer Datenbank. Die Angebote werden täglich aktualisiert — schauen Sie morgen wieder vorbei oder bewerben Sie sich auf medacta.com/careers, wo auch Spontanbewerbungen willkommen sind.',
      metaTitle: 'Jobs bei Medacta | Offene Stellen Kanton Tessin',
      metaDescription: 'Medacta International SA, Castel San Pietro: Orthopädie-Jobs, Medizintechnik, R&D, Produktion, Quality. Grenzgänger-Löhne und Bewerbung, täglich aktualisiert.',
    },
    fr: {
      h1: 'Travailler chez Medacta — dispositifs médicaux orthopédiques au Tessin',
      tagline: 'Postes ouverts Medacta à Castel San Pietro : production, R&D, regulatory, qualité. Salaires, avantages et candidature frontalière.',
      paragraphs: [
        "Medacta International SA est une entreprise suisse fondée en 1999 par la famille Siccardi et cotée au SIX Swiss Exchange depuis 2019 (MOVE). Son siège et son site de production se trouvent à Castel San Pietro, dans le Mendrisiotto (canton du Tessin), à quelques kilomètres de la frontière italienne. Medacta conçoit, fabrique et distribue des implants orthopédiques pour la hanche, le genou, l'épaule et la colonne vertébrale, ainsi que des techniques chirurgicales mini-invasives (MySpine, MyHip, MyKnee, MyShoulder) et la plateforme de navigation NextAR. Le groupe emploie plus de 1'900 personnes dans le monde, dont environ 800 au Tessin.",
        "Le campus de Castel San Pietro regroupe R&D, ingénierie, production en salle blanche, regulatory affairs, clinical research, supply chain, marketing et fonctions corporate. Le Medacta Education Lab — le centre de formation chirurgicale dédié — accueille chaque année des centaines de chirurgiens du monde entier pour des workshops et des cadaver labs. L'entreprise investit régulièrement dans l'automatisation, la fabrication additive et la digitalisation, et a récemment étendu son site avec de nouvelles lignes de production et un hub logistique.",
        "Les profils les plus recherchés à Castel San Pietro sont les ingénieurs process, ingénieurs biomédicaux et mécaniques, techniciens de production CNC, opérateurs de salle blanche, quality engineers (ISO 13485, MDR), spécialistes regulatory affairs, clinical research associates, data analysts, développeurs logiciels (navigation, robotique, AR), concepteurs mécaniques (SolidWorks, CATIA), supply chain planners, magasiniers et profils corporate en finance, RH, IT, legal et marketing. Medacta engage aussi des apprentis et stagiaires.",
        "Pour les frontaliers italiens, Medacta est l'un des employeurs les plus attractifs du Mendrisiotto : Castel San Pietro est à 5-15 minutes des principales communes frontalières italiennes (Côme, Varèse, Bizzarone, Stabio, Chiasso). Les candidatures avec Permis G sont acceptées pour tous les postes opérationnels et techniques, les accords d'entreprise incluent un 13e mois, une LPP au-dessus du minimum légal, et les diplômes italiens sont reconnus par équivalence. L'italien courant est requis pour la production et au moins un niveau B2 d'anglais pour les postes techniques et corporate.",
      ],
      sectionHeadings: {
        locations: 'Sites Medacta au Tessin',
        benefits: 'Pourquoi travailler chez Medacta',
        openRoles: 'Postes ouverts aujourd\'hui',
        howToApply: 'Comment postuler chez Medacta',
        faq: 'Questions fréquentes',
        about: 'À propos de Medacta',
      },
      howToApply: "Toutes les offres officielles Medacta sont publiées sur medacta.com/careers et suivies chaque jour par notre crawler. Processus standard : (1) candidature en ligne avec CV en anglais ou en italien ; (2) tri RH sous 2 semaines ; (3) premier entretien RH + hiring manager (souvent à distance pour les profils internationaux) ; (4) entretien technique avec étude de cas ou test pratique pour ingénierie, qualité et regulatory ; (5) visite sur site à Castel San Pietro avec tour de l'usine ; (6) offre avec salaire annuel brut × 13, bonus variable, LPP, chèques repas et avantages. Les rôles corporate prennent en général 4-8 semaines, la production et l'entrepôt 2-4 semaines.",
      benefits: [
        { title: '13e mois et bonus variable', desc: 'Salaire de base sur 13 mois + MBO individuel lié aux objectifs annuels et aux résultats de l’entreprise ; plan d’actions pour les rôles de management.' },
        { title: 'Formation continue', desc: 'Accès au Medacta Education Lab, formation technique interne, programmes MBA et Master financés, formation ISO 13485 / MDR / FDA.' },
        { title: 'LPP au-dessus du minimum', desc: 'Caisse de pension avec cotisations employeur supérieures au minimum légal ; AVS/AI/APG et LAA inclus.' },
        { title: 'Cantine et navette', desc: 'Cantine subventionnée sur le campus de Castel San Pietro ; navette depuis la gare CFF de Mendrisio et parking gratuit pour les automobilistes.' },
        { title: 'Environnement R&D international', desc: 'Travail avec des équipes multidisciplinaires dans plus de 40 pays ; langues de travail italien + anglais ; mobilité internationale vers les filiales (USA, Royaume-Uni, Chine, Japon).' },
        { title: 'Frontaliers bienvenus', desc: 'Les titulaires de Permis G sont régulièrement engagés en production, R&D, qualité et corporate. Castel San Pietro est à 5-15 minutes de la frontière italienne (Côme/Varèse).' },
      ],
      faqs: [
        { q: 'Medacta engage-t-il des frontaliers italiens ?', a: "Oui. L'usine de Castel San Pietro est à quelques kilomètres de la frontière italienne et Medacta engage régulièrement des candidats avec Permis G en production, entrepôt, qualité, regulatory, R&D et rôles corporate. La langue de travail est l'italien en production et l'anglais pour les rôles techniques internationaux." },
        { q: 'Quels salaires paie Medacta en Suisse ?', a: "Les salaires suivent le marché tessinois du dispositif médical. Valeurs brutes indicatives (données publiques) : opérateur de production CNC CHF 60'000-75'000 × 13, technicien salle blanche CHF 58'000-72'000 × 13, quality engineer CHF 85'000-110'000 × 13, spécialiste regulatory affairs CHF 90'000-120'000 × 13, ingénieur R&D CHF 95'000-130'000 × 13, senior engineer CHF 120'000-160'000 × 13. 13e mois inclus + bonus. Utilisez le simulateur Frontaliere Ticino pour estimer le net." },
        { q: 'Quels permis Medacta accepte-t-il ?', a: "Citoyens suisses et titulaires de permis C, B, G et Li. Pour les rôles de production et techniques le Permis G est pleinement accepté. Pour certains rôles R&D et corporate, un Permis B avec résidence en Suisse peut être préféré mais n'est pas une exigence stricte. L'administration est gérée par les RH à Castel San Pietro." },
        { q: 'Medacta propose-t-il des stages et des apprentissages ?', a: "Oui. Medacta est entreprise formatrice reconnue pour des apprentis en mécanique, polymécanique, laboratoire et employé de commerce. Elle offre des stages curriculaires et des travaux de thèse avec des universités suisses et italiennes (SUPSI, USI, Politecnico di Milano, Bicocca). Les stages rémunérés durent 3-6 mois." },
        { q: 'Quels types de contrats propose Medacta ?', a: 'Medacta propose des contrats à durée indéterminée (majorité), à durée déterminée pour des projets spécifiques, apprentissages CFC, stages et thèses. La plupart des rôles sont à plein temps (100 %) ; certaines fonctions corporate (RH, finance, marketing) sont également disponibles à 80 % à temps partiel.' },
        { q: 'Quelles langues sont nécessaires chez Medacta ?', a: "Un italien courant est requis pour la production, l'entrepôt et les rôles opérationnels. Pour R&D, regulatory, clinical research, qualité, marketing et corporate, l'anglais est également demandé (B2-C1). L'allemand et le français sont un plus pour les rôles commerciaux internationaux mais ne sont pas obligatoires au Tessin." },
      ],
      locationsIntro: "Medacta opère principalement depuis le campus de Castel San Pietro (siège + production + R&D + Education Lab) avec quelques fonctions à Rancate. Le site est accessible en voiture depuis Côme (15 min), Chiasso (5 min), Varèse (25 min) et Stabio (10 min), ou en navette depuis la gare CFF de Mendrisio.",
      emptyStateNote: "Aucun poste Medacta actif dans notre base pour l'instant. Les annonces sont actualisées chaque jour — revenez demain ou postulez sur medacta.com/careers, où les candidatures spontanées sont également les bienvenues.",
      metaTitle: 'Emplois Medacta | Postes ouverts Canton du Tessin',
      metaDescription: 'Medacta International SA, Castel San Pietro : emplois orthopédie, dispositifs médicaux, R&D, production, qualité. Salaires frontaliers, candidature quotidienne.',
    },
  },
};

export const EMPLOYER_BRANDS: Readonly<Record<string, EmployerBrand>> = {
  [EOC.brandKey]: EOC,
  [LIDL.brandKey]: LIDL,
  [ALDI.brandKey]: ALDI,
  [MCDONALDS.brandKey]: MCDONALDS,
  [LIS.brandKey]: LIS,
  [MANOR.brandKey]: MANOR,
  [MEDACTA.brandKey]: MEDACTA,
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
