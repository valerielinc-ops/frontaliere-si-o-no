import { workloadPercent } from './dedicated-crawler-common.mjs';
import { extractBalancedTagBlock, locateTagByAttribute } from './hospital-custom-html-helpers.mjs';

const CATEGORY_BY_KEY = {
  production: 'engineering',
  engineering: 'engineering',
  'mkt-communication': 'sales',
  'event-travel': 'admin',
  finance: 'finance',
  it: 'tech',
  'r-d': 'engineering',
  operations: 'engineering',
  'quality-assurance': 'engineering',
  regulatory: 'health',
  'medical-affairs': 'health',
  'general-services': 'admin',
  hr: 'admin',
  sales: 'sales',
};

function normalizeText(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function decodeHtmlEntities(value = '') {
  const named = String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  return named
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCharCode(code) : _m;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _m;
    });
}

export function inferMedactaCategory({ category = '', categoryLabel = '', title = '', jobCategory = '' } = {}) {
  const roleHint = normalizeText(`${title} ${jobCategory}`);

  if (/(web developer|software|sistemista|devops|cloud|robotics|c\+\+|programmat|it )/.test(roleHint)) return 'tech';
  if (/(manutent|mainten|elettro|mechanic|tecnic|fresator|tornitor|operatore|production|quality|operations|r d|research|sviluppo|ingegner|engineer)/.test(roleHint)) return 'engineering';
  if (/(medical|clinical|health|medic|orthopedic|orthopaedic|regulatory|medical affairs)/.test(roleHint)) return 'health';
  if (/(finance|account|audit|treasury|contabil|controll)/.test(roleHint)) return 'finance';
  if (/(sales|marketing|commercial|product manager|business development|communication)/.test(roleHint)) return 'sales';
  if (/(hr|human resources|recruit|talent|admin|amministr|servizi general|event|travel)/.test(roleHint)) return 'admin';

  const key = normalizeKey(category || categoryLabel).replace(/_/g, '-');
  if (CATEGORY_BY_KEY[key]) return CATEGORY_BY_KEY[key];

  return 'other';
}

export function inferMedactaContract({ rawContract = '', title = '', description = '', jobCategory = '' } = {}) {
  const text = `${String(rawContract || '')} ${String(title || '')} ${String(description || '')} ${String(jobCategory || '')}`;
  const norm = normalizeText(text);

  // Same class as #3482: range-aware, source-precedence workload extraction
  // (shared helper) — a marketing percent in the description must never
  // override an explicit workload in rawContract/title.
  let percent = NaN;
  for (const source of [rawContract, title, description, jobCategory]) {
    percent = workloadPercent(String(source || ''));
    if (Number.isFinite(percent)) break;
  }
  if (Number.isFinite(percent) && percent > 0 && percent < 90) return 'part-time';

  if (/\b(thesis|intern(?:ship)?s?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|internship|stages?(?![a-zA-Z0-9_À-ÖØ-öø-ÿ])|tirocin|apprendist|praktikum)/.test(norm)) return 'internship';
  if (/(part time|tempo parziale|teilzeit|temps partiel)/.test(norm)) return 'part-time';
  if (/(temp|temporary|determinato|fixed term|befristet)/.test(norm)) return 'temporary';
  if (/(contractor|freelance|consul|progetto|projektvertrag|contract)/.test(norm)) return 'contract';
  if (/(permanent|indeterminato|full time|vollzeit|temps plein|fulltime)/.test(norm)) return 'full-time';

  return 'full-time';
}

function cleanMetaDescription(metaDescription = '', title = '') {
  const decoded = decodeHtmlEntities(metaDescription).replace(/\s+/g, ' ').trim();
  if (!decoded) return '';
  const escapedTitle = String(title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const generic = new RegExp(`^(lavora con noi!?|join us!?|arbeiten sie mit uns!?|travaillez avec nous!?)\\s*medacta international sa\\s*(sta cercando|is looking for|sucht|recherche)\\s*${escapedTitle}\\s*(su|in|a|au)?\\s*`, 'i');
  return decoded.replace(generic, '').trim();
}

function localeConfig(locale) {
  if (locale === 'en') {
    return {
      overview: 'Role Overview',
      tasks: 'Main Responsibilities',
      requirements: 'Required Profile',
      offer: 'What Medacta Offers',
      apply: 'Application Details',
      intro: ({ title, location, departmentLabel, urgent, meta }) =>
        `${urgent ? 'Urgent search: ' : ''}Medacta International SA is hiring ${title} in ${location}. Department: ${departmentLabel}.${meta ? ` ${meta}` : ''}`,
      offerBullets: [
        'International medical technology environment with concrete impact on patient care.',
        'Cross-functional collaboration with structured quality and safety standards.',
        'Growth opportunities through internal projects, training, and technical mentoring.',
      ],
      applyLine: 'Use the official Medacta recruiting page to submit your application and supporting documents.',
    };
  }

  if (locale === 'de') {
    return {
      overview: 'Rollenubersicht',
      tasks: 'Hauptaufgaben',
      requirements: 'Erforderliches Profil',
      offer: 'Was Medacta bietet',
      apply: 'Bewerbungsinformationen',
      intro: ({ title, location, departmentLabel, urgent, meta }) =>
        `${urgent ? 'Dringende Suche: ' : ''}Medacta International SA sucht ${title} in ${location}. Abteilung: ${departmentLabel}.${meta ? ` ${meta}` : ''}`,
      offerBullets: [
        'Internationales Medizintechnik-Umfeld mit direkter Wirkung auf die Patientenversorgung.',
        'Interdisziplinare Zusammenarbeit mit klaren Qualitats- und Sicherheitsstandards.',
        'Entwicklungsmoglichkeiten durch Projekte, Weiterbildung und technisches Mentoring.',
      ],
      applyLine: 'Bewerben Sie sich uber die offizielle Medacta-Karriereseite mit Lebenslauf und relevanten Unterlagen.',
    };
  }

  if (locale === 'fr') {
    return {
      overview: 'Apercu Du Poste',
      tasks: 'Responsabilites Principales',
      requirements: 'Profil Recherche',
      offer: 'Ce Que Medacta Offre',
      apply: 'Informations De Candidature',
      intro: ({ title, location, departmentLabel, urgent, meta }) =>
        `${urgent ? 'Recherche urgente: ' : ''}Medacta International SA recrute ${title} a ${location}. Departement: ${departmentLabel}.${meta ? ` ${meta}` : ''}`,
      offerBullets: [
        'Environnement international en technologies medicales avec impact concret sur les patients.',
        'Collaboration transverse avec des standards eleves de qualite et de securite.',
        'Opportunites de croissance via projets internes, formation et mentorat technique.',
      ],
      applyLine: 'Envoyez votre candidature via la page officielle Medacta avec CV et documents utiles.',
    };
  }

  return {
    overview: 'Panoramica Ruolo',
    tasks: 'Mansioni Principali',
    requirements: 'Profilo Richiesto',
    offer: 'Cosa Offre Medacta',
    apply: 'Dettagli Candidatura',
    intro: ({ title, location, departmentLabel, urgent, meta }) =>
      `${urgent ? 'Ricerca urgente: ' : ''}Medacta International SA sta cercando ${title} con sede a ${location}. Reparto: ${departmentLabel}.${meta ? ` ${meta}` : ''}`,
    offerBullets: [
      'Contesto internazionale medicale con impatto reale su chirurgia ortopedica e cura del paziente.',
      'Collaborazione con team cross-funzionali in un ambiente strutturato su qualita e sicurezza.',
      'Percorsi di crescita tramite progetti interni, formazione tecnica e confronto continuo.',
    ],
    applyLine: 'Invia la candidatura tramite la pagina ufficiale Medacta allegando CV e documentazione rilevante.',
  };
}

function categoryBullets(locale, category) {
  const byLocale = {
    it: {
      tech: {
        tasks: [
          'Svilupperai e manterrai soluzioni software affidabili per processi aziendali e industriali.',
          'Collaborerai con team tecnici e di business per analisi requisiti, testing e rilascio.',
          'Contribuirai a migliorare performance, sicurezza applicativa e qualita del codice.',
        ],
        requirements: [
          'Esperienza con sviluppo software, debugging e gestione del ciclo di rilascio.',
          'Conoscenza di integrazioni applicative, versionamento e buone pratiche di qualita.',
          'Capacita di comunicazione tecnica e collaborazione con team multidisciplinari.',
        ],
      },
      finance: {
        tasks: [
          'Gestirai analisi economiche, controllo costi e supporto ai processi di pianificazione.',
          'Prepararai report affidabili per decisioni operative e strategiche.',
          'Collaborerai con funzioni interne per garantire conformita e accuratezza dei dati.',
        ],
        requirements: [
          'Esperienza in ambito finance, controlling o accounting in contesti strutturati.',
          'Ottima dimestichezza con reporting, analisi numerica e strumenti digitali.',
          'Precisione, riservatezza e orientamento a scadenze e priorita.',
        ],
      },
      health: {
        tasks: [
          'Supporterai attivita tecnico-cliniche legate a dispositivi e processi medicali.',
          'Lavorerai in coordinamento con qualita, regolatorio e funzioni scientifiche.',
          'Contribuirai al mantenimento di standard elevati per sicurezza e tracciabilita.',
        ],
        requirements: [
          'Background in ambito medicale, clinico o regolatorio coerente con il ruolo.',
          'Conoscenza di processi documentali e attenzione alla conformita.',
          'Approccio analitico, precisione e forte orientamento al lavoro in team.',
        ],
      },
      engineering: {
        tasks: [
          'Eseguirai attivita operative e tecniche su impianti, processi o linee produttive.',
          'Collaborerai con Produzione, Qualita e R&D per migliorare affidabilita e tempi.',
          'Aggiornerai checklist, documentazione tecnica e standard di manutenzione o processo.',
        ],
        requirements: [
          'Esperienza in ruolo tecnico analogo, preferibilmente in contesto industriale.',
          'Conoscenza di sicurezza, qualita e risoluzione strutturata dei problemi.',
          'Autonomia operativa, orientamento al risultato e capacita di lavoro in squadra.',
        ],
      },
      admin: {
        tasks: [
          'Gestirai attivita organizzative e amministrative a supporto dei team aziendali.',
          'Coordinerai flussi documentali, comunicazioni e priorita operative.',
          'Garantirai accuratezza dei dati e continuita nei processi interni.',
        ],
        requirements: [
          'Esperienza in ruoli amministrativi, HR o servizi interni in aziende strutturate.',
          'Ottime capacita organizzative e cura del dettaglio.',
          'Comunicazione chiara, affidabilita e gestione efficace delle scadenze.',
        ],
      },
      sales: {
        tasks: [
          'Svilupperai iniziative commerciali o di prodotto a supporto della crescita aziendale.',
          'Collaborerai con stakeholder interni ed esterni su piani, presentazioni e follow-up.',
          'Monitorerai KPI di mercato, pipeline e attivita di miglioramento continuo.',
        ],
        requirements: [
          'Esperienza in sales, marketing o product management in contesti internazionali.',
          'Competenze relazionali e orientamento a risultati misurabili.',
          'Capacita di pianificazione, analisi e gestione autonoma delle priorita.',
        ],
      },
      other: {
        tasks: [
          'Contribuirai alle attivita operative del team con responsabilita chiare e misurabili.',
          'Collaborerai con diverse funzioni aziendali per garantire continuita ed efficacia.',
          'Supporterai processi, documentazione e miglioramento delle modalita di lavoro.',
        ],
        requirements: [
          'Esperienza coerente con il ruolo e attitudine al lavoro strutturato.',
          'Precisione, affidabilita e orientamento alla qualita del risultato.',
          'Buone capacita relazionali e disponibilita al lavoro di squadra.',
        ],
      },
    },
    en: {
      tech: {
        tasks: [
          'Develop and maintain reliable software solutions supporting business and industrial workflows.',
          'Work with technical and business teams on requirements, testing, and production releases.',
          'Improve application performance, security posture, and engineering quality standards.',
        ],
        requirements: [
          'Hands-on experience in software development, debugging, and release lifecycle management.',
          'Knowledge of integrations, version control, and quality-first engineering practices.',
          'Strong technical communication and cross-functional collaboration skills.',
        ],
      },
      finance: {
        tasks: [
          'Support financial planning, cost control, and structured business analysis.',
          'Prepare clear and reliable reporting for operational and strategic decisions.',
          'Coordinate with internal teams to ensure data consistency and compliance.',
        ],
        requirements: [
          'Experience in finance, controlling, or accounting within structured organizations.',
          'Solid analytical mindset and confidence with reporting tools.',
          'Accuracy, confidentiality, and strong deadline management.',
        ],
      },
      health: {
        tasks: [
          'Support clinical or medical-technical activities linked to regulated devices and processes.',
          'Coordinate with quality, regulatory, and scientific stakeholders.',
          'Help maintain high standards of patient safety and process traceability.',
        ],
        requirements: [
          'Background aligned with medical, clinical, or regulatory functions.',
          'Comfort with structured documentation and compliance-driven workflows.',
          'Analytical approach, detail orientation, and team collaboration.',
        ],
      },
      engineering: {
        tasks: [
          'Perform technical activities on equipment, production flows, or industrial processes.',
          'Collaborate with Production, Quality, and R&D to improve reliability and throughput.',
          'Maintain technical documentation, preventive checks, and process standards.',
        ],
        requirements: [
          'Experience in a comparable technical role, ideally in manufacturing environments.',
          'Knowledge of safety, quality standards, and structured problem solving.',
          'Autonomy, accountability, and practical teamwork skills.',
        ],
      },
      admin: {
        tasks: [
          'Handle administrative and organizational workflows supporting business teams.',
          'Coordinate documentation, communication, and operational priorities.',
          'Ensure process continuity and data quality in day-to-day execution.',
        ],
        requirements: [
          'Experience in administration, HR, or internal services roles.',
          'Strong organization and attention to detail.',
          'Clear communication and effective deadline management.',
        ],
      },
      sales: {
        tasks: [
          'Drive commercial or product initiatives that support company growth objectives.',
          'Work with internal and external stakeholders on plans, presentations, and follow-up actions.',
          'Track market KPIs, pipeline evolution, and continuous improvement opportunities.',
        ],
        requirements: [
          'Experience in sales, marketing, or product management.',
          'Relationship-building skills and measurable-results mindset.',
          'Ability to plan, prioritize, and execute independently.',
        ],
      },
      other: {
        tasks: [
          'Contribute to team operations with clear and measurable responsibilities.',
          'Collaborate with multiple business functions to keep execution reliable.',
          'Support process quality, documentation, and continuous improvement.',
        ],
        requirements: [
          'Relevant professional experience and structured work approach.',
          'Reliability, precision, and quality orientation.',
          'Strong collaboration and communication attitude.',
        ],
      },
    },
    de: {
      tech: {
        tasks: [
          'Entwickeln und betreuen Sie zuverlassige Softwarelosungen fur Unternehmens- und Produktionsprozesse.',
          'Arbeiten Sie mit technischen und fachlichen Teams bei Anforderungen, Tests und Releases zusammen.',
          'Verbessern Sie Performance, Sicherheit und technische Qualitat kontinuierlich.',
        ],
        requirements: [
          'Erfahrung in Softwareentwicklung, Debugging und Release-Management.',
          'Kenntnisse in Integrationen, Versionskontrolle und qualitatsorientierter Entwicklung.',
          'Klare technische Kommunikation und Teamfahigkeit.',
        ],
      },
      finance: {
        tasks: [
          'Unterstutzen Sie Finanzplanung, Kostenkontrolle und strukturierte Analysen.',
          'Erstellen Sie belastbare Reports fur operative und strategische Entscheidungen.',
          'Arbeiten Sie mit internen Teams zur Sicherstellung von Datenqualitat und Compliance.',
        ],
        requirements: [
          'Erfahrung in Finance, Controlling oder Accounting in strukturierten Umfeldern.',
          'Analytisches Denken und Sicherheit im Reporting.',
          'Prazision, Vertraulichkeit und Termintreue.',
        ],
      },
      health: {
        tasks: [
          'Unterstutzen Sie klinische oder medizintechnische Aktivitaten in regulierten Prozessen.',
          'Koordinieren Sie sich mit Qualitat, Regulatory und wissenschaftlichen Funktionen.',
          'Sichern Sie hohe Standards bei Patientensicherheit und Nachverfolgbarkeit.',
        ],
        requirements: [
          'Passender Hintergrund in medizinischen, klinischen oder regulatorischen Bereichen.',
          'Routine im Umgang mit Dokumentation und Compliance-Anforderungen.',
          'Analytische Arbeitsweise und Teamorientierung.',
        ],
      },
      engineering: {
        tasks: [
          'Fuhren Sie technische Tatigkeiten an Anlagen, Prozessen oder Produktionslinien aus.',
          'Arbeiten Sie mit Produktion, Qualitat und R&D zur Verbesserung von Stabilitat und Leistung.',
          'Pflegen Sie technische Dokumentation, Prufungen und Prozessstandards.',
        ],
        requirements: [
          'Erfahrung in einer vergleichbaren technischen Funktion, idealerweise Industrieumfeld.',
          'Kenntnisse in Sicherheit, Qualitat und strukturiertem Problemlosen.',
          'Eigenverantwortung, Zuverlassigkeit und Teamfahigkeit.',
        ],
      },
      admin: {
        tasks: [
          'Steuern Sie administrative und organisatorische Ablaufe zur Unterstutzung der Teams.',
          'Koordinieren Sie Dokumente, Kommunikation und operative Prioritaten.',
          'Sichern Sie Prozesskontinuitat und Datenqualitat im Tagesgeschaft.',
        ],
        requirements: [
          'Erfahrung in Administration, HR oder internen Services.',
          'Sehr gute Organisation und Genauigkeit.',
          'Klare Kommunikation und verlassliche Terminsteuerung.',
        ],
      },
      sales: {
        tasks: [
          'Treiben Sie kommerzielle oder produktbezogene Initiativen fur Wachstumsziele voran.',
          'Arbeiten Sie mit internen und externen Stakeholdern an Planen und Follow-up.',
          'Beobachten Sie Markt-KPIs, Pipeline-Entwicklung und Verbesserungsmassnahmen.',
        ],
        requirements: [
          'Erfahrung in Sales, Marketing oder Product Management.',
          'Starke Beziehungsarbeit und Ergebnisorientierung.',
          'Planungsstarke und selbststandige Priorisierung.',
        ],
      },
      other: {
        tasks: [
          'Unterstutzen Sie den Teamablauf mit klaren und messbaren Verantwortungen.',
          'Arbeiten Sie mit mehreren Funktionen zusammen, um stabile Umsetzung zu sichern.',
          'Verbessern Sie Prozesse, Dokumentation und Arbeitsqualitat laufend.',
        ],
        requirements: [
          'Relevante Erfahrung und strukturierte Arbeitsweise.',
          'Zuverlassigkeit, Prazision und Qualitatsbewusstsein.',
          'Kooperationsfahigkeit und klare Kommunikation.',
        ],
      },
    },
    fr: {
      tech: {
        tasks: [
          'Developpez et maintenez des solutions logicielles fiables pour les processus metier et industriels.',
          'Collaborez avec les equipes techniques et metier sur exigences, tests et mises en production.',
          'Ameliorez en continu performance, securite et qualite technique.',
        ],
        requirements: [
          'Experience en developpement logiciel, debugging et gestion des releases.',
          'Connaissance des integrations, du versioning et des bonnes pratiques qualite.',
          'Communication technique claire et esprit de collaboration.',
        ],
      },
      finance: {
        tasks: [
          'Contribuez a la planification financiere, au controle des couts et aux analyses structurees.',
          'Preparez des reportings fiables pour les decisions operationnelles et strategiques.',
          'Coordonnez avec les equipes internes pour garantir coherence des donnees et conformite.',
        ],
        requirements: [
          'Experience en finance, controlling ou comptabilite dans un environnement structure.',
          'Solide capacite analytique et maitrise des outils de reporting.',
          'Rigueur, confidentialite et respect des delais.',
        ],
      },
      health: {
        tasks: [
          'Soutenez des activites cliniques ou medico-techniques dans des processus reglementes.',
          'Travaillez en coordination avec qualite, reglementaire et fonctions scientifiques.',
          'Contribuez a des standards eleves de securite patient et de tracabilite.',
        ],
        requirements: [
          'Profil adapte aux contextes medical, clinique ou reglementaire.',
          'Aisance avec la documentation et les exigences de conformite.',
          'Approche analytique, precision et travail en equipe.',
        ],
      },
      engineering: {
        tasks: [
          'Realisez des activites techniques sur equipements, processus et flux de production.',
          'Collaborez avec Production, Qualite et R&D pour ameliorer fiabilite et performance.',
          'Maintenez la documentation technique, les controles preventifs et les standards process.',
        ],
        requirements: [
          'Experience dans un role technique similaire, idealement en environnement industriel.',
          'Connaissance securite, qualite et resolution structuree de problemes.',
          'Autonomie, sens des responsabilites et cooperation terrain.',
        ],
      },
      admin: {
        tasks: [
          'Gerez les flux administratifs et organisationnels au service des equipes.',
          'Coordonnez documents, communications et priorites operationnelles.',
          'Assurez continuite des processus et fiabilite des donnees.',
        ],
        requirements: [
          'Experience en administration, RH ou services internes.',
          'Excellente organisation et attention aux details.',
          'Communication claire et gestion efficace des echeances.',
        ],
      },
      sales: {
        tasks: [
          'Pilotez des initiatives commerciales ou produit en soutien des objectifs de croissance.',
          'Travaillez avec les parties prenantes internes et externes sur plans et suivis.',
          'Suivez les KPI marche, la pipeline et les actions d amelioration continue.',
        ],
        requirements: [
          'Experience en sales, marketing ou product management.',
          'Capacite relationnelle et orientation resultats.',
          'Capacite a planifier, prioriser et executer avec autonomie.',
        ],
      },
      other: {
        tasks: [
          'Contribuez aux operations de l equipe avec des responsabilites claires.',
          'Collaborez avec plusieurs fonctions pour garantir une execution fiable.',
          'Soutenez qualite process, documentation et amelioration continue.',
        ],
        requirements: [
          'Experience pertinente et approche de travail structuree.',
          'Fiabilite, precision et orientation qualite.',
          'Bon esprit d equipe et communication efficace.',
        ],
      },
    },
  };

  const localePack = byLocale[locale] || byLocale.it;
  return localePack[category] || localePack.other;
}

function buildSingleLocalizedDescription(locale, payload) {
  const title = decodeHtmlEntities(payload.title || '').trim() || 'Posizione aperta';
  const location = decodeHtmlEntities(payload.location || '').trim() || 'Castel San Pietro';
  const departmentLabel = decodeHtmlEntities(payload.departmentLabel || payload.categoryLabel || payload.category || 'Operations').trim();
  const category = payload.category || 'other';
  const urgent = Boolean(payload.isUrgent);
  const meta = cleanMetaDescription(payload.metaDescription || '', title);
  const cfg = localeConfig(locale);
  const bullets = categoryBullets(locale, category);

  const lines = [
    `## ${cfg.overview}`,
    cfg.intro({ title, location, departmentLabel, urgent, meta }),
    `## ${cfg.tasks}`,
    ...bullets.tasks.map((x) => `- ${x}`),
    `## ${cfg.requirements}`,
    ...bullets.requirements.map((x) => `- ${x}`),
    `## ${cfg.offer}`,
    ...cfg.offerBullets.map((x) => `- ${x}`),
    `## ${cfg.apply}`,
    cfg.applyLine,
  ];

  return lines.join('\n');
}

export function buildMedactaLocalizedDescriptions(payload = {}) {
  const category = payload.category || inferMedactaCategory(payload);
  const enrichedPayload = {
    ...payload,
    category,
  };

  return {
    it: buildSingleLocalizedDescription('it', enrichedPayload),
    en: buildSingleLocalizedDescription('en', enrichedPayload),
    de: buildSingleLocalizedDescription('de', enrichedPayload),
    fr: buildSingleLocalizedDescription('fr', enrichedPayload),
  };
}

export function buildMedactaBaseDescription(payload = {}) {
  const all = buildMedactaLocalizedDescriptions(payload);
  return all.it;
}

/**
 * The role text of an Allibo detail page lives in the schema.org microdata
 * block `<div itemprop="description">` (tasks, profile, offer, EEO note).
 * The crawler used to read only `og:description` — the one-line teaser
 * "Lavora con noi! Medacta International SA sta cercando <title> su Ticino" —
 * and then published a category TEMPLATE (identical maintenance tasks for a
 * Demand Planner and for an electromechanic) instead of the vacancy. Probed
 * 2026-09-29: the page is served to our fetcher without any CAPTCHA.
 *
 * A paragraph that holds only a short bold label (`<p><b>Hard Skills</b></p>`,
 * `<p><strong>What we offer:</strong></p>`) is the source's section title and
 * becomes a markdown heading; list items become `- ` bullets.
 *
 * @param {string} html detail page
 * @returns {string} markdown, '' when the block is absent
 */
export function extractMedactaDetailMarkdown(html = '') {
  const located = locateTagByAttribute(String(html || ''), `itemprop=["']description["']`, { skipVoidTags: true });
  if (!located) return '';
  const inner = extractBalancedTagBlock(located.rest, located.tagName, 80000);
  const text = inner
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(
      /<p[^>]*>(?:\s|&nbsp;|<span[^>]*>|<\/span>)*<(b|strong)[^>]*>([\s\S]{2,80}?)<\/\1>(?:\s|&nbsp;|<span[^>]*>|<\/span>|<br\s*\/?>)*<\/p>/gi,
      (_m, _tag, label) => `\n\n## ${label.replace(/<[^>]+>/g, ' ').replace(/[\s:]+$/, '')}\n\n`,
    )
    .replace(/<h[1-6][^>]*>/gi, '\n\n## ')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|ul|ol)[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  const lines = decodeHtmlEntities(text)
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '-' && !/^##\s*$/.test(line));
  // One blank line between blocks, none between the items of one list.
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line) {
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1] || '';
    const next = lines.slice(i + 1).find(Boolean) || '';
    if (!prev || prev === '' || (prev.startsWith('- ') && next.startsWith('- '))) continue;
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const TEMPLATE_OVERVIEW_HEADINGS = ['it', 'en', 'de', 'fr'].map((locale) => `## ${localeConfig(locale).overview}`);

/**
 * True for a description produced by buildMedactaLocalizedDescriptions() —
 * the category template the crawler falls back to when the vacancy body could
 * not be read. Such text is never a source for translation: it would carry
 * made-up tasks into every locale.
 */
export function isMedactaTemplateDescription(text = '') {
  const head = String(text || '').trimStart();
  return TEMPLATE_OVERVIEW_HEADINGS.some((heading) => head.startsWith(heading));
}

/** `source` of a job whose description is the vacancy body of the detail page. */
export const MEDACTA_DETAIL_SOURCE = 'Allibo ATS detail page';
/** Below this the detail block is a teaser, not a vacancy body. */
export const MEDACTA_MIN_DETAIL_CHARS = 150;

/**
 * True when the job carries the real vacancy body read from the detail page
 * (as opposed to the category template of buildMedactaLocalizedDescriptions).
 */
export function isMedactaDetailBacked(job = {}, clean = (text) => text) {
  if (job?.source !== MEDACTA_DETAIL_SOURCE) return false;
  const base = String(clean(String(job?.description || '')) || '').trim();
  return base.length >= MEDACTA_MIN_DETAIL_CHARS && !isMedactaTemplateDescription(base);
}

/**
 * Locale slots of a detail-backed job: the template text written by earlier
 * runs is dropped (so the translation step regenerates the locale from the
 * real body) and the source-language slot is the body itself.
 */
export function detailBackedMedactaLocales(job = {}, clean = (text) => text) {
  const base = String(clean(String(job?.description || '')) || '').trim();
  const out = {};
  for (const [locale, value] of Object.entries(job?.descriptionByLocale || {})) {
    const text = String(clean(String(value || '')) || '').trim();
    if (text && !isMedactaTemplateDescription(text)) out[locale] = text;
  }
  if (job?.sourceLang) out[job.sourceLang] = base;
  return out;
}
