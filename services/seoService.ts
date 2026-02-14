/**
 * SEO Service - Dynamic Meta Tags Management
 * Manages SEO metadata for different sections of the app
 */

export interface SEOMetadata {
  title: string;
  description: string;
  keywords: string;
  ogTitle: string;
  ogDescription: string;
  canonicalPath: string;
  structuredData?: Record<string, any>;
}

const BASE_URL = 'https://www.frontaliereticino.ch';

export const SEO_METADATA: Record<string, SEOMetadata> = {
  calculator: {
    title: 'Simulatore Fiscale Frontalieri 2026 | Calcolo Tasse CH-IT',
    description: 'Calcola il tuo stipendio netto come frontaliere Svizzera-Italia. Confronta Vecchio vs Nuovo accordo 2026, imposta alla fonte Canton Ticino e IRPEF Italia. Simulazione gratuita e precisa.',
    keywords: 'simulatore frontalieri, calcolo tasse svizzera, stipendio netto ticino, imposta alla fonte, nuovo accordo frontalieri 2026, vecchio frontaliere, confronto fiscale ch-it, aliquota ticino',
    ogTitle: 'Simulatore Fiscale Frontalieri 2026 | Calcola Tasse e Stipendio Netto',
    ogDescription: '🧮 Calcola il tuo stipendio netto come frontaliere. Confronta tassazione Vecchio vs Nuovo accordo 2026 e scopri la convenienza fiscale Canton Ticino.',
    canonicalPath: '/',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      "name": "Simulatore Fiscale Frontalieri",
      "url": `${BASE_URL}/`,
      "description": "Calcolo preciso delle tasse per frontalieri tra Svizzera e Italia secondo il nuovo accordo 2026",
      "applicationCategory": "FinanceApplication",
      "operatingSystem": "Web Browser",
      "offers": {
        "@type": "Offer",
        "price": "0",
        "priceCurrency": "CHF"
      }
    }
  },
  
  comparatori: {
    title: 'Comparatori Servizi CH-IT | Cambi Valuta, Telefonia, Trasporti',
    description: 'Confronta servizi tra Svizzera e Italia: tassi di cambio CHF/EUR in tempo reale (Wise, Revolut), operatori mobili con roaming, trasporti frontalieri, assicurazioni sanitarie, banche e traffico valichi.',
    keywords: 'cambio chf eur, cambio valuta svizzera, wise revolut confronto, operatori mobili svizzera, roaming svizzera italia, trasporti frontalieri, assicurazione sanitaria ticino, banche svizzera italia, traffico valichi doganali',
    ogTitle: 'Comparatori Servizi Frontalieri | Cambi, Telefonia, Trasporti',
    ogDescription: '📊 Confronta i migliori servizi per frontalieri: tassi cambio valuta in tempo reale, operatori mobili con roaming, trasporti, assicurazioni e banche CH-IT.',
    canonicalPath: '/comparatori',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "name": "Comparatori Servizi Frontalieri",
      "url": `${BASE_URL}/comparatori`,
      "description": "Strumenti di confronto per servizi essenziali per lavoratori frontalieri"
    }
  },

  exchange: {
    title: 'Cambio CHF/EUR Oggi | Confronto Wise, Revolut, PostFinance',
    description: 'Confronto tassi di cambio CHF/EUR in tempo reale. Scopri le commissioni di Wise, Revolut, PostFinance, UBS, Credit Suisse e N26 per trasferimenti Svizzera-Italia. Risparmia fino al 3% sul cambio valuta.',
    keywords: 'cambio chf eur oggi, wise tasso cambio, revolut commissioni, postfinance cambio valuta, ubs credit suisse cambio, n26 trasferimenti, miglior cambio svizzera italia, commissioni cambio valuta',
    ogTitle: 'Cambio CHF/EUR in Tempo Reale | Confronto Tassi e Commissioni',
    ogDescription: '💱 Confronta i tassi di cambio CHF/EUR di 6 provider (Wise, Revolut, PostFinance). Risparmia sulle commissioni con il confronto in tempo reale!',
    canonicalPath: '/comparatori/cambio-valuta',
  },

  mobile: {
    title: 'Operatori Mobili Svizzera | Confronto Costi con Roaming Italia',
    description: 'Confronta operatori mobili svizzeri per frontalieri: Swisscom, Salt, Sunrise, Yallo, Wingo, Aldi Mobile. Costi mensili reali con roaming illimitato in Italia, chiamate, SMS e dati inclusi.',
    keywords: 'operatori mobili svizzera, roaming svizzera italia, swisscom frontalieri, salt mobile costi, sunrise abbonamenti, yallo wingo confronto, aldi mobile svizzera, roaming illimitato italia',
    ogTitle: 'Operatori Mobili Svizzera per Frontalieri | Confronto con Roaming',
    ogDescription: '📱 Confronta 6 operatori mobili svizzeri con roaming illimitato in Italia. Costi reali mensili da CHF 9.95/mese. Trova il piano migliore per frontalieri!',
    canonicalPath: '/comparatori/operatori-mobili',
  },

  transport: {
    title: 'Costi Trasporto Frontalieri | Calcolo Auto vs Treno CH-IT',
    description: 'Calcola i costi reali di trasporto per frontalieri: auto (carburante, usura, pedaggi), treno (Trenitalia, FFS), bus transfrontalieri. Confronta convenienza e risparmia sui costi di spostamento.',
    keywords: 'costi trasporto frontalieri, calcolo costi auto, abbonamento treno svizzera, trenitalia frontalieri, ffs ticino, pedaggi autostrada, costo benzina diesel, usura auto, trasporti pubblici frontalieri',
    ogTitle: 'Calcolo Costi Trasporto Frontalieri | Auto vs Treno',
    ogDescription: '🚗 Calcola i costi reali di trasporto per frontalieri. Confronta auto, treno e bus per trovare la soluzione più conveniente!',
    canonicalPath: '/comparatori/trasporti',
  },

  health: {
    title: 'Assicurazione Sanitaria Ticino | Confronto Casse Malati 2026',
    description: 'Confronta assicurazioni sanitarie Canton Ticino: Helsana, CSS, Swica, Visana, Sanitas. Premi mensili 2026, franchigie, coperture e opzioni per frontalieri. Trova la cassa malati più conveniente.',
    keywords: 'assicurazione sanitaria ticino, casse malati svizzera, helsana css confronto, swica visana sanitas, premi assicurazione 2026, franchigia assicurazione svizzera, cassa malati frontalieri, assicurazione obbligatoria ticino',
    ogTitle: 'Assicurazioni Sanitarie Ticino | Confronto Casse Malati 2026',
    ogDescription: '🏥 Confronta 5 casse malati in Ticino. Premi mensili da CHF 290, franchigie da CHF 300. Trova l\'assicurazione sanitaria più conveniente!',
    canonicalPath: '/comparatori/assicurazioni-sanitarie',
  },

  banks: {
    title: 'Banche Svizzera e Italia | Confronto Conti per Frontalieri',
    description: 'Confronta banche per frontalieri: UBS, Credit Suisse, PostFinance, Intesa Sanpaolo, UniCredit. Costi gestione conto, carte di credito, bonifici internazionali e servizi transfrontalieri.',
    keywords: 'banche svizzera, conto corrente ticino, ubs credit suisse postfinance, intesa sanpaolo unicredit, costi conto corrente, carte credito svizzera, bonifici internazionali, servizi bancari frontalieri',
    ogTitle: 'Banche per Frontalieri | Confronto Conti CH-IT',
    ogDescription: '🏦 Confronta 8 banche svizzere e italiane. Costi gestione, carte incluse e servizi per frontalieri. Scegli il conto migliore!',
    canonicalPath: '/comparatori/banche',
  },

  traffic: {
    title: 'Traffico Valichi Svizzera-Italia | Tempi Attesa Dogane in Tempo Reale',
    description: 'Traffico in tempo reale ai valichi doganali Svizzera-Italia: Chiasso, Ponte Tresa, Gaggiolo, Brogeda, Stabio. Tempi di attesa aggiornati, percorsi alternativi e consigli per evitare code.',
    keywords: 'traffico valichi svizzera, dogana chiasso tempo reale, ponte tresa traffico, gaggiolo brogeda coda, tempo attesa dogana, valichi frontalieri ticino, traffico confine svizzera italia, percorsi alternativi frontalieri',
    ogTitle: 'Traffico Valichi CH-IT in Tempo Reale | Tempi Attesa Dogane',
    ogDescription: '🚦 Controlla il traffico in tempo reale a 8 valichi doganali Svizzera-Italia. Tempi di attesa aggiornati e percorsi alternativi per evitare code!',
    canonicalPath: '/comparatori/traffico-valichi',
  },

  pension: {
    title: 'Pianificatore Pensione Frontalieri | Calcolo LPP, AVS e INPS',
    description: 'Calcola la tua pensione come frontaliere: contributi LPP (2° pilastro), AVS svizzera (1° pilastro) e INPS Italia. Proiezioni cumulative, età pensionabile e convenienza totalizzazione CH-IT.',
    keywords: 'pensione frontalieri, calcolo lpp, avs svizzera, inps italia, secondo pilastro svizzera, contributi pensionistici, totalizzazione pensione, età pensionabile svizzera, previdenza frontalieri, cassa pensione ticino',
    ogTitle: 'Pianificatore Pensione Frontalieri | Calcolo LPP, AVS, INPS',
    ogDescription: '👴 Pianifica la tua pensione da frontaliere. Calcola contributi LPP, AVS e INPS con proiezioni cumulative fino alla pensione!',
    canonicalPath: '/pianificatore-pensione',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      "name": "Pianificatore Pensione Frontalieri",
      "url": `${BASE_URL}/pianificatore-pensione`,
      "description": "Strumento per calcolare e pianificare la pensione dei lavoratori frontalieri tra Svizzera e Italia",
      "applicationCategory": "FinanceApplication"
    }
  },

  guide: {
    title: 'Guida Frontalieri 2026 | Tutto su Tasse, Pensione, Vita in CH/IT',
    description: 'Guida completa per frontalieri 2026: differenze Vecchio vs Nuovo accordo, comuni frontalieri, residenza Svizzera o Italia, costi vita, sanità, scuole, investimenti, Tax Free e consigli pratici.',
    keywords: 'guida frontalieri 2026, vecchio nuovo frontaliere, comuni frontalieri ticino, residenza svizzera italia, costi vita ticino, permesso b svizzera, scuole canton ticino, sanità svizzera, capital gain svizzera, tax free shopping',
    ogTitle: 'Guida Completa Frontalieri 2026 | Tasse, Pensione e Vita CH-IT',
    ogDescription: '📚 Guida completa per frontalieri: nuovo accordo 2026, comuni frontalieri, residenza, costi vita, sanità, pensione, investimenti e Tax Free shopping!',
    canonicalPath: '/guida-frontalieri',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "Article",
      "headline": "Guida Completa per Lavoratori Frontalieri Svizzera-Italia 2026",
      "url": `${BASE_URL}/guida-frontalieri`,
      "description": "Guida dettagliata su tassazione, residenza, costi vita e servizi per frontalieri tra Canton Ticino e Italia",
      "author": {
        "@type": "Organization",
        "name": "Frontaliere Si o No"
      },
      "datePublished": "2026-01-01",
      "dateModified": "2026-02-13"
    }
  },

  stats: {
    title: 'Statistiche Frontalieri | Dati Salari, Comuni e Preferenze 2026',
    description: 'Statistiche e analisi frontalieri Svizzera-Italia: distribuzione salari, comuni più usati, scelta Vecchio vs Nuovo accordo, settori lavorativi e tendenze 2026 Canton Ticino.',
    keywords: 'statistiche frontalieri, salari medi ticino, comuni frontalieri più usati, dati frontalieri svizzera, settori lavoro ticino, preferenze fiscali frontalieri, analisi frontalieri 2026',
    ogTitle: 'Statistiche Frontalieri 2026 | Dati Salari e Preferenze CH-IT',
    ogDescription: '📈 Statistiche aggiornate sui frontalieri: distribuzione salari, comuni più scelti, preferenze fiscali e tendenze Canton Ticino 2026.',
    canonicalPath: '/statistiche',
  },

  feedback: {
    title: 'Contatti e Supporto | Frontaliere Si o No?',
    description: 'Hai domande sul lavoro frontaliero? Contattaci per supporto sul simulatore fiscale, pensione, comparatori servizi o per segnalare problemi. Siamo qui per aiutarti!',
    keywords: 'contatti frontalieri, supporto simulatore, aiuto calcolo tasse, feedback frontalieri, domande frontalieri svizzera, assistenza frontalieri ticino',
    ogTitle: 'Contatti e Supporto Frontalieri | Chiedi Aiuto',
    ogDescription: '💬 Hai domande sul lavoro frontaliero? Contattaci per supporto su tasse, pensione, servizi e comparatori!',
    canonicalPath: '/supporto',
  },

  // New sections
  whatif: {
    title: 'Simulatore What-If Frontalieri | Scenari Cosa Cambia Se...',
    description: 'Scopri come cambiano le tue tasse da frontaliere con scenari what-if: figlio in arrivo, cambio stipendio, stato civile, zona di residenza. Simulazione immediata e gratuita.',
    keywords: 'what if frontalieri, simulatore scenari, cosa cambia se figlio, aumento stipendio frontaliere, detrazioni figli frontaliere, cambio stato civile tasse',
    ogTitle: 'Simulatore What-If | Scenari Fiscali per Frontalieri',
    ogDescription: '🔮 Scopri come cambiano le tue tasse con scenari what-if: figlio, stipendio, residenza. Simulazione in tempo reale!',
    canonicalPath: '/simulatore-what-if',
  },

  jobs: {
    title: 'Confronto Offerte Lavoro Svizzera | Calcolo Netto Reale per Frontalieri',
    description: 'Confronta fino a 4 offerte di lavoro in Svizzera: calcolo netto reale considerando tasse, costi trasporto, tempo viaggio, home office e benefit. Scopri quale offerta conviene davvero.',
    keywords: 'confronto offerte lavoro svizzera, stipendio netto reale frontaliere, calcolo netto lavoro ticino, costi pendolarismo frontaliere, home office frontaliere, benefit lavoro svizzera',
    ogTitle: 'Confronto Offerte Lavoro Svizzera | Netto Reale Frontalieri',
    ogDescription: '💼 Confronta offerte di lavoro in Svizzera con calcolo netto reale: tasse, trasporto, tempo e benefit inclusi.',
    canonicalPath: '/comparatori/offerte-lavoro',
  },

  calendar: {
    title: 'Calendario Scadenze Fiscali 2026 | Date Tasse Frontalieri CH-IT',
    description: 'Tutte le scadenze fiscali 2026 per frontalieri Svizzera-Italia: IRPEF, 730, Modello Redditi, IMU, imposta alla fonte, AVS. Con countdown, documenti necessari e sanzioni.',
    keywords: 'scadenze fiscali frontalieri 2026, calendario tasse frontaliere, 730 frontalieri, modello redditi frontaliere, quadro rw svizzera, imposta alla fonte scadenza, irpef frontalieri',
    ogTitle: 'Calendario Fiscale 2026 | Scadenze Tasse per Frontalieri',
    ogDescription: '📅 Tutte le scadenze fiscali 2026 per frontalieri: IRPEF, 730, imposta alla fonte. Con countdown e documenti necessari!',
    canonicalPath: '/guida-frontalieri/calendario-fiscale',
  },

  permits: {
    title: 'Permessi Lavoro Svizzera G, B, C, L | Guida Completa 2026',
    description: 'Guida completa ai permessi di lavoro in Svizzera: permesso G (frontalieri), B (dimora), C (domicilio) e L (breve durata). Requisiti, documenti, costi, diritti e limitazioni per cittadini UE.',
    keywords: 'permesso g svizzera, permesso b svizzera, permesso c svizzera, permesso l svizzera, permesso frontaliere requisiti, permesso dimora svizzera, documenti permesso lavoro svizzera',
    ogTitle: 'Permessi Lavoro Svizzera | Guida G, B, C, L per Frontalieri',
    ogDescription: '🛂 Guida completa ai permessi di lavoro svizzeri: requisiti, documenti, costi e diritti per ogni tipo di permesso.',
    canonicalPath: '/guida-frontalieri/permessi-lavoro',
  },

  pillar3: {
    title: 'Simulatore 3° Pilastro Svizzera | Calcolo Risparmio Fiscale',
    description: 'Calcola il risparmio fiscale e la crescita del tuo 3° pilastro svizzero (3a e 3b). Proiezione a lungo termine con rendimento composto, deducibilità fiscale e confronto 3a vs 3b.',
    keywords: 'terzo pilastro svizzera, pilastro 3a calcolo, pilastro 3b, risparmio fiscale svizzera, previdenza privata svizzera, deduzione fiscale pilastro 3a, investimento pilastro svizzera',
    ogTitle: 'Simulatore 3° Pilastro | Risparmio Fiscale Svizzera',
    ogDescription: '💰 Calcola quanto risparmi con il 3° pilastro: deducibilità fiscale, proiezione rendimento e confronto 3a vs 3b.',
    canonicalPath: '/pianificatore-pensione/terzo-pilastro',
  },

  newsletter: {
    title: 'Newsletter Frontalieri | Cambio CHF/EUR e Aggiornamenti Settimanali',
    description: 'Iscriviti alla newsletter settimanale per frontalieri: cambio CHF/EUR, traffico ai valichi, novità fiscali e consigli per risparmiare. Gratuita e senza spam.',
    keywords: 'newsletter frontalieri, cambio chf eur settimanale, aggiornamenti frontalieri, email frontalieri svizzera, traffico valichi email, novità tasse frontalieri',
    ogTitle: 'Newsletter Frontalieri | Aggiornamenti Settimanali Gratuiti',
    ogDescription: '📬 Iscriviti alla newsletter per frontalieri: cambio CHF/EUR, traffico ai valichi e novità fiscali ogni settimana!',
    canonicalPath: '/newsletter',
  },

  shopping: {
    title: 'Spesa Transfrontaliera | Confronto Prezzi Supermercato CH-IT',
    description: 'Confronta i prezzi della spesa tra supermercati svizzeri (Migros, Coop, Lidl) e italiani (Esselunga, Conad, Eurospin). Calcola il risparmio reale con tasso di cambio CHF/EUR aggiornato.',
    keywords: 'spesa transfrontaliera, prezzi supermercato svizzera italia, migros coop lidl prezzi, esselunga conad confronto, risparmio spesa frontaliere, costo spesa ticino, shopping transfrontaliero prezzi',
    ogTitle: 'Spesa Transfrontaliera | Confronto Prezzi Supermercato CH-IT',
    ogDescription: '🛒 Confronta i prezzi della spesa tra supermercati svizzeri e italiani. Calcola il risparmio reale con il tasso di cambio aggiornato!',
    canonicalPath: '/guida-frontalieri/spesa-transfrontaliera',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      "name": "Calcolatore Spesa Transfrontaliera",
      "url": `${BASE_URL}/guida-frontalieri/spesa-transfrontaliera`,
      "description": "Confronta prezzi della spesa tra supermercati svizzeri e italiani con tasso di cambio in tempo reale",
      "applicationCategory": "ShoppingApplication",
      "operatingSystem": "Web Browser",
      "offers": {
        "@type": "Offer",
        "price": "0",
        "priceCurrency": "CHF"
      }
    }
  },

  costOfLiving: {
    title: 'Costo della Vita CH vs IT | Confronto Città di Frontiera 2026',
    description: 'Confronta il costo della vita tra le città di frontiera svizzere (Lugano, Mendrisio, Chiasso) e italiane (Como, Varese, Verbania). Affitti, spesa, trasporti, sanità, ristoranti e tempo libero.',
    keywords: 'costo vita svizzera italia, costo vita lugano, costo vita como, affitto ticino prezzi, costo vita mendrisio chiasso, confronto prezzi svizzera italia, vivere in svizzera costi, costo vita frontiera',
    ogTitle: 'Costo della Vita CH vs IT | Confronto Città di Frontiera',
    ogDescription: '🏠 Confronta il costo della vita tra città di frontiera svizzere e italiane: affitti, spesa, trasporti, sanità e tempo libero.',
    canonicalPath: '/guida-frontalieri/costo-della-vita',
    structuredData: {
      "@context": "https://schema.org",
      "@type": "WebApplication",
      "name": "Confronto Costo della Vita Svizzera-Italia",
      "url": `${BASE_URL}/guida-frontalieri/costo-della-vita`,
      "description": "Confronto interattivo del costo della vita tra città di frontiera svizzere e italiane",
      "applicationCategory": "FinanceApplication",
      "operatingSystem": "Web Browser",
      "offers": {
        "@type": "Offer",
        "price": "0",
        "priceCurrency": "CHF"
      }
    }
  },

  livingCH: {
    title: 'Vivere in Svizzera | Guida Completa per Frontalieri e Residenti',
    description: 'Tutto su vivere in Svizzera: costo della vita, affitti Canton Ticino, sistema sanitario LAMal, scuole, trasporti, tasse e burocrazia. Guida pratica per frontalieri che valutano il trasferimento.',
    keywords: 'vivere in svizzera, trasferirsi in svizzera, affitti ticino, costo vita svizzera, lamal assicurazione, scuole svizzera, sistema sanitario svizzera, burocrazia svizzera, residenza svizzera',
    ogTitle: 'Vivere in Svizzera | Guida Completa per Frontalieri',
    ogDescription: '🇨🇭 Guida completa su vivere in Svizzera: affitti, sanità, scuole, trasporti e burocrazia nel Canton Ticino.',
    canonicalPath: '/guida-frontalieri/vivere-in-svizzera',
  },

  livingIT: {
    title: 'Vivere in Italia come Frontaliere | Vantaggi Residenza Italiana',
    description: 'Vantaggi e svantaggi di vivere in Italia lavorando in Svizzera: costi più bassi, detrazioni fiscali, sanità SSN, scuole italiane, qualità della vita nelle province di frontiera Como, Varese, VCO.',
    keywords: 'vivere in italia frontaliere, residenza italia vantaggi, como varese frontalieri, costi vivere italia, detrazioni frontalieri italia, sanità ssn frontalieri, province frontiera',
    ogTitle: 'Vivere in Italia come Frontaliere | Vantaggi e Svantaggi',
    ogDescription: '🇮🇹 Pro e contro di vivere in Italia lavorando in Svizzera: costi, detrazioni, sanità e qualità della vita.',
    canonicalPath: '/guida-frontalieri/vivere-in-italia',
  },

  border: {
    title: 'Valichi di Frontiera Svizzera-Italia | Orari, Traffico e Percorsi',
    description: 'Guida completa ai valichi doganali Svizzera-Italia: Chiasso, Ponte Tresa, Gaggiolo, Brogeda, Stabio. Orari apertura, tempi di attesa, percorsi alternativi e consigli per evitare code.',
    keywords: 'valichi frontiera svizzera italia, dogana chiasso, ponte tresa orari, gaggiolo brogeda, stabio valico, orari valichi, percorsi alternativi frontiera, code dogana',
    ogTitle: 'Valichi di Frontiera CH-IT | Orari e Percorsi Alternativi',
    ogDescription: '🛃 Guida ai valichi doganali Svizzera-Italia: orari, tempi di attesa e percorsi alternativi per evitare code.',
    canonicalPath: '/guida-frontalieri/valichi-frontiera',
  },

  costs: {
    title: 'Costi Pendolarismo Frontaliere | Calcolo Spese Auto, Treno, Bus',
    description: 'Calcola i costi reali del pendolarismo come frontaliere: benzina, autostrada, usura auto, parcheggio, abbonamenti treno e bus transfrontalieri. Confronta le opzioni più convenienti.',
    keywords: 'costi pendolarismo frontaliere, spese viaggio frontaliere, benzina frontaliere, autostrada svizzera costi, parcheggio dogana, treno frontalieri, bus transfrontaliero',
    ogTitle: 'Costi Pendolarismo Frontaliere | Calcolo Spese Viaggio',
    ogDescription: '🚗 Calcola quanto spendi di pendolarismo: auto, treno, bus. Confronta le opzioni per risparmiare!',
    canonicalPath: '/guida-frontalieri/costi-pendolarismo',
  },

  companies: {
    title: 'Aziende che Assumono in Ticino | Settori e Opportunità Lavoro',
    description: 'Scopri le principali aziende che assumono frontalieri nel Canton Ticino: settori tecnologia, finanza, farmaceutico, industria e servizi. Link diretti alle pagine carriere e consigli per candidarsi.',
    keywords: 'aziende ticino lavoro, aziende che assumono svizzera, lavoro canton ticino, settori lavoro ticino, opportunità lavoro frontalieri, carriere svizzera, stipendi ticino',
    ogTitle: 'Aziende che Assumono in Ticino | Opportunità per Frontalieri',
    ogDescription: '🏢 Scopri le migliori aziende che assumono nel Canton Ticino: settori, stipendi e link alle pagine carriere.',
    canonicalPath: '/guida-frontalieri/aziende-ticino',
  },
};

/**
 * Updates document meta tags dynamically
 */
export function updateMetaTags(section: string): void {
  const metadata = SEO_METADATA[section] || SEO_METADATA.calculator;

  // Update title
  document.title = metadata.title;

  // Update or create meta tags
  updateOrCreateMetaTag('name', 'description', metadata.description);
  updateOrCreateMetaTag('name', 'keywords', metadata.keywords);
  
  // Update Open Graph tags
  updateOrCreateMetaTag('property', 'og:title', metadata.ogTitle);
  updateOrCreateMetaTag('property', 'og:description', metadata.ogDescription);
  updateOrCreateMetaTag('property', 'og:url', `${BASE_URL}${metadata.canonicalPath}`);
  updateOrCreateMetaTag('property', 'og:locale', getOgLocale());
  
  // Update Twitter Card tags
  updateOrCreateMetaTag('name', 'twitter:title', metadata.ogTitle);
  updateOrCreateMetaTag('name', 'twitter:description', metadata.ogDescription);
  updateOrCreateMetaTag('name', 'twitter:url', `${BASE_URL}${metadata.canonicalPath}`);

  // Update canonical URL
  updateCanonicalLink(`${BASE_URL}${metadata.canonicalPath}`);

  // Update hreflang tags for multilingual SEO
  updateHreflangTags(metadata.canonicalPath);

  // Update structured data if provided
  if (metadata.structuredData) {
    updateStructuredData(metadata.structuredData);
  }
}

/**
 * Update document language attribute and OG locale based on current i18n locale
 */
export function updateDocumentLanguage(locale: string): void {
  document.documentElement.lang = locale;
  updateOrCreateMetaTag('property', 'og:locale', getOgLocale());
}

/**
 * Get OG locale format from current document lang
 */
function getOgLocale(): string {
  const lang = document.documentElement.lang || 'it';
  const localeMap: Record<string, string> = {
    'it': 'it_IT', 'en': 'en_US', 'de': 'de_CH', 'fr': 'fr_CH',
  };
  return localeMap[lang] || 'it_IT';
}

/**
 * Update hreflang link tags for multilingual SEO
 * Tells search engines about language versions of the page
 */
function updateHreflangTags(canonicalPath: string): void {
  // Remove existing hreflang tags
  document.querySelectorAll('link[hreflang]').forEach(el => el.remove());

  const supportedLocales = [
    { lang: 'it', hreflang: 'it' },
    { lang: 'en', hreflang: 'en' },
    { lang: 'de', hreflang: 'de' },
    { lang: 'fr', hreflang: 'fr' },
  ];

  // Add hreflang for each locale
  supportedLocales.forEach(({ hreflang }) => {
    const link = document.createElement('link');
    link.rel = 'alternate';
    link.hreflang = hreflang;
    link.href = `${BASE_URL}${canonicalPath}?lang=${hreflang}`;
    document.head.appendChild(link);
  });

  // Add x-default (Italian as default)
  const xDefault = document.createElement('link');
  xDefault.rel = 'alternate';
  xDefault.setAttribute('hreflang', 'x-default');
  xDefault.href = `${BASE_URL}${canonicalPath}`;
  document.head.appendChild(xDefault);
}

/**
 * Helper function to update or create meta tags
 */
function updateOrCreateMetaTag(attrName: string, attrValue: string, content: string): void {
  let element = document.querySelector(`meta[${attrName}="${attrValue}"]`);
  
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attrName, attrValue);
    document.head.appendChild(element);
  }
  
  element.setAttribute('content', content);
}

/**
 * Update canonical link
 */
function updateCanonicalLink(url: string): void {
  let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement;
  
  if (!canonical) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  
  canonical.href = url;
}

/**
 * Update structured data (JSON-LD)
 */
function updateStructuredData(data: Record<string, any>): void {
  const scriptId = 'dynamic-structured-data';
  let script = document.getElementById(scriptId) as HTMLScriptElement | null;
  
  if (!script) {
    script = document.createElement('script') as HTMLScriptElement;
    script.id = scriptId;
    script.type = 'application/ld+json';
    document.head.appendChild(script);
  }
  
  script.textContent = JSON.stringify(data);
}

/**
 * Track section view for analytics
 */
export function trackSectionView(section: string): void {
  // Check if gtag is available (Google Analytics)
  if (typeof window !== 'undefined' && 'gtag' in window && typeof (window as any).gtag === 'function') {
    (window as any).gtag('event', 'page_view', {
      page_title: SEO_METADATA[section]?.title || document.title,
      page_location: `${BASE_URL}${SEO_METADATA[section]?.canonicalPath || '/'}`,
      page_path: SEO_METADATA[section]?.canonicalPath || '/',
    });
  }
}
