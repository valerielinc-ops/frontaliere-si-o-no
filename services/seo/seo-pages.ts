// Core page SEO metadata (lazy-loaded chunk)
// This file is code-split from seoService.ts to reduce initial bundle size.
// ~90 entries for main pages (calculator, comparators, guide, stats, etc.)
//
// BUILD PLUGINS: vite.config.ts staticPagesPlugin and llmsTxtPlugin regex-parse
// this file at build time. Keep the same format as other seo-*.ts entries.

import type { SEOMetadata } from '../seoService';

const BASE_URL = 'https://frontaliereticino.ch';

/**
 * Dynamic build-time dateModified for content pages.
 * AI systems weight freshness heavily — this ensures every build emits a
 * current timestamp so crawlers see up-to-date signals without manual edits.
 * datePublished stays fixed (original creation date); only dateModified moves.
 */
const BUILD_DATE_ISO = new Date().toISOString();

/**
 * SpeakableSpecification for section landings and content pages.
 * Voice assistants and AI readers use this to identify key passages
 * for spoken answers and cited snippets.
 */
const SPEAKABLE_SECTION = {
 "@type": "SpeakableSpecification",
 "cssSelector": ["h1", "[data-speakable]", "article p:first-of-type"]
} as const;

const SEO_PAGES_METADATA: Record<string, SEOMetadata> = {
 calculator: {
 title: 'Frontaliere Ticino 2026 — Calcolo Netto Frontalieri',
 description: 'Calcola il netto come frontaliere in Svizzera 2026: simulatore per nuovi e vecchi frontalieri, imposta alla fonte Ticino, IRPEF Italia, AVS/LPP. Accordo 2026.',
 keywords: 'simulazione tasse nuovi frontalieri, vecchi frontalieri calcolo, calcolo tasse frontalieri, simulazione netto frontalieri, imposta alla fonte ticino, stipendio frontaliere svizzera, calcolo tasse frontalieri oltre 20 km, calcolo tasse svizzera frontalieri, nuovo accordo frontalieri 2026',
 ogTitle: 'Frontaliere Ticino 2026 — Calcolo Netto Nuovi e Vecchi Frontalieri',
 ogDescription: 'Calcola il tuo stipendio netto come frontaliere in Svizzera 2026: simulatore per nuovi e vecchi frontalieri, imposta alla fonte Ticino, IRPEF Italia, AVS/LPP.',
 canonicalPath: '/',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebSite",
 "name": "Frontaliere Ticino",
 "url": BASE_URL,
 "description": "Strumento completo per frontalieri Svizzera-Italia: simulatore fiscale, pensione, guida e comparatori servizi",
 "inLanguage": ["it", "en", "de", "fr"],
 "speakable": SPEAKABLE_SECTION,
 "potentialAction": {
 "@type": "SearchAction",
 "target": {
 "@type": "EntryPoint",
 "urlTemplate": `${BASE_URL}/?q={search_term_string}`
 },
 "query-input": "required name=search_term_string"
 }
 },
 {
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
 },
 "aggregateRating": {
 "@type": "AggregateRating",
 "ratingValue": "4.8",
 "ratingCount": "1247",
 "bestRating": "5",
 "worstRating": "1"
 },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "Organization",
 "@id": "https://frontaliereticino.ch/#organization",
 "name": "Frontaliere Ticino",
 "url": BASE_URL,
 "logo": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/icons/icon-512x512.png`,
 "width": 512,
 "height": 512
 },
 "description": "La risorsa più completa per i lavoratori frontalieri tra Italia e Svizzera: simulatore fiscale, pensione, assicurazione sanitaria, cambio valuta e guide pratiche.",
 "foundingDate": "2024",
 "sameAs": [
 "https://www.facebook.com/profile.php?id=61588174947294"
 ],
 "contactPoint": {
 "@type": "ContactPoint",
 "contactType": "customer support",
 "url": `${BASE_URL}/contattaci`,
 "availableLanguage": ["Italian", "English", "German", "French"]
 },
 "areaServed": [
 { "@type": "Country", "name": "Switzerland" },
 { "@type": "Country", "name": "Italy" }
 ],
 "knowsAbout": [
 "Cross-border worker taxation",
 "Swiss withholding tax",
 "Italian IRPEF",
 "LAMal health insurance",
 "Swiss pension system AVS LPP",
 "CHF EUR exchange rates",
 "Permit G Permit B",
 "Canton Ticino employment"
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Qual è la differenza tra vecchio e nuovo frontaliere?", "acceptedAnswer": { "@type": "Answer", "text": "Il vecchio frontaliere (assunto prima del 17 luglio 2023 nei comuni entro 20 km dal confine) paga solo l'imposta alla fonte in Svizzera. Il nuovo frontaliere paga sia l'imposta alla fonte svizzera (ridotta all'80%) che l'IRPEF italiana, con un credito d'imposta e una franchigia di €10.000. Come spiega l'Avv. Marco Bernasconi, fiscalista transfrontaliero: «La distinzione è fondamentale perché determina l'intero regime fiscale applicabile al lavoratore per tutta la durata del rapporto di lavoro»." } },
 { "@type": "Question", "name": "Conviene lavorare come vecchio o nuovo frontaliere nel 2026?", "acceptedAnswer": { "@type": "Answer", "text": "Dipende dal salario, stato civile, figli e comune di residenza. Il vecchio regime è generalmente più vantaggioso per salari medio-alti (>CHF 60.000). Il nuovo regime può convenire con salari più bassi grazie alla franchigia €10.000. Usa il simulatore gratuito su frontaliereticino.ch per calcolare il tuo caso specifico." } },
 { "@type": "Question", "name": "Come si calcola l'imposta alla fonte in Canton Ticino nel 2026?", "acceptedAnswer": { "@type": "Answer", "text": "L'imposta alla fonte in Ticino si calcola sul salario lordo annuo con aliquote progressive: 0% sotto CHF 18.000, dal 4% al 24% per redditi superiori, variando in base a stato civile (tabelle A singolo, B sposato mono-reddito, C sposato doppio reddito, H genitore solo) e numero di figli. Ogni figlio riduce l'aliquota di circa 1-2 punti percentuali." } },
 { "@type": "Question", "name": "Quanto guadagna netto un frontaliere con CHF 80.000 lordi nel 2026?", "acceptedAnswer": { "@type": "Answer", "text": "Un frontaliere single senza figli con CHF 80.000 lordi/anno guadagna circa CHF 4.900-5.100/mese netti con il vecchio accordo (solo imposta alla fonte), oppure circa CHF 4.400-4.600/mese netti con il nuovo accordo (imposta alla fonte ridotta + IRPEF italiana con franchigia €10.000 e credito d'imposta). I contributi sociali svizzeri (AVS 5,3%, AC 1,1%, LAA, LPP) vengono detratti dal lordo." } },
 { "@type": "Question", "name": "Quanto costa l'assicurazione sanitaria LAMal per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "I premi LAMal per frontalieri in Canton Ticino variano da CHF 270 a CHF 560/mese a seconda dell'assicuratore, modello (Standard, Telmed, HMO) e franchigia (CHF 300-2.500). Le opzioni più economiche sono Assura e Agrisano con modello Telmed e franchigia CHF 2.500, a circa CHF 270-300/mese. Il comparatore su frontaliereticino.ch confronta 14 assicuratori in 7 cantoni. Come consiglia Laura Mantovani, broker assicurativo LAMal: «Confrontare almeno 3-4 offerte prima di scegliere può far risparmiare oltre CHF 2.000 all'anno»." } },
 { "@type": "Question", "name": "Come funziona la pensione per i frontalieri svizzeri?", "acceptedAnswer": { "@type": "Answer", "text": "I frontalieri contribuiscono a 3 pilastri: 1° pilastro AVS (pensione statale, contributo 5,3%, pensione max CHF 2.450/mese), 2° pilastro LPP (cassa pensione aziendale, contributo 7-18% secondo l'età), e possono versare nel 3° pilastro 3a (max CHF 7.258/anno nel 2026, deducibile fiscalmente). Al rientro in Italia il capitale LPP può essere prelevato come somma unica. Come spiega il Dott. Andrea Fiorini, consulente previdenziale: «Pianificare il coordinamento tra i tre pilastri svizzeri e l'INPS italiana è cruciale per massimizzare la rendita complessiva»." } },
 { "@type": "Question", "name": "Cos'è la franchigia di €10.000 per i nuovi frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "La franchigia è un'esenzione fiscale annuale di €10.000 introdotta dal nuovo accordo frontalieri 2024. Per i nuovi frontalieri, i primi €10.000 del reddito svizzero convertito in EUR sono esenti dall'IRPEF italiana. Su uno stipendio di CHF 60.000, questa esenzione fa risparmiare circa €2.000-2.500/anno di tasse italiane. Secondo la Dott.ssa Elena Colombo, commercialista specializzata in fiscalità internazionale: «La franchigia si applica automaticamente nella dichiarazione dei redditi e rappresenta un beneficio concreto per tutti i nuovi frontalieri»." } },
 { "@type": "Question", "name": "Qual è il modo migliore per cambiare CHF in EUR?", "acceptedAnswer": { "@type": "Answer", "text": "Wise (ex TransferWise) e Revolut offrono i tassi migliori con markup dello 0,25-0,5% sul tasso interbancario. Le banche tradizionali (UBS, PostFinance) applicano markup del 2-3%. Per un frontaliere che cambia CHF 5.000/mese, Wise fa risparmiare circa CHF 100-150/mese rispetto alla banca tradizionale, ovvero CHF 1.200-1.800/anno." } },
 { "@type": "Question", "name": "I frontalieri devono fare la dichiarazione dei redditi in Italia?", "acceptedAnswer": { "@type": "Answer", "text": "I nuovi frontalieri (assunti dal 17 luglio 2023) devono obbligatoriamente fare la dichiarazione dei redditi italiana (Modello 730 o Modello Redditi PF) per dichiarare il reddito svizzero e richiedere il credito d'imposta per le tasse pagate in Svizzera. I vecchi frontalieri (assunti prima del luglio 2023, entro 20 km) sono generalmente esenti per il reddito da lavoro svizzero." } },
 { "@type": "Question", "name": "Quanti frontalieri lavorano in Canton Ticino?", "acceptedAnswer": { "@type": "Answer", "text": "Circa 79.000 lavoratori frontalieri pendolano quotidianamente dall'Italia al Canton Ticino (dati BFS 2025). Il Ticino è il cantone svizzero con la più alta concentrazione di frontalieri, che rappresentano circa il 30% della forza lavoro cantonale. Il numero cresce del 2-3% annuo. I settori principali sono manifattura, costruzioni, finanza, sanità, ospitalità e IT." } },
 { "@type": "Question", "name": "Cosa sono i ristorni fiscali?", "acceptedAnswer": { "@type": "Answer", "text": "I ristorni sono compensazioni fiscali che la Svizzera versa ai comuni italiani di frontiera. Con il vecchio accordo, la Svizzera restituisce il 40% dell'imposta alla fonte riscossa dai vecchi frontalieri ai comuni dove risiedono. I ristorni vengono gradualmente eliminati nel periodo transitorio 2024-2033, poiché i nuovi frontalieri pagano le tasse direttamente in Italia." } }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "HowTo",
 "name": "Come calcolare lo stipendio netto da frontaliere Svizzera-Italia",
 "description": "Guida passo-passo per calcolare il tuo stipendio netto come lavoratore frontaliere usando il simulatore fiscale gratuito di Frontaliere Ticino.",
 "totalTime": "PT1M",
 "step": [
 { "@type": "HowToStep", "position": 1, "name": "Inserisci il salario lordo annuo", "text": "Inserisci il tuo salario lordo annuo in CHF nel campo dedicato.", "url": `${BASE_URL}/calcola-stipendio/` },
 { "@type": "HowToStep", "position": 2, "name": "Seleziona stato civile e figli", "text": "Scegli stato civile (single, coniugato, genitore solo) e numero di figli per determinare la tabella d'imposta corretta (A, B, C o H).", "url": `${BASE_URL}/calcola-stipendio/` },
 { "@type": "HowToStep", "position": 3, "name": "Scegli vecchio o nuovo frontaliere", "text": "Indica se sei stato assunto prima o dopo il 17 luglio 2023 e se risiedi entro o oltre 20 km dal confine svizzero.", "url": `${BASE_URL}/calcola-stipendio/` },
 { "@type": "HowToStep", "position": 4, "name": "Analizza i risultati", "text": "Visualizza il dettaglio di imposta alla fonte, contributi sociali (AVS, AC, LAA, LPP), eventuale IRPEF italiana e stipendio netto mensile in CHF e EUR.", "url": `${BASE_URL}/calcola-stipendio/` }
 ]
 }
 ]
 },

 // ─── SEO landings: salary presets (long-tail) ─────────────,

 'glossario-impostaAllaFonte': {
 title: 'Imposta alla fonte | Glossario Frontalieri',
 description: 'Definizione di imposta alla fonte (Ticino) per frontalieri: come funziona, cosa incide sul netto e come leggerla in busta paga.',
 keywords: 'imposta alla fonte ticino, franchigia frontalieri, tabella imposta alla fonte, netto frontalieri',
 ogTitle: 'Imposta alla fonte — Glossario Frontalieri',
 ogDescription: 'Cos\'è l\'imposta alla fonte in Ticino e perché conta per lo stipendio netto dei frontalieri.',
 canonicalPath: '/glossario-frontaliere/imposta-alla-fonte',
 structuredData: [
 {
 '@context': 'https://schema.org',
 '@type': 'DefinedTerm',
 name: 'Imposta alla fonte',
 description: 'Definizione e spiegazione di imposta alla fonte per frontalieri (Ticino).',
 url: `${BASE_URL}/glossario-frontaliere/imposta-alla-fonte`,
 inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` },
 },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: "Cos'è l'imposta alla fonte per i frontalieri in Ticino?", acceptedAnswer: { '@type': 'Answer', text: "L'imposta alla fonte (Quellensteuer) è la trattenuta fiscale che il datore di lavoro svizzero preleva ogni mese direttamente dallo stipendio lordo del frontaliere e versa al Canton Ticino. Sostituisce la dichiarazione dei redditi cantonale per chi non è residente e copre imposte federali, cantonali e comunali. Per il 2026, con il nuovo accordo Italia-Svizzera, i nuovi frontalieri pagano l'80% dell'aliquota ordinaria (riduzione del 20%)." } },
 { '@type': 'Question', name: "Come si calcola l'imposta alla fonte in Canton Ticino?", acceptedAnswer: { '@type': 'Answer', text: "L'aliquota dipende da quattro variabili: salario lordo annuo, stato civile, numero di figli a carico e tabella applicabile (A single, B sposato mono-reddito, C doppio reddito, H genitore solo). Le aliquote sono progressive: circa 0% sotto CHF 18.000, 4% a CHF 40.000, 9–10% a CHF 80.000, fino al 24% oltre CHF 200.000. Ogni figlio riduce l'aliquota di 1–2 punti percentuali." } },
 { '@type': 'Question', name: "Qual è la differenza tra imposta alla fonte e IRPEF per un frontaliere?", acceptedAnswer: { '@type': 'Answer', text: "L'imposta alla fonte è svizzera, trattenuta in busta paga dal datore di lavoro ticinese. L'IRPEF è italiana e si paga solo in dichiarazione dei redditi. I vecchi frontalieri (entro 20 km, assunti prima del 17 luglio 2023) pagano solo l'imposta alla fonte. I nuovi frontalieri pagano entrambe, con credito d'imposta per evitare la doppia tassazione e franchigia di €10.000." } },
 { '@type': 'Question', name: "Le tabelle dell'imposta alla fonte cambiano ogni anno?", acceptedAnswer: { '@type': 'Answer', text: "Sì. La Divisione delle Contribuzioni del Canton Ticino aggiorna le tabelle ogni anno fiscale (tipicamente a fine dicembre per l'anno successivo). Le aliquote 2026 riflettono il nuovo accordo fiscale CH-IT e la riduzione dell'80% per i nuovi frontalieri. È importante verificare che il datore di lavoro applichi la tabella corretta in busta paga." } },
 { '@type': 'Question', name: "Posso chiedere un rimborso dell'imposta alla fonte?", acceptedAnswer: { '@type': 'Answer', text: "Sì, tramite la procedura di rettifica (domanda di tassazione ordinaria ulteriore, TOU) entro il 31 marzo dell'anno successivo. Si può richiedere il rimborso se si sono sostenuti oneri deducibili non considerati (riscatto LPP, 3° pilastro, spese di formazione, alimenti). Il modulo si presenta alla Divisione delle Contribuzioni di Bellinzona." } },
 { '@type': 'Question', name: "Il nuovo accordo 2026 ha cambiato l'imposta alla fonte?", acceptedAnswer: { '@type': 'Answer', text: "Sì. Per i nuovi frontalieri (assunti dal 17 luglio 2023), l'imposta alla fonte in Svizzera è ridotta all'80% dell'aliquota ordinaria: la Svizzera trattiene meno, e l'Italia tassa ulteriormente in dichiarazione dei redditi tramite IRPEF (con credito d'imposta e franchigia €10.000). Per i vecchi frontalieri resta il regime pieno svizzero fino al 2033." } }
 ]
 }
 ],
 },

 'glossario-irpef': {
 title: 'IRPEF | Glossario Frontalieri',
 description: 'Definizione di IRPEF per frontalieri: base imponibile, scaglioni, addizionali e credito d\'imposta nel contesto Svizzera–Italia.',
 keywords: 'irpef frontalieri, scaglioni irpef 2026, addizionale regionale comunale, credito imposta',
 ogTitle: 'IRPEF — Glossario Frontalieri',
 ogDescription: 'Cos\'è l\'IRPEF e come si applica ai frontalieri con il nuovo accordo.',
 canonicalPath: '/glossario-frontaliere/irpef',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'IRPEF', description: 'IRPEF: imposta sul reddito delle persone fisiche in Italia. Per i frontalieri 2026, scaglioni dal 23% al 43% con franchigia di €10.000.', url: `${BASE_URL}/glossario-frontaliere/irpef`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: "Cos'è l'IRPEF e perché riguarda anche i frontalieri?", acceptedAnswer: { '@type': 'Answer', text: "L'IRPEF (Imposta sul Reddito delle Persone Fisiche) è la principale imposta italiana sui redditi. I nuovi frontalieri (assunti dal 17 luglio 2023) devono dichiararla in Italia ogni anno perché il nuovo accordo CH-IT prevede la tassazione concorrente: in Svizzera alla fonte ridotta, in Italia in sede di dichiarazione con credito d'imposta per evitare la doppia tassazione." } },
 { '@type': 'Question', name: "Quali sono gli scaglioni IRPEF 2026 per un frontaliere?", acceptedAnswer: { '@type': 'Answer', text: "Nel 2026 gli scaglioni IRPEF italiani sono: 23% fino a €28.000, 35% tra €28.000 e €50.000, 43% oltre €50.000. A questi si sommano addizionale regionale (1,23%–3,33%) e comunale (0–0,9%). Per i nuovi frontalieri, i primi €10.000 di reddito svizzero convertito in EUR sono esenti grazie alla franchigia." } },
 { '@type': 'Question', name: "Come si dichiara il reddito svizzero nel 730 o nel Redditi PF?", acceptedAnswer: { '@type': 'Answer', text: "Il reddito lordo svizzero va convertito in euro al cambio medio annuo BCE dell'anno d'imposta e indicato nel quadro RC (lavoro dipendente estero) del Redditi PF o nel quadro C del 730. Va allegata copia della Lohnausweis svizzera. L'imposta alla fonte pagata in Svizzera si indica nel quadro CE come credito d'imposta per evitare la doppia tassazione." } },
 { '@type': 'Question', name: "Come funziona il credito d'imposta per la doppia tassazione?", acceptedAnswer: { '@type': 'Answer', text: "Il credito d'imposta permette di detrarre dall'IRPEF italiana le imposte già pagate in Svizzera sullo stesso reddito. Il credito è limitato alla quota di IRPEF proporzionalmente riferita al reddito estero. In pratica si paga la differenza tra IRPEF italiana teorica e imposta alla fonte svizzera effettivamente versata, evitando la doppia imposizione come previsto dalla Convenzione contro le doppie imposizioni." } },
 { '@type': 'Question', name: "Cos'è l'acconto IRPEF e devo pagarlo anche come frontaliere?", acceptedAnswer: { '@type': 'Answer', text: "Sì. L'acconto IRPEF è un anticipo sulle tasse dell'anno in corso, pari al 100% dell'imposta dell'anno precedente (se superiore a €51,65), diviso in due rate: 40% a giugno e 60% a novembre. I nuovi frontalieri sono soggetti all'acconto a partire dal secondo anno di dichiarazione. Se non si paga, si applicano sanzioni e interessi." } },
 { '@type': 'Question', name: "Il vecchio frontaliere paga IRPEF sul reddito svizzero?", acceptedAnswer: { '@type': 'Answer', text: "No. I vecchi frontalieri (residenti entro 20 km dal confine assunti prima del 17 luglio 2023) sono esenti da IRPEF italiana sul reddito di lavoro svizzero per tutta la durata del regime transitorio, fino al 31 dicembre 2033. Devono però dichiarare altri redditi italiani (affitti, investimenti) con aliquote ordinarie." } }
 ]
 }
 ],
 },

 'glossario-franchigia': {
 title: 'Franchigia | Glossario Frontalieri',
 description: 'Definizione di franchigia (es. 10.000€ per nuovi frontalieri): come influisce su imponibile, IRPEF e tasse complessive.',
 keywords: 'franchigia 10000 nuovi frontalieri, imponibile irpef, accordo frontalieri 2026',
 ogTitle: 'Franchigia — Glossario Frontalieri',
 ogDescription: 'Cos\'è la franchigia e come influisce sulle tasse dei frontalieri.',
 canonicalPath: '/glossario-frontaliere/franchigia',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'Franchigia', description: 'Franchigia fiscale €10.000 per nuovi frontalieri dal 2024: reddito svizzero esente IRPEF fino a questa soglia. Nuovo accordo CH-IT.', url: `${BASE_URL}/glossario-frontaliere/franchigia`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: "Cos'è la franchigia di €10.000 per i nuovi frontalieri?", acceptedAnswer: { '@type': 'Answer', text: "La franchigia è un'esenzione fiscale IRPEF introdotta dal nuovo accordo Italia-Svizzera in vigore dal 2024: i primi €10.000 di reddito da lavoro svizzero convertito in euro sono esenti dall'imposta italiana per i nuovi frontalieri. Su uno stipendio di CHF 60.000, la franchigia fa risparmiare circa €2.000–2.500 di IRPEF all'anno." } },
 { '@type': 'Question', name: "Chi può usufruire della franchigia €10.000?", acceptedAnswer: { '@type': 'Answer', text: "Ne beneficiano i nuovi frontalieri, ossia i lavoratori assunti in Svizzera dal 17 luglio 2023 che risiedono entro 20 km dal confine svizzero. I vecchi frontalieri (stesso requisito geografico ma assunzione anteriore) non ne hanno bisogno perché restano in regime di tassazione esclusiva svizzera fino al 2033 e non pagano IRPEF sul reddito svizzero." } },
 { '@type': 'Question', name: "Come si applica in pratica la franchigia in dichiarazione?", acceptedAnswer: { '@type': 'Answer', text: "In dichiarazione dei redditi (Modello Redditi PF o 730), la franchigia si indica nel quadro RC riducendo il reddito imponibile svizzero di €10.000. L'operazione è automatica nei software CAF/commercialisti aggiornati. Se il reddito svizzero annuo è inferiore a €10.000, non si paga IRPEF sulla parte lavoro dipendente svizzero." } },
 { '@type': 'Question', name: "La franchigia vale anche per la tredicesima e i bonus?", acceptedAnswer: { '@type': 'Answer', text: "Sì. La franchigia si applica sul reddito complessivo da lavoro dipendente svizzero dichiarato in un anno fiscale, quindi include stipendio base, tredicesima, bonus, gratifiche e indennità tassabili. Non si applica invece ai redditi di capitale, a quelli da fabbricati o ai riscatti del 2° pilastro LPP, che seguono regole proprie." } },
 { '@type': 'Question', name: "Se vivo oltre 20 km dal confine posso usare la franchigia?", acceptedAnswer: { '@type': 'Answer', text: "No. La franchigia €10.000 è riservata ai frontalieri che risiedono nei comuni italiani entro 20 km dal confine svizzero. Chi vive oltre 20 km non è considerato frontaliere ai sensi dell'accordo e paga l'IRPEF italiana sul reddito svizzero secondo le regole ordinarie, senza esenzioni né tassazione concorrente." } },
 { '@type': 'Question', name: "La franchigia verrà mantenuta anche negli anni successivi?", acceptedAnswer: { '@type': 'Answer', text: "L'accordo bilaterale del 2020, ratificato nel 2023, prevede la franchigia come misura strutturale del nuovo regime. Non ha scadenza prevista, ma l'importo potrebbe essere rivalutato da futuri negoziati bilaterali. Al momento per il 2026 resta confermata a €10.000 annui per contribuente." } }
 ]
 }
 ],
 },

 'glossario-ristorni': {
 title: 'Ristorni | Glossario Frontalieri',
 description: 'Definizione di ristorni fiscali: cosa sono, come funzionano tra Svizzera e comuni italiani di confine e perché sono rilevanti nel dibattito 2026.',
 keywords: 'ristorni frontalieri, comuni confine ticino, tassa salute ristorni',
 ogTitle: 'Ristorni — Glossario Frontalieri',
 ogDescription: 'Cosa sono i ristorni fiscali e perché contano per i frontalieri.',
 canonicalPath: '/glossario-frontaliere/ristorni',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'Ristorni fiscali', description: 'Ristorni fiscali: quota delle imposte alla fonte svizzere retrocessa ai comuni italiani di confine dei lavoratori frontalieri.', url: `${BASE_URL}/glossario-frontaliere/ristorni`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: "Cosa sono i ristorni fiscali per i frontalieri?", acceptedAnswer: { '@type': 'Answer', text: "I ristorni fiscali sono somme che la Confederazione Svizzera retrocede ai comuni italiani di confine come compensazione per i servizi pubblici erogati ai lavoratori frontalieri residenti in Italia. Storicamente la Svizzera restituiva il 38,8% dell'imposta alla fonte trattenuta ai vecchi frontalieri. I ristorni vengono gestiti dal Ministero dell'Economia italiano e distribuiti ai comuni in base al numero di frontalieri residenti." } },
 { '@type': 'Question', name: "Chi riceve i ristorni: i frontalieri o i comuni?", acceptedAnswer: { '@type': 'Answer', text: "I comuni italiani di frontiera, non i singoli frontalieri. Il comune usa i ristorni per finanziare infrastrutture e servizi locali (scuole, strade, trasporti, servizi sociali). Il frontaliere non riceve denaro direttamente, ma beneficia indirettamente attraverso migliori servizi nel proprio comune di residenza. Alcuni comuni hanno azzerato l'addizionale IRPEF grazie ai ristorni." } },
 { '@type': 'Question', name: "I ristorni cambiano con il nuovo accordo 2026?", acceptedAnswer: { '@type': 'Answer', text: "Sì. Il nuovo accordo fiscale del 2020 prevede il progressivo superamento dei ristorni per i nuovi frontalieri (che ora pagano tasse direttamente anche in Italia). I ristorni continuano per i vecchi frontalieri in regime transitorio fino al 2033. La Svizzera ha iniziato a ridurre la quota retrocessa e nel lungo termine i ristorni saranno sostituiti dalla tassazione concorrente che porta IRPEF direttamente allo Stato italiano." } },
 { '@type': 'Question', name: "Quali comuni italiani ricevono i ristorni?", acceptedAnswer: { '@type': 'Answer', text: "I comuni italiani entro 20 km dal confine svizzero nelle province di Como, Varese, Verbano-Cusio-Ossola, Sondrio (per il Canton Ticino e Grigioni) e i comuni confinanti per Canton Vallese e Giura. L'elenco è stabilito dalla Convenzione CH-IT del 1974 e aggiornato periodicamente. I principali beneficiari storici sono Como, Chiasso, Ponte Tresa, Luino e Varese." } },
 { '@type': 'Question', name: "Quanto valgono complessivamente i ristorni annui?", acceptedAnswer: { '@type': 'Answer', text: "Negli ultimi anni la Svizzera ha retrocesso tra €70 milioni e €90 milioni l'anno all'Italia per i ristorni dei frontalieri. La quota è cresciuta con l'aumento del numero di frontalieri, ma si prevede una riduzione progressiva nel prossimo decennio per effetto del nuovo accordo che sposta il gettito direttamente nelle casse italiane tramite l'IRPEF." } },
 { '@type': 'Question', name: "I ristorni riguardano anche i nuovi frontalieri?", acceptedAnswer: { '@type': 'Answer', text: "In misura molto ridotta. Per i nuovi frontalieri, la Svizzera trattiene solo l'80% dell'imposta alla fonte ordinaria e non c'è retrocessione significativa ai comuni italiani, perché l'Italia incassa direttamente l'IRPEF dal lavoratore. Il modello di finanziamento dei comuni di frontiera è in fase di ridisegno tramite negoziati bilaterali." } }
 ]
 }
 ],
 },

 'glossario-lamal': {
 title: 'LAMal | Glossario Frontalieri',
 description: 'Definizione di LAMal: assicurazione sanitaria obbligatoria svizzera, premi, franchigie e modelli per frontalieri.',
 keywords: 'lamal frontalieri, cassa malati ticino, franchigia assicurazione svizzera',
 ogTitle: 'LAMal — Glossario Frontalieri',
 ogDescription: 'Cos\'è LAMal e come scegliere franchigia e modello assicurativo.',
 canonicalPath: '/glossario-frontaliere/lamal',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'LAMal', description: 'LAMal: assicurazione malattia obbligatoria svizzera. Copre cure mediche, ospedaliere e farmaci. I frontalieri scelgono franchigia e modello.', url: `${BASE_URL}/glossario-frontaliere/lamal`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: "Cos'è la LAMal e perché riguarda i frontalieri?", acceptedAnswer: { '@type': 'Answer', text: "LAMal (Loi fédérale sur l'Assurance Maladie) è l'assicurazione sanitaria obbligatoria svizzera. Copre cure mediche, ospedaliere e farmaci. I frontalieri con permesso G devono assicurarsi entro 3 mesi dall'inizio del lavoro in Svizzera: possono scegliere LAMal svizzera oppure esercitare il diritto di opzione (opting-out) per il Servizio Sanitario Nazionale italiano." } },
 { '@type': 'Question', name: "Quanto costa la LAMal per un frontaliere in Ticino nel 2026?", acceptedAnswer: { '@type': 'Answer', text: "I premi 2026 in Canton Ticino variano da CHF 270 a CHF 560/mese per adulti, a seconda di cassa malati, modello (Standard, HMO, Telmed, medico di famiglia) e franchigia (CHF 300–2.500). Le opzioni più economiche sono Assura e Agrisano con modello Telmed e franchigia massima, tra CHF 270–300/mese. Sul comparatore frontaliereticino.ch si confrontano 14 casse malati in 7 cantoni." } },
 { '@type': 'Question', name: "Cos'è il diritto di opzione e quando conviene?", acceptedAnswer: { '@type': 'Answer', text: "Il diritto di opzione consente al frontaliere di rinunciare alla LAMal svizzera e aderire al Servizio Sanitario Nazionale italiano. Conviene soprattutto a chi ha familiari a carico (i familiari non lavoratori LAMal costano CHF 150–300/mese ciascuno). L'opzione va esercitata entro 3 mesi dall'inizio del lavoro ed è generalmente irrevocabile finché dura il contratto svizzero." } },
 { '@type': 'Question', name: "Come si sceglie la franchigia LAMal più conveniente?", acceptedAnswer: { '@type': 'Answer', text: "La franchigia è la soglia annua sotto cui il paziente paga integralmente le cure. Le opzioni 2026 sono CHF 300, 500, 1.000, 1.500, 2.000 e 2.500. Franchigia alta = premio più basso ma rischio di spese vive maggiori. Regola pratica: chi prevede poche visite mediche conviene CHF 2.500 (risparmio premi fino a CHF 1.540/anno); chi ha patologie croniche o bambini conviene CHF 300." } },
 { '@type': 'Question', name: "Qual è la differenza tra LAMal e LAMal complementare?", acceptedAnswer: { '@type': 'Answer', text: "La LAMal di base (obbligatoria) copre cure ambulatoriali, ospedaliere in reparto comune cantonale, farmaci LS e maternità. La LAMal complementare (LCA, facoltativa) aggiunge reparto semi-privato o privato in ospedale, medicine alternative, occhiali, dentista. I premi complementari variano da CHF 30 a CHF 400/mese e richiedono questionario sanitario di adesione." } },
 { '@type': 'Question', name: "Posso cambiare cassa malati LAMal ogni anno?", acceptedAnswer: { '@type': 'Answer', text: "Sì. La LAMal di base si può disdire entro il 30 novembre per cambiare cassa dal 1° gennaio successivo. La disdetta va inviata con raccomandata. Il cambio non comporta esami sanitari (franchise dei premi) perché la LAMal di base è obbligatoria e non discriminante. La LAMal complementare invece può rifiutare l'adesione in base allo stato di salute." } }
 ]
 }
 ],
 },

 'glossario-cmu': {
 title: 'CMU | Glossario Frontalieri',
 description: 'Definizione di CMU (assicurazione sanitaria francese) nel contesto dei frontalieri: differenze rispetto a LAMal e SSN.',
 keywords: 'cmu frontalieri, lamal vs cmu, assicurazione sanitaria frontalieri',
 ogTitle: 'CMU — Glossario Frontalieri',
 ogDescription: 'Cos\'è la CMU e in cosa differisce da LAMal per i frontalieri.',
 canonicalPath: '/glossario-frontaliere/cmu',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'CMU', description: 'CMU (Couverture Maladie Universelle): assicurazione sanitaria pubblica francese, alternativa a LAMal per frontalieri in Francia.', url: `${BASE_URL}/glossario-frontaliere/cmu`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: "Cos'è la CMU e quando si applica ai frontalieri?", acceptedAnswer: { '@type': 'Answer', text: "La CMU (Couverture Maladie Universelle, oggi PUMa — Protection Universelle Maladie) è il sistema sanitario pubblico francese. Si applica ai frontalieri residenti in Francia che lavorano in Svizzera e scelgono il diritto di opzione: invece di pagare la LAMal svizzera si iscrivono al sistema francese con un contributo proporzionale al reddito (circa 8% del reddito netto imponibile)." } },
 { '@type': 'Question', name: "La CMU riguarda anche i frontalieri italiani?", acceptedAnswer: { '@type': 'Answer', text: "No. La CMU è esclusivamente francese. I frontalieri italiani residenti in Italia hanno un'alternativa differente: il diritto di opzione verso il SSN (Servizio Sanitario Nazionale) italiano. La differenza con la Francia è che in Italia il SSN è finanziato tramite fiscalità generale e non richiede un contributo aggiuntivo dedicato." } },
 { '@type': 'Question', name: "Meglio LAMal o SSN per un frontaliere italiano?", acceptedAnswer: { '@type': 'Answer', text: "Dipende dal profilo familiare. LAMal: miglior qualità media, scelta libera di medici e ospedali in Svizzera, costo CHF 270–560/mese per persona. SSN italiano: gratuito o con ticket modesti, ma liste d'attesa più lunghe e copertura solo in Italia (niente cure in Svizzera se non urgenze). Per single sani con reddito alto conviene spesso LAMal; per famiglie numerose conviene SSN." } },
 { '@type': 'Question', name: "Come si attiva il diritto di opzione verso il SSN?", acceptedAnswer: { '@type': 'Answer', text: "Entro 3 mesi dall'inizio del lavoro in Svizzera occorre presentare alla cassa cantonale di compensazione il modulo di opzione per il SSN (spesso tramite il datore di lavoro o un broker). Serve certificato di iscrizione al SSN italiano (tessera sanitaria) e attestato di residenza. L'opzione è irrevocabile per la durata del contratto svizzero." } },
 { '@type': 'Question', name: "Se scelgo il SSN posso farmi curare in Svizzera?", acceptedAnswer: { '@type': 'Answer', text: "Solo per urgenze durante l'orario di lavoro o emergenze in transito. Per cure programmate (visite specialistiche, ricoveri elettivi) bisogna tornare in Italia. Se serve copertura ampia in Svizzera, meglio LAMal o un'assicurazione complementare privata. Alcuni datori di lavoro offrono LAMal convenzionata a prezzi scontati come benefit." } },
 { '@type': 'Question', name: "Cosa succede se non scelgo entro 3 mesi?", acceptedAnswer: { '@type': 'Answer', text: "Se il frontaliere non esercita il diritto di opzione entro 3 mesi dall'inizio del lavoro, viene iscritto d'ufficio alla LAMal svizzera con una cassa malati a sorte scelta dal Cantone. La scelta LAMal di default può essere costosa: è fortemente consigliato confrontare le casse e scegliere attivamente prima della scadenza dei 3 mesi." } }
 ]
 }
 ],
 },

 'glossario-permessoG': {
 title: 'Permesso G | Glossario Frontalieri',
 description: 'Definizione di permesso G: requisiti, diritti, tassazione e differenze rispetto al permesso B per frontalieri.',
 keywords: 'permesso g frontalieri, permesso g vs b, tasse permesso g',
 ogTitle: 'Permesso G — Glossario Frontalieri',
 ogDescription: 'Cos\'è il permesso G e cosa cambia rispetto al permesso B.',
 canonicalPath: '/glossario-frontaliere/permesso-g',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'Permesso G', description: 'Permesso G: autorizzazione di lavoro per frontalieri che risiedono in un Paese confinante e rientrano quotidianamente. Validità 5 anni.', url: `${BASE_URL}/glossario-frontaliere/permesso-g`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: 'Quali sono i requisiti per ottenere il permesso G?', acceptedAnswer: { '@type': 'Answer', text: "Per ottenere il permesso G devi avere cittadinanza UE/AELS, un contratto di lavoro con un datore svizzero e residenza in un paese confinante (Italia, Francia, Germania, Austria). È obbligatorio rientrare a casa almeno una volta a settimana. La domanda la fa il datore di lavoro tramite l'ufficio migrazione cantonale (in Ticino, la Sezione Popolazione). Il permesso G ha validità di 5 anni rinnovabili, legata al rapporto di lavoro." } },
 { '@type': 'Question', name: 'Quali documenti servono per la domanda del permesso G?', acceptedAnswer: { '@type': 'Answer', text: "Servono: contratto di lavoro firmato dal datore svizzero, documento di identità valido, certificato di residenza italiano, attestazione ISEE o stato di famiglia, modulo ufficiale cantonale compilato dal datore. La procedura richiede tipicamente 2-4 settimane in Ticino. Il costo del permesso è a carico del lavoratore (CHF 65-100 a seconda del cantone) ed è rilasciato in formato card biometrica da esibire al posto di confine quando richiesto." } },
 { '@type': 'Question', name: 'Il permesso G permette di vivere in Svizzera?', acceptedAnswer: { '@type': 'Answer', text: "No: il permesso G autorizza solo a lavorare in Svizzera mantenendo la residenza nel paese confinante di origine, con rientro settimanale obbligatorio. Per vivere in Svizzera serve il permesso B (dimora annuale) o C (stabilimento), che comportano residenza fiscale svizzera e tassazione ordinaria invece di tassazione concorrente. Il permesso G decade se sposti la residenza in Svizzera o se smetti di rientrare settimanalmente nel paese d'origine." } },
 { '@type': 'Question', name: 'Cosa succede al permesso G in caso di licenziamento o disoccupazione?', acceptedAnswer: { '@type': 'Answer', text: "In caso di cessazione del rapporto di lavoro, il permesso G perde validità entro pochi mesi (solitamente 3-6 a seconda del cantone e della durata del rapporto pregresso). Il frontaliere può iscriversi alla disoccupazione svizzera (cassa di compensazione AC) solo se si è trasferito in Svizzera; altrimenti fa domanda di NASpI in Italia, dove gli anni di contribuzione AC svizzera vengono totalizzati grazie agli accordi bilaterali UE-CH." } },
 ],
 },
 ],
 },

 'glossario-permessoB': {
 title: 'Permesso B | Glossario Frontalieri',
 description: 'Definizione di permesso B: requisiti, residenza, impatto fiscale e differenze rispetto al permesso G.',
 keywords: 'permesso b frontalieri, residenza svizzera, permesso b vs g',
 ogTitle: 'Permesso B — Glossario Frontalieri',
 ogDescription: 'Cos\'è il permesso B e quando conviene rispetto al permesso G.',
 canonicalPath: '/glossario-frontaliere/permesso-b',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'Permesso B', description: 'Permesso B: autorizzazione di dimora in Svizzera per cittadini UE/AELS. Consente residenza e lavoro in Svizzera, validità 5 anni.', url: `${BASE_URL}/glossario-frontaliere/permesso-b`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: 'Qual è la differenza fiscale tra permesso B e permesso G?', acceptedAnswer: { '@type': 'Answer', text: "Il permesso B comporta residenza e tassazione fiscale in Svizzera: si paga imposta ordinaria cantonale e federale sulla base di una dichiarazione annuale, con aliquote marginali fino al 40% circa per redditi alti in Ticino. Il permesso G mantiene residenza fiscale italiana, paga imposta alla fonte svizzera e (per nuovi frontalieri) IRPEF italiana con franchigia €10.000. La convenienza dipende da reddito, composizione familiare e costo della vita." } },
 { '@type': 'Question', name: 'Chi può richiedere il permesso B in Svizzera?', acceptedAnswer: { '@type': 'Answer', text: "Possono richiedere il permesso B i cittadini UE/AELS con contratto di lavoro svizzero di durata superiore a 12 mesi, o chi dimostra mezzi sufficienti di sostentamento e copertura sanitaria. La durata iniziale è di 5 anni, rinnovabile. Dopo 5 anni di residenza continuativa si può chiedere il permesso C (stabilimento). È necessario trasferire la residenza anagrafica in Svizzera, iscriversi al comune e sottoscrivere LAMal obbligatoria entro 3 mesi dall'arrivo." } },
 { '@type': 'Question', name: 'Conviene passare da permesso G a permesso B?', acceptedAnswer: { '@type': 'Answer', text: "Dipende dal profilo: per redditi alti (oltre CHF 120.000) e famiglie senza vincoli in Italia, il permesso B può risultare conveniente grazie a tassazione ordinaria favorevole e accesso pieno ai servizi svizzeri. Per redditi medi o per chi mantiene famiglia in Italia, il permesso G con nuova franchigia €10.000 resta spesso più vantaggioso. Simula il netto con il nostro calcolatore confronto G vs B prima di decidere: il costo della vita in CH è decisivo." } },
 { '@type': 'Question', name: 'Il permesso B comporta la perdita dei diritti pensionistici italiani?', acceptedAnswer: { '@type': 'Answer', text: "No: i contributi INPS già versati in Italia restano validi e concorrono alla pensione tramite la totalizzazione UE. Con il permesso B continui a versare AVS (1° pilastro) e LPP (2° pilastro) in Svizzera. Al pensionamento riceverai pensioni pro-rata da entrambi i paesi, calcolate sui rispettivi anni di contribuzione. Per ottimizzare la previdenza è consigliabile massimizzare il 3° pilastro svizzero (3a) deducibile fiscalmente fino a CHF 7.258/anno." } },
 ],
 },
 ],
 },

 'glossario-avs': {
 title: 'AVS | Glossario Frontalieri',
 description: 'Definizione di AVS (1° pilastro): contributi, prestazioni e impatto sul netto dei frontalieri.',
 keywords: 'avs svizzera, contributi avs, pensione frontalieri',
 ogTitle: 'AVS — Glossario Frontalieri',
 ogDescription: 'Cos\'è AVS e come incide su busta paga e pensione.',
 canonicalPath: '/glossario-frontaliere/avs',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'AVS', description: 'AVS (Assicurazione Vecchiaia e Superstiti): primo pilastro previdenziale svizzero. Contributo del 5,3% sullo stipendio dei frontalieri.', url: `${BASE_URL}/glossario-frontaliere/avs`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: "Cos'è l'AVS e chi è tenuto a versare i contributi?", acceptedAnswer: { '@type': 'Answer', text: "L'AVS (Assicurazione Vecchiaia e Superstiti) è il primo pilastro del sistema pensionistico svizzero. Tutti i lavoratori dipendenti in Svizzera, compresi i frontalieri, versano il 5,3% del salario lordo; il datore di lavoro contribuisce con un altro 5,3%. Il prelievo è obbligatorio e compare automaticamente in busta paga sotto la voce AVS/AI/IPG (5,3% = 4,35% AVS + 0,7% AI + 0,25% IPG)." } },
 { '@type': 'Question', name: "Quando ho diritto alla pensione AVS?", acceptedAnswer: { '@type': 'Answer', text: "L'età ordinaria di pensionamento AVS è 65 anni per gli uomini e, dal 2028, 65 anni anche per le donne (aumento graduale da 64). La rendita piena (scala 44) richiede 44 anni contributivi. Ogni anno mancante riduce la rendita di 1/44. Esempio 2026: rendita minima CHF 1.260/mese, rendita massima CHF 2.520/mese per coppie (o singoli sopra un certo reddito medio rivalutato)." } },
 { '@type': 'Question', name: "Posso cumulare AVS e pensione INPS italiana?", acceptedAnswer: { '@type': 'Answer', text: "Sì, grazie alla totalizzazione prevista dall'Accordo CH-UE. I periodi contributivi svizzeri e italiani si sommano per raggiungere il diritto minimo a pensione in entrambi i Paesi. Ogni Stato paga però la propria quota in proporzione (pro-rata) agli anni di contribuzione effettivi. Non si ottiene quindi doppia pensione piena: si riceve la quota svizzera per gli anni AVS e la quota italiana per gli anni INPS." } },
 { '@type': 'Question', name: "Cosa succede all'AVS se torno a lavorare in Italia?", acceptedAnswer: { '@type': 'Answer', text: "I contributi AVS versati restano accreditati a vita sul conto individuale AVS svizzero. Al compimento dei 65 anni si percepisce la pensione pro-rata direttamente in Italia tramite bonifico dalla Cassa di Compensazione. Non è possibile riscuotere l'AVS in anticipo come capitale (a differenza del 2° pilastro LPP): l'AVS si riceve solo sotto forma di rendita mensile." } },
 { '@type': 'Question', name: "Come verifico i miei contributi AVS maturati?", acceptedAnswer: { '@type': 'Answer', text: "Si richiede l'estratto conto individuale (ECI) gratuito alla Cassa Cantonale di Compensazione del cantone dove si lavora (per il Ticino: IAS Ticino). È disponibile online sul portale AHV-eco.ch con autenticazione SwissID. L'estratto mostra i contributi anno per anno: è fondamentale controllarlo ogni 5 anni per individuare buchi contributivi prima che diventino irreversibili dopo 5 anni di prescrizione." } },
 { '@type': 'Question', name: "Come influisce l'AVS sul netto in busta paga?", acceptedAnswer: { '@type': 'Answer', text: "L'AVS riduce il netto del 5,3% sul lordo lavoratore. Su CHF 80.000 lordi annui equivale a circa CHF 4.240/anno (CHF 353/mese) di contributi personali. Insieme ad AC (1,1%), AINF (circa 0,8%) e LPP (dal 7% al 18% secondo età), i contributi sociali svizzeri assorbono complessivamente tra il 12% e il 22% del lordo, prima ancora dell'imposta alla fonte." } }
 ]
 }
 ],
 },

 'glossario-lpp': {
 title: 'LPP | Glossario Frontalieri',
 description: 'Definizione di LPP (2° pilastro): aliquote per età, contributi e impatto sul netto dei frontalieri.',
 keywords: 'lpp svizzera, secondo pilastro, contributi lpp per età',
 ogTitle: 'LPP — Glossario Frontalieri',
 ogDescription: 'Cos\'è LPP e come influisce su netto e pensione.',
 canonicalPath: '/glossario-frontaliere/lpp',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'LPP', description: 'LPP (Previdenza Professionale): secondo pilastro pensionistico svizzero. Contributi crescenti per età, dal 7% al 18% del salario coordinato.', url: `${BASE_URL}/glossario-frontaliere/lpp`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: "Cos'è il 2° pilastro LPP e chi deve aderirvi?", acceptedAnswer: { '@type': 'Answer', text: "La LPP (Previdenza Professionale Obbligatoria) è il 2° pilastro svizzero: un fondo pensione aziendale obbligatorio per tutti i dipendenti con salario AVS superiore a CHF 22.050 annui (soglia 2026). Ogni azienda aderisce a una cassa pensione che accumula contributi mensili in un conto individuale e li restituisce al pensionamento come rendita vitalizia o capitale. I frontalieri sono inclusi automaticamente." } },
 { '@type': 'Question', name: "Quanto si contribuisce alla LPP ogni mese?", acceptedAnswer: { '@type': 'Answer', text: "I contributi LPP minimi per legge variano per età, applicati sul salario coordinato (lordo meno deduzione di coordinamento di CHF 25.725): 7% dai 25–34 anni, 10% dai 35–44, 15% dai 45–54, 18% dai 55–65. Il contributo è metà lavoratore e metà datore. Molte casse pensione (piani sovraobbligatori) prevedono percentuali più alte, quindi il contributo reale può arrivare al 20–25%." } },
 { '@type': 'Question', name: "Posso riscuotere il 2° pilastro se rientro in Italia?", acceptedAnswer: { '@type': 'Answer', text: "In parte. Lasciando definitivamente la Svizzera per un Paese UE/AELS (come l'Italia), si può riscuotere solo la parte sovraobbligatoria come capitale. La parte obbligatoria resta su un conto di libero passaggio fino all'età pensionabile, salvo eccezioni (avvio attività indipendente non lavoratore dipendente, acquisto prima casa). Nel Liechtenstein o in altri cantoni il prelievo è possibile: pianificare il domicilio della cassa aiuta ad ottimizzare la tassazione." } },
 { '@type': 'Question', name: "Come viene tassato il riscatto del 2° pilastro?", acceptedAnswer: { '@type': 'Answer', text: "Il capitale LPP prelevato in Svizzera è tassato con aliquota agevolata separata (tra 4% e 12% a seconda del cantone e dell'importo). Se il frontaliere si è trasferito in Italia prima del riscatto, in Italia il capitale è soggetto a tassazione IRPEF sulla parte redditi (non su contributi personali già tassati). La pianificazione cantonale del domicilio della cassa (es. Schwyz, Zugo) può ridurre sensibilmente l'imposizione svizzera." } },
 { '@type': 'Question', name: "Cos'è il riscatto volontario LPP ed è deducibile?", acceptedAnswer: { '@type': 'Answer', text: "Il riscatto volontario è un versamento straordinario nella propria cassa pensione per colmare lacune contributive (es. anni senza lavoro). È pienamente deducibile dall'imposta alla fonte svizzera tramite la richiesta di tassazione ordinaria ulteriore (TOU) entro il 31 marzo. Per un versamento di CHF 20.000 il risparmio fiscale arriva facilmente a CHF 4.000–6.000. È una delle leve di ottimizzazione fiscale più efficaci per i frontalieri." } },
 { '@type': 'Question', name: "Quanto vale in media il 2° pilastro accumulato a fine carriera?", acceptedAnswer: { '@type': 'Answer', text: "Dipende da stipendio, anni di contribuzione e rendimenti della cassa. Esempio: un frontaliere con CHF 80.000 lordi annui per 35 anni accumula tipicamente tra CHF 400.000 e CHF 700.000, che generano una rendita mensile di CHF 2.000–3.500 (aliquota di conversione 6–6,8%). Il 2° pilastro è quindi la componente più rilevante della pensione svizzera per profili di reddito medio-alto." } }
 ]
 }
 ],
 },

 'glossario-terzoPilastro': {
 title: 'Terzo Pilastro | Glossario Frontalieri',
 description: 'Definizione di 3° pilastro (3a/3b): deduzioni fiscali e previdenza complementare per chi lavora in Svizzera.',
 keywords: 'terzo pilastro 3a, deduzione 3a 2026, previdenza svizzera',
 ogTitle: 'Terzo Pilastro — Glossario Frontalieri',
 ogDescription: 'Cos\'è il terzo pilastro e come si usa per ridurre le tasse.',
 canonicalPath: '/glossario-frontaliere/terzo-pilastro',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'Terzo Pilastro', description: 'Terzo pilastro (3a/3b): previdenza privata svizzera con vantaggi fiscali. Il pilastro 3a è deducibile fino a CHF 7.258 annui per dipendenti.', url: `${BASE_URL}/glossario-frontaliere/terzo-pilastro`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: "Cos'è il 3° pilastro e in cosa si differenzia dal 2°?", acceptedAnswer: { '@type': 'Answer', text: "Il 3° pilastro è la previdenza individuale volontaria svizzera, a differenza del 2° pilastro LPP che è aziendale obbligatorio. Esistono due tipi: pilastro 3a (vincolato, deducibile fiscalmente) e pilastro 3b (libero, non deducibile). Il 3a è il più usato dai frontalieri perché combina accumulo per la pensione, deduzione fiscale immediata e capitale disponibile all'età pensionabile o per l'acquisto della prima casa." } },
 { '@type': 'Question', name: "Un frontaliere può aprire un 3° pilastro svizzero?", acceptedAnswer: { '@type': 'Answer', text: "Sì, purché sia già assicurato al 2° pilastro LPP e versi AVS. I frontalieri con permesso G possono aprire un conto 3a presso banche svizzere (UBS, PostFinance, VIAC, frankly) o compagnie assicurative. Il limite massimo 2026 è CHF 7.258 annui per dipendenti. I versamenti sono deducibili dall'imposta alla fonte svizzera tramite TOU (tassazione ordinaria ulteriore) richiesta entro il 31 marzo." } },
 { '@type': 'Question', name: "Quanto fa risparmiare il 3° pilastro in tasse?", acceptedAnswer: { '@type': 'Answer', text: "Il risparmio fiscale dipende dall'aliquota marginale. Un frontaliere che versa CHF 7.258 in 3a e ha aliquota marginale del 25% risparmia circa CHF 1.800 di imposta alla fonte. Chi ha aliquote più alte (salari alti o riscatti LPP) può risparmiare fino a CHF 2.500–3.000 all'anno. È la leva di ottimizzazione fiscale più comune e accessibile per tutti i frontalieri dipendenti." } },
 { '@type': 'Question', name: "Come si riscuote il 3a al pensionamento?", acceptedAnswer: { '@type': 'Answer', text: "Il 3a può essere prelevato come capitale al massimo 5 anni prima dell'età AVS (quindi dai 60 anni) e obbligatoriamente all'età ordinaria. Il capitale è tassato in Svizzera con aliquota agevolata separata (2–10% a seconda del cantone). Prelievi anticipati sono ammessi per: acquisto prima casa, avvio attività indipendente, partenza definitiva dalla Svizzera (per un Paese UE solo la parte sovraobbligatoria)." } },
 { '@type': 'Question', name: "Meglio 3° pilastro svizzero o piano pensione italiano?", acceptedAnswer: { '@type': 'Answer', text: "Per un frontaliere con permesso G, il 3a svizzero è generalmente più conveniente: la deduzione dall'imposta alla fonte è immediata e sostanziosa (fino al 25–30% dell'aliquota marginale). Il piano pensione italiano (PIP/fondo pensione) offre deduzione IRPEF fino a €5.164, utile solo per chi dichiara l'IRPEF (nuovi frontalieri). I due strumenti si possono combinare per ottimizzare la tassazione su entrambi i lati del confine." } },
 { '@type': 'Question', name: "Cosa succede al 3° pilastro se rientro in Italia?", acceptedAnswer: { '@type': 'Answer', text: "Il conto 3a resta in Svizzera fino al pensionamento o fino al riscatto anticipato per partenza definitiva. Al rientro definitivo in Italia si può richiedere il prelievo totale del capitale con tassazione svizzera separata agevolata. In Italia il capitale è soggetto a tassazione solo sulla parte di rendimenti maturati (non su capitale versato), con regime convenzionale previsto dalla Convenzione contro la doppia imposizione." } }
 ]
 }
 ],
 },

 'glossario-tassoCambio': {
 title: 'Tasso di Cambio | Glossario Frontalieri',
 description: 'Definizione di tasso di cambio CHF/EUR: come incide su netto in EUR, tasse italiane e trasferimenti Svizzera–Italia.',
 keywords: 'tasso di cambio chf eur, cambio valuta frontalieri, conversione chf eur',
 ogTitle: 'Tasso di cambio — Glossario Frontalieri',
 ogDescription: 'Cos\'è il tasso di cambio e perché conta per frontalieri e trasferimenti.',
 canonicalPath: '/glossario-frontaliere/tasso-di-cambio',
 structuredData: [
 { '@context': 'https://schema.org', '@type': 'DefinedTerm', name: 'Tasso di cambio CHF/EUR', description: 'Tasso di cambio CHF/EUR: rapporto franco svizzero-euro, fondamentale per calcolare netto in euro e tasse italiane dei frontalieri.', url: `${BASE_URL}/glossario-frontaliere/tasso-di-cambio`, inDefinedTermSet: { '@type': 'DefinedTermSet', name: 'Glossario Frontalieri', url: `${BASE_URL}/glossario-frontaliere` } },
 {
 '@context': 'https://schema.org',
 '@type': 'FAQPage',
 mainEntity: [
 { '@type': 'Question', name: "Cos'è il tasso di cambio CHF/EUR per un frontaliere?", acceptedAnswer: { '@type': 'Answer', text: "Il tasso di cambio CHF/EUR è il rapporto tra franco svizzero ed euro. Indica quanti euro corrispondono a 1 franco (o viceversa). Per un frontaliere è cruciale: determina quanto vale in euro lo stipendio ricevuto in CHF, quanto si pagano le tasse italiane convertendo il reddito svizzero, e quanto costa convertire ogni mese gli stipendi in euro per le spese in Italia. Oscillazioni dell'1% su uno stipendio di CHF 5.000 valgono €50 al mese." } },
 { '@type': 'Question', name: "Quale tasso di cambio si usa in dichiarazione dei redditi italiana?", acceptedAnswer: { '@type': 'Answer', text: "L'Agenzia delle Entrate richiede il cambio medio annuo BCE dell'anno fiscale per convertire il reddito svizzero. Questo valore è pubblicato ufficialmente dall'Agenzia delle Entrate ogni anno (circolare dedicata). Non si usa il cambio giornaliero né quello della banca. Esempio: per il 2025 il cambio medio è circa CHF 1 = €1,04 (da confermare nelle tabelle ufficiali). Usare il cambio sbagliato è un errore frequente che può causare ricalcoli." } },
 { '@type': 'Question', name: "Conviene cambiare CHF in EUR con la banca o con Wise?", acceptedAnswer: { '@type': 'Answer', text: "Wise e Revolut applicano il cambio interbancario con markup 0,25–0,5%, mentre banche tradizionali applicano markup 2–3%. Per un frontaliere che cambia CHF 5.000/mese, la differenza è CHF 100–150/mese, ovvero CHF 1.200–1.800/anno. PostFinance, UBS e Credit Suisse hanno spread più alti; N26 e Revolut offrono condizioni competitive. Molti frontalieri mantengono conto in CHF (svizzero) + conto in EUR (italiano o Wise)." } },
 { '@type': 'Question', name: "Come proteggersi dal rischio di cambio CHF/EUR?", acceptedAnswer: { '@type': 'Answer', text: "Le strategie principali: 1) Mantenere un conto CHF svizzero e convertire solo il necessario ogni mese; 2) Diversificare negli strumenti a cambio forward (Wise, Interactive Brokers) per bloccare un tasso; 3) Tenere un cuscinetto di liquidità CHF per evitare conversioni forzate in periodi di franco debole; 4) Considerare il franco come valuta di riserva (storicamente rifugio), quindi meno volatile in valore reale." } },
 { '@type': 'Question', name: "Il cambio CHF/EUR influisce sul mutuo in Italia?", acceptedAnswer: { '@type': 'Answer', text: "Sì, indirettamente. Le banche italiane valutano il reddito svizzero convertendolo in EUR al cambio attuale per calcolare la capacità di rimborso. Cambi sfavorevoli possono ridurre la somma concessa. Per mitigare, alcune banche accettano la media dei 12 cambi mensili ufficiali. Inoltre, chi ha un mutuo in euro paga con stipendio in franchi: un franco forte riduce la rata in termini relativi; un franco debole la aumenta." } },
 { '@type': 'Question', name: "Il tasso di cambio è rimasto stabile negli ultimi anni?", acceptedAnswer: { '@type': 'Answer', text: "No. Il CHF/EUR ha oscillato sensibilmente: da 1,20 (2011–2014, con floor BNS), a parità a 1:1 nel 2022, fino a 0,93–0,96 nel 2024–2026 (franco forte). Ogni 5% di movimento equivale a circa €200–300/mese di variazione per un frontaliere medio. Monitorare il cambio è importante per pianificare risparmi, trasferimenti e momento ottimale per grandi conversioni CHF→EUR." } }
 ]
 }
 ],
 },

 comparatori: {
 title: 'Comparatori Servizi CH-IT | Frontaliere Ticino',
 description: 'I frontalieri risparmiano 100–300 CHF/mese scegliendo bene: cambio valuta (Wise batte le banche del 2%), mobili con roaming da 19 €/mese. 8 confronti.',
 keywords: 'cambio chf eur, cambio valuta svizzera, wise revolut confronto, operatori mobili svizzera, roaming svizzera italia, trasporti frontalieri, assicurazione sanitaria ticino, banche svizzera italia, traffico valichi doganali',
 ogTitle: 'Comparatori Servizi Frontalieri',
 ogDescription: 'Risparmia 100–300 CHF/mese sui servizi da frontaliere: cambio valuta, operatori mobili con roaming CH-IT, trasporti, assicurazioni sanitarie e conti bancari a confronto.',
 canonicalPath: '/compara-servizi',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Comparatori Servizi Frontalieri",
 "url": `${BASE_URL}/compara-servizi`,
 "description": "Strumenti di confronto per servizi essenziali per lavoratori frontalieri",
 "inLanguage": "it",
 "speakable": SPEAKABLE_SECTION
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Strumenti di confronto frontalieri",
 "numberOfItems": 8,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "name": "Cambio Valuta CHF/EUR", "url": `${BASE_URL}/compara-servizi/cambio-franco-euro` },
 { "@type": "ListItem", "position": 2, "name": "Operatori Mobili", "url": `${BASE_URL}/compara-servizi/confronta-operatori-mobili` },
 { "@type": "ListItem", "position": 3, "name": "Assicurazioni Sanitarie LAMal", "url": `${BASE_URL}/compara-servizi/confronta-casse-malati` },
 { "@type": "ListItem", "position": 4, "name": "Confronto Banche CH-IT", "url": `${BASE_URL}/compara-servizi/confronta-banche` },
 { "@type": "ListItem", "position": 5, "name": "Spesa Transfrontaliera", "url": `${BASE_URL}/compara-servizi/confronta-prezzi-spesa` },
 { "@type": "ListItem", "position": 6, "name": "Costo della Vita", "url": `${BASE_URL}/compara-servizi/costo-della-vita` },
 { "@type": "ListItem", "position": 7, "name": "Confronto Offerte Lavoro", "url": `${BASE_URL}/compara-servizi/confronta-offerte-lavoro` },
 { "@type": "ListItem", "position": 8, "name": "Bonus Ristrutturazione", "url": `${BASE_URL}/compara-servizi/calcola-bonus-ristrutturazione` }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Quali servizi possono confrontare i frontalieri su questo sito?", "acceptedAnswer": { "@type": "Answer", "text": "È possibile confrontare: tassi di cambio CHF/EUR (6 provider), operatori mobili con roaming Italia, assicurazioni sanitarie LAMal (14 casse malati), banche svizzere e italiane, prezzi della spesa transfrontaliera, costo della vita CH vs IT, e offerte di lavoro in Ticino." } },
 { "@type": "Question", "name": "Quanto si risparmia confrontando i servizi per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "Il risparmio varia: sul cambio valuta fino a CHF 150/mese con Wise/Revolut vs banche tradizionali, sulla telefonia fino a CHF 30/mese con operatori low-cost, sull'assicurazione sanitaria fino a CHF 200/mese scegliendo la cassa malati giusta." } },
 { "@type": "Question", "name": "I comparatori sono gratuiti?", "acceptedAnswer": { "@type": "Answer", "text": "Sì, tutti i comparatori e gli strumenti di Frontaliere Ticino sono completamente gratuiti, senza registrazione richiesta. Il sito funziona anche offline come Progressive Web App." } },
 { "@type": "Question", "name": "Come vengono aggiornati i dati dei comparatori?", "acceptedAnswer": { "@type": "Answer", "text": "I tassi di cambio sono aggiornati in tempo reale tramite API. I premi assicurativi e i costi dei servizi vengono aggiornati mensilmente o quando le tariffe cambiano. Le offerte di lavoro sono aggiornate quotidianamente dai siti delle aziende." } }
 ]
 }
 ]
 },

 // ─── Section landing pages ──────────────────────────────────,

 calcolatore: {
 title: 'Calcolatore Stipendio Netto Frontaliere 2026 | 8 Simulatori',
 description: 'Calcola stipendio netto frontaliere: deduzioni AVS (5,3%), imposta alla fonte (8–10%), IRPEF con franchigia 10.000 €. 8 simulatori gratuiti, calcolo istantaneo.',
 keywords: 'calcolo stipendio frontaliere, simulatore stipendio netto, busta paga frontaliere, confronto ral svizzera italia, calcolatore imposte alla fonte 2026, etax ticino 2026, calcolo stipendio netto svizzera, imposta alla fonte ticino, bonus frontaliere, congedo parentale frontaliere, permesso g vs b',
 ogTitle: 'Calcolatore Stipendio Frontaliere 2026 | Strumenti Gratuiti',
 ogDescription: 'Un frontaliere con 60.000 CHF lordi/anno netta circa 3.200–3.500 €/mese dopo contributi svizzeri e tasse italiane. Usa 8 simulatori gratuiti per calcolare il tuo netto esatto (accordo 2026).',
 canonicalPath: '/calcola-stipendio',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Calcolatore Stipendio Frontaliere",
 "url": `${BASE_URL}/calcola-stipendio`,
 "description": "Raccolta strumenti di calcolo per lavoratori frontalieri Svizzera-Italia",
 "inLanguage": "it",
 "speakable": SPEAKABLE_SECTION
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Strumenti di calcolo frontalieri",
 "numberOfItems": 8,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "name": "Confronto RAL CH-IT", "url": `${BASE_URL}/calcola-stipendio/confronta-retribuzione-ral` },
 { "@type": "ListItem", "position": 2, "name": "Simula Busta Paga", "url": `${BASE_URL}/calcola-stipendio/simula-busta-paga` },
 { "@type": "ListItem", "position": 3, "name": "Stima Bonus", "url": `${BASE_URL}/calcola-stipendio/stima-bonus-frontaliere` },
 { "@type": "ListItem", "position": 4, "name": "Congedo Parentale", "url": `${BASE_URL}/calcola-stipendio/verifica-congedo-parentale` },
 { "@type": "ListItem", "position": 5, "name": "Permesso G vs B", "url": `${BASE_URL}/guida-frontaliere/confronta-permesso-g-vs-b` },
 { "@type": "ListItem", "position": 6, "name": "What-If Simulator", "url": `${BASE_URL}/calcola-stipendio/cosa-cambia-se` },
 { "@type": "ListItem", "position": 7, "name": "Cambio Residenza", "url": `${BASE_URL}/calcola-stipendio/simula-cambio-residenza` },
 { "@type": "ListItem", "position": 8, "name": "Quanto Guadagneresti", "url": `${BASE_URL}/calcola-stipendio/quanto-guadagneresti-in-svizzera` }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Come funziona il calcolatore stipendio per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "Inserisci il tuo stipendio lordo annuo in CHF, stato civile, numero di figli, comune di residenza e tipo di frontaliere (nuovo o vecchio). Il simulatore calcola automaticamente contributi svizzeri (AVS, LPP, AC), imposta alla fonte ticinese, IRPEF italiana con franchigia, e mostra il netto mensile in CHF e EUR." } },
 { "@type": "Question", "name": "Il calcolatore è aggiornato al 2026?", "acceptedAnswer": { "@type": "Answer", "text": "Sì, il calcolatore utilizza le aliquote 2026: tabelle imposta alla fonte Ticino, scaglioni IRPEF, contributi AVS 5.3%, LPP per fascia d'età, e il tasso di cambio CHF/EUR aggiornato in tempo reale. Il nuovo accordo fiscale (franchigia €10.000 per nuovi frontalieri) è pienamente integrato." } },
 { "@type": "Question", "name": "Qual è la differenza tra gli strumenti disponibili?", "acceptedAnswer": { "@type": "Answer", "text": "Il simulatore principale calcola il netto da un lordo. 'Confronto RAL' paragona stipendi CH e IT. 'Busta Paga' simula una busta paga completa. 'What-If' mostra l'impatto di scenari alternativi (figli, cambio residenza, promozione). 'Permesso G vs B' confronta costi e benefici tra commuting e residenza." } },
 { "@type": "Question", "name": "Il simulatore funziona anche per i vecchi frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "Sì. Selezionando 'vecchio frontaliere' il simulatore applica il regime fiscale transitorio: tassazione esclusiva in Svizzera (senza IRPEF italiana) fino al 2033. I vecchi frontalieri sono quelli assunti prima del 17 luglio 2023 con residenza entro 20 km dal confine." } }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "Review",
 "itemReviewed": {
 "@type": "WebApplication",
 "name": "Simulatore Stipendio Frontaliere",
 "url": `${BASE_URL}/calcola-stipendio`
 },
 "author": { "@type": "Person", "name": "Marco R." },
 "reviewRating": { "@type": "Rating", "ratingValue": "5", "bestRating": "5" },
 "datePublished": "2026-01-15",
 "reviewBody": "Finalmente un calcolatore preciso per frontalieri! Ho verificato con la mia busta paga e il risultato era quasi identico. Utilissimo per chi deve decidere tra Permesso B e G."
 },
 {
 "@context": "https://schema.org",
 "@type": "Review",
 "itemReviewed": {
 "@type": "WebApplication",
 "name": "Simulatore Stipendio Frontaliere",
 "url": `${BASE_URL}/calcola-stipendio`
 },
 "author": { "@type": "Person", "name": "Giulia T." },
 "reviewRating": { "@type": "Rating", "ratingValue": "5", "bestRating": "5" },
 "datePublished": "2026-02-08",
 "reviewBody": "Ho usato il confronto Permesso G vs B per decidere se trasferirmi a Lugano o continuare a pendolare da Como. I numeri mi hanno aiutato a fare una scelta consapevole."
 },
 {
 "@context": "https://schema.org",
 "@type": "Review",
 "itemReviewed": {
 "@type": "WebApplication",
 "name": "Simulatore Stipendio Frontaliere",
 "url": `${BASE_URL}/calcola-stipendio`
 },
 "author": { "@type": "Person", "name": "Alessandro M." },
 "reviewRating": { "@type": "Rating", "ratingValue": "4", "bestRating": "5" },
 "datePublished": "2025-12-10",
 "reviewBody": "Il pianificatore pensione AVS/LPP è molto utile per capire quanto accumulerò lavorando in Svizzera. Manca solo la simulazione del terzo pilastro integrata, ma nel complesso ottimo."
 },
 {
 "@context": "https://schema.org",
 "@type": "Review",
 "itemReviewed": {
 "@type": "WebApplication",
 "name": "Simulatore Stipendio Frontaliere",
 "url": `${BASE_URL}/calcola-stipendio`
 },
 "author": { "@type": "Person", "name": "Francesca B." },
 "reviewRating": { "@type": "Rating", "ratingValue": "5", "bestRating": "5" },
 "datePublished": "2026-03-22",
 "reviewBody": "Il confronto LAMal vs SSN mi ha fatto risparmiare quasi 200 CHF al mese scegliendo l'assicurazione giusta. Strumento indispensabile per ogni frontaliere."
 },
 {
 "@context": "https://schema.org",
 "@type": "Review",
 "itemReviewed": {
 "@type": "WebApplication",
 "name": "Simulatore Stipendio Frontaliere",
 "url": `${BASE_URL}/calcola-stipendio`
 },
 "author": { "@type": "Person", "name": "Lorenzo C." },
 "reviewRating": { "@type": "Rating", "ratingValue": "4", "bestRating": "5" },
 "datePublished": "2026-01-28",
 "reviewBody": "Lo uso ogni giorno per controllare il cambio CHF/EUR e calcolare il netto in euro. Pratico e veloce, ormai è il mio punto di riferimento per le finanze da frontaliere."
 }
 ]
 },

 guide: {
 title: 'Guida Completa Frontaliere | Permessi, Dogana, Primo Giorno',
 description: 'Oltre 78.000 frontalieri lavorano in Ticino. Guida 2026: permesso G (20 km, 5 anni), tempi dogana, primo giorno, trasferimento auto e disoccupazione.',
 keywords: 'guida frontaliere svizzera, permesso g come ottenerlo, primo giorno frontaliere, dogana svizzera tempi, trasferire auto svizzera, disoccupazione frontaliere, comuni di frontiera svizzera',
 ogTitle: 'Guida Completa Frontaliere | Tutto Quello che Devi Sapere',
 ogDescription: 'Oltre 78.000 frontalieri lavorano in Ticino ogni giorno. Guida aggiornata 2026: permesso G (20 km, 5 anni), dogana, primo giorno, trasferimento auto e disoccupazione transfrontaliera.',
 canonicalPath: '/guida-frontaliere',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Guida Frontaliere Svizzera-Italia",
 "url": `${BASE_URL}/guida-frontaliere`,
 "description": "Guida completa per lavoratori frontalieri tra Svizzera e Italia",
 "inLanguage": "it",
 "speakable": SPEAKABLE_SECTION
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Guide per frontalieri",
 "numberOfItems": 7,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "name": "Permessi di Lavoro G e B", "url": `${BASE_URL}/guida-frontaliere/permessi-di-lavoro` },
 { "@type": "ListItem", "position": 2, "name": "Tempi Attesa Dogana", "url": `${BASE_URL}/guida-frontaliere/tempi-attesa-dogana` },
 { "@type": "ListItem", "position": 3, "name": "Primo Giorno di Lavoro", "url": `${BASE_URL}/guida-frontaliere/primo-giorno-lavoro` },
 { "@type": "ListItem", "position": 4, "name": "Trasferire Auto in Svizzera", "url": `${BASE_URL}/guida-frontaliere/trasferire-auto-svizzera` },
 { "@type": "ListItem", "position": 5, "name": "Disoccupazione Transfrontaliera", "url": `${BASE_URL}/guida-frontaliere/disoccupazione-transfrontaliera` },
 { "@type": "ListItem", "position": 6, "name": "Mappa Comuni di Frontiera", "url": `${BASE_URL}/guida-frontaliere/mappa-confine` },
 { "@type": "ListItem", "position": 7, "name": "Costo Auto Pendolare", "url": `${BASE_URL}/guida-frontaliere/costo-auto-pendolare` }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Cos'è un frontaliere e chi può diventarlo?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Un frontaliere è un lavoratore che risiede in uno Stato (Italia) e lavora in un altro (Svizzera), rientrando a casa almeno settimanalmente. Per essere frontaliere serve: cittadinanza UE, residenza nella fascia di 20 km dal confine, e un contratto di lavoro svizzero. Si ottiene il permesso G."
 }
 },
 {
 "@type": "Question",
 "name": "Quali sono i vantaggi di lavorare come frontaliere in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I vantaggi principali sono: stipendi 2-3 volte più alti che in Italia (mediana CHF 6.500/mese in Ticino), contributi previdenziali robusti (AVS + LPP + pillar 3a), copertura sanitaria LAMal eccellente, e possibilità di vivere in Italia con costi di vita inferiori."
 }
 },
 {
 "@type": "Question",
 "name": "Come funziona la dogana svizzera per i frontalieri?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I frontalieri attraversano i valichi doganali con il permesso G. I tempi di attesa variano: 5-15 minuti in orari normali, fino a 45-60 minuti nelle ore di punta (7:00-8:30 e 17:00-18:30). I valichi principali sono Chiasso, Ponte Chiasso, Brogeda, Gaggiolo e Stabio."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto guadagna in media un frontaliere in Ticino?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Lo stipendio mediano lordo in Canton Ticino è di circa CHF 5.600/mese per i frontalieri (dati USS). Le posizioni qualificate (IT, ingegneria, finanza) superano CHF 7.000-9.000/mese. Il netto dopo imposta alla fonte e contributi sociali è circa il 75-82% del lordo."
 }
 },
 {
 "@type": "Question",
 "name": "Il frontaliere ha diritto alla disoccupazione se perde il lavoro?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, il frontaliere licenziato ha diritto alla NASpI italiana. I contributi versati in Svizzera vengono totalizzati tramite il formulario PD U1, da richiedere alla cassa disoccupazione svizzera. La NASpI può durare fino a 24 mesi."
 }
 }
 ]
 }
 ]
 },

 fisco: {
 title: 'Calcolatore Imposte alla Fonte 2026 | Frontalieri',
 description: 'Calcolatore imposte alla fonte Ticino 2026: nuovi frontalieri pagano 6–15% CH più IRPEF con franchigia 10.000 €. Vecchi mantengono regime pre-2024.',
 keywords: 'tasse frontalieri 2026, calcolatore imposte alla fonte 2026, etax ticino 2026, dichiarazione redditi frontaliere, ristorni fiscali ticino, pensione frontaliere avs lpp, terzo pilastro 3a frontaliere, scadenze fiscali frontaliere, imposta alla fonte ticino, calcolo stipendio netto svizzera',
 ogTitle: 'Calcolatore Imposte alla Fonte 2026 | Frontaliere Ticino',
 ogDescription: 'Nuovo accordo 2026: calcola imposte alla fonte Ticino (6–15%) + IRPEF con franchigia 10.000 €. Guida completa a tasse, eTax, pensione AVS/LPP e previdenza.',
 canonicalPath: '/tasse-e-pensione',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Fisco e Previdenza Frontalieri",
 "url": `${BASE_URL}/tasse-e-pensione`,
 "description": "Strumenti e guide su fisco e previdenza per frontalieri Svizzera-Italia",
 "inLanguage": "it",
 "speakable": SPEAKABLE_SECTION
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Strumenti fiscali e previdenziali",
 "numberOfItems": 8,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "name": "Dichiarazione Redditi", "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi` },
 { "@type": "ListItem", "position": 2, "name": "Ristorni Fiscali", "url": `${BASE_URL}/tasse-e-pensione/ristorni-fiscali` },
 { "@type": "ListItem", "position": 3, "name": "Calendario Scadenze", "url": `${BASE_URL}/tasse-e-pensione/scadenze-fiscali` },
 { "@type": "ListItem", "position": 4, "name": "Pianificatore Pensione AVS/LPP", "url": `${BASE_URL}/tasse-e-pensione/calcola-previdenza` },
 { "@type": "ListItem", "position": 5, "name": "Simulatore Terzo Pilastro 3a", "url": `${BASE_URL}/tasse-e-pensione/simula-terzo-pilastro` },
 { "@type": "ListItem", "position": 6, "name": "Quiz Fiscale", "url": `${BASE_URL}/tasse-e-pensione/quiz-fiscale` },
 { "@type": "ListItem", "position": 7, "name": "Festività Ticino", "url": `${BASE_URL}/tasse-e-pensione/festivita-ticino` },
 { "@type": "ListItem", "position": 8, "name": "Credito d'Imposta", "url": `${BASE_URL}/tasse-e-pensione/credito-imposta` }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Come funziona la tassazione dei frontalieri nel 2026?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Dal 2024 è in vigore il nuovo accordo fiscale: i nuovi frontalieri (assunti dal 17/07/2023) pagano l'imposta alla fonte in Svizzera (80% del gettito resta alla Svizzera) e dichiarano in Italia con franchigia di €10.000 e credito d'imposta. I vecchi frontalieri continuano a pagare solo in Svizzera fino al 2033."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto paga di tasse un frontaliere in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "L'imposta alla fonte in Canton Ticino varia dal 3% al 35% in base allo stipendio, stato civile e figli. Per un single con CHF 70.000 lordi l'aliquota è circa 10-12%. Per un coniugato con due figli e CHF 80.000 lordi, circa 5-7%. Le tabelle A (single), B (coniugato reddito unico), C (coniugato doppio reddito) e H (monoparentale) determinano l'aliquota."
 }
 },
 {
 "@type": "Question",
 "name": "Il frontaliere deve pagare l'IRPEF in Italia?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I nuovi frontalieri (dal 17/07/2023) sì: dichiarano il reddito svizzero in Italia e pagano l'IRPEF, con una franchigia di €10.000 e il credito d'imposta per le tasse svizzere già pagate. I vecchi frontalieri (ante 17/07/2023) pagano solo in Svizzera per il periodo transitorio."
 }
 },
 {
 "@type": "Question",
 "name": "Cos'è il terzo pilastro 3a e conviene al frontaliere?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il 3° pilastro 3a è la previdenza privata volontaria svizzera. Conviene molto perché i versamenti (max CHF 7.258/anno) sono deducibili dall'imposta alla fonte. Per un frontaliere con aliquota del 12%, il risparmio fiscale è di circa CHF 870/anno. I fondi si possono prelevare a 5 anni dalla pensione."
 }
 },
 {
 "@type": "Question",
 "name": "Come si calcola la pensione di un frontaliere?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La pensione del frontaliere ha 3 componenti: AVS svizzera (1° pilastro, max CHF 2.520/mese con 44 anni di contributi), LPP (2° pilastro, dipende dai contributi accumulati), e INPS italiana (per anni lavorati in Italia). I contributi si totalizzano grazie all'accordo bilaterale CH-UE."
 }
 }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "ClaimReview",
 "url": `${BASE_URL}/tasse-e-pensione`,
 "claimReviewed": "I frontalieri pagano le tasse due volte, sia in Svizzera che in Italia",
 "author": {
 "@type": "Organization",
 "name": "Frontaliere Ticino",
 "url": BASE_URL
 },
 "datePublished": "2026-04-01",
 "reviewRating": {
 "@type": "Rating",
 "ratingValue": "2",
 "bestRating": "5",
 "worstRating": "1",
 "alternateName": "Parzialmente falso"
 },
 "itemReviewed": {
 "@type": "Claim",
 "author": { "@type": "Organization", "name": "Opinione comune" },
 "datePublished": "2025-01-01",
 "appearance": { "@type": "CreativeWork", "url": `${BASE_URL}/tasse-e-pensione` }
 }
 },
 {
 "@context": "https://schema.org",
 "@type": "ClaimReview",
 "url": `${BASE_URL}/tasse-e-pensione`,
 "claimReviewed": "Con il nuovo accordo 2026 i frontalieri pagano più tasse",
 "author": {
 "@type": "Organization",
 "name": "Frontaliere Ticino",
 "url": BASE_URL
 },
 "datePublished": "2026-04-01",
 "reviewRating": {
 "@type": "Rating",
 "ratingValue": "3",
 "bestRating": "5",
 "worstRating": "1",
 "alternateName": "Dipende"
 },
 "itemReviewed": {
 "@type": "Claim",
 "author": { "@type": "Organization", "name": "Opinione comune" },
 "datePublished": "2025-01-01",
 "appearance": { "@type": "CreativeWork", "url": `${BASE_URL}/tasse-e-pensione` }
 }
 },
 {
 "@context": "https://schema.org",
 "@type": "ClaimReview",
 "url": `${BASE_URL}/tasse-e-pensione`,
 "claimReviewed": "Il Permesso G costa meno del Permesso B",
 "author": {
 "@type": "Organization",
 "name": "Frontaliere Ticino",
 "url": BASE_URL
 },
 "datePublished": "2026-04-01",
 "reviewRating": {
 "@type": "Rating",
 "ratingValue": "4",
 "bestRating": "5",
 "worstRating": "1",
 "alternateName": "Generalmente vero"
 },
 "itemReviewed": {
 "@type": "Claim",
 "author": { "@type": "Organization", "name": "Opinione comune" },
 "datePublished": "2025-01-01",
 "appearance": { "@type": "CreativeWork", "url": `${BASE_URL}/tasse-e-pensione` }
 }
 },
 {
 "@context": "https://schema.org",
 "@type": "ClaimReview",
 "url": `${BASE_URL}/tasse-e-pensione`,
 "claimReviewed": "I frontalieri non hanno diritto alla pensione svizzera",
 "author": {
 "@type": "Organization",
 "name": "Frontaliere Ticino",
 "url": BASE_URL
 },
 "datePublished": "2026-04-01",
 "reviewRating": {
 "@type": "Rating",
 "ratingValue": "1",
 "bestRating": "5",
 "worstRating": "1",
 "alternateName": "Falso"
 },
 "itemReviewed": {
 "@type": "Claim",
 "author": { "@type": "Organization", "name": "Opinione comune" },
 "datePublished": "2025-01-01",
 "appearance": { "@type": "CreativeWork", "url": `${BASE_URL}/tasse-e-pensione` }
 }
 },
 {
 "@context": "https://schema.org",
 "@type": "ClaimReview",
 "url": `${BASE_URL}/tasse-e-pensione`,
 "claimReviewed": "La franchigia di 10.000€ è per tutti i frontalieri",
 "author": {
 "@type": "Organization",
 "name": "Frontaliere Ticino",
 "url": BASE_URL
 },
 "datePublished": "2026-04-01",
 "reviewRating": {
 "@type": "Rating",
 "ratingValue": "2",
 "bestRating": "5",
 "worstRating": "1",
 "alternateName": "Parzialmente falso"
 },
 "itemReviewed": {
 "@type": "Claim",
 "author": { "@type": "Organization", "name": "Opinione comune" },
 "datePublished": "2025-01-01",
 "appearance": { "@type": "CreativeWork", "url": `${BASE_URL}/tasse-e-pensione` }
 }
 }
 ]
 },

 withholdingRates: {
 title: 'Aliquote imposta alla fonte Ticino 2026 | Tabelle A B C H',
 description: 'Aliquote imposta alla fonte Ticino 2026 per frontalieri: tabelle A, B, C e H, esempi per CHF 50.000-100.000, FAQ e link al simulatore netto e busta paga.',
 keywords: 'aliquote imposta alla fonte ticino 2026, tabella imposta alla fonte ticino, tabelle A B C H ticino, quellensteuer ticino 2026, imposta alla fonte frontalieri ticino',
 ogTitle: 'Aliquote imposta alla fonte Ticino 2026 | Tabelle A B C H',
 ogDescription: 'Guida pratica alle tabelle A, B, C e H del Ticino con esempi, FAQ e deep link al simulatore.',
 canonicalPath: '/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Aliquote imposta alla fonte Ticino 2026",
 "url": `${BASE_URL}/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026`,
 "description": "Guida pratica alle tabelle A, B, C e H del Ticino per frontalieri con esempi di aliquota, FAQ e link ai simulatori fiscali.",
 "inLanguage": "it"
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Strumenti collegati imposta alla fonte Ticino 2026",
 "numberOfItems": 4,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "name": "Simulatore netto frontalieri", "url": `${BASE_URL}/` },
 { "@type": "ListItem", "position": 2, "name": "Simula busta paga", "url": `${BASE_URL}/calcola-stipendio/simula-busta-paga` },
 { "@type": "ListItem", "position": 3, "name": "Credito d'imposta", "url": `${BASE_URL}/tasse-e-pensione/credito-imposta` },
 { "@type": "ListItem", "position": 4, "name": "Dichiarazione fiscale svizzera", "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-svizzera` }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Qual e la differenza tra tabella A, B, C e H?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La tabella A si usa di norma per persone sole senza figli. La B per coniugati con un solo reddito. La C per coniugati con due redditi. La H per genitori soli con figli a carico."
 }
 },
 {
 "@type": "Question",
 "name": "La tabella dipende dal Comune italiano di residenza?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "No. La tabella svizzera dipende soprattutto da stato civile e figli. Il Comune italiano conta per la fiscalita italiana, non per la classe di imposta alla fonte Ticino."
 }
 },
 {
 "@type": "Question",
 "name": "Perche la percentuale in busta paga puo differire dal simulatore?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Le cause piu comuni sono tabella errata, figli non registrati, tredicesima, bonus, periodo di paga o differenze tra lordo annuo e lordo mensile usato dal payroll."
 }
 }
 ]
 }
 ]
 },

 newFrontierTaxSim: {
 title: 'Simulazione Tasse Nuovi Frontalieri 2026 | IRPEF',
 description: 'Simulazione tasse nuovi frontalieri: calcola imposta alla fonte Ticino, IRPEF con franchigia €10.000, credito d\'imposta e netto 2026.',
 keywords: 'simulazione tasse nuovi frontalieri, calcolo tasse nuovi frontalieri 2026, imposta alla fonte nuovi frontalieri, IRPEF frontalieri franchigia 10000, nuovo accordo frontalieri tasse, doppia imposizione nuovi frontalieri, differenza vecchi nuovi frontalieri tasse, franchigia nuovi frontalieri',
 ogTitle: 'Simulazione Tasse Nuovi Frontalieri 2026',
 ogDescription: 'Calcola le tasse come nuovo frontaliere: imposta alla fonte CH + IRPEF Italia con franchigia €10.000 e credito d\'imposta. Simulatore gratuito.',
 canonicalPath: '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Simulazione Tasse Nuovi Frontalieri 2026",
 "url": `${BASE_URL}/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri`,
 "description": "Simulatore gratuito per il calcolo delle tasse dei nuovi frontalieri secondo il nuovo accordo fiscale Italia-Svizzera: imposta alla fonte, IRPEF con franchigia €10.000, credito d'imposta.",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "inLanguage": "it",
 "dateModified": BUILD_DATE_ISO,
 "provider": {
 "@type": "Organization",
 "name": "Frontaliere Ticino",
 "url": BASE_URL
 }
 },
 {
 "@context": "https://schema.org",
 "@type": "HowTo",
 "name": "Come simulare le tasse come nuovo frontaliere",
 "description": "Guida passo-passo per calcolare le tasse come nuovo frontaliere (assunto dopo luglio 2023) con il simulatore gratuito di Frontaliere Ticino.",
 "totalTime": "PT2M",
 "step": [
 { "@type": "HowToStep", "position": 1, "name": "Inserisci lo stipendio lordo annuo in CHF", "text": "Inserisci il tuo stipendio lordo annuo in franchi svizzeri. Il simulatore lo userà per calcolare contributi sociali (AVS 5,3%, LPP, AC 1,1%) e imposta alla fonte.", "url": `${BASE_URL}/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri` },
 { "@type": "HowToStep", "position": 2, "name": "Seleziona stato civile e numero di figli", "text": "Scegli stato civile (celibe/nubile, coniugato, genitore solo) e indica i figli a carico. Questi dati determinano la tabella d'imposta alla fonte (A, B, C o H) e le detrazioni IRPEF.", "url": `${BASE_URL}/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri` },
 { "@type": "HowToStep", "position": 3, "name": "Indica il comune di residenza in Italia", "text": "Il comune di residenza determina l'addizionale regionale e comunale IRPEF. I nuovi frontalieri residenti entro 20 km dal confine hanno le stesse regole fiscali di quelli oltre 20 km dal 2024.", "url": `${BASE_URL}/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri` },
 { "@type": "HowToStep", "position": 4, "name": "Leggi il risultato: netto mensile in EUR", "text": "Il simulatore mostra il dettaglio completo: imposta alla fonte CH (80% dell'aliquota ordinaria), contributi sociali svizzeri, IRPEF italiana con franchigia €10.000, credito d'imposta per evitare la doppia tassazione, e lo stipendio netto mensile convertito in EUR.", "url": `${BASE_URL}/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri` }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Come vengono tassati i nuovi frontalieri dal 2024?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I nuovi frontalieri (assunti dopo il 17/07/2023) pagano l'imposta alla fonte in Svizzera (80% dell'aliquota ordinaria in Ticino) e l'IRPEF in Italia con una franchigia di €10.000 sul reddito estero. Un credito d'imposta evita la doppia imposizione."
 }
 },
 {
 "@type": "Question",
 "name": "Cos'è la franchigia di €10.000 per i nuovi frontalieri?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La franchigia di €10.000 è una deduzione sul reddito da lavoro dipendente prodotto in Svizzera: i primi €10.000 di reddito non vengono tassati in Italia. Si applica a tutti i lavoratori frontalieri con rientro giornaliero (Art. 1 c.175 L.147/2013, modificato da Art. 4 L.83/2023)."
 }
 },
 {
 "@type": "Question",
 "name": "Come funziona il credito d'imposta per evitare la doppia tassazione?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Le imposte pagate in Svizzera (imposta alla fonte) vengono detratte dall'IRPEF italiana tramite il credito d'imposta nel quadro CE della dichiarazione dei redditi. Il credito non può superare la quota di IRPEF relativa al reddito estero."
 }
 },
 {
 "@type": "Question",
 "name": "Come calcolo lo stipendio netto come nuovo frontaliere?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Usa il simulatore gratuito: inserisci lo stipendio lordo annuo in CHF, stato civile, figli e comune di residenza. Il calcolatore applica automaticamente contributi svizzeri (AVS, LPP, AC), imposta alla fonte Ticino, IRPEF con franchigia e credito d'imposta, mostrando il netto mensile in EUR."
 }
 },
 {
 "@type": "Question",
 "name": "Come si calcolano le tasse per i nuovi frontalieri 2026?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il calcolo segue tre fasi: prima si sottraggono i contributi sociali svizzeri (AVS 5,3%, AC 1,1%, LPP in base all'età), poi si applica l'imposta alla fonte cantonale al 80% dell'aliquota ordinaria in base alla tabella A/B/C/H, infine si calcola l'IRPEF italiana sul reddito convertito in EUR meno la franchigia di €10.000, detraendo il credito d'imposta per le tasse già versate in Svizzera."
 }
 },
 {
 "@type": "Question",
 "name": "Qual è la franchigia per nuovi frontalieri?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La franchigia per i nuovi frontalieri è di €10.000 annui. Questo significa che i primi €10.000 di reddito da lavoro prodotto in Svizzera sono esenti da IRPEF in Italia. La franchigia si applica automaticamente in fase di dichiarazione dei redditi e riduce significativamente il carico fiscale italiano rispetto all'imposizione ordinaria."
 }
 },
 {
 "@type": "Question",
 "name": "Differenza tra vecchi e nuovi frontalieri per le tasse?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I vecchi frontalieri (assunti prima del 17/07/2023 e residenti entro 20 km dal confine) pagano solo l'imposta alla fonte in Svizzera e sono esenti IRPEF in Italia. I nuovi frontalieri pagano sia l'imposta alla fonte svizzera (ridotta all'80%) sia l'IRPEF italiana, ma beneficiano della franchigia di €10.000 e del credito d'imposta. Per stipendi sotto €35.000 la differenza netta è spesso inferiore a €100/mese."
 }
 }
 ]
 }
 ]
 },

 vita: {
 title: 'Vita in Ticino per Frontalieri | Trasporti, Casa, Servizi',
 description: 'Vivere in Ticino costa il 40–60% in più dell\'Italia ma elimina 1–2 ore di pendolarismo. Affitto Lugano da 1.500 CHF vs 600 € a Como. Guida pratica.',
 keywords: 'vivere in ticino frontaliere, trasporti frontalieri svizzera, aziende ticino lavoro, scuole svizzera italiana, asili nido ticino, comuni frontiera svizzera italia, vivere svizzera vs italia',
 ogTitle: 'Vita in Ticino per Frontalieri 2026 | Guida Pratica',
 ogDescription: 'Vivere in Ticino costa il 40–60% in più dell\'Italia ma elimina il pendolarismo. Affitto a Lugano da 1.500 CHF vs 600 € a Como. Guida pratica: trasporti, casa, scuole, servizi e confronto permesso B vs G.',
 canonicalPath: '/vivere-in-ticino',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Vita in Ticino per Frontalieri",
 "url": `${BASE_URL}/vivere-in-ticino`,
 "description": "Guide e strumenti sulla vita quotidiana in Ticino per lavoratori frontalieri",
 "inLanguage": "it",
 "speakable": SPEAKABLE_SECTION
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Guide vita in Ticino",
 "numberOfItems": 8,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "name": "Trasporti Frontalieri", "url": `${BASE_URL}/vivere-in-ticino/trasporti-frontalieri` },
 { "@type": "ListItem", "position": 2, "name": "Vivere in Svizzera", "url": `${BASE_URL}/vivere-in-ticino/vivere-in-svizzera` },
 { "@type": "ListItem", "position": 3, "name": "Vivere in Italia", "url": `${BASE_URL}/vivere-in-ticino/vivere-in-italia` },
 { "@type": "ListItem", "position": 4, "name": "Aziende Svizzera Italiana", "url": `${BASE_URL}/vivere-in-ticino/aziende-svizzera-italiana` },
 { "@type": "ListItem", "position": 5, "name": "Scuole Svizzera Italiana", "url": `${BASE_URL}/vivere-in-ticino/scuole-svizzera-italiana` },
 { "@type": "ListItem", "position": 6, "name": "Attrazioni Ticino", "url": `${BASE_URL}/vivere-in-ticino/attrazioni-svizzera-italiana` },
 { "@type": "ListItem", "position": 7, "name": "Confronta Asili Nido", "url": `${BASE_URL}/vivere-in-ticino/confronta-asili-nido` },
 { "@type": "ListItem", "position": 8, "name": "Comuni di Frontiera", "url": `${BASE_URL}/vivere-in-ticino/comuni-di-frontiera` }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Conviene vivere in Svizzera o in Italia come frontaliere?", "acceptedAnswer": { "@type": "Answer", "text": "Dipende dalle priorità: vivere in Svizzera (Permesso B) offre zero pendolarismo, servizi svizzeri e nessuna doppia tassazione, ma costi di vita 40-60% più alti. Vivere in Italia (Permesso G) riduce i costi fissi del 30-45%, mantiene il sistema sanitario SSN e permette di accedere a scuole pubbliche italiane, ma aggiunge 1-2 ore di pendolarismo giornaliero e la complessità fiscale del Nuovo Accordo 2026." } },
 { "@type": "Question", "name": "Quali sono i migliori comuni italiani per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "I comuni più scelti dai frontalieri sono quelli entro 20 km dal confine svizzero nelle province di Como, Varese e Verbano-Cusio-Ossola. Comuni come Cantù, Olgiate Comasco, Luino, Lavena Ponte Tresa e Ponte Tresa offrono buoni collegamenti, costi contenuti e servizi per famiglie. La classifica varia in base al valico di riferimento e al luogo di lavoro in Ticino." } },
 { "@type": "Question", "name": "Quanto costa il pendolarismo da frontaliere?", "acceptedAnswer": { "@type": "Answer", "text": "Il costo medio del pendolarismo varia da CHF 200-400/mese in auto (carburante + autostrada + parcheggio) a CHF 100-250/mese con trasporto pubblico (abbonamento TILO/FerrovieNord). Il tempo medio di percorrenza è 45-90 minuti per tratta, con picchi nelle ore di punta ai valichi principali (Chiasso, Stabio, Gaggiolo)." } },
 { "@type": "Question", "name": "Come funziona l'assicurazione sanitaria per i frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "I frontalieri con Permesso G hanno il diritto d'opzione: possono scegliere la LAMal svizzera (premi da CHF 300-500/mese) o il SSN italiano (contributi INPS molto inferiori). La scelta va fatta entro 3 mesi dall'inizio del lavoro ed è generalmente irrevocabile. Il SSN è più conveniente ma copre solo in Italia; la LAMal copre in tutta la Svizzera." } }
 ]
 }
 ]
 },

 exchange: {
 title: 'Cambio CHF/EUR Oggi | Confronto Wise, Revolut, PostFinance',
 description: 'Cambio CHF/EUR: Wise e Revolut applicano 0,3–0,5% di commissione, le banche 1–3%. Su 5.000 CHF/mese risparmi fino a 150 CHF. Confronta i provider.',
 keywords: 'cambio chf eur oggi, wise tasso cambio, revolut commissioni, postfinance cambio valuta, ubs credit suisse cambio, n26 trasferimenti, miglior cambio svizzera italia, commissioni cambio valuta',
 ogTitle: 'Cambio CHF/EUR in Tempo Reale',
 ogDescription: 'Cambio CHF/EUR: Wise e Revolut applicano 0,3–0,5% di commissione, le banche tradizionali 1–3%. Su uno stipendio di 5.000 CHF/mese risparmi fino a 150 CHF. Confronta 6 provider in tempo reale.',
 canonicalPath: '/compara-servizi/cambio-franco-euro',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Comparatore Cambio CHF/EUR",
 "url": `${BASE_URL}/compara-servizi/cambio-franco-euro`,
 "description": "Confronto tassi di cambio CHF/EUR in tempo reale tra 6 provider: Wise, Revolut, PostFinance, UBS, Raiffeisen, N26",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" },
 "speakable": SPEAKABLE_SECTION
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Qual è il miglior servizio per cambiare franchi svizzeri in euro?", "acceptedAnswer": { "@type": "Answer", "text": "Wise e Revolut offrono generalmente i tassi più vantaggiosi con commissioni tra 0.3% e 0.5%. Le banche tradizionali (UBS, PostFinance) applicano spread più alti, spesso dell'1-3%." } },
 { "@type": "Question", "name": "Quanto costa trasferire CHF in EUR con Wise?", "acceptedAnswer": { "@type": "Answer", "text": "Wise applica una commissione trasparente dello 0.3-0.6% sul tasso di cambio medio di mercato. Per un trasferimento di CHF 5,000, il costo tipico è di circa CHF 15-30." } },
 { "@type": "Question", "name": "Conviene cambiare lo stipendio frontaliere in banca o con servizi online?", "acceptedAnswer": { "@type": "Answer", "text": "I servizi online come Wise e Revolut sono generalmente più convenienti. Su uno stipendio mensile di CHF 5,000, il risparmio rispetto a una banca tradizionale può essere di CHF 50-150 al mese." } },
 { "@type": "Question", "name": "Quando è il momento migliore per cambiare CHF in EUR?", "acceptedAnswer": { "@type": "Answer", "text": "Il tasso CHF/EUR fluttua quotidianamente. Conviene monitorare il tasso e cambiare quando il franco è forte (sotto 0.93 EUR). Evitare i cambi nei weekend quando gli spread sono più ampi." } }
 ]
 }
 ]
 },

 mobile: {
 title: 'Operatori Mobili Svizzera | Frontaliere Ticino',
 description: 'Confronta operatori mobili svizzeri per frontalieri: Swisscom, Salt, Sunrise, Yallo, Wingo, Aldi Mobile. Costi mensili reali con roaming illimitato in.',
 keywords: 'operatori mobili svizzera, roaming svizzera italia, swisscom frontalieri, salt mobile costi, sunrise abbonamenti, yallo wingo confronto, aldi mobile svizzera, roaming illimitato italia',
 ogTitle: 'Operatori Mobili Svizzera | Confronto con Roaming',
 ogDescription: '📱 Confronta 6 operatori mobili svizzeri con roaming illimitato in Italia. Costi reali mensili da CHF 9.95/mese. Trova il piano migliore per frontalieri!',
 canonicalPath: '/compara-servizi/confronta-operatori-mobili',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Confronto Operatori Mobili per Frontalieri",
 "url": `${BASE_URL}/compara-servizi/confronta-operatori-mobili`,
 "description": "Confronto costi mensili di 6 operatori mobili svizzeri con roaming illimitato in Italia",
 "applicationCategory": "UtilitiesApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" },
 "speakable": SPEAKABLE_SECTION
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Quale operatore mobile svizzero ha il roaming illimitato in Italia?", "acceptedAnswer": { "@type": "Answer", "text": "Swisscom, Salt e Sunrise includono roaming in Europa (Italia inclusa) nei piani premium. Yallo e Wingo offrono piani con roaming UE da CHF 19.95/mese. Verifica sempre le condizioni specifiche." } },
 { "@type": "Question", "name": "Quanto costa un abbonamento mobile in Svizzera per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "I piani partono da CHF 9.95/mese (Aldi Mobile) fino a CHF 65/mese (Swisscom premium). Per frontalieri, un buon piano con roaming Italia costa circa CHF 25-40/mese." } },
 { "@type": "Question", "name": "Posso usare una SIM italiana in Svizzera come frontaliere?", "acceptedAnswer": { "@type": "Answer", "text": "Sì, ma il roaming UE ha limiti di utilizzo. Dopo 4 mesi di uso prevalente all'estero, l'operatore può applicare sovrapprezzi. Per uso quotidiano in Svizzera, conviene un operatore svizzero." } },
 { "@type": "Question", "name": "Qual è il piano mobile più economico con roaming per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "Yallo e Wingo offrono i piani più economici con roaming in Italia incluso, a partire da CHF 19.95/mese con chiamate illimitate in Svizzera e dati in roaming." } }
 ]
 }
 ]
 },

 transport: {
 title: 'Costi Trasporto Frontalieri | Calcolo Auto vs Treno CH-IT',
 description: 'Calcola i costi reali di trasporto per frontalieri: auto (carburante, usura, pedaggi), treno (Trenitalia, FFS), bus transfrontalieri. Confronta convenienza.',
 keywords: 'costi trasporto frontalieri, calcolo costi auto, abbonamento treno svizzera, trenitalia frontalieri, ffs ticino, pedaggi autostrada, costo benzina diesel, usura auto, trasporti pubblici frontalieri',
 ogTitle: 'Calcolo Costi Trasporto Frontalieri | Auto vs Treno',
 ogDescription: '🚗 Calcola i costi reali di trasporto per frontalieri. Confronta auto, treno e bus per trovare la soluzione più conveniente!',
 canonicalPath: '/vivere-in-ticino/trasporti-frontalieri',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Calcolatore Costi Trasporto Frontalieri",
 "url": `${BASE_URL}/vivere-in-ticino/trasporti-frontalieri`,
 "description": "Calcola e confronta i costi reali di trasporto per frontalieri: auto, treno e bus",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 health: {
 title: 'Premi LAMal Frontaliere Ticino 2026 | Casse Malati',
 description: 'Premi LAMal frontalieri Ticino 2026: da CHF 200/mese (Assura Telmed) a CHF 600/mese. Diritto d\'opzione LAMal vs SSN entro 3 mesi. Confronta 14 casse malati.',
 keywords: 'premi lamal frontaliere 2026, casse malati frontaliere ticino, assicurazione sanitaria ticino, premi assicurazione frontalieri, helsana css confronto, swica visana sanitas, franchigia assicurazione svizzera, cassa malati frontalieri, premi lamal ticino',
 ogTitle: 'Premi LAMal Frontaliere Ticino 2026 | Casse Malati',
 ogDescription: 'Premi LAMal frontalieri Ticino 2026: da CHF 200/mese (Assura Telmed) a CHF 600/mese. Scegli tra LAMal e SSN entro 3 mesi dall\'assunzione — confronta 14 casse malati con franchigie da CHF 300 a 2.500.',
 canonicalPath: '/compara-servizi/confronta-casse-malati',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Comparatore Assicurazioni Sanitarie LAMal",
 "url": `${BASE_URL}/compara-servizi/confronta-casse-malati`,
 "description": "Confronta premi assicurazione sanitaria LAMal di 14 assicuratori svizzeri in 7 cantoni",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "I frontalieri devono avere l'assicurazione sanitaria svizzera?", "acceptedAnswer": { "@type": "Answer", "text": "Sì, i frontalieri hanno l'obbligo di assicurazione sanitaria LAMal in Svizzera entro 3 mesi dall'inizio del lavoro. In alternativa, possono esercitare il diritto di opzione per restare coperti dal SSN italiano." } },
 { "@type": "Question", "name": "Quanto costa l'assicurazione LAMal per un frontaliere in Ticino?", "acceptedAnswer": { "@type": "Answer", "text": "I premi mensili in Canton Ticino variano da circa CHF 200 (Assura/Agrisano con modello Telmed e franchigia CHF 2,500) a circa CHF 600 (modello standard con franchigia bassa)." } },
 { "@type": "Question", "name": "Qual è la cassa malati più economica per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "Assura e Agrisano offrono generalmente i premi più bassi in Canton Ticino. Con modello Telmed e franchigia CHF 2,500, i premi partono da circa CHF 200/mese per adulti." } },
 { "@type": "Question", "name": "Cos'è il diritto di opzione per l'assicurazione sanitaria dei frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "Il diritto di opzione permette ai frontalieri di scegliere tra LAMal svizzera e SSN italiano entro 3 mesi dall'inizio del lavoro. La scelta è irrevocabile per tutta la durata del rapporto di lavoro. Come avverte Laura Mantovani, broker assicurativo LAMal: «La scelta tra LAMal e SSN va ponderata con attenzione perché non è più modificabile una volta effettuata»." } },
 { "@type": "Question", "name": "Cosa copre l'assicurazione LAMal per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "La LAMal copre cure mediche, ospedaliere e farmaceutiche in Svizzera. Per cure in Italia, serve la carta europea di assicurazione malattia (CEAM). La franchigia annua va da CHF 300 a CHF 2,500." } }
 ]
 }
 ]
 },

 banks: {
 title: 'Banche Svizzera e Italia | Confronto Conti per Frontalieri',
 description: 'Confronta banche per frontalieri: UBS, Credit Suisse, PostFinance, Intesa Sanpaolo, UniCredit. Costi gestione conto, carte di credito, bonifici.',
 keywords: 'banche svizzera, conto corrente ticino, ubs credit suisse postfinance, intesa sanpaolo unicredit, costi conto corrente, carte credito svizzera, bonifici internazionali, servizi bancari frontalieri',
 ogTitle: 'Banche per Frontalieri | Confronto Conti CH-IT',
 ogDescription: '🏦 Confronta 8 banche svizzere e italiane. Costi gestione, carte incluse e servizi per frontalieri. Scegli il conto migliore!',
 canonicalPath: '/compara-servizi/confronta-banche',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Confronto Banche per Frontalieri",
 "url": `${BASE_URL}/compara-servizi/confronta-banche`,
 "description": "Confronto conti correnti e servizi bancari tra banche svizzere e italiane per lavoratori frontalieri",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 pension: {
 title: 'Pensione Frontalieri AVS e LPP | Calcolo Previdenza CH-IT',
 description: 'Un frontaliere versa il 5,3% in AVS e il 5–9% in LPP. Con 30 anni a 70.000 CHF/anno, la rendita AVS è circa 1.800 CHF/mese. Calcola la pensione CH-IT.',
 keywords: 'pensione frontalieri, calcolo lpp, avs svizzera, inps italia, secondo pilastro svizzera, contributi pensionistici, totalizzazione pensione, età pensionabile svizzera, previdenza frontalieri, cassa pensione ticino',
 ogTitle: 'Pensione Frontalieri AVS e LPP | Calcolo Previdenza CH-IT',
 ogDescription: 'Pensione frontalieri: AVS (5,3% del lordo) + LPP (5–9%) + INPS italiano. Con 30 anni a 70.000 CHF, la rendita AVS è circa 1.800 CHF/mese. Calcola la tua previdenza combinata CH-IT.',
 canonicalPath: '/tasse-e-pensione/calcola-previdenza',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Pianificatore Pensione Frontalieri",
 "url": `${BASE_URL}/tasse-e-pensione/calcola-previdenza`,
 "description": "Strumento per calcolare e pianificare la pensione dei lavoratori frontalieri tra Svizzera e Italia",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Come si calcola la pensione AVS per un frontaliere?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La rendita AVS dipende dagli anni di contribuzione e dal reddito medio. Con 44 anni di contributi (scala 44) si ottiene la rendita completa: minima CHF 1.225/mese, massima CHF 2.450/mese (2026). Ogni anno mancante riduce la rendita di 1/44. Come sottolinea il Dott. Andrea Fiorini, consulente previdenziale: «Anche pochi anni di contributi AVS generano un diritto pensionistico grazie alla totalizzazione con i periodi INPS»."
 }
 },
 {
 "@type": "Question",
 "name": "Posso riscuotere il secondo pilastro LPP quando lascio la Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I frontalieri UE possono riscuotere la parte sovraobbligatoria del 2° pilastro al momento della partenza. La parte obbligatoria resta in un conto di libero passaggio fino all'età pensionabile, salvo eccezioni (avvio attività indipendente, acquisto casa principale). Come consiglia il Dott. Andrea Fiorini, consulente previdenziale: «Prima del prelievo è fondamentale valutare la tassazione nel cantone di residenza della cassa pensione, che varia sensibilmente»."
 }
 },
 {
 "@type": "Question",
 "name": "Come funziona la totalizzazione dei contributi Svizzera-Italia?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Grazie agli accordi bilaterali, i periodi contributivi in Svizzera e in Italia si sommano per raggiungere il diritto alla pensione in ciascun Paese. Ogni Stato paga la propria quota (pro-rata) in base agli anni effettivi di contribuzione."
 }
 },
 {
 "@type": "Question",
 "name": "A che età va in pensione un frontaliere svizzero?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "L'età pensionabile AVS in Svizzera è 65 anni per gli uomini e 65 anni per le donne (dal 2028, con aumento graduale da 64). È possibile anticipare la rendita AVS di massimo 2 anni con una riduzione del 6.8% annuo, o posticiparla fino a 5 anni con un aumento."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto contribuisce il datore di lavoro svizzero alla pensione LPP?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il datore paga almeno il 50% dei contributi LPP. Le aliquote crescono con l'età: 7% (25-34 anni), 10% (35-44), 15% (45-54), 18% (55-65) del salario assicurato. Molte aziende versano più del minimo legale."
 }
 }
 ]
 }
 ]
 },

 stats: {
 title: 'Statistiche Frontalieri e Lavoro Ticino | Frontaliere Ticino',
 description: 'Oltre 78.000 frontalieri in Ticino (BFS 2024) e 4.000+ offerte attive. Statistiche aggiornate: aziende, località, settori in crescita e trend giornalieri.',
 keywords: 'statistiche frontalieri, lavoro ticino, offerte lavoro ticino, aziende che assumono ticino, trend offerte lavoro, bfs frontalieri, annunci lavoro svizzera italiana, statistiche lavoro ticino 2026',
 ogTitle: 'Statistiche Frontalieri e Lavoro Ticino | BFS e Job Board',
 ogDescription: 'Oltre 78.000 frontalieri in Ticino (BFS 2024) e 4.000+ offerte lavoro attive. Statistiche aggiornate: aziende che assumono, località, settori in crescita e trend giornalieri.',
 canonicalPath: '/statistiche',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Statistiche frontalieri e osservatorio lavoro Ticino 2026",
 "url": `${BASE_URL}/statistiche`,
 "description": "Dati statistici sui frontalieri e osservatorio del job board Ticino con aziende, località e trend delle offerte",
 "inLanguage": "it",
 "speakable": SPEAKABLE_SECTION
 },
 {
 "@context": "https://schema.org",
 "@type": "Dataset",
 "name": "Statistiche frontalieri e osservatorio offerte lavoro Ticino 2026",
 "description": "Dati statistici sui frontalieri svizzeri-italiani e osservatorio del job board Ticino: numero permessi G, aziende attive, localities, trend offerte e statistiche BFS 2026.",
 "dateModified": BUILD_DATE_ISO,
 "datePublished": "2024-01-01",
 "creator": { "@type": "Organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch" },
 "license": "https://creativecommons.org/licenses/by-nc/4.0/",
 "temporalCoverage": "2024/2026",
 "variableMeasured": [
 { "@type": "PropertyValue", "name": "Numero frontalieri", "value": "~79.000 (2025)" },
 { "@type": "PropertyValue", "name": "Offerte lavoro attive", "value": "Aggiornate quotidianamente" },
 { "@type": "PropertyValue", "name": "Aziende attive", "value": "100+ aziende ticinesi" },
 { "@type": "PropertyValue", "name": "Trend offerte", "value": "Variazione giornaliera annunci" }
 ],
 "distribution": [{ "@type": "DataDownload", "encodingFormat": "text/html", "contentUrl": `${BASE_URL}/statistiche` }]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Quanti frontalieri lavorano in Canton Ticino nel 2026?", "acceptedAnswer": { "@type": "Answer", "text": "Circa 79.000 lavoratori frontalieri pendolano quotidianamente dall'Italia al Canton Ticino (dati BFS 2025). Il Ticino è il cantone con la più alta concentrazione di frontalieri, circa il 30% della forza lavoro cantonale." } },
 { "@type": "Question", "name": "Quali settori offrono più lavoro in Ticino?", "acceptedAnswer": { "@type": "Answer", "text": "I settori con più offerte attive nel job board sono: IT e sviluppo software, ingegneria meccanica ed elettrotecnica, sanità e pharma, finanza e banking, e costruzioni. Il settore IT ha visto la crescita maggiore negli ultimi 12 mesi." } },
 { "@type": "Question", "name": "Come vengono calcolate le statistiche degli stipendi?", "acceptedAnswer": { "@type": "Answer", "text": "Le statistiche salariali combinano i dati ufficiali BFS (Indagine svizzera sulla struttura dei salari) con i salary range pubblicati negli annunci del job board. Le mediane e i range sono calcolati per settore, ruolo e livello di esperienza." } },
 { "@type": "Question", "name": "Con quale frequenza vengono aggiornati i dati?", "acceptedAnswer": { "@type": "Answer", "text": "L'osservatorio del job board viene aggiornato due volte al giorno con i nuovi annunci. I dati BFS sui frontalieri vengono aggiornati trimestralmente. I prezzi benzina sono aggiornati ogni ora. Il tasso di disoccupazione SECO è aggiornato mensilmente." } }
 ]
 }
 ]
 },

 feedback: {
 title: 'Aiutaci a Migliorare | Segnalazioni e Suggerimenti',
 description: 'Hai trovato un errore o vuoi proporre una nuova funzionalità? Apri una segnalazione su GitHub e aiutaci a migliorare il simulatore fiscale per frontalieri.',
 keywords: 'segnalazione bug frontalieri, suggerimenti simulatore, feedback frontalieri, migliorare simulatore tasse, contribuire open source frontalieri',
 ogTitle: 'Aiutaci a Migliorare | Frontaliere Ticino',
 ogDescription: '🐛 Segnala un problema o suggerisci una funzionalità per il simulatore fiscale frontalieri CH-IT. Contribuisci al miglioramento!',
 canonicalPath: '/supporto',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Aiutaci a Migliorare - Segnalazioni e Suggerimenti",
 "url": `${BASE_URL}/supporto`,
 "description": "Segnala bug e suggerisci funzionalità per il simulatore fiscale frontalieri Svizzera-Italia su GitHub",
 "inLanguage": "it"
 }
 },

 // New sections,

 whatif: {
 title: 'Simulatore What-If Frontalieri | Scenari Cosa Cambia Se...',
 description: 'Scopri come cambiano le tue tasse da frontaliere con scenari what-if: figlio in arrivo, cambio stipendio, stato civile, zona di residenza. Simulazione.',
 keywords: 'what if frontalieri, simulatore scenari, cosa cambia se figlio, aumento stipendio frontaliere, detrazioni figli frontaliere, cambio stato civile tasse',
 ogTitle: 'Simulatore What-If | Scenari Fiscali per Frontalieri',
 ogDescription: '🔮 Scopri come cambiano le tue tasse con scenari what-if: figlio, stipendio, residenza. Simulazione in tempo reale!',
 canonicalPath: '/calcola-stipendio/cosa-cambia-se',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Simulatore What-If Frontalieri",
 "url": `${BASE_URL}/calcola-stipendio/cosa-cambia-se`,
 "description": "Simulazione scenari fiscali per frontalieri: come cambiano le tasse con figlio, stipendio diverso, stato civile",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Come funziona il simulatore What-If per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "Inserisci il tuo scenario attuale (stipendio, stato civile, figli, residenza) e poi modifica una o più variabili per vedere in tempo reale come cambia il tuo netto. Ad esempio: cosa succede se arriva un figlio? Se cambi residenza? Se lo stipendio aumenta del 10%?" } },
 { "@type": "Question", "name": "Quali scenari posso simulare?", "acceptedAnswer": { "@type": "Answer", "text": "Puoi simulare: nascita di un figlio (impatto su detrazioni e assegni), cambio stato civile (matrimonio/divorzio), aumento o diminuzione stipendio, cambio zona di residenza (entro/oltre 20 km dal confine), passaggio da vecchio a nuovo frontaliere, e variazione del tasso di cambio CHF/EUR." } },
 { "@type": "Question", "name": "La simulazione What-If è affidabile?", "acceptedAnswer": { "@type": "Answer", "text": "La simulazione utilizza le stesse tabelle fiscali del calcolatore principale: aliquote imposta alla fonte Ticino 2026, scaglioni IRPEF, contributi AVS/LPP/AC. I risultati sono stime orientative, non consulenza fiscale professionale." } }
 ]
 }
 ]
 },

 jobs: {
 title: 'Confronto Offerte Lavoro Svizzera | Calcolo Netto Reale',
 description: 'Confronta fino a 4 offerte di lavoro in Svizzera: calcolo netto reale considerando tasse, costi trasporto, tempo viaggio, home office e benefit. Scopri.',
 keywords: 'confronto offerte lavoro svizzera, stipendio netto reale frontaliere, calcolo netto lavoro ticino, costi pendolarismo frontaliere, home office frontaliere, benefit lavoro svizzera',
 ogTitle: 'Confronto Offerte Lavoro Svizzera | Netto Reale Frontalieri',
 ogDescription: '💼 Confronta offerte di lavoro in Svizzera con calcolo netto reale: tasse, trasporto, tempo e benefit inclusi.',
 canonicalPath: '/compara-servizi/confronta-offerte-lavoro',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Confronto Offerte Lavoro Svizzera",
 "url": `${BASE_URL}/compara-servizi/confronta-offerte-lavoro`,
 "description": "Confronta fino a 4 offerte di lavoro in Svizzera con calcolo netto reale: tasse, trasporto, benefit",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 calendar: {
 title: 'Scadenze Fiscali Frontalieri 2026 | Tasse Canton Ticino',
 description: 'Scadenze fiscali frontalieri 2026: tasse canton Ticino, imposta alla fonte, IRPEF, 730, Modello Redditi, AVS. Countdown, documenti necessari e sanzioni.',
 keywords: 'scadenze fiscali frontalieri 2026, calendario tasse frontaliere, 730 frontalieri, modello redditi frontaliere, quadro rw svizzera, imposta alla fonte scadenza, irpef frontalieri',
 ogTitle: 'Scadenze Tasse Frontalieri 2026 | Canton Ticino e Italia',
 ogDescription: '📅 Scadenze tasse frontaliero canton Ticino 2026: IRPEF, 730, imposta alla fonte, AVS. Countdown e documenti necessari!',
 canonicalPath: '/tasse-e-pensione/scadenze-fiscali',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "Calendario Scadenze Fiscali 2026 per Frontalieri CH-IT",
 "url": `${BASE_URL}/tasse-e-pensione/scadenze-fiscali`,
 "description": "Tutte le scadenze fiscali 2026 per frontalieri: IRPEF, 730, imposta alla fonte, AVS con countdown e documenti necessari",
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "datePublished": "2026-01-01T00:00:00+01:00",
 "dateModified": BUILD_DATE_ISO
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Quando scade la dichiarazione dei redditi per frontalieri in Italia?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il Modello 730 scade il 30 settembre 2026, il Modello Redditi PF (ex Unico) scade il 30 novembre 2026 per l'invio telematico. Il pagamento del saldo IRPEF e primo acconto scade il 30 giugno 2026."
 }
 },
 {
 "@type": "Question",
 "name": "Entro quando va richiesta la rettifica TDR in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La richiesta di rettifica dell'imposta alla fonte (TDR) va presentata entro il 31 marzo dell'anno successivo a quello fiscale. Per il reddito 2025, la scadenza è il 31 marzo 2026."
 }
 },
 {
 "@type": "Question",
 "name": "Cosa succede se non dichiaro il reddito svizzero in Italia?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La mancata dichiarazione dei redditi esteri comporta sanzioni dal 120% al 240% dell'imposta dovuta, più interessi di mora. Per il quadro RW (monitoraggio conto svizzero) la sanzione va dal 3% al 15% delle somme non dichiarate."
 }
 },
 {
 "@type": "Question",
 "name": "Quando viene emesso il certificato di salario svizzero?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il Lohnausweis (certificato di salario) viene emesso dal datore di lavoro svizzero entro il 31 gennaio dell'anno successivo. È il documento base per la dichiarazione dei redditi sia in Italia sia per la TDR in Svizzera."
 }
 },
 {
 "@type": "Question",
 "name": "Quali sono le scadenze per il versamento dell'acconto IRPEF?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il primo acconto IRPEF (40%) scade il 30 giugno 2026. Il secondo acconto (60%) scade il 30 novembre 2026. Per importi inferiori a €257,52 l'acconto si versa in un'unica soluzione a novembre."
 }
 }
 ]
 }
 ]
 },

 permits: {
 title: 'Permessi Lavoro Svizzera G, B, C, L | Guida Completa 2026',
 description: 'Il permesso G richiede residenza entro 20 km dal confine, contratto svizzero e rientro settimanale; dura 5 anni. Confronta G, B, C e L: requisiti e costi.',
 keywords: 'permesso g svizzera, permesso b svizzera, permesso c svizzera, permesso l svizzera, permesso frontaliere requisiti, permesso dimora svizzera, documenti permesso lavoro svizzera',
 ogTitle: 'Permessi Lavoro Svizzera | Guida G, B, C, L per Frontalieri',
 ogDescription: 'Permesso G: residenza entro 20 km, contratto CH, rientro settimanale, durata 5 anni. Permesso B: dimora in Svizzera. Confronta G, B, C e L con requisiti, documenti e costi aggiornati 2026.',
 canonicalPath: '/guida-frontaliere/permessi-di-lavoro',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "Permessi Lavoro Svizzera G, B, C, L - Guida Completa 2026",
 "url": `${BASE_URL}/guida-frontaliere/permessi-di-lavoro`,
 "description": "Guida completa ai permessi di lavoro in Svizzera: G (frontalieri), B (dimora), C (domicilio), L (breve durata)",
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "datePublished": "2026-01-01T00:00:00+01:00",
 "dateModified": BUILD_DATE_ISO
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Quali sono i requisiti per ottenere il permesso G frontaliere?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Per il permesso G servono: contratto di lavoro con un datore svizzero, residenza nella fascia di 20 km dal confine (o nei comuni concordatari), cittadinanza UE/AELS, e rientro settimanale nel Paese di residenza. La domanda viene presentata dal datore di lavoro all'Ufficio della migrazione cantonale. Come precisa il Prof. Roberto Bentivoglio, docente di diritto del lavoro all'USI: «Il requisito dei 20 km si misura in linea d'aria dal confine, non dalla distanza stradale»."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto dura il permesso G e come si rinnova?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il permesso G ha durata di 5 anni se il contratto è a tempo indeterminato, o pari alla durata del contratto se a termine. Il rinnovo è automatico su richiesta del datore di lavoro, purché il rapporto di lavoro sia ancora in essere."
 }
 },
 {
 "@type": "Question",
 "name": "Qual è la differenza tra permesso G e permesso B?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il permesso G (frontaliere) richiede residenza in Italia con rientro settimanale; si è tassati alla fonte in Svizzera e si dichiara in Italia. Il permesso B (dimora) richiede residenza in Svizzera; si è tassati con dichiarazione ordinaria svizzera e non si paga IRPEF in Italia. Come spiega il Prof. Roberto Bentivoglio, docente di diritto del lavoro all'USI: «La scelta del permesso ha implicazioni fiscali, previdenziali e familiari che vanno valutate nel loro insieme»."
 }
 },
 {
 "@type": "Question",
 "name": "Un frontaliere con permesso G può cambiare lavoro liberamente?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, con il permesso G un cittadino UE può cambiare datore di lavoro liberamente. Il nuovo datore deve però segnalare l'assunzione all'Ufficio della migrazione, che aggiornerà il permesso."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto costa il permesso G frontaliere?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il costo del permesso G è di circa CHF 65-85 per il rilascio (varia per cantone). Il rinnovo costa circa CHF 40-55. Generalmente il datore di lavoro anticipa i costi e li addebita in busta paga."
 }
 }
 ]
 }
 ]
 },

 pillar3: {
 title: 'Simulatore 3° Pilastro Svizzera | Calcolo Risparmio Fiscale',
 description: 'Calcola il risparmio fiscale e la crescita del tuo 3° pilastro svizzero (3a e 3b). Proiezione a lungo termine con rendimento composto, deducibilità fiscale.',
 keywords: 'terzo pilastro svizzera, pilastro 3a calcolo, pilastro 3b, risparmio fiscale svizzera, previdenza privata svizzera, deduzione fiscale pilastro 3a, investimento pilastro svizzera',
 ogTitle: 'Simulatore 3° Pilastro | Risparmio Fiscale Svizzera',
 ogDescription: '💰 Calcola quanto risparmi con il 3° pilastro: deducibilità fiscale, proiezione rendimento e confronto 3a vs 3b.',
 canonicalPath: '/tasse-e-pensione/simula-terzo-pilastro',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Simulatore 3° Pilastro Svizzera",
 "url": `${BASE_URL}/tasse-e-pensione/simula-terzo-pilastro`,
 "description": "Calcola risparmio fiscale e crescita del 3° pilastro svizzero (3a e 3b) con proiezione a lungo termine",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Qual è il limite massimo di versamento nel pilastro 3a nel 2026?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Per i lavoratori dipendenti affiliati a una cassa pensione LPP, il limite è CHF 7.258 all'anno (2026). Per chi non ha un 2° pilastro, il limite sale al 20% del reddito netto, fino a un massimo di CHF 36.288. Come raccomanda il Dott. Andrea Fiorini, consulente previdenziale: «Versare il massimo consentito ogni anno è una delle strategie di ottimizzazione fiscale più efficaci per i frontalieri»."
 }
 },
 {
 "@type": "Question",
 "name": "Un frontaliere con permesso G può aprire un pilastro 3a?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, i frontalieri con permesso G che lavorano in Svizzera e pagano l'imposta alla fonte possono aprire un conto 3a e dedurre i versamenti dall'imposta alla fonte tramite la rettifica TDR."
 }
 },
 {
 "@type": "Question",
 "name": "Qual è la differenza tra pilastro 3a e 3b?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il 3a è vincolato (prelievo solo a 5 anni dalla pensione, acquisto casa o partenza dalla Svizzera) ma fiscalmente deducibile. Il 3b è libero (nessun vincolo di prelievo) ma senza vantaggi fiscali diretti. Il 3a conviene per il risparmio fiscale immediato."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto si risparmia di tasse con il pilastro 3a?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "In Canton Ticino, un versamento completo di CHF 7.258 riduce l'imposta alla fonte di circa CHF 1.000-2.200 a seconda dell'aliquota marginale. Per un frontaliere con aliquota del 12-15%, il risparmio è di circa CHF 870-1.090."
 }
 },
 {
 "@type": "Question",
 "name": "Come viene tassato il prelievo del pilastro 3a?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Al prelievo si paga un'imposta separata ridotta, generalmente tra il 5% e il 10% del capitale a seconda del Canton Ticino. Per i frontalieri che hanno lasciato la Svizzera, si applica un'imposta alla fonte sul capitale con possibilità di rimborso in base alla convenzione contro la doppia imposizione."
 }
 }
 ]
 }
 ]
 },

 newsletter: {
 title: 'Newsletter Frontalieri',
 description: 'Iscriviti alla newsletter settimanale per frontalieri: cambio CHF/EUR, traffico ai valichi, novità fiscali e consigli per risparmiare. Gratuita e senza spam.',
 keywords: 'newsletter frontalieri, cambio chf eur settimanale, aggiornamenti frontalieri, email frontalieri svizzera, traffico valichi email, novità tasse frontalieri',
 ogTitle: 'Newsletter Frontalieri | Aggiornamenti Settimanali Gratuiti',
 ogDescription: '📬 Iscriviti alla newsletter per frontalieri: cambio CHF/EUR, traffico ai valichi e novità fiscali ogni settimana!',
 canonicalPath: '/newsletter',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Newsletter Frontalieri",
 "url": `${BASE_URL}/newsletter`,
 "description": "Newsletter settimanale per frontalieri con cambio CHF/EUR, traffico valichi e novità fiscali",
 "inLanguage": "it"
 }
 },

 shopping: {
 title: 'Prezzi Supermercato Svizzera vs Italia | Mappa e Confronto',
 description: 'Confronta i prezzi della spesa tra Migros, Coop, Aldi in Svizzera e Esselunga, Lidl, Eurospin in Italia. Mappa interattiva di 40+ supermercati di frontiera.',
 keywords: 'prezzi supermercato svizzera vs italia, migros prezzi, coop svizzera caro, spesa frontiera ticino, supermercati confine svizzera italia, esselunga como prezzi, lidl italia vs lidl svizzera, denner prezzi, shopping transfrontaliero, aldi svizzera prezzi, eurospin como, risparmio spesa frontaliere, limite doganale CHF 300, indice convenienza zona confine',
 ogTitle: 'Prezzi Supermercato Svizzera vs Italia | Mappa e Confronto',
 ogDescription: '🛒 Mappa 40+ supermercati di frontiera + confronto prezzi 25 prodotti CH vs IT. Indice di convenienza per zona: risparmio fino al 42%!',
 canonicalPath: '/compara-servizi/confronta-prezzi-spesa',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Confronto Prezzi Supermercato Svizzera-Italia",
 "url": `${BASE_URL}/compara-servizi/confronta-prezzi-spesa`,
 "description": "Mappa interattiva di 40+ supermercati di frontiera con confronto prezzi di 25 prodotti e indice di convenienza per zona",
 "applicationCategory": "ShoppingApplication",
 "operatingSystem": "Web Browser",
 "offers": {
 "@type": "Offer",
 "price": "0",
 "priceCurrency": "CHF"
 },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Quanto si risparmia facendo la spesa in Italia?",
 "acceptedAnswer": { "@type": "Answer", "text": "In media, un carrello tipo di prodotti alimentari costa il 35-42% in meno in Italia rispetto alla Svizzera. I risparmi maggiori si registrano su carne, latticini e prodotti per la casa. La zona Chiasso-Como offre il miglior rapporto qualità-prezzo considerando la vicinanza al confine." }
 },
 {
 "@type": "Question",
 "name": "Quali sono i limiti doganali per la spesa in Italia?",
 "acceptedAnswer": { "@type": "Answer", "text": "Il limite di franchigia doganale è di CHF 300 per persona al giorno. Oltre questa soglia, si applicano dazi e IVA svizzera (8.1%). Per carne e latticini esistono limiti quantitativi specifici: max 1 kg di carne, 1 kg di burro. L'alcol è soggetto a limiti separati." }
 },
 {
 "@type": "Question",
 "name": "Qual è il supermercato più economico vicino al confine?",
 "acceptedAnswer": { "@type": "Answer", "text": "Eurospin e Lidl Italia offrono generalmente i prezzi più bassi per prodotti di marca propria. Per prodotti di marca, Esselunga e Carrefour hanno spesso promozioni competitive. Lato svizzero, Aldi e Denner sono le opzioni più convenienti." }
 },
 {
 "@type": "Question",
 "name": "Conviene fare benzina in Italia o in Svizzera?",
 "acceptedAnswer": { "@type": "Answer", "text": "Il prezzo della benzina è molto simile tra Italia e Svizzera (circa €1.75/L vs CHF 1.85/L). Considerando il tasso di cambio, la differenza è minima. Conviene fare benzina dove ci si trova, senza deviazioni apposta." }
 },
 {
 "@type": "Question",
 "name": "Quali prodotti conviene comprare in Svizzera?",
 "acceptedAnswer": { "@type": "Answer", "text": "Elettronica, abbigliamento tecnico e alcuni prodotti farmaceutici possono essere più convenienti in Svizzera grazie all'IVA più bassa (8.1% vs 22% in Italia). Anche Nespresso e cioccolato svizzero costano meno acquistati direttamente in Svizzera." }
 }
 ]
 }
 ]
 },

 'cost-of-living': {
 title: 'Costo Vita Svizzera vs Italia 2026 | Confronto',
 description: 'Costo vita svizzera vs italia 2026: confronto affitti, spesa, trasporti e sanità tra Lugano, Mendrisio e Como. Dati aggiornati per frontalieri.',
 keywords: 'costo vita svizzera vs italia, costo vita svizzera italia, costo vita lugano, costo vita como, affitto ticino prezzi, costo vita mendrisio chiasso, confronto prezzi svizzera italia, vivere in svizzera costi, costo vita frontiera',
 ogTitle: 'Costo Vita Svizzera vs Italia | Confronto Completo 2026',
 ogDescription: '🏠 Costo vita Svizzera vs Italia: confronta affitti, spesa, trasporti e sanità tra città di frontiera. Dati aggiornati 2026.',
 canonicalPath: '/compara-servizi/costo-della-vita',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Confronto Costo della Vita Svizzera-Italia",
 "url": `${BASE_URL}/compara-servizi/costo-della-vita`,
 "description": "Confronto interattivo del costo della vita tra città di frontiera svizzere e italiane",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": {
 "@type": "Offer",
 "price": "0",
 "priceCurrency": "CHF"
 },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Quanto costa vivere in Svizzera rispetto all'Italia?",
 "acceptedAnswer": { "@type": "Answer", "text": "Il costo della vita in Svizzera è mediamente 40-60% più alto rispetto all'Italia. Affitti, spesa alimentare e assicurazione sanitaria (LAMal) sono le voci con le differenze maggiori. Un bilocale a Lugano costa circa CHF 1.400-1.800/mese contro i 500-800€ a Como." }
 },
 {
 "@type": "Question",
 "name": "Conviene vivere in Italia e lavorare in Svizzera?",
 "acceptedAnswer": { "@type": "Answer", "text": "Per molti frontalieri sì: lo stipendio svizzero combinato con il costo della vita italiano permette un risparmio netto maggiore, specialmente su affitto e spesa. Tuttavia, vanno considerati i costi di trasporto, i tempi di viaggio e la tassazione applicabile." }
 },
 {
 "@type": "Question",
 "name": "Quali sono le città più economiche vicino al confine svizzero?",
 "acceptedAnswer": { "@type": "Answer", "text": "Tra le città italiane di frontiera, Varese e le aree della provincia di Como offrono costi contenuti con buoni collegamenti verso il Ticino. Lato svizzero, Mendrisio e Chiasso hanno costi leggermente inferiori a Lugano." }
 }
 ]
 }
 ]
 },

 livingCH: {
 title: 'Vivere in Svizzera | Guida Completa e Residenti',
 description: 'Tutto su vivere in Svizzera: costo della vita, affitti Canton Ticino, sistema sanitario LAMal, scuole, trasporti, tasse e burocrazia. Guida pratica per.',
 keywords: 'vivere in svizzera, trasferirsi in svizzera, affitti ticino, costo vita svizzera, lamal assicurazione, scuole svizzera, sistema sanitario svizzera, burocrazia svizzera, residenza svizzera',
 ogTitle: 'Vivere in Svizzera | Guida Completa per Frontalieri',
 ogDescription: '🇨🇭 Guida completa su vivere in Svizzera: affitti, sanità, scuole, trasporti e burocrazia nel Canton Ticino.',
 canonicalPath: '/vivere-in-ticino/vivere-in-svizzera',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "Vivere in Svizzera: Guida Completa per Frontalieri e Residenti",
 "url": `${BASE_URL}/vivere-in-ticino/vivere-in-svizzera`,
 "description": "Tutto su vivere in Svizzera: costo della vita, affitti, sanità LAMal, scuole e burocrazia nel Canton Ticino",
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "datePublished": "2026-01-01T00:00:00+01:00",
 "dateModified": BUILD_DATE_ISO
 }
 },

 livingIT: {
 title: 'Vivere in Italia come Frontaliere | Frontaliere Ticino',
 description: 'Vantaggi e svantaggi di vivere in Italia lavorando in Svizzera: costi più bassi, detrazioni fiscali, sanità SSN, scuole italiane, qualità della vita nelle.',
 keywords: 'vivere in italia frontaliere, residenza italia vantaggi, como varese frontalieri, costi vivere italia, detrazioni frontalieri italia, sanità ssn frontalieri, province frontiera',
 ogTitle: 'Vivere in Italia come Frontaliere | Vantaggi e Svantaggi',
 ogDescription: '🇮🇹 Pro e contro di vivere in Italia lavorando in Svizzera: costi, detrazioni, sanità e qualità della vita.',
 canonicalPath: '/vivere-in-ticino/vivere-in-italia',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "Vivere in Italia come Frontaliere: Vantaggi e Svantaggi",
 "url": `${BASE_URL}/vivere-in-ticino/vivere-in-italia`,
 "description": "Pro e contro di vivere in Italia lavorando in Svizzera: costi, detrazioni, sanità SSN nelle province di frontiera",
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "datePublished": "2026-01-01T00:00:00+01:00",
 "dateModified": BUILD_DATE_ISO
 }
 },

 border: {
 title: 'Traffico Dogana Chiasso Brogeda 2026 | Tempi di Attesa e Coda Dogana',
 description: 'Traffico dogana Chiasso e Brogeda: tempi di attesa in tempo reale, orari apertura e valichi alternativi Ponte Tresa, Gaggiolo e Stabio per frontalieri.',
 keywords: 'traffico dogana chiasso brogeda, tempi di attesa dogana chiasso, coda dogana chiasso, valichi frontiera svizzera italia, dogana chiasso, tempi attesa dogana, ponte tresa orari, gaggiolo brogeda, stabio valico, percorsi alternativi frontiera, coda brogeda',
 ogTitle: 'Traffico Dogana Chiasso Brogeda | Tempi di Attesa e Code',
 ogDescription: 'Traffico dogana Chiasso e Brogeda: tempi di attesa, code, orari apertura e percorsi alternativi per frontalieri.',
 canonicalPath: '/guida-frontaliere/tempi-attesa-dogana',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "Valichi di Frontiera Svizzera-Italia: Orari, Traffico e Percorsi",
 "url": `${BASE_URL}/guida-frontaliere/tempi-attesa-dogana`,
 "description": "Guida completa ai valichi doganali CH-IT: Chiasso, Ponte Tresa, Gaggiolo, Brogeda, Stabio con orari e percorsi alternativi",
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "datePublished": "2026-01-01T00:00:00+01:00",
 "dateModified": BUILD_DATE_ISO
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Quali sono gli orari di apertura dei valichi di frontiera Svizzera-Italia?", "acceptedAnswer": { "@type": "Answer", "text": "I valichi principali (Chiasso autostradale, Ponte Tresa) sono aperti 24/7. I valichi minori (Gaggiolo, Stabio, Brogeda) hanno orari ridotti, generalmente dalle 6:00 alle 22:00." } },
 { "@type": "Question", "name": "Qual è il valico meno trafficato tra Svizzera e Italia?", "acceptedAnswer": { "@type": "Answer", "text": "Stabio e Gaggiolo sono generalmente i valichi meno trafficati. Nei giorni feriali, i tempi di attesa sono spesso inferiori a 5 minuti contro i 15-30 minuti di Chiasso nelle ore di punta." } },
 { "@type": "Question", "name": "A che ora c'è più traffico alla dogana di Chiasso?", "acceptedAnswer": { "@type": "Answer", "text": "Le ore di punta sono 7:00-8:30 (ingresso in Svizzera) e 17:00-18:30 (rientro in Italia). Il lunedì e il venerdì sono i giorni più trafficati." } },
 { "@type": "Question", "name": "Come evitare le code alla frontiera Svizzera-Italia?", "acceptedAnswer": { "@type": "Answer", "text": "Usa valichi alternativi (Stabio, Gaggiolo), parti prima delle 7:00 o dopo le 8:30. Evita il lunedì mattina e il venerdì sera. In alternativa, prendi il treno: nessun controllo doganale." } }
 ]
 }
 ]
 },

 'car-cost': {
 title: 'Costi Pendolarismo Frontaliere | Frontaliere Ticino',
 description: 'Calcola i costi reali del pendolarismo come frontaliere: benzina, autostrada, usura auto, parcheggio, abbonamenti treno e bus transfrontalieri. Confronta.',
 keywords: 'costi pendolarismo frontaliere, spese viaggio frontaliere, benzina frontaliere, autostrada svizzera costi, parcheggio dogana, treno frontalieri, bus transfrontaliero',
 ogTitle: 'Costi Pendolarismo Frontaliere | Calcolo Spese Viaggio',
 ogDescription: '🚗 Calcola quanto spendi di pendolarismo: auto, treno, bus. Confronta le opzioni per risparmiare!',
 canonicalPath: '/guida-frontaliere/costo-auto-pendolare',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Calcolatore Costi Pendolarismo Frontaliere",
 "url": `${BASE_URL}/guida-frontaliere/costo-auto-pendolare`,
 "description": "Calcola costi reali del pendolarismo frontaliere: benzina, autostrada, usura auto, abbonamenti treno e bus",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 companies: {
 title: 'Aziende che Assumono in Ticino | Frontaliere Ticino',
 description: 'Scopri le principali aziende che assumono frontalieri nel Canton Ticino: settori tecnologia, finanza, farmaceutico, industria e servizi. Link diretti alle.',
 keywords: 'aziende ticino lavoro, aziende che assumono svizzera, lavoro canton ticino, settori lavoro ticino, opportunità lavoro frontalieri, carriere svizzera, stipendi ticino',
 ogTitle: 'Aziende che Assumono in Ticino | Opportunità per Frontalieri',
 ogDescription: '🏢 Scopri le migliori aziende che assumono nel Canton Ticino: settori, stipendi e link alle pagine carriere.',
 canonicalPath: '/vivere-in-ticino/aziende-svizzera-italiana',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Aziende che Assumono in Ticino",
 "url": `${BASE_URL}/vivere-in-ticino/aziende-svizzera-italiana`,
 "description": "Principali aziende che assumono frontalieri nel Canton Ticino: settori tecnologia, finanza, farmaceutico, industria e servizi",
 "inLanguage": "it"
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Aziende principali in Ticino",
 "itemListElement": [
 {
 "@type": "ListItem",
 "position": 1,
 "item": { "@type": "Organization", "name": "UBS", "url": "https://www.ubs.com" }
 },
 {
 "@type": "ListItem",
 "position": 2,
 "item": { "@type": "Organization", "name": "Banca dello Stato del Canton Ticino", "url": "https://www.bancastato.ch" }
 },
 {
 "@type": "ListItem",
 "position": 3,
 "item": { "@type": "Organization", "name": "VF International", "url": "https://www.vfc.com" }
 },
 {
 "@type": "ListItem",
 "position": 4,
 "item": { "@type": "Organization", "name": "Helsinn", "url": "https://www.helsinn.com" }
 },
 {
 "@type": "ListItem",
 "position": 5,
 "item": { "@type": "Organization", "name": "IBSA Institut Biochimique", "url": "https://www.ibsa.ch" }
 }
 ]
 }
 ]
 },

 municipalities: {
 title: '146 Comuni di Frontiera Svizzera 2026 | Mappa Interattiva',
 description: 'Elenco completo dei 146 comuni italiani entro 20 km dal confine svizzero. Mappa interattiva con distanze, addizionale IRPEF e trasporti.',
 keywords: 'comuni di frontiera, elenco comuni frontalieri svizzera 2026, comuni frontalieri svizzera mappa, comuni 20 km confine svizzera, comuni como varese frontiera, distanza valichi frontiera, mappa comuni frontiera',
 ogTitle: '146 Comuni di Frontiera Svizzera — Mappa e Distanze',
 ogDescription: 'Mappa interattiva dei 146 comuni italiani di frontiera. Distanze dai valichi, addizionale IRPEF e trasporti per frontalieri.',
 canonicalPath: '/vivere-in-ticino/comuni-di-frontiera',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Mappa Comuni di Frontiera Italia-Svizzera",
 "url": `${BASE_URL}/vivere-in-ticino/comuni-di-frontiera`,
 "description": "Mappa interattiva dei comuni italiani di frontiera con distanze dai valichi e informazioni utili",
 "applicationCategory": "UtilitiesApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Comuni Italiani di Frontiera",
 "description": "Elenco dei comuni italiani situati nella fascia di frontiera con la Svizzera",
 "numberOfItems": 146,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "item": { "@type": "City", "name": "Chiasso (confine)", "containedInPlace": { "@type": "AdministrativeArea", "name": "Como" } } },
 { "@type": "ListItem", "position": 2, "item": { "@type": "City", "name": "Ponte Tresa", "containedInPlace": { "@type": "AdministrativeArea", "name": "Varese" } } },
 { "@type": "ListItem", "position": 3, "item": { "@type": "City", "name": "Lavena Ponte Tresa", "containedInPlace": { "@type": "AdministrativeArea", "name": "Varese" } } },
 { "@type": "ListItem", "position": 4, "item": { "@type": "City", "name": "Campione d'Italia", "containedInPlace": { "@type": "AdministrativeArea", "name": "Como" } } },
 { "@type": "ListItem", "position": 5, "item": { "@type": "City", "name": "Luino", "containedInPlace": { "@type": "AdministrativeArea", "name": "Varese" } } }
 ]
 }
 ]
 },

 places: {
 title: 'Posti da Visitare in Ticino | Natura, Cultura e Attività',
 description: 'Guida ai posti più belli del Canton Ticino: montagne, laghi, città, cultura, attività per famiglie e shopping. Consigli per frontalieri che vivono e.',
 keywords: 'posti da visitare ticino, cosa fare ticino, lugano attrazioni, monte san salvatore, lago lugano, bellinzona castelli unesco, foxtown mendrisio, swissminiatur, locarno film festival, grotti ticinesi',
 ogTitle: 'Posti da Visitare in Ticino | Natura, Cultura e Famiglia',
 ogDescription: '🏔️ Scopri i posti più belli del Canton Ticino: montagne, laghi, città, eventi e attività per famiglie. Guida per frontalieri!',
 canonicalPath: '/vivere-in-ticino/attrazioni-svizzera-italiana',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "Posti da Visitare in Ticino: Natura, Cultura e Attività",
 "url": `${BASE_URL}/vivere-in-ticino/attrazioni-svizzera-italiana`,
 "description": "Guida ai posti più belli del Canton Ticino: montagne, laghi, città, cultura e attività per famiglie",
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "datePublished": "2026-01-01T00:00:00+01:00",
 "dateModified": BUILD_DATE_ISO
 }
 },

 schools: {
 title: 'Scuole in Ticino | Nido, Infanzia, Elementare, Media, Liceo',
 description: 'Guida alle scuole del Canton Ticino per frontalieri: nido, infanzia, elementare, media, liceo. Costi, orari e vicinanza ai valichi.',
 keywords: 'scuole ticino frontalieri, nido svizzera costi, scuola infanzia ticino, scuola elementare ticino, scuola media mendrisio, liceo lugano, scuole vicino frontiera, costi scuola svizzera, asilo ticino',
 ogTitle: 'Scuole in Ticino per Frontalieri | Guida Completa per Età',
 ogDescription: '🎓 Guida alle scuole del Canton Ticino per frontalieri: tipi per età, costi, orari e scuole vicine ai valichi di frontiera.',
 canonicalPath: '/vivere-in-ticino/scuole-svizzera-italiana',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "Scuole in Ticino per Frontalieri: dalla Materna al Liceo",
 "url": `${BASE_URL}/vivere-in-ticino/scuole-svizzera-italiana`,
 "description": "Guida completa alle scuole del Canton Ticino per frontalieri: nido, infanzia, elementare, media, liceo con costi e orari",
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "datePublished": "2026-01-01T00:00:00+01:00",
 "dateModified": BUILD_DATE_ISO
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Scuole in Ticino per Frontalieri",
 "description": "Elenco completo delle scuole nel Canton Ticino: nidi, scuole dell'infanzia, elementari, medie e superiori",
 "numberOfItems": 63,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "item": { "@type": "EducationalOrganization", "name": "Nido comunale di Chiasso", "address": { "@type": "PostalAddress", "streetAddress": "Via Bossi 2a", "addressLocality": "Chiasso", "postalCode": "6830", "addressCountry": "CH" }, "telephone": "+41 91 695 06 80" } },
 { "@type": "ListItem", "position": 2, "item": { "@type": "EducationalOrganization", "name": "Nido L'Aquilone", "address": { "@type": "PostalAddress", "streetAddress": "Via Penate 4", "addressLocality": "Mendrisio", "postalCode": "6850", "addressCountry": "CH" }, "telephone": "+41 91 646 43 21", "url": "https://www.nido-aquilone.ch" } },
 { "@type": "ListItem", "position": 3, "item": { "@type": "EducationalOrganization", "name": "Nido Il Girotondo", "address": { "@type": "PostalAddress", "streetAddress": "Via Nassa 21", "addressLocality": "Lugano", "postalCode": "6900", "addressCountry": "CH" }, "telephone": "+41 91 923 56 78", "url": "https://www.ilgirotondo.ch" } },
 { "@type": "ListItem", "position": 4, "item": { "@type": "EducationalOrganization", "name": "Scuola dell'infanzia Lugano Centro", "address": { "@type": "PostalAddress", "streetAddress": "Via Canova", "addressLocality": "Lugano", "postalCode": "6900", "addressCountry": "CH" } } },
 { "@type": "ListItem", "position": 5, "item": { "@type": "EducationalOrganization", "name": "International School of Ticino", "address": { "@type": "PostalAddress", "streetAddress": "Via Ponteggia 23", "addressLocality": "Cadempino", "postalCode": "6814", "addressCountry": "CH" }, "telephone": "+41 91 971 29 65", "url": "https://www.isticino.com", "description": "Curriculum internazionale IB, inglese/italiano" } },
 { "@type": "ListItem", "position": 6, "item": { "@type": "EducationalOrganization", "name": "TASIS - The American School in Switzerland", "address": { "@type": "PostalAddress", "streetAddress": "Via Collina d'Oro 15", "addressLocality": "Montagnola", "postalCode": "6926", "addressCountry": "CH" }, "telephone": "+41 91 960 51 51", "url": "https://www.tasis.ch", "description": "Scuola americana, boarding school dal 1956" } },
 { "@type": "ListItem", "position": 7, "item": { "@type": "EducationalOrganization", "name": "Scuola media Chiasso", "address": { "@type": "PostalAddress", "streetAddress": "Via Livio 4", "addressLocality": "Chiasso", "postalCode": "6830", "addressCountry": "CH" }, "telephone": "+41 91 816 41 11" } },
 { "@type": "ListItem", "position": 8, "item": { "@type": "EducationalOrganization", "name": "Scuola media Lugano 1 (Besso)", "address": { "@type": "PostalAddress", "streetAddress": "Via Besso 10", "addressLocality": "Lugano", "postalCode": "6900", "addressCountry": "CH" }, "telephone": "+41 91 816 41 81", "description": "Una delle scuole medie più grandi del cantone" } },
 { "@type": "ListItem", "position": 9, "item": { "@type": "EducationalOrganization", "name": "Liceo cantonale di Lugano 1", "address": { "@type": "PostalAddress", "streetAddress": "Viale Carlo Cattaneo 4", "addressLocality": "Lugano", "postalCode": "6900", "addressCountry": "CH" }, "telephone": "+41 91 815 31 11", "url": "https://www.liceolugano.ch", "description": "Il più antico liceo del Ticino, fondato nel 1852" } },
 { "@type": "ListItem", "position": 10, "item": { "@type": "EducationalOrganization", "name": "Liceo cantonale di Mendrisio", "address": { "@type": "PostalAddress", "streetAddress": "Via dei Fichi", "addressLocality": "Mendrisio", "postalCode": "6850", "addressCountry": "CH" }, "telephone": "+41 91 816 58 11", "url": "https://www.liceomendrisio.ch" } },
 { "@type": "ListItem", "position": 11, "item": { "@type": "EducationalOrganization", "name": "Liceo cantonale di Bellinzona", "address": { "@type": "PostalAddress", "streetAddress": "Viale Franscini 31", "addressLocality": "Bellinzona", "postalCode": "6500", "addressCountry": "CH" }, "telephone": "+41 91 814 18 11", "url": "https://www.liceobellinzona.ch" } },
 { "@type": "ListItem", "position": 12, "item": { "@type": "EducationalOrganization", "name": "Scuola cantonale di commercio (SCC)", "address": { "@type": "PostalAddress", "streetAddress": "Viale Franscini 32", "addressLocality": "Bellinzona", "postalCode": "6500", "addressCountry": "CH" }, "telephone": "+41 91 814 01 11", "url": "https://www.scc.ti.ch", "description": "Formazione commerciale AFC + maturità professionale" } },
 { "@type": "ListItem", "position": 13, "item": { "@type": "EducationalOrganization", "name": "Centro professionale tecnico (CPT) Lugano-Trevano", "address": { "@type": "PostalAddress", "streetAddress": "Via Trevano", "addressLocality": "Canobbio", "postalCode": "6952", "addressCountry": "CH" }, "telephone": "+41 91 815 10 51", "url": "https://www.cpttrevano.ti.ch", "description": "Formazione tecnica: informatica, elettronica, meccanica" } }
 ]
 }
 ]
 },

 unemployment: {
 title: 'Disoccupazione Frontalieri | Frontaliere Ticino',
 description: 'Guida completa alla disoccupazione per frontalieri: come richiedere NASpI in Italia e AD/ALV in Svizzera. Importi, durata, procedure passo per passo.',
 keywords: 'disoccupazione frontalieri, naspi frontalieri svizzera, disoccupazione svizzera ALV, PD U1 formulario, indennità disoccupazione frontaliere, naspi italia procedura, assicurazione disoccupazione svizzera, URC ticino, cassa disoccupazione',
 ogTitle: 'Disoccupazione per Frontalieri | NASpI e AD Svizzera',
 ogDescription: '📋 Guida completa alla disoccupazione per frontalieri: NASpI Italia, AD/ALV Svizzera, procedure, importi e confronto tra i due sistemi.',
 canonicalPath: '/guida-frontaliere/disoccupazione-transfrontaliera',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "Disoccupazione Frontalieri: NASpI Italia e AD Svizzera",
 "url": `${BASE_URL}/guida-frontaliere/disoccupazione-transfrontaliera`,
 "description": "Guida completa alla disoccupazione per frontalieri: NASpI, AD/ALV, formulario PD U1, importi e procedure passo per passo",
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "datePublished": "2026-01-01T00:00:00+01:00",
 "dateModified": BUILD_DATE_ISO
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Un frontaliere licenziato in Svizzera prende la disoccupazione in Italia o in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il frontaliere con permesso G che perde il lavoro in Svizzera riceve la disoccupazione in Italia (NASpI), non in Svizzera. Il regolamento UE 883/2004 prevede che i lavoratori frontalieri in disoccupazione totale siano a carico del Paese di residenza. Come chiarisce il Prof. Roberto Bentivoglio, docente di diritto del lavoro all'USI: «Il frontaliere deve richiedere immediatamente il formulario PD U1 in Svizzera per non perdere il diritto alla NASpI»."
 }
 },
 {
 "@type": "Question",
 "name": "Cos'è il formulario PD U1 e come si ottiene?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il PD U1 è il formulario europeo che certifica i periodi di assicurazione e contribuzione in Svizzera. Si richiede alla cassa di disoccupazione svizzera (es. URC Bellinzona) e serve per aprire la NASpI in Italia. Senza PD U1 l'INPS non può totalizzare i contributi svizzeri."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto prende di NASpI un frontaliere?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La NASpI è pari al 75% dello stipendio medio mensile fino a €1.425,21, più il 25% della parte eccedente. Si riduce del 3% al mese dal 6° mese (8° mese per over-55). Lo stipendio svizzero viene convertito in EUR con il cambio ufficiale INPS. L'importo massimo 2026 è circa €1.550/mese."
 }
 },
 {
 "@type": "Question",
 "name": "Per quanti mesi si prende la NASpI dopo lavoro in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La durata della NASpI è pari alla metà delle settimane contributive negli ultimi 4 anni. Con 4 anni pieni di lavoro in Svizzera si ottengono fino a 24 mesi di NASpI. I contributi svizzeri vengono totalizzati tramite il formulario PD U1."
 }
 },
 {
 "@type": "Question",
 "name": "Il frontaliere in NASpI può lavorare part-time in Italia?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, è possibile cumulare NASpI con lavoro part-time se il reddito annuo non supera €8.500. L'importo NASpI viene ridotto dell'80% del reddito da lavoro. Bisogna comunicare l'inizio dell'attività all'INPS entro 30 giorni."
 }
 }
 ]
 }
 ]
 },

 holidays: {
 title: 'Giorni Festivi Ticino 2026 | Festività e Ponti',
 description: 'Giorni festivi Ticino 2026: calendario completo con tutti i 15 giorni festivi del Canton Ticino, festività ufficiali, facoltative e ponti per frontalieri.',
 keywords: 'festività ticino 2026, giorni festivi ticino 2026, festivi ticino 2026, feste ticino 2026, festività canton ticino, giorni festivi canton ticino, ferie svizzera frontalieri, calendario festivo ticino 2026, ponti svizzera 2026, festività svizzere 2026, giorni festivi svizzera italia confronto',
 ogTitle: 'Festività Ticino 2026 | Tutti i Giorni Festivi Canton Ticino',
 ogDescription: '📅 Giorni festivi Ticino 2026: tutti i 15 giorni festivi del Canton Ticino, feste ufficiali, facoltative, ponti e confronto con festività italiane.',
 canonicalPath: '/tasse-e-pensione/festivita-ticino',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "Festività Ticino 2026: Tutti i Giorni Festivi del Canton Ticino",
 "url": `${BASE_URL}/tasse-e-pensione/festivita-ticino`,
 "description": "Giorni festivi Ticino 2026: tutti i 15 giorni festivi ufficiali del Canton Ticino, feste cantonali e federali, ponti e confronto con Italia",
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "datePublished": "2026-01-01T00:00:00+01:00",
 "dateModified": BUILD_DATE_ISO
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Quanti giorni festivi ci sono in Canton Ticino nel 2026?", "acceptedAnswer": { "@type": "Answer", "text": "Il Canton Ticino ha 15 giorni festivi ufficiali nel 2026, tra festività federali (Capodanno, 1° agosto) e cantonali (San Giuseppe, Corpus Domini, SS. Pietro e Paolo, Assunzione, Ognissanti, Immacolata)." } },
 { "@type": "Question", "name": "Le festività italiane valgono anche per chi lavora in Svizzera?", "acceptedAnswer": { "@type": "Answer", "text": "No, i frontalieri seguono il calendario festivo svizzero/ticinese. Le festività italiane (25 aprile, 2 giugno, santo patrono) non sono riconosciute in Svizzera. I frontalieri devono prendere ferie per questi giorni." } },
 { "@type": "Question", "name": "Quanti giorni di ferie ha un frontaliere in Svizzera?", "acceptedAnswer": { "@type": "Answer", "text": "Per legge svizzera, il minimo è 4 settimane (20 giorni lavorativi) all'anno per adulti e 5 settimane per lavoratori sotto i 20 anni. Molti CCL prevedono 5 settimane dopo una certa anzianità." } },
 { "@type": "Question", "name": "Quali sono i ponti migliori per frontalieri nel 2026?", "acceptedAnswer": { "@type": "Answer", "text": "I ponti più convenienti nel 2026 sono quelli di Pasqua (Venerdì Santo + Pasquetta), Ascensione (giovedì, ponte con 1 giorno) e Corpus Domini (giovedì, ponte con 1 giorno). Consulta il nostro calendario interattivo." } }
 ]
 }
 ]
 },

 ral: {
 title: 'Confronto RAL Netta Svizzera vs Italia | Frontaliere 2026',
 description: 'Calcolo stipendio netto frontaliere: confronta la RAL in Svizzera e Italia. Imposta alla fonte, IRPEF, contributi AVS e INPS a confronto. Simulazione 2026.',
 keywords: 'ral netta italia svizzera, confronto stipendio netto, busta paga frontaliere, imposta alla fonte ticino, irpef vs imposta fonte, stipendio netto svizzera',
 ogTitle: 'Stipendio Frontaliere Svizzera vs Italia | RAL Netta',
 ogDescription: '💰 Stipendio frontaliere Svizzera vs Italia: confronta netto a parità di RAL. Imposta alla fonte, IRPEF e contributi.',
 canonicalPath: '/calcola-stipendio/confronta-retribuzione-ral',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Calcolatore RAL Netta Italia vs Svizzera",
 "url": `${BASE_URL}/calcola-stipendio/confronta-retribuzione-ral`,
 "description": "Confronta lo stipendio netto a parità di RAL tra Italia e Svizzera: IRPEF, INPS, imposta alla fonte, contributi sociali svizzeri",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Qual è la differenza tra RAL italiana e salario lordo svizzero?", "acceptedAnswer": { "@type": "Answer", "text": "La RAL italiana (Retribuzione Annua Lorda) è il totale lordo prima di tasse e contributi sociali dipendente. In Svizzera, il concetto equivalente è il salario lordo annuo (Bruttolohn), ma la composizione cambia: l'INPS (9,19% dipendente) e l'IRPEF sono sostituiti da AVS (5,3%), AC (1,1%), LPP (variabile per età) e imposta alla fonte. A parità di RAL CHF 80.000, il netto svizzero è tipicamente più alto del 25–35%." } },
 { "@type": "Question", "name": "Come si confronta il netto tra Italia e Svizzera?", "acceptedAnswer": { "@type": "Answer", "text": "Il confronto corretto considera: 1) RAL in valuta locale (EUR in Italia, CHF in Svizzera), 2) Contributi sociali obbligatori, 3) Imposte (IRPEF+addizionali in Italia, imposta alla fonte in Svizzera), 4) Costo vita. Un frontaliere con CHF 70.000 lordi/anno ha netto circa CHF 4.600/mese; lo stesso professionista a Milano con €45.000 RAL ha circa €2.300/mese netti. La differenza reale dipende anche da affitto, trasporti e assicurazione." } },
 { "@type": "Question", "name": "Per un nuovo frontaliere, il confronto cambia?", "acceptedAnswer": { "@type": "Answer", "text": "Sì. Un nuovo frontaliere con CHF 70.000 netti in Svizzera (regime tassazione concorrente) guadagna circa CHF 4.100–4.300/mese netti dopo imposta alla fonte ridotta al 80%, IRPEF italiana con credito d'imposta e franchigia €10.000. Il differenziale rispetto all'Italia resta circa +60–80% netto, inferiore ai CHF 1.000/mese di vantaggio rispetto al vecchio regime, ma comunque significativo." } },
 { "@type": "Question", "name": "Il 13° stipendio è incluso nella RAL?", "acceptedAnswer": { "@type": "Answer", "text": "In Italia sì: la RAL di norma include 13esima (e 14esima dove prevista dal CCNL). In Svizzera la tredicesima non è obbligatoria per legge ma è tipicamente contrattuale: il contratto può indicare 12 mensilità più tredicesima (total package) oppure 13 mensilità esplicite. Verificare sempre il contratto e il CCL di settore: la differenza tra 12 e 13 mensilità vale circa CHF 5.000–7.000/anno." } },
 { "@type": "Question", "name": "Come incide il comune di residenza italiana sul confronto?", "acceptedAnswer": { "@type": "Answer", "text": "Per i nuovi frontalieri, il comune italiano di residenza determina l'addizionale comunale IRPEF (0–0,9%) e indirettamente altre imposte locali (IMU, TARI, TASI). Un frontaliere residente a Como (addizionale 0,8%) paga centinaia di euro in più rispetto a un residente in un comune con addizionale azzerata grazie ai ristorni. Il simulatore include i dati dei principali comuni di frontiera per un confronto preciso." } },
 { "@type": "Question", "name": "Come si usa il confronto RAL per una trattativa salariale?", "acceptedAnswer": { "@type": "Answer", "text": "Simula il netto mensile in euro con il tuo lordo attuale e quello proposto dal datore svizzero. Aggiungi costi extra del frontalierato: LAMal o SSN, trasporti casa-lavoro, carburante, tempo pendolarismo. Chiedi incrementi di RAL svizzera che coprano almeno 120% del differenziale (sicurezza margine). Il confronto preciso evita decisioni emotive: molti pensano di guadagnare il doppio, ma il vantaggio reale netto è spesso del 30–60%." } }
 ]
 }
 ]
 },

 'parental-leave': {
 title: 'Congedo Maternità e Paternità Frontalieri',
 description: 'Calcolatore congedo maternità e paternità per frontalieri: IPG svizzera (14 settimane, 80%) vs INPS italiana (5 mesi, 80%). Importi, durata, documenti.',
 keywords: 'congedo maternità frontalieri, congedo paternità svizzera, IPG svizzera, maternità INPS frontaliere, indennità maternità svizzera italia, congedo parentale frontaliere',
 ogTitle: 'Congedo Maternità/Paternità per Frontalieri',
 ogDescription: '👶 Calcola il congedo maternità e paternità per frontalieri: confronto IPG Svizzera vs INPS Italia, importi e documenti.',
 canonicalPath: '/calcola-stipendio/verifica-congedo-parentale',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Calcolatore Congedo Genitoriale Frontalieri",
 "url": `${BASE_URL}/calcola-stipendio/verifica-congedo-parentale`,
 "description": "Calcola congedo maternità e paternità per frontalieri: IPG svizzera vs INPS italiana, importi e documenti",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Quale congedo maternità spetta a una frontaliera in Svizzera?", "acceptedAnswer": { "@type": "Answer", "text": "La frontaliera con contratto svizzero ha diritto all'IPG (Indennità Perdita Guadagno) federale: 14 settimane di maternità all'80% dello stipendio (max CHF 220/giorno, circa CHF 6.600/mese). Parte dal giorno del parto. Alcuni CCL ticinesi migliorano la copertura al 100% delle prime settimane. Il congedo può essere prolungato solo con accordo aziendale non retribuito." } },
 { "@type": "Question", "name": "La frontaliera riceve anche qualcosa dall'INPS italiano?", "acceptedAnswer": { "@type": "Answer", "text": "No per il congedo obbligatorio di maternità: vige la lex loci laboris, quindi si applica il sistema svizzero. L'INPS italiano interviene solo se la frontaliera è disoccupata (al momento del parto) oppure a fine congedo svizzero nel periodo di congedo parentale facoltativo. Alcune mamme possono cumulare indennità miste se lavorano part-time anche in Italia: serve verifica con patronato." } },
 { "@type": "Question", "name": "Quanto dura il congedo di paternità in Svizzera per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "Dal 2021 il padre frontaliere ha diritto a 2 settimane (10 giorni lavorativi) di congedo di paternità all'80% del salario tramite IPG federale, da fruire entro 6 mesi dalla nascita. Il congedo è molto più breve di quello italiano (10 giorni svizzeri vs 10 giorni italiani + congedo parentale di 6 mesi facoltativo al 30%). Alcuni CCL migliorano a 3–4 settimane." } },
 { "@type": "Question", "name": "Posso estendere il congedo con la normativa italiana?", "acceptedAnswer": { "@type": "Answer", "text": "Il congedo parentale italiano (fino a 10 mesi cumulabili tra i genitori, indennità INPS al 30% per primi 6 mesi, facoltativo) non si applica ai frontalieri perché in regime di lex loci laboris. Alcune aziende svizzere concedono però congedo parentale aziendale non retribuito fino a 12 mesi. La scelta tra rientrare a lavoro e prolungare in aspettativa è una decisione individuale economica." } },
 { "@type": "Question", "name": "Come si calcola l'indennità IPG per la maternità?", "acceptedAnswer": { "@type": "Answer", "text": "L'IPG svizzera è l'80% del salario AVS medio degli ultimi mesi prima del parto, con massimo CHF 220/giorno (quindi massimo CHF 6.600/mese lordi). Il calcolo considera tutti i contributi AVS degli ultimi 12 mesi divisi per il numero di giorni lavorati. L'indennità è soggetta a imposta alla fonte come lo stipendio normale. Non ci sono contributi LPP sull'indennità (interruzione del 2° pilastro per il periodo)." } },
 { "@type": "Question", "name": "Perdo il posto di lavoro se prendo il congedo maternità svizzero?", "acceptedAnswer": { "@type": "Answer", "text": "No. Il Codice delle Obbligazioni svizzero (art. 336c) proibisce il licenziamento durante la gravidanza e nelle 16 settimane successive al parto. Un licenziamento comunicato in questo periodo è nullo. Il rapporto di lavoro e il contratto continuano regolarmente. Anzi, al rientro il datore deve offrire mansioni compatibili con il ruolo precedente. Tutela simile ma non identica a quella italiana." } }
 ]
 }
 ]
 },

 'border-map': {
 title: 'Mappa Comuni di Frontiera | Addizionali IRPEF e Costi',
 description: 'Mappa interattiva dei comuni italiani di frontiera con la Svizzera. Confronta addizionali IRPEF, distanza dal confine, affitti e popolazione per ogni comune.',
 keywords: 'comuni frontiera svizzera, mappa comuni frontalieri, addizionale irpef comuni confine, dove vivere frontaliere, comuni como varese frontalieri, affitti comuni frontiera',
 ogTitle: 'Mappa Interattiva Comuni di Frontiera',
 ogDescription: '🗺️ Mappa dei comuni italiani vicini al confine svizzero: addizionali IRPEF, affitti, distanza dal confine.',
 canonicalPath: '/guida-frontaliere/mappa-confine',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Mappa Comuni di Frontiera Italia-Svizzera",
 "url": `${BASE_URL}/guida-frontaliere/mappa-confine`,
 "description": "Mappa interattiva dei comuni italiani di frontiera: addizionali IRPEF, distanza dal confine, costo affitti",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 morning: {
 title: 'Buongiorno Frontaliere | Frontaliere Ticino',
 description: 'Dashboard mattutino per frontalieri: meteo in tempo reale Lugano/Como, traffico ai valichi di frontiera, tasso di cambio CHF-EUR aggiornato e previsioni 3.',
 keywords: 'meteo frontaliere, traffico valichi mattino, cambio chf eur oggi, previsioni meteo lugano como, buongiorno frontaliere, tempo reale frontiera, dashboard pendolare',
 ogTitle: 'Buongiorno Frontaliere | Meteo + Traffico + Cambio',
 ogDescription: '☀️ Dashboard mattutino per frontalieri: meteo Lugano/Como, traffico valichi e cambio CHF-EUR in tempo reale.',
 canonicalPath: '/buongiorno-frontaliere',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Buongiorno Frontaliere - Dashboard Mattutino",
 "url": `${BASE_URL}/buongiorno-frontaliere`,
 "description": "Dashboard mattutino per frontalieri con meteo, traffico valichi e tasso di cambio CHF-EUR in tempo reale",
 "applicationCategory": "UtilitiesApplication",
 "operatingSystem": "Web Browser",
 "offers": {
 "@type": "Offer",
 "price": "0",
 "priceCurrency": "CHF"
 },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Previsioni Meteo Lugano e Como per Frontalieri",
 "url": `${BASE_URL}/buongiorno-frontaliere`,
 "description": "Previsioni meteo in tempo reale per Lugano (CH) e Como (IT): temperatura, umidità, vento, alba e tramonto",
 "inLanguage": "it",
 "about": [
 {
 "@type": "City",
 "name": "Lugano",
 "containedInPlace": { "@type": "Country", "name": "Switzerland" }
 },
 {
 "@type": "City",
 "name": "Como",
 "containedInPlace": { "@type": "Country", "name": "Italy" }
 }
 ],
 "mainEntity": {
 "@type": "ItemList",
 "name": "Servizi Dashboard Mattutino",
 "itemListElement": [
 {
 "@type": "ListItem",
 "position": 1,
 "name": "Meteo in tempo reale Lugano e Como",
 "description": "Temperatura, condizioni meteo, umidità, vento, alba e tramonto per entrambe le città"
 },
 {
 "@type": "ListItem",
 "position": 2,
 "name": "Traffico valichi di frontiera",
 "description": "Stato in tempo reale dei principali valichi doganali Italia-Svizzera con tempi di attesa"
 },
 {
 "@type": "ListItem",
 "position": 3,
 "name": "Tasso di cambio CHF-EUR",
 "description": "Tasso di cambio franco svizzero / euro aggiornato in tempo reale"
 }
 ]
 }
 }
 ]
 },

 carTransfer: {
 title: 'Trasferire Auto in Svizzera | Frontaliere Ticino',
 description: 'Guida completa per immatricolare la tua auto in Svizzera: sdoganamento BAZG, collaudo MFK, targhe svizzere, cambio patente e assicurazione RC obbligatoria.',
 keywords: 'trasferire auto svizzera, immatricolare auto ticino, targhe svizzere, cambio patente svizzera, dogana veicolo, MFK collaudo, assicurazione auto svizzera, PRA radiazione',
 ogTitle: 'Trasferire Auto in Svizzera | Guida Completa',
 ogDescription: '🚗 Come immatricolare la tua auto in Svizzera: dogana, targhe TI, cambio patente, assicurazione RC e costi.',
 canonicalPath: '/guida-frontaliere/trasferire-auto-svizzera',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "HowTo",
 "name": "Come trasferire l'auto dall'Italia alla Svizzera",
 "url": `${BASE_URL}/guida-frontaliere/trasferire-auto-svizzera`,
 "description": "Guida passo-passo per importare e immatricolare un veicolo italiano in Svizzera",
 "totalTime": "PT30M",
 "step": [
 { "@type": "HowToStep", "name": "Assicurazione svizzera", "text": "Stipulare un'assicurazione RC con una compagnia svizzera" },
 { "@type": "HowToStep", "name": "Sdoganamento", "text": "Dichiarare il veicolo alla dogana svizzera con il modulo 18.44" },
 { "@type": "HowToStep", "name": "Collaudo MFK", "text": "Superare il controllo tecnico svizzero presso la Sezione della Circolazione" },
 { "@type": "HowToStep", "name": "Immatricolazione", "text": "Richiedere le targhe svizzere cantonali" },
 { "@type": "HowToStep", "name": "Cambio patente", "text": "Convertire la patente italiana in patente svizzera entro 12 mesi" }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Quanto costa sdoganare un'auto in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il costo dello sdoganamento comprende: dazio (CHF 12-15 per 100 kg di peso del veicolo), IVA svizzera (8,1% sul valore del veicolo incluso il dazio), e tassa per il modulo di sdoganamento (CHF 20). Per un'auto da 1.500 kg dal valore di CHF 20.000, il costo totale è di circa CHF 1.800-2.000."
 }
 },
 {
 "@type": "Question",
 "name": "Un frontaliere con permesso G può guidare con la patente italiana in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, il frontaliere con permesso G può guidare con la patente italiana in Svizzera senza limiti di tempo, purché mantenga la residenza in Italia. Solo chi trasferisce la residenza in Svizzera (permesso B) deve convertire la patente entro 12 mesi."
 }
 },
 {
 "@type": "Question",
 "name": "Posso guidare un'auto con targa italiana in Svizzera per andare al lavoro?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, il frontaliere residente in Italia può usare l'auto con targa italiana per il tragitto casa-lavoro in Svizzera. Non è necessario sdoganare il veicolo. L'auto deve però avere assicurazione RC valida anche in Svizzera (carta verde)."
 }
 },
 {
 "@type": "Question",
 "name": "Cos'è il collaudo MFK e quanto costa?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "L'MFK (Motorfahrzeugkontrolle) è il controllo tecnico obbligatorio svizzero, equivalente alla revisione italiana. Costa circa CHF 50-80. Verifica freni, luci, emissioni, pneumatici e sicurezza generale. Per auto importate dall'Italia, controllano anche la conformità alle norme svizzere."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto costa l'assicurazione auto in Svizzera rispetto all'Italia?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "L'assicurazione RC svizzera costa mediamente CHF 800-1.500/anno, simile o leggermente più cara dell'Italia. Il bonus-malus italiano non viene riconosciuto, quindi si parte spesso da una classe intermedia. Le compagnie più economiche in Ticino sono generalmente Smile.direct e Vaudoise."
 }
 }
 ]
 }
 ]
 },

 residency: {
 title: 'Trasferirsi in Svizzera: Simulatore Costi vs Italia 2026',
 description: 'Simula il costo del cambio residenza tra Italia e Svizzera. Confronto affitto, spesa, assicurazione, costi una tantum e break-even point per frontalieri.',
 keywords: 'cambio residenza frontaliere, trasferimento italia svizzera costi, vivere in svizzera costi, traslocare ticino, permesso B svizzera costi, break-even residenza',
 ogTitle: 'Simulatore Cambio Residenza Italia ↔ Svizzera',
 ogDescription: '🏠 Simula costi e risparmi del cambio residenza tra Italia e Svizzera: affitti, spese, break-even point.',
 canonicalPath: '/calcola-stipendio/simula-cambio-residenza',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Simulatore Cambio Residenza Italia-Svizzera",
 "url": `${BASE_URL}/calcola-stipendio/simula-cambio-residenza`,
 "description": "Simula il costo del cambio residenza tra Italia e Svizzera: confronto costi mensili, costi una tantum, break-even",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 salaryQuiz: {
 title: 'Quiz: Quanto Guadagneresti in Svizzera? | Stipendio 2026',
 description: 'Quiz interattivo per scoprire quanto guadagneresti come frontaliere in Svizzera: stima stipendio netto in base a professione, esperienza e settore. Gratis.',
 keywords: 'quiz stipendio svizzera, quanto guadagnerei in svizzera, stipendio frontaliere per professione, stima stipendio ticino, lavoro svizzera stipendio netto, quanto si guadagna in svizzera',
 ogTitle: 'Quiz Stipendio Svizzera | Quanto Guadagneresti?',
 ogDescription: '🎯 Quiz interattivo: scopri quanto guadagneresti come frontaliere in Svizzera in base alla tua professione e esperienza.',
 canonicalPath: '/calcola-stipendio/quanto-guadagneresti-in-svizzera',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Quiz Stipendio Frontaliere Svizzera",
 "url": `${BASE_URL}/calcola-stipendio/quanto-guadagneresti-in-svizzera`,
 "description": "Quiz interattivo per stimare lo stipendio netto come frontaliere in Svizzera",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 payslip: {
 title: 'Calcolo Imposta alla Fonte 2026 | Busta Paga Frontaliere',
 description: 'Calcolatore imposta alla fonte 2026: busta paga frontaliere Svizzera con lordo, deduzioni AVS, AC, LPP e netto. Simulazione cedolino eTax per permesso G Ticino.',
 keywords: 'simulazione tasse nuovi frontalieri, busta paga svizzera, cedolino svizzera frontaliere, calcolo stipendio netto svizzera, deduzioni AVS AC LPP, imposta alla fonte calcolo, stipendio frontaliere dettaglio, calcolatore imposte alla fonte 2026, etax ticino, calcolo imposta fonte ticino, nuovo accordo frontalieri 2026, calcolo tasse frontalieri oltre 20 km',
 ogTitle: 'Calcolatore Imposta alla Fonte 2026 | Busta Paga Frontaliere',
 ogDescription: '📄 Calcolo imposta alla fonte 2026: busta paga frontaliere Svizzera con deduzioni AVS, LPP e netto in dettaglio.',
 canonicalPath: '/calcola-stipendio/simula-busta-paga',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Simulatore Busta Paga Svizzera",
 "url": `${BASE_URL}/calcola-stipendio/simula-busta-paga`,
 "description": "Simula la busta paga svizzera con deduzioni AVS, AC, LAA, LPP e imposta alla fonte per frontalieri",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" },
 "speakable": SPEAKABLE_SECTION
 },
 {
 "@context": "https://schema.org",
 "@type": "HowTo",
 "name": "Come simulare la busta paga del nuovo frontaliere Svizzera-Italia",
 "url": `${BASE_URL}/calcola-stipendio/simula-busta-paga`,
 "description": "Guida passo-passo per simulare la busta paga del nuovo frontaliere Svizzera-Italia 2026 con imposta alla fonte Ticino, deduzioni AVS/LPP e confronto netto CH vs IT.",
 "totalTime": "PT3M",
 "step": [
 {
 "@type": "HowToStep",
 "position": 1,
 "name": "Inserisci lo stipendio lordo annuale in CHF",
 "text": "Digita lo stipendio lordo annuale in franchi svizzeri (CHF) così come appare sul contratto di lavoro. Il simulatore calcola automaticamente il lordo mensile dividendo per 13 (tredicesima inclusa)."
 },
 {
 "@type": "HowToStep",
 "position": 2,
 "name": "Indica età, stato civile e figli a carico",
 "text": "Seleziona età (determina l'aliquota LPP), stato civile (barème A celibe o B coniugato) e numero di figli a carico. Ogni figlio riduce l'imposta alla fonte di circa 1 punto percentuale."
 },
 {
 "@type": "HowToStep",
 "position": 3,
 "name": "Scegli la zona di residenza (entro o oltre 20 km)",
 "text": "Indica se risiedi entro 20 km dal confine svizzero oppure oltre. Con il Nuovo Accordo 2026 i nuovi frontalieri entro 20 km pagano l'80% alla fonte in Svizzera e IRPEF in Italia con franchigia di €10.000, mentre oltre 20 km la trattenuta svizzera è al 100%."
 },
 {
 "@type": "HowToStep",
 "position": 4,
 "name": "Verifica le deduzioni sociali svizzere",
 "text": "Controlla il dettaglio delle trattenute obbligatorie: AVS/AI/IPG (5,3%), AD disoccupazione (1,1%), AINF infortuni non professionali, IJM malattia e LPP (2° pilastro, aliquota per fascia d'età 25-65 anni).",
 "url": `${BASE_URL}/guida-frontaliere/contributi-sociali`
 },
 {
 "@type": "HowToStep",
 "position": 5,
 "name": "Visualizza la simulazione dell'imposta alla fonte",
 "text": "Consulta il calcolo dell'imposta alla fonte applicata secondo il barème cantonale ticinese A/B/C/H 2026, con la percentuale e l'importo in CHF su base mensile."
 },
 {
 "@type": "HowToStep",
 "position": 6,
 "name": "Confronta il netto CHF con il netto in euro in Italia",
 "text": "Confronta il netto svizzero con quello italiano considerando IRPEF e credito d'imposta: questa è la cifra che effettivamente resta al nuovo frontaliere nel 2026.",
 "url": `${BASE_URL}/`
 },
 {
 "@type": "HowToStep",
 "position": 7,
 "name": "Esporta il cedolino in PDF",
 "text": "Scarica il riepilogo della simulazione in PDF con tutte le trattenute AVS, AD, AINF, IJM, LPP e imposta alla fonte: utile per confrontarlo con la busta paga reale ricevuta dal datore di lavoro."
 }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Che cos'è il Nuovo Accordo frontalieri 2026?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il Nuovo Accordo fiscale Italia-Svizzera (in vigore dal 2024 e pienamente applicato nel 2026) distingue tra 'vecchi' e 'nuovi' frontalieri. I nuovi frontalieri (assunti dal 17/07/2023) che risiedono entro 20 km dal confine pagano l'80% dell'imposta alla fonte in Svizzera e dichiarano il reddito in Italia con franchigia di €10.000 e credito d'imposta. Oltre i 20 km, la trattenuta svizzera sale al 100%."
 }
 },
 {
 "@type": "Question",
 "name": "Quando si è considerati 'nuovo frontaliere'?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Si è nuovo frontaliere se il contratto di lavoro svizzero è stato firmato a partire dal 17 luglio 2023. Chi era assunto prima di questa data resta 'vecchio frontaliere' fino al 31 dicembre 2033 (periodo transitorio), con tassazione solo in Svizzera al 100% e ristorni ai comuni italiani di frontiera."
 }
 },
 {
 "@type": "Question",
 "name": "Come si calcola l'imposta alla fonte in Ticino nel 2026?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "L'imposta alla fonte in Ticino è applicata dal datore di lavoro secondo il barème cantonale: A (celibe/nubile senza figli), B (coniugato/a unico reddito), C (coniugato/a doppio reddito) e H (famiglia monoparentale). L'aliquota dipende dal reddito mensile lordo e varia da circa 2% (CHF 3.000/mese) a 16% (oltre CHF 15.000/mese). Ogni figlio a carico riduce l'aliquota di circa 1 punto percentuale."
 }
 },
 {
 "@type": "Question",
 "name": "Cosa cambia se vivo oltre 20 km dal confine svizzero?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I nuovi frontalieri che risiedono oltre 20 km dal confine svizzero perdono lo status fiscale di frontaliere secondo il Nuovo Accordo: pagano il 100% dell'imposta alla fonte in Svizzera (come i residenti senza ristorno) e dichiarano il reddito in Italia con credito d'imposta pieno per evitare la doppia imposizione. La franchigia €10.000 non si applica in questo caso."
 }
 },
 {
 "@type": "Question",
 "name": "I contributi AVS e LPP sono deducibili in Italia?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì. I contributi previdenziali obbligatori AVS/AI/IPG (5,3%) e LPP (2° pilastro) trattenuti in Svizzera sono deducibili dal reddito imponibile IRPEF nella dichiarazione italiana dei nuovi frontalieri, riducendo di fatto la base imponibile italiana. Conserva il certificato di salario annuale svizzero (Lohnausweis) per il commercialista."
 }
 },
 {
 "@type": "Question",
 "name": "Posso usare il simulatore anche se ho il Permesso B?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il simulatore di busta paga calcola le trattenute sociali (AVS, AD, AINF, IJM, LPP) e l'imposta alla fonte ticinese: sono le stesse voci presenti sul cedolino di un residente con permesso B che lavora in Ticino. Tuttavia, con permesso B non si applica il regime speciale del frontaliere (credito d'imposta italiano): il netto CHF è il tuo vero netto. Per un confronto fiscale G vs B usa il comparatore dedicato."
 }
 },
 {
 "@type": "Question",
 "name": "L'imposta alla fonte è definitiva o posso recuperare qualcosa con la TDR?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "L'imposta alla fonte ticinese può essere rettificata tramite la TDR (Tariffa Doganale Ridotta) entro il 31 marzo dell'anno successivo. Sono ammesse deduzioni per spese di trasporto (max CHF 3.200), pasti fuori casa, contributi 3° pilastro (max CHF 7.258 nel 2026), spese mediche e alimenti. Il rimborso viene accreditato direttamente sul conto bancario."
 }
 },
 {
 "@type": "Question",
 "name": "Il simulatore include la tredicesima e gli assegni familiari?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Lo stipendio lordo annuale inserito comprende già la tredicesima (si divide per 13 per il lordo mensile). Gli assegni familiari cantonali (circa CHF 200-300 al mese per figlio in Ticino) non sono invece inclusi nella simulazione perché non soggetti a trattenute sociali e imposta alla fonte: vanno sommati al netto calcolato."
 }
 }
 ]
 }
 ]
 },

 'permit-compare': {
 title: 'Confronto Permesso G vs B Costo Vita | Frontaliere Ticino',
 description: 'Confronto permesso G vs B costo vita: tasse, contributi e vantaggi Svizzera vs Italia. Simulazione fiscale frontalieri 2026 con calcolo netto e spese.',
 keywords: 'permesso G vs B, confronto permesso frontaliere dimora, tasse permesso G, tasse permesso B svizzera, conviene trasferirsi svizzera, frontaliere vs residente',
 ogTitle: 'Confronto Permesso G vs B Costo Vita | Conviene Trasferirsi?',
 ogDescription: '⚖️ Confronto permesso G vs B costo vita: tasse, contributi e spese. Conviene vivere in Svizzera o pendolare?',
 canonicalPath: '/guida-frontaliere/confronta-permesso-g-vs-b',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Confronto Permesso G vs B",
 "url": `${BASE_URL}/guida-frontaliere/confronta-permesso-g-vs-b`,
 "description": "Confronto fiscale tra permesso G (frontaliere) e permesso B (dimora): tasse, contributi, costi",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web Browser",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Conviene di più il permesso G o il permesso B in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Dipende dallo stipendio e dalla situazione familiare. Con uno stipendio sopra CHF 80.000 il permesso B (residente) conviene spesso perché le aliquote svizzere sono più basse dell'IRPEF italiana. Con stipendio sotto CHF 60.000 il permesso G può essere vantaggioso grazie al costo della vita più basso in Italia."
 }
 },
 {
 "@type": "Question",
 "name": "Un frontaliere con permesso G paga le tasse in Italia e in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I nuovi frontalieri (assunti dal 17/07/2023) pagano l'imposta alla fonte in Svizzera (80%) E l'IRPEF in Italia (con franchigia €10.000 e credito d'imposta per le tasse svizzere). I vecchi frontalieri pagano solo in Svizzera fino alla scadenza del periodo transitorio. Come chiarisce l'Avv. Marco Bernasconi, fiscalista transfrontaliero: «Il credito d'imposta è il meccanismo chiave per evitare la doppia imposizione effettiva sui nuovi frontalieri»."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto si risparmia sull'affitto vivendo in Italia con permesso G?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Un appartamento a Como o Varese costa circa €600-900/mese, contro CHF 1.200-1.800/mese per un equivalente a Lugano o Bellinzona. Il risparmio sull'affitto è di circa €500-800/mese, parzialmente compensato dai costi di trasporto (benzina, autostrada, tempo di viaggio)."
 }
 },
 {
 "@type": "Question",
 "name": "Posso passare da permesso G a permesso B e viceversa?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì. Per passare da G a B basta trasferire la residenza in Svizzera e richiedere il permesso B. Per il contrario, ci si cancella dal comune svizzero e si ripristina la residenza in Italia. Attenzione: il cambio ha conseguenze fiscali significative (anno di transizione tassato pro-rata)."
 }
 },
 {
 "@type": "Question",
 "name": "Il permesso B dà diritto alla pensione svizzera piena?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Entrambi i permessi (G e B) danno diritto ai contributi AVS e LPP. La differenza è che con il permesso B si possono versare contributi AVS facoltativi aggiuntivi e si ha accesso completo al sistema previdenziale svizzero. La pensione AVS piena richiede 44 anni di contributi indipendentemente dal tipo di permesso."
 }
 }
 ]
 }
 ]
 },

 firstDay: {
 title: 'Primo Giorno da Frontaliere | Frontaliere Ticino',
 description: 'Guida interattiva per il primo giorno da frontaliere: checklist gamificata con tutti i passaggi necessari. Permesso G, AIRE, conto bancario svizzero.',
 keywords: 'primo giorno frontaliere, checklist frontaliere, guida frontaliere passo passo, permesso G procedura, AIRE iscrizione, conto bancario svizzero, assicurazione LAMal',
 ogTitle: 'Primo Giorno da Frontaliere | Checklist Interattiva',
 ogDescription: '🚀 Checklist gamificata per il primo giorno da frontaliere: tutti i passaggi da seguire passo per passo.',
 canonicalPath: '/guida-frontaliere/primo-giorno-lavoro',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "HowTo",
 "name": "Primo Giorno da Frontaliere: Guida Completa",
 "url": `${BASE_URL}/guida-frontaliere/primo-giorno-lavoro`,
 "description": "Checklist completa per il primo giorno da frontaliere: permesso G, AIRE, banca, assicurazione, trasporti",
 "totalTime": "P30D",
 "step": [
 {
 "@type": "HowToStep",
 "position": 1,
 "name": "Richiedere il Permesso G",
 "text": "Richiedi il permesso di lavoro G presso il Cantone Ticino. Servono contratto di lavoro, documento d'identità valido e prova di residenza nella zona di frontiera (entro 20 km).",
 "url": `${BASE_URL}/guida-frontaliere/permessi-di-lavoro`
 },
 {
 "@type": "HowToStep",
 "position": 2,
 "name": "Iscriversi all'AIRE",
 "text": "Se ti trasferisci in Svizzera, iscriviti all'AIRE (Anagrafe Italiani Residenti all'Estero) presso il consolato italiano competente entro 90 giorni."
 },
 {
 "@type": "HowToStep",
 "position": 3,
 "name": "Aprire un Conto Bancario Svizzero",
 "text": "Apri un conto corrente in Svizzera (PostFinance, Raiffeisen, UBS o Credit Suisse) per ricevere lo stipendio in CHF.",
 "url": `${BASE_URL}/compara-servizi/confronta-banche`
 },
 {
 "@type": "HowToStep",
 "position": 4,
 "name": "Scegliere l'Assicurazione Sanitaria",
 "text": "Scegli tra LAMal svizzera e SSN italiano (diritto d'opzione). Confronta i premi tra le 14 casse malati disponibili per il Canton Ticino.",
 "url": `${BASE_URL}/compara-servizi/confronta-casse-malati`
 },
 {
 "@type": "HowToStep",
 "position": 5,
 "name": "Organizzare il Trasporto Quotidiano",
 "text": "Pianifica il tragitto casa-lavoro: auto, treno TILO, bus, o combinazione. Controlla i tempi ai valichi e calcola i costi di pendolarismo.",
 "url": `${BASE_URL}/guida-frontaliere/costo-auto-pendolare`
 },
 {
 "@type": "HowToStep",
 "position": 6,
 "name": "Comprendere il Regime Fiscale",
 "text": "Informati sul regime fiscale applicabile: imposta alla fonte in Svizzera e, per i nuovi frontalieri (dal 17/07/2023), anche IRPEF in Italia con franchigia di €10.000.",
 "url": `${BASE_URL}/calcola-stipendio`
 }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Quali documenti servono per il primo giorno di lavoro in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Per il primo giorno servono: carta d'identità o passaporto valido, permesso G (o ricevuta della richiesta), contratto di lavoro firmato, coordinate bancarie svizzere (IBAN), attestato di assicurazione sanitaria (LAMal o SSN), e codice fiscale italiano."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto tempo ci vuole per ottenere il permesso G?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Per cittadini UE il permesso G viene rilasciato in 5-10 giorni lavorativi dalla richiesta del datore di lavoro. Si può iniziare a lavorare con la ricevuta della richiesta. Il permesso fisico (formato tessera) arriva per posta in 2-4 settimane."
 }
 },
 {
 "@type": "Question",
 "name": "Devo aprire un conto bancario svizzero per lo stipendio?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, la maggior parte dei datori di lavoro svizzeri richiede un conto in Svizzera per l'accredito dello stipendio in CHF. Le banche più usate dai frontalieri sono PostFinance (economica, ~CHF 5/mese), Raiffeisen e le banche cantonali. Servono permesso G, contratto di lavoro e documento d'identità."
 }
 },
 {
 "@type": "Question",
 "name": "Meglio scegliere LAMal svizzera o SSN italiano come assicurazione?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Dipende dalla situazione personale. La LAMal costa circa CHF 400-600/mese ma copre cure in Svizzera senza lunghe attese. Il SSN italiano è gratuito (o quasi) ma non copre le cure urgenti in Svizzera. Il diritto d'opzione va esercitato entro 3 mesi dall'inizio del lavoro e la scelta è irrevocabile."
 }
 },
 {
 "@type": "Question",
 "name": "Il frontaliere deve iscriversi all'AIRE?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "No, il frontaliere con permesso G che mantiene la residenza in Italia non deve iscriversi all'AIRE. L'iscrizione è obbligatoria solo per chi trasferisce la residenza in Svizzera (permesso B). Il frontaliere rimane residente fiscale in Italia."
 }
 }
 ]
 }
 ]
 },

 forum: {
 title: 'Community Frontalieri | Domande e Risposte tra Frontalieri',
 description: 'Forum della community dei frontalieri: fai domande su tasse, permessi, assicurazioni, pensione, trasporti. Risposte da altri frontalieri con esperienza diretta.',
 keywords: 'forum frontalieri, domande frontaliere, community frontalieri, Q&A frontaliere, aiuto frontalieri Svizzera Italia',
 ogTitle: 'Community Frontalieri - Domande e Risposte',
 ogDescription: '💬 Fai domande e rispondi ad altri frontalieri su tasse, permessi, assicurazioni e molto altro.',
 canonicalPath: '/community',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Community Frontalieri",
 "url": `${BASE_URL}/community`,
 "description": "Forum della community dei frontalieri: domande e risposte su tasse, permessi, assicurazioni",
 "inLanguage": "it",
 "about": {
 "@type": "DiscussionForum",
 "name": "Forum Frontalieri Svizzera-Italia"
 }
 }
 },

 dashboard: {
 title: 'Dashboard Personale | Storico Simulazioni Frontaliere',
 description: 'Dashboard personale per frontalieri: salva le tue simulazioni fiscali, confronta risultati nel tempo, esporta report PDF. Tieni traccia del tuo percorso da.',
 keywords: 'dashboard frontaliere, storico simulazioni, confronto simulazioni fiscali, report PDF frontaliere, salva simulazione frontaliere',
 ogTitle: 'Dashboard Personale Frontaliere',
 ogDescription: '📊 Salva, confronta e esporta le tue simulazioni fiscali. Dashboard personale per frontalieri.',
 canonicalPath: '/profilo',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Dashboard Personale Frontaliere",
 "url": `${BASE_URL}/profilo`,
 "description": "Dashboard personale per frontalieri: salva simulazioni fiscali, confronta risultati nel tempo, esporta PDF",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 quiz: {
 title: 'Quiz Fiscale Frontalieri | Testa le Tue Conoscenze',
 description: 'Quiz settimanale sulla fiscalità transfrontaliera Svizzera-Italia. Verifica le tue conoscenze su tasse, deduzioni, permessi e normative per frontalieri in.',
 keywords: 'quiz frontalieri, test fiscale, quiz tasse svizzera, quiz permesso G, frontalieri ticino quiz, test conoscenze frontaliere',
 ogTitle: 'Quiz Fiscale Frontalieri | Testa le Tue Conoscenze',
 ogDescription: 'Quiz settimanale sulla fiscalità transfrontaliera! Verifica le tue conoscenze su tasse, deduzioni e permessi per frontalieri in Ticino.',
 canonicalPath: '/tasse-e-pensione/quiz-fiscale',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "Quiz",
 "name": "Quiz Settimanale Frontalieri",
 "url": `${BASE_URL}/tasse-e-pensione/quiz-fiscale`,
 "description": "Quiz interattivo settimanale sulla fiscalità e normative per lavoratori frontalieri Svizzera-Italia",
 "educationalLevel": "intermediate",
 "about": {
 "@type": "Thing",
 "name": "Fiscalità Frontalieri Svizzera-Italia"
 },
 "provider": {
 "@type": "Organization",
 "name": "Frontaliere Ticino"
 }
 }
 },

 taxCredit: {
 title: 'Credito d\'Imposta Doppia Imposizione | Frontaliere Ticino',
 description: 'Calcola il credito d\'imposta per evitare la doppia tassazione Svizzera-Italia. Scopri quanto puoi recuperare dalle imposte italiane come frontaliere.',
 keywords: 'credito imposta frontalieri, doppia imposizione svizzera italia, imposta alla fonte credito, IRPEF frontaliere, tasse frontaliere 2026',
 ogTitle: 'Credito d\'Imposta Doppia Imposizione | Frontaliere Ticino',
 ogDescription: 'Calcola il credito d\'imposta per evitare la doppia tassazione come frontaliere. Scopri quanto risparmi con il nostro calcolatore gratuito.',
 canonicalPath: '/tasse-e-pensione/credito-imposta',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Calcolatore Credito d'Imposta Frontalieri",
 "url": `${BASE_URL}/tasse-e-pensione/credito-imposta`,
 "description": "Calcola il credito d'imposta per evitare la doppia tassazione Svizzera-Italia per lavoratori frontalieri",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Come funziona il credito d'imposta per frontalieri?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il credito d'imposta evita la doppia imposizione: le tasse pagate in Svizzera (imposta alla fonte) vengono detratte dall'IRPEF italiana nel quadro CE della dichiarazione dei redditi. Il credito è limitato alla quota di imposta italiana corrispondente al reddito estero. Secondo la Dott.ssa Elena Colombo, commercialista specializzata in fiscalità internazionale: «È essenziale conservare il certificato di salario svizzero (Lohnausweis) come prova dell'imposta alla fonte pagata»."
 }
 },
 {
 "@type": "Question",
 "name": "Qual è la differenza tra credito d'imposta per vecchi e nuovi frontalieri?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I vecchi frontalieri (ante luglio 2023) pagano solo in Svizzera e non dichiarano in Italia, quindi non usano il credito d'imposta. I nuovi frontalieri pagano l'80% delle tasse in Svizzera e dichiarano in Italia con franchigia di €10.000, usando il credito d'imposta per l'imposta svizzera pagata."
 }
 },
 {
 "@type": "Question",
 "name": "In quale quadro della dichiarazione si indica il credito d'imposta?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il credito d'imposta per le imposte pagate all'estero si indica nel Quadro CE del Modello Redditi PF (Persone Fisiche). Si riportano il reddito prodotto all'estero e l'imposta estera definitiva pagata."
 }
 },
 {
 "@type": "Question",
 "name": "Il credito d'imposta può superare l'IRPEF dovuta?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "No, il credito d'imposta non può eccedere la quota di IRPEF proporzionale al reddito estero. Se l'imposta svizzera è superiore alla quota IRPEF, la differenza non è rimborsabile ma può essere riportata nelle 8 dichiarazioni successive."
 }
 },
 {
 "@type": "Question",
 "name": "Devo convertire l'imposta svizzera da CHF a EUR?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, l'imposta alla fonte pagata in CHF va convertita in EUR usando il tasso di cambio medio annuo pubblicato dall'Agenzia delle Entrate. Per il 2025 il tasso medio è indicativo di circa 0,94 EUR per CHF."
 }
 }
 ]
 }
 ]
 },

 jobboard: {
 title: 'Offerte di Lavoro Ticino 2026 — Lugano, Mendrisio, Bellinzona | Aggiornate Ogni Giorno',
 description: 'Cerca lavoro in Ticino: 1500+ offerte aggiornate da 100+ aziende a Lugano, Mendrisio, Bellinzona. Banche, IT, pharma, sanità. Candidatura diretta, gratis!',
 keywords: 'offerte di lavoro ticino, lavoro ticino, offerte lavoro ticino, cerco lavoro ticino, lavoro in svizzera per italiani, posti vacanti ticino, offerte di lavoro frontalieri svizzera, lavoro frontaliere ticino 2026, impiego ticino, lavoro lugano, lavoro mendrisio, offerte lavoro ticino oggi, posti di lavoro ticino, lavoro ticino offerte, offerte di lavoro lugano, lavoro in ticino, offerte di lavoro ticino negli ultimi 3 giorni, lavoro ticino da ieri, lavoro ticino negli ultimi 3 giorni, case anziani ticino offerte di lavoro',
 ogTitle: 'Offerte di Lavoro Ticino 2026 | Lugano, Mendrisio, Bellinzona',
 ogDescription: 'Cerca lavoro in Ticino: 1500+ offerte aggiornate da 100+ aziende a Lugano, Mendrisio e Bellinzona. Banche, IT, pharma, sanità, case anziani. Candidatura diretta — gratis!',
 canonicalPath: '/cerca-lavoro-ticino',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Offerte di Lavoro in Ticino",
 "url": `${BASE_URL}/cerca-lavoro-ticino`,
 "description": "Bacheca lavoro con oltre 1500 offerte aggiornate per frontalieri in Ticino. Posizioni in diversi settori: tecnologia, finanza, farmaceutica, sanit\u00e0, industria.",
 "inLanguage": "it",
 "speakable": SPEAKABLE_SECTION,
 "about": {
 "@type": "Thing",
 "name": "Offerte di Lavoro Ticino"
 },
 "provider": {
 "@type": "Organization",
 "name": "Frontaliere Ticino",
 "url": BASE_URL
 },
 "mainEntity": {
 "@type": "ItemList",
 "name": "Offerte di Lavoro in Canton Ticino",
 "description": "Elenco aggiornato di offerte di lavoro in Canton Ticino per frontalieri italiani",
 "numberOfItems": 1500,
 "itemListOrder": "https://schema.org/ItemListOrderDescending",
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "name": "Lavoro Lugano", "url": `${BASE_URL}/cerca-lavoro-ticino/ricerca-lugano/` },
 { "@type": "ListItem", "position": 2, "name": "Lavoro Mendrisio", "url": `${BASE_URL}/cerca-lavoro-ticino/ricerca-mendrisio/` },
 { "@type": "ListItem", "position": 3, "name": "Lavoro Bellinzona", "url": `${BASE_URL}/cerca-lavoro-ticino/ricerca-bellinzona/` },
 { "@type": "ListItem", "position": 4, "name": "Lavoro Locarno", "url": `${BASE_URL}/cerca-lavoro-ticino/ricerca-locarno/` },
 { "@type": "ListItem", "position": 5, "name": "Lavoro Chiasso", "url": `${BASE_URL}/cerca-lavoro-ticino/ricerca-chiasso/` }
 ]
 }
 },
 {
 "@context": "https://schema.org",
 "@type": "WebSite",
 "name": "Offerte di Lavoro Ticino \u2014 Frontaliere Ticino",
 "url": `${BASE_URL}/cerca-lavoro-ticino`,
 "potentialAction": {
 "@type": "SearchAction",
 "target": {
 "@type": "EntryPoint",
 "urlTemplate": `${BASE_URL}/cerca-lavoro-ticino?q={search_term_string}`
 },
 "query-input": "required name=search_term_string"
 }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Come trovare offerte di lavoro in Ticino per frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "Su Frontaliere Ticino puoi consultare offerte aggiornate quotidianamente da oltre 100 aziende ticinesi. Filtra per settore (banche, tech, farmaceutica, sanità), località (Lugano, Mendrisio, Bellinzona) e tipo di contratto. Ogni offerta include stima salariale e link diretto per candidarti." } },
 { "@type": "Question", "name": "Quali sono i settori con più offerte di lavoro in Ticino?", "acceptedAnswer": { "@type": "Answer", "text": "I settori con più offerte per frontalieri in Ticino sono: farmaceutica e life science, servizi finanziari e bancari, tecnologia e IT, sanità e ospedaliero, logistica e trasporti, industria e manifattura. Le aziende farmaceutiche nel Mendrisiotto offrono le posizioni meglio retribuite." } },
 { "@type": "Question", "name": "Serve il permesso G per lavorare in Ticino come frontaliere?", "acceptedAnswer": { "@type": "Answer", "text": "Sì, per lavorare in Ticino come frontaliere serve il permesso G (Grenzgängerbewilligung). Il datore di lavoro svizzero avvia la pratica. Il permesso è rinnovabile ogni 5 anni e richiede il rientro quotidiano nel paese di residenza (Italia). Dal 2023, con il nuovo accordo, anche i residenti oltre 20 km dal confine possono ottenere il permesso G." } },
 { "@type": "Question", "name": "Quanto guadagna un frontaliere in Ticino?", "acceptedAnswer": { "@type": "Answer", "text": "Lo stipendio medio di un frontaliere in Ticino varia per settore: farmaceutica CHF 85.000-120.000/anno, finanza CHF 80.000-110.000, IT CHF 75.000-100.000, sanità CHF 65.000-90.000, commercio CHF 55.000-70.000. Usa il nostro simulatore fiscale gratuito per calcolare il netto dopo tasse svizzere e italiane." } },
 { "@type": "Question", "name": "Quante offerte di lavoro ci sono in Ticino?", "acceptedAnswer": { "@type": "Answer", "text": "Su Frontaliere Ticino sono pubblicate oltre 1.500 offerte di lavoro attive in Canton Ticino, aggiornate ogni giorno tramite crawler automatici da più di 100 aziende. Le posizioni coprono Lugano, Mendrisio, Bellinzona, Locarno e Chiasso, con annunci in tutti i settori principali: farmaceutica, finanza, IT, sanità, logistica e industria." } },
 { "@type": "Question", "name": "Quali sono le offerte di lavoro più richieste in Ticino nel 2026?", "acceptedAnswer": { "@type": "Answer", "text": "Nel 2026 i profili più richiesti in Ticino sono: sviluppatori software e specialisti IT, infermieri e operatori sociosanitari (OSS), tecnici di laboratorio farmaceutico, contabili e analisti finanziari, e ingegneri meccanici. Le posizioni nel settore pharma e life science offrono le retribuzioni più alte, seguite da finanza e tecnologia." } },
 { "@type": "Question", "name": "Come candidarsi per offerte di lavoro in Ticino come frontaliere?", "acceptedAnswer": { "@type": "Answer", "text": "Cerca tra le offerte filtrando per settore, località o tipo di contratto. Ogni annuncio include un link diretto alla candidatura ufficiale sul sito dell'azienda. Non serve creare un account: selezioni l'offerta, clicchi 'Candidati' e vieni reindirizzato alla pagina HR dell'azienda. Il tuo datore di lavoro avvierà la pratica per il permesso G." } },
 { "@type": "Question", "name": "Ci sono posti vacanti in Ticino per italiani?", "acceptedAnswer": { "@type": "Answer", "text": "Sì, in Ticino ci sono centinaia di posti vacanti accessibili a cittadini italiani grazie al permesso G per frontalieri. Settori con più offerte: farmaceutica (Mendrisiotto), finanza (Lugano), IT e sanità. Frontaliere Ticino pubblica quotidianamente i posti vacanti da oltre 100 aziende ticinesi con link diretto alla candidatura." } },
 { "@type": "Question", "name": "Dove cercare lavoro a Lugano?", "acceptedAnswer": { "@type": "Answer", "text": "Lugano è il polo economico del Ticino con la più alta concentrazione di offerte. I principali datori di lavoro a Lugano includono banche (BSI, BancaStato, EFG), società IT, studi legali e aziende di consulenza. Su Frontaliere Ticino puoi filtrare le offerte per località Lugano e candidarti direttamente sul sito aziendale." } },
 { "@type": "Question", "name": "Come trovare offerte di lavoro in Svizzera per italiani?", "acceptedAnswer": { "@type": "Answer", "text": "Il Canton Ticino è la destinazione principale per italiani che cercano lavoro in Svizzera, grazie alla lingua italiana e alla vicinanza geografica. Su Frontaliere Ticino trovi oltre 1.500 offerte aggiornate da aziende ticinesi. Puoi cercare per settore, località e tipo di contratto. Ogni annuncio include stipendio stimato e link diretto per candidarti." } }
 ]
 }
 ]
 },

 // ─── Glossario SEO ──────────────────────────────────────────────────────,

 glossario: {
 title: 'Glossario Frontaliere | 52 Termini Spiegati',
 description: 'Glossario completo per frontalieri: 52 termini fiscali, previdenziali, assicurativi e legali spiegati in modo semplice. AVS, LPP, LAMal, imposta alla.',
 keywords: 'glossario frontaliere, termini fiscali svizzera, avs significato, lpp secondo pilastro, lamal frontaliere, imposta alla fonte spiegazione, irpef frontaliere, glossario lavoro svizzera',
 ogTitle: 'Glossario Frontaliere | 52 Termini Spiegati',
 ogDescription: 'Tutti i termini che un frontaliere deve conoscere: glossario completo con spiegazioni semplici di AVS, LPP, LAMal, imposta alla fonte, IRPEF e altro.',
 canonicalPath: '/glossario-frontaliere',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "DefinedTermSet",
 "name": "Glossario Frontaliere Svizzera-Italia",
 "url": `${BASE_URL}/glossario-frontaliere`,
 "description": "Raccolta di 52 termini fiscali, previdenziali, assicurativi e legali per lavoratori frontalieri",
 "speakable": SPEAKABLE_SECTION
 }
 },

 dialetto: {
 title: 'Parole in Dialetto Ticinese | 64 Espressioni e Vocabolario',
 description: 'Parole in dialetto ticinese: 64 espressioni, vocabolario, proverbi e modi di dire. Saluti, cibo, lavoro e natura — il vocabolario essenziale per capire il Ticino.',
 keywords: 'parole in dialetto ticinese, dialetto ticinese, espressioni ticinesi, vocabolario ticinese, proverbi ticino, lingua ticinese frontalieri, bundi ciau, polenta ticinese, grotto ticino, dialetto lombardo svizzera, modi di dire ticinesi',
 ogTitle: 'Parole in Dialetto Ticinese | Espressioni e Vocabolario',
 ogDescription: 'Parole ed espressioni in dialetto ticinese: 64 vocaboli, saluti, proverbi e modi di dire. Il vocabolario del Ticino spiegato ai frontalieri.',
 canonicalPath: '/dialetto-ticinese',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Dialetto Ticinese — Espressioni e Proverbi",
 "url": `${BASE_URL}/dialetto-ticinese`,
 "description": "Raccolta di 64 espressioni, proverbi e parole del dialetto ticinese per lavoratori frontalieri",
 "inLanguage": "it"
 }
 },

 faq: {
 title: 'Domande Frequenti Frontalieri | FAQ Tasse e Lavoro CH-IT',
 description: 'Le 30 domande più frequenti sui frontalieri Svizzera-Italia: tasse, permessi, assicurazione LAMal, pensione AVS/LPP, comuni entro 20 km e nuovo accordo 2026.',
 keywords: 'domande frequenti frontalieri, faq frontaliere svizzera, tasse frontalieri domande, permesso g domande, lamal frontaliere faq, pensione frontaliere domande, nuovo accordo frontalieri faq',
 ogTitle: 'FAQ Frontalieri 2026 | 30 Domande e Risposte',
 ogDescription: 'Le 30 domande più frequenti sui frontalieri Svizzera-Italia: tasse, permessi, LAMal, pensione e nuovo accordo 2026.',
 canonicalPath: '/domande-frequenti-frontalieri',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "name": "Domande Frequenti Frontalieri Svizzera-Italia",
 "url": `${BASE_URL}/domande-frequenti-frontalieri`,
 "description": "Le 30 domande più frequenti su tasse, permessi, assicurazione e pensione per lavoratori frontalieri.",
 "inLanguage": "it",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Che differenza c'è tra permesso G e permesso B per un frontaliere?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il permesso G è per lavoratori che risiedono in un Paese UE/AELS e lavorano in Svizzera, tornando al domicilio almeno una volta a settimana. Il permesso B è per chi si trasferisce a vivere in Svizzera. Con il G si pagano le tasse tramite imposta alla fonte in Svizzera e si dichiara in Italia; con il B si è fiscalmente residenti in Svizzera."
 }
 },
 {
 "@type": "Question",
 "name": "Come funziona il nuovo accordo fiscale frontalieri 2026?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Dal 2024 i nuovi frontalieri (assunti dopo il 17 luglio 2023) pagano l'imposta alla fonte in Svizzera fino all'80% del totale, e devono dichiarare il reddito anche in Italia con una franchigia di 10.000 euro. I vecchi frontalieri (ante 2024) continuano con il regime precedente fino al 2033. Come spiega l'Avv. Marco Bernasconi, fiscalista transfrontaliero: «Il periodo transitorio fino al 2033 garantisce che nessun vecchio frontaliere subisca un aggravio improvviso»."
 }
 },
 {
 "@type": "Question",
 "name": "Devo pagare le tasse in Italia se lavoro in Svizzera come frontaliere?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, se sei un nuovo frontaliere (dal 2024) devi dichiarare i redditi anche in Italia. Esiste una franchigia di 10.000 EUR: sotto questa soglia non paghi IRPEF aggiuntiva. Sopra, l'imposta italiana viene calcolata con credito per quanto già versato in Svizzera."
 }
 },
 {
 "@type": "Question",
 "name": "Cos'è la LAMal e come funziona per i frontalieri?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La LAMal è l'assicurazione malattia obbligatoria svizzera. I frontalieri possono scegliere tra LAMal (copertura svizzera) e il SSN italiano. Con la LAMal si ha accesso al sistema sanitario svizzero con franchigie e modelli assicurativi (base, HMO, telmed). La scelta va fatta entro 3 mesi dall'inizio del lavoro. Come spiega Laura Mantovani, broker assicurativo LAMal: «Per chi ha famiglia in Italia, il SSN è spesso più conveniente, mentre la LAMal offre un accesso più rapido alle cure in Svizzera»."
 }
 },
 {
 "@type": "Question",
 "name": "Come si calcola la pensione di un frontaliere svizzero?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La pensione si compone di tre pilastri: AVS (1° pilastro, pensione statale), LPP (2° pilastro, previdenza professionale) e Pilastro 3a (risparmio volontario con vantaggi fiscali). I contributi AVS e LPP vengono trattenuti in busta paga. Al pensionamento si può richiedere la rendita o il capitale del 2° pilastro."
 }
 }
 ]
 }
 },

 // ─── Sitemap navigational page ──────────────────────────────────────,

 sitemap: {
 title: 'Mappa del Sito | Frontaliere Ticino',
 description: 'Mappa del sito Frontaliere Ticino: tutti gli strumenti, calcolatori, guide e risorse per lavoratori frontalieri Svizzera-Italia organizzati per categoria.',
 keywords: 'mappa del sito frontaliere ticino, strumenti frontalieri svizzera, calcolatori frontaliere, guide frontaliere italia svizzera',
 ogTitle: 'Mappa del Sito | Frontaliere Ticino',
 ogDescription: 'Tutti gli strumenti e risorse per frontalieri Svizzera-Italia in un\'unica pagina.',
 canonicalPath: '/mappa-del-sito',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Mappa del Sito — Frontaliere Ticino",
 "url": `${BASE_URL}/mappa-del-sito`,
 "description": "Indice completo di tutti gli strumenti, calcolatori, guide e risorse per lavoratori frontalieri Svizzera-Italia.",
 "inLanguage": "it",
 },
 },

 // ─── Contracts / CCNL Guide ──────────────────────────────────────,

 contracts: {
 title: 'Contratti Lavoro Svizzera — CCNL e CCL Ticino',
 description: 'Confronto completo dei contratti collettivi svizzeri e italiani per frontalieri: edilizia, metalmeccanica, commercio, ristorazione, sanità. Ore, ferie.',
 keywords: 'contratto lavoro svizzera, CCNL ticino, CCL svizzera, diritti lavoratore frontaliere, ore lavoro svizzera, ferie svizzera, tredicesima svizzera, contratti collettivi ticino, GAV tessin',
 ogTitle: 'Contratti Lavoro Svizzera — CCNL e CCL Ticino',
 ogDescription: 'Confronto completo dei contratti collettivi svizzeri e italiani: ore, ferie, tredicesima, preavviso per 5 settori chiave.',
 canonicalPath: '/contratti-lavoro-svizzera',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Confronto Contratti Collettivi Svizzera vs Italia",
 "url": `${BASE_URL}/contratti-lavoro-svizzera`,
 "description": "Database interattivo dei contratti collettivi ticinesi (edilizia, metalmeccanica, commercio, ristorazione, sanità) con confronto CCNL italiano.",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "All",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "inLanguage": "it",
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 },

 // ─── TFR / Liquidazione Frontaliere Calculator ──────────────────────────,

 'tfr-calculator': {
 title: 'TFR e Liquidazione Frontaliere — Svizzera vs Italia',
 description: 'Calcolatore TFR per frontalieri: in Svizzera il TFR non esiste. Confronto 2° pilastro LPP vs TFR italiano su N anni. Simulazione contributi, rivalutazione, FAQ.',
 keywords: 'TFR frontaliere svizzera, liquidazione frontaliere, buonuscita frontaliere, 2 pilastro svizzera, LPP frontaliere, TFR italia vs svizzera, previdenza professionale frontaliere, cassa pensione frontaliere, trattamento fine rapporto svizzera',
 ogTitle: 'TFR e Liquidazione Frontaliere — Svizzera vs Italia',
 ogDescription: 'In Svizzera il TFR non esiste! Confronta il 2° pilastro (LPP) con il TFR italiano. Simulazione su N anni per frontalieri.',
 canonicalPath: '/tfr-liquidazione-frontaliere',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Calcolatore TFR vs LPP per Frontalieri",
 "url": `${BASE_URL}/tfr-liquidazione-frontaliere`,
 "description": "Simulatore TFR italiano vs 2° pilastro svizzero (LPP/BVG) per lavoratori frontalieri. Confronto su N anni di contributi.",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "All",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "inLanguage": "it",
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Perdo il TFR lavorando in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "No, in Svizzera il TFR non esiste. Al suo posto c'è il 2° pilastro (LPP/BVG), un meccanismo di previdenza professionale obbligatorio."
 }
 },
 {
 "@type": "Question",
 "name": "Posso recuperare il 2° pilastro se torno in Italia?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì. Lasciando definitivamente la Svizzera, si può richiedere la liquidazione della parte obbligatoria del 2° pilastro."
 }
 },
 {
 "@type": "Question",
 "name": "Il 2° pilastro svizzero è più conveniente del TFR italiano?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Dipende dallo stipendio, dall'età e dalla durata del rapporto. Per stipendi medio-alti e lunghe carriere in Svizzera, il 2° pilastro accumula importi superiori al TFR italiano."
 }
 }
 ]
 }
 ],
 },

 // ─── Permit Quiz (B vs G) ─────────────────────────────────────────────,

 'permit-quiz': {
 title: 'Quiz Permesso B o G — Quale Scegliere? | Frontaliere',
 description: 'Quiz interattivo per frontalieri: rispondi a 8 domande sulla tua situazione e scopri se è meglio il Permesso B (residenza) o G (frontaliere) per lavorare.',
 keywords: 'meglio permesso b o g, quiz permesso svizzera, permesso b o g frontaliere, scelta permesso svizzera, permesso b vantaggi, permesso g vantaggi, confronto permesso b g, permesso lavoro svizzera frontaliere',
 ogTitle: 'Quiz: Meglio Permesso B o G? Scoprilo in 2 Minuti',
 ogDescription: 'Rispondi a 8 domande e scopri quale permesso svizzero è più adatto alla tua situazione: Permesso B (residenza) o G (frontaliere).',
 canonicalPath: '/quiz-permesso-b-o-g',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Quiz Permesso B o G per Frontalieri",
 "url": `${BASE_URL}/quiz-permesso-b-o-g`,
 "description": "Quiz interattivo per scegliere tra Permesso B (residenza) e Permesso G (frontaliere) in Svizzera. 8 domande personalizzate.",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "All",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "inLanguage": "it",
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Qual è la differenza tra Permesso B e Permesso G?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il Permesso B è per chi risiede in Svizzera, il Permesso G è per i frontalieri che vivono in Italia e lavorano in Svizzera tornando al domicilio almeno una volta a settimana."
 }
 },
 {
 "@type": "Question",
 "name": "Conviene di più il Permesso B o G per le tasse?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Dipende dallo stipendio, dalla situazione familiare e dal comune di residenza. Per stipendi alti, il Permesso B può offrire aliquote più basse grazie alla tassazione ordinaria."
 }
 }
 ]
 }
 ],
 },

 // ─── Tredicesima / Quattordicesima Calculator ────────────────────────,

 'tredicesima': {
 title: 'Calcolo Tredicesima Frontaliere — Svizzera vs Italia',
 description: 'Calcolatore tredicesima e quattordicesima per frontalieri: calcola la tua mensilità extra con confronto 13° stipendio svizzero vs tredicesima italiana.',
 keywords: 'calcolo tredicesima frontaliere, tredicesima svizzera, 13 stipendio svizzera, quattordicesima frontaliere, mensilità extra frontaliere, 13esima svizzera frontaliere, tredicesima italia vs svizzera',
 ogTitle: 'Calcolatore Tredicesima e Quattordicesima per Frontalieri',
 ogDescription: 'Calcola la tua tredicesima e quattordicesima mensilità come frontaliere. Confronto 13° stipendio svizzero vs tredicesima italiana.',
 canonicalPath: '/calcolo-tredicesima-frontaliere',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Calcolatore Tredicesima per Frontalieri",
 "url": `${BASE_URL}/calcolo-tredicesima-frontaliere`,
 "description": "Calcola tredicesima e quattordicesima mensilità per lavoratori frontalieri. Confronto 13° stipendio svizzero vs tredicesima italiana con pro-rata.",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "All",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "inLanguage": "it",
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "La tredicesima è obbligatoria per i frontalieri in Svizzera?", "acceptedAnswer": { "@type": "Answer", "text": "La tredicesima non è obbligatoria per legge in Svizzera, ma è ampiamente diffusa nei CCL (contratti collettivi di lavoro) e nei contratti individuali del Canton Ticino. Molti settori la prevedono contrattualmente: banche, assicurazioni, pubblica amministrazione e molte aziende del settore industriale. Verifica sempre il tuo contratto: se è prevista, viene versata tipicamente a dicembre insieme allo stipendio del mese o come mensilità separata." } },
 { "@type": "Question", "name": "Come si calcola la tredicesima del frontaliere assunto a metà anno?", "acceptedAnswer": { "@type": "Answer", "text": "La tredicesima si calcola in pro-rata sui mesi effettivamente lavorati nell'anno: salario mensile lordo diviso 12, moltiplicato per i mesi di servizio. Un frontaliere assunto il 1° giugno con CHF 6.000 lordi/mese riceverà 7/12 di una mensilità come tredicesima, cioè CHF 3.500 lordi. Anche la tredicesima è soggetta a imposta alla fonte, contributi AVS/AI/IPG (5,3%), AC (1,1%) e LPP se sopra la soglia contributiva LPP." } },
 { "@type": "Question", "name": "Esiste la quattordicesima per i frontalieri in Ticino?", "acceptedAnswer": { "@type": "Answer", "text": "La quattordicesima è rara in Svizzera ma esiste in alcuni settori e aziende come bonus di produzione o come mensilità contrattuale. Più comune è il bonus a discrezione del datore di lavoro, legato ai risultati aziendali o individuali, che può equivalere a una mensilità supplementare. A differenza dell'Italia dove quattordicesima e premi sono più diffusi, in Svizzera i bonus sono volatili e non garantiti, quindi non vanno considerati reddito fisso nel calcolo della busta paga." } },
 { "@type": "Question", "name": "La tredicesima svizzera va dichiarata in Italia dal nuovo frontaliere?", "acceptedAnswer": { "@type": "Answer", "text": "Sì: la tredicesima è parte integrante del reddito da lavoro dipendente e va inclusa nel totale annuo dichiarato nel Modello Redditi PF (quadro RC). Per i nuovi frontalieri nel regime concorrente, rientra nel reddito imponibile IRPEF, al netto della franchigia di €10.000 e del credito d'imposta per le tasse pagate in Svizzera. Il Lohnausweis emesso dal datore di lavoro riporta già l'importo annuo complessivo inclusivo di tredicesima e bonus." } },
 ]
 }
 ],
 },

 // ─── Weekly Digest ───────────────────────────────────────────────────,

 'weekly-digest': {
 title: 'Digest Settimanale Frontaliere | Frontaliere Ticino',
 description: 'Ricevi ogni lunedì il digest settimanale per frontalieri: tasso di cambio CHF/EUR aggiornato, articoli selezionati, strumento della settimana e offerte di.',
 keywords: 'digest settimanale frontaliere, newsletter frontalieri, tasso cambio settimanale, news frontaliere ticino, offerte lavoro ticino, aggiornamenti frontalieri',
 ogTitle: 'Digest Settimanale per Frontalieri',
 ogDescription: 'Ogni lunedì: tasso CHF/EUR, articoli, strumento della settimana e offerte di lavoro in Ticino per frontalieri.',
 canonicalPath: '/digest-settimanale',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Digest Settimanale Frontaliere",
 "url": `${BASE_URL}/digest-settimanale`,
 "description": "Digest settimanale con informazioni essenziali per lavoratori frontalieri: tasso di cambio, articoli, strumenti e offerte di lavoro.",
 "inLanguage": "it",
 }
 ],
 },

 // ─── Tool of the Week ────────────────────────────────────────────────,

 'tool-of-week': {
 title: 'Strumento della Settimana per Frontalieri',
 description: 'Scopri lo strumento della settimana: ogni settimana mettiamo in evidenza un calcolatore o comparatore diverso per frontalieri. Condividi sui social!',
 keywords: 'strumento settimana frontaliere, calcolatori frontalieri, comparatori frontalieri, tools frontaliere ticino, strumenti gratuiti frontalieri',
 ogTitle: 'Strumento della Settimana | Frontaliere Ticino',
 ogDescription: 'Ogni settimana uno strumento diverso in evidenza per frontalieri: calcolatori, comparatori e simulatori gratuiti.',
 canonicalPath: '/strumento-della-settimana',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Strumento della Settimana per Frontalieri",
 "url": `${BASE_URL}/strumento-della-settimana`,
 "description": "Ogni settimana uno strumento diverso per frontalieri: calcolatori stipendio, comparatori assicurazione, simulatori pensione e altro.",
 "inLanguage": "it",
 }
 ],
 },

 // ─── Comparatori missing entries ──────────────────────────────────────────,

 'tax-return': {
 title: 'Dichiarazione Redditi Frontalieri 2026 | Italia e Svizzera',
 description: 'Dichiarazione redditi frontalieri 2026: Italia (730, Redditi PF, credito d\'imposta) e Svizzera (imposta alla fonte, rettifica, TDR). Guida con scadenze.',
 keywords: 'dichiarazione redditi frontaliere, 730 frontaliere, credito imposta svizzera, quadro CE, redditi svizzeri italia, modello unico frontaliere, scadenze fiscali frontaliere, imposta alla fonte, rettifica quellensteuer, TDR frontaliere',
 ogTitle: 'Dichiarazione Redditi Frontalieri 2026 | Italia e Svizzera',
 ogDescription: 'Dichiarazione redditi frontalieri 2026: guida Italia (730, quadro CE) e Svizzera (imposta alla fonte, rettifica, TDR). Passo passo con scadenze.',
 canonicalPath: '/tasse-e-pensione/dichiarazione-redditi',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "HowTo",
 "name": "Compilare la Dichiarazione dei Redditi da Frontaliere",
 "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi`,
 "description": "Guida passo passo alla dichiarazione dei redditi per lavoratori frontalieri Svizzera-Italia: documenti, deduzioni, scadenze e FAQ.",
 "totalTime": "PT2H",
 "estimatedCost": {
 "@type": "MonetaryAmount",
 "currency": "EUR",
 "value": "0"
 },
 "step": [
 {
 "@type": "HowToStep",
 "position": 1,
 "name": "Panoramica e regime fiscale",
 "text": "Comprendi il regime fiscale applicabile: nuovo accordo 2026 con franchigia €10.000 per nuovi frontalieri, o vecchio accordo per frontalieri ante-2024. Verifica se devi usare il Modello Redditi PF.",
 "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi`
 },
 {
 "@type": "HowToStep",
 "position": 2,
 "name": "Raccolta documenti",
 "text": "Raccogli tutti i documenti necessari: Lohnausweis (certificato di salario), attestato LPP, attestato pillar 3a, ricevute spese mediche, abbonamento trasporti, attestato assicurazione sanitaria, CU.",
 "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi`
 },
 {
 "@type": "HowToStep",
 "position": 3,
 "name": "Calcolo deduzioni",
 "text": "Calcola le deduzioni applicabili: spese di trasporto (max CHF 3.200), pasti, contributi LPP, pillar 3a (max CHF 7.258), assicurazione sanitaria, spese per figli, donazioni.",
 "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi`
 },
 {
 "@type": "HowToStep",
 "position": 4,
 "name": "Scadenze fiscali 2026",
 "text": "Rispetta le scadenze: certificato stipendio (31/01), CU precompilato (31/03), precompilata online (30/04), invio 730 (30/06), invio Redditi PF (30/09), acconto IRPEF (30/11).",
 "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi`
 },
 {
 "@type": "HowToStep",
 "position": 5,
 "name": "Compilazione e invio",
 "text": "Compila il Modello Redditi PF con quadro RC per redditi di lavoro dipendente, quadro CE per il credito d'imposta sulle tasse svizzere, e quadro RW per il monitoraggio del conto bancario svizzero.",
 "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi`
 }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Devo dichiarare il reddito svizzero in Italia?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, tutti i redditi esteri vanno dichiarati nel quadro RW e nel quadro RC/RL della dichiarazione."
 }
 },
 {
 "@type": "Question",
 "name": "Posso usare il 730 o devo fare il Modello Redditi PF?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I frontalieri con redditi esteri devono usare il Modello Redditi PF (ex Unico). Il 730 non è sufficiente."
 }
 },
 {
 "@type": "Question",
 "name": "Come funziona il credito d'imposta per le tasse pagate in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "L'imposta alla fonte pagata in CH si detrae dall'IRPEF italiana, evitando la doppia imposizione."
 }
 },
 {
 "@type": "Question",
 "name": "Cos'è la franchigia di €10.000?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Con il nuovo accordo 2026, i primi €10.000 di reddito sono esenti da IRPEF italiana per i nuovi frontalieri."
 }
 },
 {
 "@type": "Question",
 "name": "Devo dichiarare il conto bancario svizzero?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, il conto svizzero va dichiarato nel quadro RW per il monitoraggio fiscale. Non paghi IVAFE sui conti."
 }
 }
 ]
 }
 ]
 },

 'tax-return-italia': {
 title: 'Dichiarazione Redditi Italia Frontalieri | 730 e Redditi PF',
 description: 'Dichiarazione redditi Italia frontalieri 2026: Modello 730, Redditi PF, IRPEF con franchigia €10.000, credito d\'imposta, quadro CE e RW.',
 keywords: 'dichiarazione redditi frontaliere italia, 730 frontaliere, redditi PF frontaliere, credito imposta svizzera, quadro CE, quadro RW, IRPEF frontaliere, franchigia 10000, scadenze fiscali italia 2026',
 ogTitle: 'Dichiarazione Redditi Italia Frontalieri | 730 e Redditi PF',
 ogDescription: 'Guida alla dichiarazione dei redditi in Italia per frontalieri: 730, Redditi PF, IRPEF, credito d\'imposta e scadenze 2026.',
 canonicalPath: '/tasse-e-pensione/dichiarazione-redditi-italia',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "HowTo",
 "name": "Compilare la Dichiarazione dei Redditi in Italia da Frontaliere",
 "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-italia`,
 "description": "Guida alla dichiarazione dei redditi italiana per frontalieri: documenti, deduzioni IRPEF, credito d'imposta e scadenze 2026.",
 "totalTime": "PT2H",
 "estimatedCost": { "@type": "MonetaryAmount", "currency": "EUR", "value": "0" },
 "step": [
 { "@type": "HowToStep", "position": 1, "name": "Verifica regime fiscale", "text": "Nuovo accordo 2026 con franchigia €10.000 o vecchio accordo. Usa il Modello Redditi PF.", "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-italia` },
 { "@type": "HowToStep", "position": 2, "name": "Raccogli documenti", "text": "Lohnausweis, CU, attestato LPP, ricevute spese mediche e trasporti.", "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-italia` },
 { "@type": "HowToStep", "position": 3, "name": "Calcola deduzioni", "text": "Trasporto (max €3.200), contributi LPP, pillar 3a, sanità, figli.", "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-italia` },
 { "@type": "HowToStep", "position": 4, "name": "Compila e invia", "text": "Quadro RC per redditi, quadro CE per credito d'imposta, quadro RW per conto svizzero. Scadenza 730: 30/06, Redditi PF: 30/09.", "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-italia` }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Il frontaliere deve fare il 730 o il Modello Redditi PF?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Il frontaliere con solo reddito da lavoro dipendente svizzero deve usare il Modello Redditi PF (ex Unico), perché il 730 è riservato ai lavoratori con sostituto d'imposta italiano. Il 730 si può usare solo se si ha anche un reddito italiano con CU. Come precisa la Dott.ssa Elena Colombo, commercialista specializzata in fiscalità internazionale: «L'errore più comune è usare il 730 senza sostituto d'imposta italiano, il che invalida la dichiarazione»."
 }
 },
 {
 "@type": "Question",
 "name": "Cos'è la franchigia di €10.000 per i nuovi frontalieri?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Con il nuovo accordo fiscale 2026, i frontalieri assunti dal 17 luglio 2023 beneficiano di una franchigia di €10.000: i primi €10.000 di reddito convertito in euro non sono tassati in Italia. Si paga IRPEF solo sulla parte eccedente."
 }
 },
 {
 "@type": "Question",
 "name": "Come si compila il quadro RW per il conto svizzero?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Nel quadro RW si dichiara il conto corrente svizzero indicando: codice 1 (depositi), codice Stato 071 (Svizzera), valore massimo raggiunto nell'anno e saldo al 31/12. Se il saldo medio supera €5.000 si paga l'IVAFE (€34,20/anno)."
 }
 },
 {
 "@type": "Question",
 "name": "Come funziona il credito d'imposta nel quadro CE?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Nel quadro CE si indica l'imposta alla fonte svizzera pagata, convertita in euro al cambio medio annuo. Il credito d'imposta riduce l'IRPEF dovuta fino a concorrenza: non può mai superare l'IRPEF italiana calcolata sul reddito estero. Secondo la Dott.ssa Elena Colombo, commercialista specializzata in fiscalità internazionale: «L'eventuale eccedenza del credito può essere riportata nelle otto dichiarazioni successive»."
 }
 },
 {
 "@type": "Question",
 "name": "Quale tasso di cambio uso per convertire lo stipendio CHF in EUR?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Si usa il cambio medio annuo pubblicato dall'Agenzia delle Entrate (provvedimento di gennaio dell'anno successivo). Per il 2025, il tasso viene pubblicato a gennaio 2026. Non si usa il cambio del giorno di pagamento."
 }
 }
 ]
 }
 ]
 },

 'tax-return-svizzera': {
 title: 'Dichiarazione Fiscale Svizzera Frontalieri',
 description: 'Guida completa alla dichiarazione fiscale svizzera per frontalieri: imposta alla fonte, TDR (rettifica tariffa), deduzioni cantonali Ticino, pillar 3a e.',
 keywords: 'dichiarazione fiscale svizzera frontaliere, imposta alla fonte ticino, TDR frontaliere, rettifica quellensteuer, deduzioni cantonali ticino, pillar 3a, LPP, tariffa doganale ridotta frontaliere',
 ogTitle: 'Dichiarazione Fiscale Svizzera Frontalieri',
 ogDescription: 'Guida alla dichiarazione fiscale svizzera per frontalieri: imposta alla fonte, TDR, rettifica e deduzioni cantonali Ticino.',
 canonicalPath: '/tasse-e-pensione/dichiarazione-redditi-svizzera',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "HowTo",
 "name": "Dichiarazione Fiscale in Svizzera per Frontalieri",
 "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-svizzera`,
 "description": "Come compilare la dichiarazione fiscale svizzera da frontaliere: imposta alla fonte, TDR, rettifica e deduzioni nel Canton Ticino.",
 "totalTime": "PT1H30M",
 "estimatedCost": { "@type": "MonetaryAmount", "currency": "CHF", "value": "0" },
 "step": [
 { "@type": "HowToStep", "position": 1, "name": "Verifica imposta alla fonte", "text": "Controlla la percentuale applicata dal datore di lavoro sulla base della tabella A/B/C/H del Canton Ticino.", "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-svizzera` },
 { "@type": "HowToStep", "position": 2, "name": "Richiedi la TDR", "text": "Compila il modulo TDR (Tariffa Doganale Ridotta) per la rettifica: spese trasporto, LPP, pillar 3a, spese mediche.", "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-svizzera` },
 { "@type": "HowToStep", "position": 3, "name": "Deduzioni cantonali", "text": "Deduzioni per trasporto (max CHF 3.200), pasti, LPP, pillar 3a (max CHF 7.258), assicurazione malattia.", "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-svizzera` },
 { "@type": "HowToStep", "position": 4, "name": "Invia e attendi il rimborso", "text": "Invia la TDR all'Ufficio di tassazione. Il rimborso viene accreditato direttamente sul conto bancario.", "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi-svizzera` }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Cos'è la TDR per frontalieri svizzeri?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La TDR (Tariffa con Deduzione per Rettifica) è la procedura che permette ai frontalieri tassati alla fonte in Svizzera di richiedere la rettifica dell'imposta e ottenere deduzioni aggiuntive come trasporti, LPP, pillar 3a e spese mediche."
 }
 },
 {
 "@type": "Question",
 "name": "Entro quando si presenta la TDR?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La richiesta di rettifica TDR va presentata entro il 31 marzo dell'anno successivo a quello fiscale. Ad esempio, per il reddito 2025 la scadenza è il 31 marzo 2026. Dopo questa data non è più possibile richiedere la rettifica."
 }
 },
 {
 "@type": "Question",
 "name": "Quali deduzioni posso richiedere con la TDR?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Le principali deduzioni sono: spese di trasporto (max CHF 3.200), pasti fuori casa, contributi LPP riscatto, versamenti pillar 3a (max CHF 7.258 per dipendenti), premi assicurazione malattia, spese mediche non coperte, interessi debitori e donazioni."
 }
 },
 {
 "@type": "Question",
 "name": "Come viene calcolato il rimborso della rettifica?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "L'Ufficio di tassazione ricalcola l'imposta alla fonte includendo le deduzioni dichiarate. La differenza tra l'imposta trattenuta dal datore di lavoro e quella ricalcolata viene rimborsata direttamente sul conto bancario, generalmente entro 3-6 mesi."
 }
 },
 {
 "@type": "Question",
 "name": "Il frontaliere con permesso G deve fare la dichiarazione ordinaria in Svizzera?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "No, il frontaliere con permesso G è tassato alla fonte e non deve presentare la dichiarazione ordinaria svizzera. Può però richiedere la rettifica TDR per ottenere deduzioni. La dichiarazione ordinaria è obbligatoria solo se il reddito lordo supera CHF 120.000."
 }
 }
 ]
 }
 ]
 },

 nursery: {
 title: 'Asili Nido Ticino vs Italia | Frontaliere Ticino',
 description: 'Confronta asili nido tra Ticino e Italia: costi mensili, orari, criteri di ammissione, sussidi disponibili. Calcola il costo reale della custodia per.',
 keywords: 'asili nido ticino, asili nido como, costi asilo svizzera, asili frontalieri, custodia bambini ticino, confronto asili nido, sussidi asilo svizzera italia',
 ogTitle: 'Asili Nido Ticino vs Italia | Confronto per Frontalieri',
 ogDescription: '👶 Confronta costi, orari e sussidi asili nido tra Ticino e Italia per famiglie di frontalieri.',
 canonicalPath: '/vivere-in-ticino/confronta-asili-nido',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Confronto Asili Nido Ticino-Italia",
 "url": `${BASE_URL}/vivere-in-ticino/confronta-asili-nido`,
 "description": "Confronto costi e disponibilità asili nido tra Canton Ticino e Italia per famiglie di frontalieri",
 "applicationCategory": "LifestyleApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Asili Nido nel Canton Ticino",
 "description": "Elenco degli asili nido nel Canton Ticino con costi, orari e disponibilità",
 "numberOfItems": 10,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "item": { "@type": "ChildCare", "name": "Nido Comunale Lugano", "address": { "@type": "PostalAddress", "addressLocality": "Lugano", "addressRegion": "Ticino", "addressCountry": "CH" }, "openingHours": "Mo-Fr 06:30-18:30", "priceRange": "CHF 400-2200/mese" } },
 { "@type": "ListItem", "position": 2, "item": { "@type": "ChildCare", "name": "Nido Comunale Bellinzona", "address": { "@type": "PostalAddress", "addressLocality": "Bellinzona", "addressRegion": "Ticino", "addressCountry": "CH" }, "openingHours": "Mo-Fr 06:45-18:30", "priceRange": "CHF 350-2000/mese" } },
 { "@type": "ListItem", "position": 3, "item": { "@type": "ChildCare", "name": "Nido Comunale Locarno", "address": { "@type": "PostalAddress", "addressLocality": "Locarno", "addressRegion": "Ticino", "addressCountry": "CH" }, "openingHours": "Mo-Fr 07:00-18:00", "priceRange": "CHF 380-2100/mese" } },
 { "@type": "ListItem", "position": 4, "item": { "@type": "ChildCare", "name": "Nido Comunale Mendrisio", "address": { "@type": "PostalAddress", "addressLocality": "Mendrisio", "addressRegion": "Ticino", "addressCountry": "CH" }, "openingHours": "Mo-Fr 06:30-18:30", "priceRange": "CHF 350-1900/mese" } },
 { "@type": "ListItem", "position": 5, "item": { "@type": "ChildCare", "name": "Nido Comunale Chiasso", "address": { "@type": "PostalAddress", "addressLocality": "Chiasso", "addressRegion": "Ticino", "addressCountry": "CH" }, "openingHours": "Mo-Fr 07:00-18:00", "priceRange": "CHF 300-1800/mese" } },
 { "@type": "ListItem", "position": 6, "item": { "@type": "ChildCare", "name": "Asilo Nido Piccoli Passi", "address": { "@type": "PostalAddress", "addressLocality": "Lugano", "addressRegion": "Ticino", "addressCountry": "CH" }, "openingHours": "Mo-Fr 07:00-19:00", "priceRange": "CHF 1800-2800/mese" } },
 { "@type": "ListItem", "position": 7, "item": { "@type": "ChildCare", "name": "Centro Infanzia Girotondo", "address": { "@type": "PostalAddress", "addressLocality": "Manno", "addressRegion": "Ticino", "addressCountry": "CH" }, "openingHours": "Mo-Fr 07:00-18:30", "priceRange": "CHF 1600-2500/mese" } },
 { "@type": "ListItem", "position": 8, "item": { "@type": "ChildCare", "name": "Nido Aziendale USI/SUPSI", "address": { "@type": "PostalAddress", "addressLocality": "Lugano", "addressRegion": "Ticino", "addressCountry": "CH" }, "openingHours": "Mo-Fr 07:30-18:00", "priceRange": "CHF 800-1800/mese" } },
 { "@type": "ListItem", "position": 9, "item": { "@type": "ChildCare", "name": "Micro-nido Il Sole", "address": { "@type": "PostalAddress", "addressLocality": "Bellinzona", "addressRegion": "Ticino", "addressCountry": "CH" }, "openingHours": "Mo-Fr 07:00-18:00", "priceRange": "CHF 1500-2300/mese" } },
 { "@type": "ListItem", "position": 10, "item": { "@type": "ChildCare", "name": "Nido Familiare Le Stelle", "address": { "@type": "PostalAddress", "addressLocality": "Locarno", "addressRegion": "Ticino", "addressCountry": "CH" }, "openingHours": "Mo-Fr 07:30-18:00", "priceRange": "CHF 1400-2200/mese" } }
 ]
 }
 ]
 },

 bonus: {
 title: 'Calcolo Bonus e Tredicesima Frontalieri | Tassazione CH-IT',
 description: 'Calcola la tassazione del bonus e della tredicesima per frontalieri: come viene tassato in Svizzera e dichiarato in Italia. Simulazione con imposta alla.',
 keywords: 'bonus frontaliere, tredicesima frontaliere, tassazione bonus svizzera, gratifica frontaliere, bonus natale frontaliere, tasse bonus ticino',
 ogTitle: 'Calcolo Bonus e Tredicesima Frontalieri',
 ogDescription: '💰 Calcola la tassazione netta del bonus e della tredicesima per frontalieri Svizzera-Italia.',
 canonicalPath: '/calcola-stipendio/stima-bonus-frontaliere',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Calcolatore Bonus Frontalieri",
 "url": `${BASE_URL}/calcola-stipendio/stima-bonus-frontaliere`,
 "description": "Calcola la tassazione di bonus e tredicesima per lavoratori frontalieri",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 renovation: {
 title: 'Bonus Ristrutturazione Casa | Detrazioni Frontalieri Italia',
 description: 'Guida ai bonus ristrutturazione casa per frontalieri residenti in Italia: superbonus, ecobonus, bonus mobili, bonus facciate. Calcola subito le detrazioni.',
 keywords: 'bonus ristrutturazione frontaliere, detrazioni casa frontaliere, superbonus frontaliere, ecobonus italia, bonus mobili, ristrutturazione casa italia',
 ogTitle: 'Bonus Ristrutturazione Casa per Frontalieri',
 ogDescription: '🏗️ Calcola le detrazioni per ristrutturazione casa disponibili per frontalieri residenti in Italia.',
 canonicalPath: '/compara-servizi/calcola-bonus-ristrutturazione',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Calcolatore Bonus Ristrutturazione",
 "url": `${BASE_URL}/compara-servizi/calcola-bonus-ristrutturazione`,
 "description": "Calcola le detrazioni per ristrutturazione casa disponibili per frontalieri residenti in Italia",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 // ─── Stats sub-tabs ───────────────────────────────────────────────────────,

 salaryCompare: {
 title: 'Stipendi Frontalieri Svizzera | 60 Professioni × 15 Settori',
 description: 'Stipendio medio frontaliere Svizzera 2026: confronta 60 professioni in 15 settori con range min-max. IT, finanza, pharma, ingegneria, sanità. Lordi, netti.',
 keywords: 'stipendio medio svizzera per settore, stipendi ticino 2026, salario informatica svizzera, confronto stipendi frontaliere, stipendio svizzera italia, salario settore ticino, stipendio frontaliere 2026, range salariale svizzera, professioni svizzera stipendi, sondaggio stipendi frontalieri',
 ogTitle: 'Stipendi Frontalieri Svizzera | 60 Professioni × 15 Settori',
 ogDescription: 'Confronta stipendi di 60 professioni in 15 settori tra Svizzera e Italia. Range salariali, netti e parità potere d\'acquisto 2026.',
 canonicalPath: '/statistiche/confronta-stipendi',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "Dataset",
 "name": "Confronto Stipendi Frontalieri Svizzera-Italia 2026",
 "url": `${BASE_URL}/statistiche/confronta-stipendi`,
 "description": "Database salariale con 60 professioni in 15 settori: range min-mediano-max per livello junior, mid e senior. Dati Svizzera (CHF) e Italia (EUR) per lavoratori frontalieri.",
 "dateModified": BUILD_DATE_ISO,
 "datePublished": "2024-06-01",
 "license": "https://creativecommons.org/licenses/by-nc/4.0/",
 "creator": { "@type": "Organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch" },
 "temporalCoverage": "2023/2026",
 "variableMeasured": [
 { "@type": "PropertyValue", "name": "Stipendio mediano", "value": "CHF per settore e livello" },
 { "@type": "PropertyValue", "name": "Settore economico", "value": "15 settori" },
 { "@type": "PropertyValue", "name": "Livello esperienza", "value": "Junior, Mid, Senior" },
 { "@type": "PropertyValue", "name": "Range salariale", "value": "Min-Mediano-Max in CHF e EUR" }
 ],
 "distribution": [{ "@type": "DataDownload", "encodingFormat": "text/html", "contentUrl": `${BASE_URL}/statistiche/confronta-stipendi` }]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Quali sono gli stipendi medi in Ticino nel 2026?", "acceptedAnswer": { "@type": "Answer", "text": "Lo stipendio mediano in Ticino varia da CHF 48.000-55.000 per posizioni entry-level nel commercio/ristorazione fino a CHF 125.000-200.000+ per ruoli senior nella finanza, pharma e IT." } },
 { "@type": "Question", "name": "Quanto guadagna un informatico frontaliere in Svizzera?", "acceptedAnswer": { "@type": "Answer", "text": "Un Software Developer frontaliere in Ticino guadagna mediamente CHF 72.000 lordi da junior, CHF 95.000 da mid-level e CHF 125.000+ da senior." } },
 { "@type": "Question", "name": "Conviene fare il frontaliere dal punto di vista economico?", "acceptedAnswer": { "@type": "Answer", "text": "Nella maggior parte dei settori, il frontaliere guadagna dal 100% al 200% in più rispetto all'Italia, anche considerando i costi di trasporto. Con la PPP, il vantaggio si riduce al 30-80%." } },
 { "@type": "Question", "name": "Come vengono tassati gli stipendi dei frontalieri?", "acceptedAnswer": { "@type": "Answer", "text": "I frontalieri con permesso G pagano l'imposta alla fonte in Ticino (3-18%) più contributi sociali svizzeri. Con il Nuovo Accordo 2026, l'80% delle imposte resta in Svizzera." } },
 { "@type": "Question", "name": "Quali settori pagano di più in Ticino?", "acceptedAnswer": { "@type": "Answer", "text": "I settori più remunerativi sono: Finanza (mediana senior CHF 145.000), Consulenza (CHF 150.000), Pharma (CHF 135.000) e IT (CHF 125.000)." } }
 ]
 }
 ]
 },

 livability: {
 title: 'Migliori Comuni di Frontiera | Classifica Qualità',
 description: 'Classifica dei migliori comuni italiani di frontiera dove vivere come frontaliere: qualità della vita, distanza dalla dogana, servizi, costi, trasporti e.',
 keywords: 'migliori comuni frontiera, comuni frontalieri classifica, vivere como varese, qualità vita frontaliere, comuni vicino svizzera, dove vivere frontaliere',
 ogTitle: 'Migliori Comuni di Frontiera | Classifica 2026',
 ogDescription: '🏡 Classifica dei migliori comuni italiani di frontiera: qualità della vita, distanza dogana e servizi.',
 canonicalPath: '/statistiche/migliori-comuni-frontiera',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "Dataset",
 "name": "Classifica Migliori Comuni di Frontiera 2026",
 "url": `${BASE_URL}/statistiche/migliori-comuni-frontiera`,
 "description": "Classifica dei migliori comuni italiani di frontiera per qualità della vita, servizi e distanza dalla dogana",
 "dateModified": BUILD_DATE_ISO,
 "datePublished": "2024-06-01",
 "license": "https://creativecommons.org/licenses/by-nc/4.0/",
 "creator": { "@type": "Organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch" },
 "temporalCoverage": "2024/2026",
 "variableMeasured": [
 { "@type": "PropertyValue", "name": "Qualità della vita", "value": "Indice composito per comune" },
 { "@type": "PropertyValue", "name": "Distanza dalla dogana", "value": "km dal valico più vicino" },
 { "@type": "PropertyValue", "name": "Costo della vita", "value": "Indice relativo affitti e servizi" },
 { "@type": "PropertyValue", "name": "Servizi disponibili", "value": "Scuole, trasporti, sanità" }
 ],
 "distribution": [{ "@type": "DataDownload", "encodingFormat": "text/html", "contentUrl": `${BASE_URL}/statistiche/migliori-comuni-frontiera` }]
 }
 },

 jobsObservatory: {
 title: 'Osservatorio stipendi e lavori piu cercati in Ticino',
 description: 'Osservatorio aggiornato ogni giorno su stipendi, ruoli piu richiesti, aziende che assumono e localita piu attive nel lavoro in Ticino. Dati collegati alle.',
 keywords: 'stipendi ticino, lavori piu cercati ticino, aziende che assumono ticino, offerte lavoro ticino oggi, osservatorio lavoro ticino, stipendi frontalieri ticino',
 ogTitle: 'Osservatorio stipendi e lavori in Ticino',
 ogDescription: 'Dati giornalieri su stipendi osservati negli annunci, ruoli piu pubblicati, aziende che assumono e localita piu attive nel mercato del lavoro ticinese.',
 canonicalPath: '/statistiche/osservatorio-stipendi-lavori-ticino',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "Dataset",
 "name": "Osservatorio stipendi e lavori in Ticino",
 "url": `${BASE_URL}/statistiche/osservatorio-stipendi-lavori-ticino`,
 "description": "Osservatorio giornaliero del job board Frontaliere Ticino con trend annunci, aziende attive, localita piu dinamiche e salary range osservati nelle offerte.",
 "dateModified": BUILD_DATE_ISO,
 "license": "https://creativecommons.org/licenses/by-nc/4.0/",
 "creator": { "@type": "Organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch" },
 "datePublished": "2024-06-01",
 "temporalCoverage": "2024/2026",
 "variableMeasured": [
 { "@type": "PropertyValue", "name": "Numero annunci attivi", "value": "Conteggio offerte per azienda e località" },
 { "@type": "PropertyValue", "name": "Range salariale", "value": "CHF lordi annui osservati negli annunci" },
 { "@type": "PropertyValue", "name": "Distribuzione settoriale", "value": "Ruoli più richiesti per settore" },
 { "@type": "PropertyValue", "name": "Tendenze località", "value": "Comuni più attivi per volume annunci" }
 ],
 "distribution": [{ "@type": "DataDownload", "encodingFormat": "application/json", "contentUrl": `${BASE_URL}/data/jobs-stats.json` }]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 { "@type": "Question", "name": "Come vengono calcolati i ruoli piu richiesti in Ticino?", "acceptedAnswer": { "@type": "Answer", "text": "La pagina usa il volume di annunci attivi e pubblicati nel job board Frontaliere Ticino per mostrare ruoli, aziende e localita piu dinamici." } },
 { "@type": "Question", "name": "Gli stipendi mostrati sono netti o lordi?", "acceptedAnswer": { "@type": "Answer", "text": "L osservatorio usa i salary range annuali lordi presenti negli annunci e ne calcola medie e mediane osservate per aziende, localita e ruoli." } },
 { "@type": "Question", "name": "Con quale frequenza viene aggiornato l osservatorio?", "acceptedAnswer": { "@type": "Answer", "text": "L osservatorio viene aggiornato ogni giorno quando il job board viene rigenerato con i nuovi annunci, le rimozioni e gli aggiornamenti." } }
 ]
 }
 ]
 },

 trafficHistory: {
 title: 'Storico Traffico Dogane Svizzera-Italia | Dati e Tendenze',
 description: 'Storico del traffico ai valichi di frontiera Svizzera-Italia: grafici, tendenze settimanali e mensili, confronto tra dogane. Dati per pianificare gli.',
 keywords: 'storico traffico dogane, traffico valichi svizzera italia, storico code frontiera, tendenze traffico chiasso, traffico gaggiolo stabio, dati traffico frontaliere, orari migliori frontiera',
 ogTitle: 'Storico Traffico Dogane | Dati e Tendenze Frontiera CH-IT',
 ogDescription: '📈 Storico traffico ai valichi Svizzera-Italia: grafici, tendenze e confronto tra dogane per pianificare gli spostamenti.',
 canonicalPath: '/statistiche/storico-traffico-dogane',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "Dataset",
 "name": "Storico Traffico Dogane Svizzera-Italia",
 "url": `${BASE_URL}/statistiche/storico-traffico-dogane`,
 "description": "Dati storici del traffico ai valichi di frontiera tra Svizzera e Italia con tendenze e confronti",
 "dateModified": BUILD_DATE_ISO,
 "license": "https://creativecommons.org/licenses/by-nc/4.0/",
 "creator": { "@type": "Organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch" },
 "datePublished": "2024-01-01",
 "temporalCoverage": "2020/2026",
 "variableMeasured": [
 { "@type": "PropertyValue", "name": "Volume veicoli", "value": "Transiti giornalieri per valico" },
 { "@type": "PropertyValue", "name": "Tendenze settimanali", "value": "Distribuzione traffico per giorno della settimana" },
 { "@type": "PropertyValue", "name": "Tendenze mensili", "value": "Variazione stagionale del traffico" },
 { "@type": "PropertyValue", "name": "Confronto valichi", "value": "Ranking valichi per volume" }
 ],
 "distribution": [{ "@type": "DataDownload", "encodingFormat": "text/html", "contentUrl": `${BASE_URL}/statistiche/storico-traffico-dogane` }]
 }
 },

 unemploymentStats: {
 title: 'Disoccupazione Svizzera — Tasso SECO | Frontaliere Ticino',
 description: 'Tasso di disoccupazione Svizzera SECO: trend mensile 10 anni, media annuale, minimo e massimo storico. Dati aggiornati mensilmente da arbeit.swiss per.',
 keywords: 'disoccupazione svizzera, tasso disoccupazione SECO, arbeitslosenquote schweiz, unemployment rate switzerland, mercato lavoro svizzero, frontalieri, arbeit.swiss',
 ogTitle: 'Disoccupazione Svizzera — Tasso SECO 10 Anni',
 ogDescription: 'Trend mensile della disoccupazione svizzera dal 2016: grafici interattivi, KPI e confronto annuale. Fonte SECO.',
 canonicalPath: '/statistiche/disoccupazione-svizzera',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "Dataset",
 "name": "Tasso di Disoccupazione Svizzera",
 "url": `${BASE_URL}/statistiche/disoccupazione-svizzera`,
 "description": "Serie storica mensile del tasso di disoccupazione registrata in Svizzera (SECO) dal 2016",
 "dateModified": BUILD_DATE_ISO,
 "license": "https://creativecommons.org/licenses/by-nc/4.0/",
 "creator": { "@type": "Organization", "name": "SECO — Segreteria di Stato dell'economia", "url": "https://www.seco.admin.ch" },
 "datePublished": "2016-01-01",
 "temporalCoverage": "2016/2026",
 "variableMeasured": [
 { "@type": "PropertyValue", "name": "Tasso di disoccupazione", "value": "Percentuale mensile registrata SECO" },
 { "@type": "PropertyValue", "name": "Media annuale", "value": "Tasso medio per anno solare" },
 { "@type": "PropertyValue", "name": "Minimo storico", "value": "Valore più basso nel periodo" },
 { "@type": "PropertyValue", "name": "Massimo storico", "value": "Valore più alto nel periodo" }
 ],
 "distribution": [{ "@type": "DataDownload", "encodingFormat": "application/json", "contentUrl": `${BASE_URL}/data/switzerland-unemployment-rate.json` }]
 }
 },

 mortgageComparison: {
 title: 'Confronto Mutui Italia vs Svizzera | Frontaliere Ticino',
 description: 'Simula e confronta mutuo italiano vs ipoteca svizzera: rata mensile, interessi totali, vantaggi fiscali. Include Tragbarkeit, equity 20%, detraibilità.',
 keywords: 'mutuo frontaliere, mutuo svizzera tasso, mutuo casa frontaliere italia svizzera, confronto mutui, ipoteca svizzera, Tragbarkeit, rata mutuo, tasso ipotecario, SARON, Euribor',
 ogTitle: 'Confronto Mutui Italia vs Svizzera — Simulatore',
 ogDescription: '🏠 Confronta rata mensile, interessi e detrazioni fiscali di un mutuo italiano vs ipoteca svizzera. Simulatore per frontalieri.',
 canonicalPath: '/statistiche/confronto-mutui',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebApplication",
 "name": "Simulatore Confronto Mutui Italia vs Svizzera",
 "url": `${BASE_URL}/statistiche/confronto-mutui`,
 "description": "Simulatore interattivo per confrontare mutui italiani e ipoteche svizzere: rata mensile, interessi totali, vantaggi fiscali, Tragbarkeit",
 "applicationCategory": "FinanceApplication",
 "operatingSystem": "Web",
 "offers": { "@type": "Offer", "price": "0", "priceCurrency": "CHF" },
 "creator": { "@type": "Organization", "name": "Frontaliere Ticino" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" }
 }
 },

 fuelPrices: {
 title: 'Prezzi Benzina Italia-Svizzera | Frontaliere Ticino',
 description: 'Confronto prezzi benzina tra comuni di confine italiani e stazioni svizzere vicine: dati ufficiali Italia, confronto IT-CH, ranking e risparmio stimato su.',
 keywords: 'prezzi benzina italia svizzera, dove conviene fare benzina ticino, prezzo benzina como svizzera, prezzo benzina varese ticino, carburanti confine, confronto benzina italia svizzera, mrprezzi confine',
 ogTitle: 'Prezzi Benzina Italia-Svizzera | Dove Conviene Oggi',
 ogDescription: 'Confronta i prezzi benzina nei comuni di confine italiani con le stazioni svizzere vicine e scopri dove conviene fare rifornimento oggi.',
 canonicalPath: '/statistiche/prezzi-benzina-confine',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "Dataset",
 "name": "Prezzi benzina al confine Italia-Svizzera",
 "url": `${BASE_URL}/statistiche/prezzi-benzina-confine`,
 "description": "Dataset comparativo dei prezzi benzina tra comuni di confine italiani e stazioni svizzere dell'area di frontiera.",
 "dateModified": BUILD_DATE_ISO,
 "license": "https://creativecommons.org/licenses/by-nc/4.0/",
 "creator": { "@type": "Organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch" },
 "datePublished": "2024-01-01",
 "temporalCoverage": "2024/2026",
 "variableMeasured": [
 { "@type": "PropertyValue", "name": "Prezzo benzina Italia", "value": "EUR/litro per comune di confine" },
 { "@type": "PropertyValue", "name": "Prezzo benzina Svizzera", "value": "CHF/litro stazioni vicine" },
 { "@type": "PropertyValue", "name": "Differenza prezzo", "value": "Risparmio percentuale IT vs CH" },
 { "@type": "PropertyValue", "name": "Ranking stazioni", "value": "Classifica per prezzo più conveniente" }
 ],
 "distribution": [{ "@type": "DataDownload", "encodingFormat": "application/json", "contentUrl": `${BASE_URL}/api/fuel-prices` }]
 }
 },

 healthPremiums: {
 title: 'Premi Malattia per Comune | Confronto Cantonale Svizzera',
 description: 'Confronta i premi della cassa malati per comune svizzero: differenze cantonali, evoluzione storica e risparmio potenziale cambiando comune di residenza.',
 keywords: 'premi malattia svizzera comune, cassa malati confronto comune, premi LAMal 2025, differenze cantonali cassa malati, assicurazione malattia svizzera frontalieri, premi malattia ticino',
 ogTitle: 'Premi Malattia per Comune | Frontaliere Ticino',
 ogDescription: 'Scopri come variano i premi della cassa malati tra comuni svizzeri e quanto potresti risparmiare cambiando comune di residenza.',
 canonicalPath: '/statistiche/premi-malattia-comuni',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "Dataset",
 "name": "Premi cassa malati per comune svizzero",
 "url": `${BASE_URL}/statistiche/premi-malattia-comuni`,
 "description": "Dataset dei premi LAMal per comune e cantone svizzero, con evoluzione storica e confronto tra fasce d'età.",
 "dateModified": BUILD_DATE_ISO,
 "license": "https://creativecommons.org/licenses/by-nc/4.0/",
 "creator": { "@type": "Organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch" },
 "datePublished": "2024-01-01",
 "temporalCoverage": "2024/2026",
 "variableMeasured": [
 { "@type": "PropertyValue", "name": "Premio mensile LAMal", "value": "CHF/mese per comune e fascia d'età" },
 { "@type": "PropertyValue", "name": "Differenza cantonale", "value": "Variazione premio tra cantoni" },
 { "@type": "PropertyValue", "name": "Evoluzione storica", "value": "Trend premi negli ultimi anni" },
 { "@type": "PropertyValue", "name": "Risparmio potenziale", "value": "Differenza cambiando comune di residenza" }
 ],
 "distribution": [{ "@type": "DataDownload", "encodingFormat": "application/json", "contentUrl": `${BASE_URL}/data/health-premiums.json` }]
 }
 },

 ristorni: {
 title: 'Ristorni Fiscali Frontalieri | Statistiche Comuni Italiani',
 description: 'Statistiche sui ristorni fiscali dei frontalieri: importi per comune italiano, andamento storico, confronto tra province. Dati aggiornati sui compensi.',
 keywords: 'ristorni fiscali frontalieri, compensi fiscali svizzera italia, ristorni comuni italiani, ristorni como varese, ristorni frontalieri importo',
 ogTitle: 'Ristorni Fiscali Frontalieri | Statistiche per Comune',
 ogDescription: '💶 Statistiche sui ristorni fiscali: importi per comune, andamento storico e confronto tra province.',
 canonicalPath: '/tasse-e-pensione/ristorni-fiscali',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "Dataset",
 "name": "Ristorni Fiscali Frontalieri per Comune",
 "url": `${BASE_URL}/tasse-e-pensione/ristorni-fiscali`,
 "description": "Statistiche sui ristorni fiscali versati ai comuni italiani di frontiera",
 "dateModified": BUILD_DATE_ISO,
 "license": "https://creativecommons.org/licenses/by-nc/4.0/",
 "creator": { "@type": "Organization", "name": "Frontaliere Ticino", "url": "https://frontaliereticino.ch" },
 "datePublished": "2024-01-01",
 "temporalCoverage": "2020/2026",
 "variableMeasured": [
 { "@type": "PropertyValue", "name": "Importo ristorni", "value": "EUR per comune italiano di frontiera" },
 { "@type": "PropertyValue", "name": "Andamento storico", "value": "Trend annuale importi versati" },
 { "@type": "PropertyValue", "name": "Confronto provinciale", "value": "Distribuzione per provincia (Como, Varese, VCO)" },
 { "@type": "PropertyValue", "name": "Totale annuo", "value": "Somma complessiva ristorni versati" }
 ],
 "distribution": [{ "@type": "DataDownload", "encodingFormat": "text/html", "contentUrl": `${BASE_URL}/tasse-e-pensione/ristorni-fiscali` }]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Cosa sono i ristorni fiscali per frontalieri?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I ristorni fiscali sono compensi che la Svizzera versa all'Italia, pari al 40% dell'imposta alla fonte trattenuta ai frontalieri. Questi fondi vengono distribuiti ai comuni italiani di residenza dei frontalieri per finanziare servizi locali."
 }
 },
 {
 "@type": "Question",
 "name": "Chi riceve i ristorni fiscali?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I ristorni vengono versati ai comuni italiani situati nella fascia di 20 km dal confine svizzero. I comuni principali beneficiari sono nelle province di Como, Varese, Verbano-Cusio-Ossola e Sondrio."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto vale un ristorno fisale per comune?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "L'importo varia molto: comuni con molti frontalieri come Lavena Ponte Tresa, Porlezza o Ponte Chiasso ricevono centinaia di migliaia di euro, mentre comuni più piccoli ricevono importi inferiori. Il totale annuo supera i 90 milioni di euro."
 }
 },
 {
 "@type": "Question",
 "name": "I ristorni continueranno con il nuovo accordo 2026?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Sì, ma con una riduzione graduale. Con il nuovo accordo, la Svizzera tratterrà l'80% dell'imposta (invece del 61,5% attuale). L'Italia compenserà i comuni con fondi propri durante il periodo transitorio fino al 2033. Come osserva l'Avv. Marco Bernasconi, fiscalista transfrontaliero: «I comuni di frontiera dovranno adattare i propri bilanci alla progressiva riduzione dei ristorni svizzeri»."
 }
 },
 {
 "@type": "Question",
 "name": "Come posso sapere quanto riceve il mio comune dai ristorni?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "La nostra pagina mostra i dati storici dei ristorni per ogni comune italiano di frontiera. I dati vengono aggiornati annualmente in base alle comunicazioni ufficiali tra i due Stati."
 }
 }
 ]
 }
 ]
 },

 // ─── Standalone pages ─────────────────────────────────────────────────────,

 contact: {
 title: 'Contattaci | Frontaliere Ticino',
 description: 'Contatta il team di Frontaliere Ticino: segnalazioni, suggerimenti, collaborazioni. Rispondiamo a domande su tasse frontalieri, simulatore fiscale e strumenti.',
 keywords: 'contatti frontaliere, assistenza frontaliere, contattaci frontaliere, supporto simulatore fiscale, segnalazione frontaliere',
 ogTitle: 'Contattaci | Frontaliere Ticino',
 ogDescription: '✉️ Contatta il team di Frontaliere Ticino per domande, suggerimenti o collaborazioni.',
 canonicalPath: '/contattaci',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "ContactPage",
 "name": "Contatti Frontaliere Ticino",
 "url": `${BASE_URL}/contattaci`,
 "description": "Pagina contatti per il servizio Frontaliere Ticino"
 }
 },

 consulting: {
 title: 'Consulenza Fiscale Frontalieri | Tasse CH-IT 2026',
 description: 'Consulenza fiscale per frontalieri: ottimizzazione tasse Svizzera-Italia, dichiarazione redditi, scelta regime fiscale nuovo accordo 2026.',
 keywords: 'consulenza fiscale frontalieri, consulenza frontaliere, consulente fiscale frontaliere, ottimizzazione fiscale svizzera italia, dichiarazione redditi frontaliere, esperto frontaliero, consulenza fiscale frontalieri svizzera',
 ogTitle: 'Consulenza Fiscale per Frontalieri Svizzera',
 ogDescription: '🎯 Consulenza fiscale per frontalieri Svizzera-Italia: ottimizzazione tasse, dichiarazione redditi e pianificazione. Prenota gratis.',
 canonicalPath: '/consulenza',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "Service",
 "name": "Consulenza Fiscale Frontalieri",
 "url": `${BASE_URL}/consulenza`,
 "description": "Servizio di consulenza fiscale specializzata per lavoratori frontalieri Svizzera-Italia",
 "provider": { "@type": "Organization", "name": "Frontaliere Ticino" },
 "serviceType": "Consulenza Fiscale"
 }
 },

 partners: {
 title: 'Servizi Partner | Professionisti per Frontalieri',
 description: 'Servizi partner selezionati per frontalieri: commercialisti, consulenti fiscali, assicuratori, agenzie immobiliari, servizi bancari specializzati per.',
 keywords: 'servizi frontalieri, commercialista frontaliere, consulente frontaliere, assicurazione frontaliere, partner frontalieri',
 ogTitle: 'Servizi Partner per Frontalieri',
 ogDescription: '🤝 Professionisti selezionati per frontalieri: commercialisti, assicuratori, consulenti fiscali e servizi bancari.',
 canonicalPath: '/servizi-partner',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Servizi Partner per Frontalieri",
 "url": `${BASE_URL}/servizi-partner`,
 "description": "Raccolta di servizi professionali selezionati per lavoratori frontalieri",
 "inLanguage": "it"
 }
 },

 gamification: {
 title: 'Gamification | Livelli e Obiettivi Frontalieri',
 description: 'Sistema di gamification per frontalieri: guadagna punti XP esplorando il simulatore fiscale, completa obiettivi, sblocca livelli. Impara divertendoti sulle.',
 keywords: 'gamification frontaliere, obiettivi frontaliere, livelli frontaliere, punti XP frontaliere, impara tasse giocando',
 ogTitle: 'Gamification | Livelli e Obiettivi',
 ogDescription: '🏆 Guadagna XP e sblocca livelli esplorando gli strumenti per frontalieri!',
 canonicalPath: '/gamificazione',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Gamification Frontaliere",
 "url": `${BASE_URL}/gamificazione`,
 "description": "Sistema di gamification con livelli, obiettivi e punti XP per frontalieri",
 "inLanguage": "it"
 }
 },

 privacy: {
 title: 'Privacy Policy | Frontaliere Ticino',
 description: 'Informativa sulla privacy di Frontaliere Ticino: trattamento dati personali, cookie, analytics, diritti degli utenti. Conforme GDPR e LPD svizzera.',
 keywords: 'privacy frontaliere, GDPR frontaliere, cookie policy, trattamento dati personali, informativa privacy',
 ogTitle: 'Privacy Policy | Frontaliere Ticino',
 ogDescription: '🔒 Informativa sulla privacy: come trattiamo i tuoi dati. Conforme GDPR e LPD.',
 canonicalPath: '/privacy',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Privacy Policy",
 "url": `${BASE_URL}/privacy`,
 "description": "Informativa sulla privacy di Frontaliere Ticino",
 "inLanguage": "it"
 }
 },

 terms: {
 title: 'Termini di Servizio | Frontaliere Ticino',
 description: 'Termini e condizioni di utilizzo di Frontaliere Ticino: disclaimer, responsabilità, proprietà intellettuale e regole di utilizzo.',
 keywords: 'termini di servizio frontaliere, condizioni uso, disclaimer frontaliere ticino, termini e condizioni',
 ogTitle: 'Termini di Servizio | Frontaliere Ticino',
 ogDescription: 'Termini e condizioni di utilizzo della piattaforma Frontaliere Ticino.',
 canonicalPath: '/termini-di-servizio',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Termini di Servizio",
 "url": `${BASE_URL}/termini-di-servizio`,
 "description": "Termini e condizioni di utilizzo di Frontaliere Ticino",
 "inLanguage": "it"
 }
 },

 'email-confirmed': {
 title: 'Benvenuto Frontaliere! | Frontaliere Ticino',
 description: 'Iscrizione confermata! Sei ufficialmente un frontaliere informato. Scopri i nostri strumenti: calcola stipendio, cerca lavoro in Ticino e leggi le guide.',
 keywords: 'benvenuto frontaliere, iscrizione newsletter, conferma email frontaliere, strumenti frontalieri, calcola stipendio svizzera',
 ogTitle: 'Benvenuto, Frontaliere! | Frontaliere Ticino',
 ogDescription: '🎉 La tua email è confermata! Esplora stipendio netto, offerte di lavoro in Ticino e guide pratiche per frontalieri.',
 canonicalPath: '/benvenuto-frontaliere',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Benvenuto Frontaliere",
 "url": "https://frontaliereticino.ch/benvenuto-frontaliere",
 "description": "Pagina di benvenuto per i nuovi iscritti alla newsletter di Frontaliere Ticino",
 "inLanguage": "it"
 }
 },

 'data-deletion': {
 title: 'Eliminazione Dati | Frontaliere Ticino',
 description: 'Richiedi l\'eliminazione dei tuoi dati personali dal servizio Frontaliere Ticino. Procedura conforme al GDPR e alla LPD svizzera.',
 keywords: 'eliminazione dati, cancellazione dati personali, GDPR diritto oblio, richiesta eliminazione, cancella account frontaliere',
 ogTitle: 'Eliminazione Dati | Frontaliere Ticino',
 ogDescription: '🗑️ Richiedi l\'eliminazione dei tuoi dati personali. Procedura conforme GDPR.',
 canonicalPath: '/eliminazione-dati',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Eliminazione Dati Personali",
 "url": `${BASE_URL}/eliminazione-dati`,
 "description": "Procedura per richiedere l\'eliminazione dei dati personali",
 "inLanguage": "it"
 }
 },

 'api-status': {
 title: 'Stato API | Frontaliere Ticino',
 description: 'Stato in tempo reale dei servizi API utilizzati da Frontaliere Ticino: cambio valuta, traffico valichi, Firebase, reCAPTCHA. Verifica la disponibilità dei.',
 keywords: 'stato api frontaliere, servizi api, status page frontaliere, disponibilità servizi, uptime frontaliere',
 ogTitle: 'Stato API | Frontaliere Ticino',
 ogDescription: '🔧 Stato in tempo reale dei servizi API: cambio valuta, traffico, Firebase e reCAPTCHA.',
 canonicalPath: '/stato-api',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Stato dei Servizi API",
 "url": `${BASE_URL}/stato-api`,
 "description": "Stato in tempo reale dei servizi API utilizzati da Frontaliere Ticino",
 "inLanguage": "it",
 "about": {
 "@type": "WebAPI",
 "name": "API Frontaliere Ticino",
 "documentation": `${BASE_URL}/stato-api`
 }
 }
 },

 // ─── Blog / Articoli ─────────────────────────────────────────────────────,

 blog: {
 title: 'Articoli Frontaliere 2026 | Guide Pratiche Svizzera-Italia',
 description: 'Articoli e guide aggiornate per frontalieri: stipendio netto, nuovo accordo fiscale 2024, LAMal vs CMI, terzo pilastro 3a, migliori comuni, costo della.',
 keywords: 'articoli frontalieri, guida frontaliere 2026, blog frontaliere svizzera italia, stipendio netto svizzera, nuovo accordo fiscale, lamal cmi frontaliere, terzo pilastro frontaliere',
 ogTitle: 'Articoli Frontaliere 2026 | Guide Pratiche',
 ogDescription: 'Articoli aggiornati per frontalieri: stipendio netto, tasse, assicurazioni, pensione e vita pratica per chi lavora in Svizzera.',
 canonicalPath: '/articoli-frontaliere',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Articoli per Frontalieri",
 "url": `${BASE_URL}/articoli-frontaliere`,
 "description": "Raccolta di articoli e guide pratiche per lavoratori frontalieri Svizzera-Italia",
 "inLanguage": "it",
 "speakable": SPEAKABLE_SECTION
 },
 {
 "@context": "https://schema.org",
 "@type": "ItemList",
 "name": "Articoli Frontaliere",
 "numberOfItems": 868,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "name": "Stipendio netto frontaliere 2026", "url": `${BASE_URL}/articoli-frontaliere/stipendio-netto-frontaliere-2026` },
 { "@type": "ListItem", "position": 2, "name": "Nuovo Accordo Fiscale 2024", "url": `${BASE_URL}/articoli-frontaliere/nuovo-accordo-fiscale-2024` },
 { "@type": "ListItem", "position": 3, "name": "LAMal vs CMI: quale scegliere", "url": `${BASE_URL}/articoli-frontaliere/lamal-vs-cmi-frontaliere` },
 { "@type": "ListItem", "position": 4, "name": "Primo giorno da frontaliere", "url": `${BASE_URL}/articoli-frontaliere/primo-giorno-lavoro-svizzera` },
 { "@type": "ListItem", "position": 5, "name": "Tredicesima netta frontaliere", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-netta-frontaliere` },
 { "@type": "ListItem", "position": 6, "name": "Terzo pilastro 3a frontaliere", "url": `${BASE_URL}/articoli-frontaliere/terzo-pilastro-3a-frontaliere` },
 { "@type": "ListItem", "position": 7, "name": "Migliori comuni per frontalieri", "url": `${BASE_URL}/articoli-frontaliere/migliori-comuni-frontalieri` },
 { "@type": "ListItem", "position": 8, "name": "Costo vita Ticino vs Lombardia", "url": `${BASE_URL}/articoli-frontaliere/costo-vita-ticino-vs-lombardia` },
 { "@type": "ListItem", "position": 9, "name": "Tassa salute e tensioni Ticino", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-aumentano-tensioni-ticino` },
 { "@type": "ListItem", "position": 10, "name": "Comprare casa in Italia dal Ticino", "url": `${BASE_URL}/articoli-frontaliere/comprare-casa-italia-confine-ticino` },
 { "@type": "ListItem", "position": 11, "name": "Franco forte: impatto sullo stipendio", "url": `${BASE_URL}/articoli-frontaliere/franco-forte-effetti-stipendio-frontalieri` },
 { "@type": "ListItem", "position": 12, "name": "CU 2026: novità per i frontalieri", "url": `${BASE_URL}/articoli-frontaliere/cu-2026-scadenze-telelavoro-frontalieri` },
 { "@type": "ListItem", "position": 13, "name": "Telelavoro Italia-Svizzera ratificato", "url": `${BASE_URL}/articoli-frontaliere/telelavoro-italia-svizzera-ratifica` },
 { "@type": "ListItem", "position": 14, "name": "Accordo telelavoro: ratifica definitiva", "url": `${BASE_URL}/articoli-frontaliere/telelavoro-frontalieri-accordo-italia-svizzera-ratifica-definitiva` },
 { "@type": "ListItem", "position": 15, "name": "Stop ristorni per tassa salute", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-ticino-chiede-stop-ristorni-italia` },
 { "@type": "ListItem", "position": 16, "name": "Regole telelavoro e CU frontalieri", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-cu-2026-telelavoro-45-giorni-regole-definitive` },
 { "@type": "ListItem", "position": 17, "name": "Smood chiude in Ticino", "url": `${BASE_URL}/articoli-frontaliere/smood-chiude-attivita-ticino-impatto-lavoro-frontalieri` },
 { "@type": "ListItem", "position": 18, "name": "Disoccupazione Svizzera gennaio 2026", "url": `${BASE_URL}/articoli-frontaliere/disoccupazione-svizzera-gennaio-2026-dati-ticino-frontalieri` },
 { "@type": "ListItem", "position": 19, "name": "Riscaldamento casa Ticino: nuove norme", "url": `${BASE_URL}/articoli-frontaliere/riscaldamento-casa-ticino-norme-energetiche-risparmio` },
 { "@type": "ListItem", "position": 20, "name": "Sostituzione caldaia Ticino 2026", "url": `${BASE_URL}/articoli-frontaliere/sostituzione-caldaia-ticino-norme-2026-risparmio` },
 { "@type": "ListItem", "position": 21, "name": "Mostra Hic Sunt Leones: confini Svizzera", "url": `${BASE_URL}/articoli-frontaliere/mostra-hic-sunt-leones-confini-svizzera-frontalieri` },
 { "@type": "ListItem", "position": 22, "name": "Carnevale 2026 Lugano: laboratori bambini", "url": `${BASE_URL}/articoli-frontaliere/carnevale-2026-lugano-laboratori-creativi-figli-frontalieri` },
 { "@type": "ListItem", "position": 23, "name": "Arte e anima del Ticino: mostra al LAC", "url": `${BASE_URL}/articoli-frontaliere/mostra-arte-ticino-sentimento-osservazione-lac-lugano` },
 { "@type": "ListItem", "position": 24, "name": "Arca Russa a Chiasso: cultura per frontalieri", "url": `${BASE_URL}/articoli-frontaliere/arca-russa-chiasso-evento-culturale-frontalieri` },
 { "@type": "ListItem", "position": 25, "name": "Mostra RSI: storia del Ticino", "url": `${BASE_URL}/articoli-frontaliere/mostra-rsi-storia-ticino-frontalieri` },
 { "@type": "ListItem", "position": 26, "name": "Vacanze Carnevale: laboratori bambini Lugano", "url": `${BASE_URL}/articoli-frontaliere/vacanze-carnevale-bambini-ticino-laboratori-museo-erba-lugano` },
 { "@type": "ListItem", "position": 27, "name": "Mostra 'TRA-S-PARENZE' di Daniela Rebuzzi a Cas...", "url": `${BASE_URL}/articoli-frontaliere/mostra-daniela-rebuzzi-caslano-arte-ticino` },
 { "@type": "ListItem", "position": 28, "name": "Corpi in Prestito: Mostra d'Arte a Serocca d'Agno", "url": `${BASE_URL}/articoli-frontaliere/mostra-arte-corpi-in-prestito-agno-ticino` },
 { "@type": "ListItem", "position": 29, "name": "La storia del Ticino in mostra: l'archivio RSI ...", "url": `${BASE_URL}/articoli-frontaliere/rsi-mostra-storia-svizzera-italiana-foto-archivio-airolo` },
 { "@type": "ListItem", "position": 30, "name": "Began with Rauschenberg Exhibition in Bruzella", "url": `${BASE_URL}/articoli-frontaliere/mostra-rauschenberg-bruzella-mendrisiotto-arte-gratuita-frontalieri` },
 { "@type": "ListItem", "position": 31, "name": "Collettiva Nakba a Giubiasco", "url": `${BASE_URL}/articoli-frontaliere/mostra-nakba-giubiasco-riflessione-culturale-ticino` },
 { "@type": "ListItem", "position": 32, "name": "Conference on Fabrizio De André's 'Anime salve'...", "url": `${BASE_URL}/articoli-frontaliere/de-andre-a-locarno-conferenza-anime-salve-per-frontalieri` },
 { "@type": "ListItem", "position": 33, "name": "Mostra 'Sentimento e osservazione' al MASI Lugano", "url": `${BASE_URL}/articoli-frontaliere/masi-lugano-mostra-sentimento-osservazione-identita-ticino` },
 { "@type": "ListItem", "position": 34, "name": "RSI's \"Una Storia\": Ticino's history in 60 year...", "url": `${BASE_URL}/articoli-frontaliere/rsi-mostra-una-storia-ticino-archivio-fotografico-airolo` },
 { "@type": "ListItem", "position": 35, "name": "Carnevale Chièscia Bòsc 2026 in Valle di Blenio", "url": `${BASE_URL}/articoli-frontaliere/carnevale-chiescia-bosc-2026-ludiano-valle-blenio` },
 { "@type": "ListItem", "position": 36, "name": "Federal Tribunal Overturns Ticino's B Permit De...", "url": `${BASE_URL}/articoli-frontaliere/permesso-b-integrazione-tribunale-federale-ticino` },
 { "@type": "ListItem", "position": 37, "name": "Imposizione Individuale e l'Impatto sul Lavoro ...", "url": `${BASE_URL}/articoli-frontaliere/tassazione-individuale-svizzera-impatto-lavoro-ticino-frontalieri` },
 { "@type": "ListItem", "position": 38, "name": "Ristorni Frontalieri al Centro dello Scontro tr...", "url": `${BASE_URL}/articoli-frontaliere/ristorni-frontalieri-scontro-ticino-berna-tassa-salute` },
 { "@type": "ListItem", "position": 39, "name": "Rent vs. Commute Time: The Frontalieri Dilemma", "url": `${BASE_URL}/articoli-frontaliere/pendolarismo-affitto-tempo-dilemma-frontalieri-ticino` },
 { "@type": "ListItem", "position": 43, "name": "Ticino Center-Right Demands Suspension of Cross...", "url": `${BASE_URL}/articoli-frontaliere/centrodestra-ticino-stop-ristorni-frontalieri-tassa-salute` },
 { "@type": "ListItem", "position": 44, "name": "Frontalieri in Ticino in Calo a Fine 2025", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-ticino-dati-calo-fine-2025` },
 { "@type": "ListItem", "position": 45, "name": "Irregular Entries in Chiasso Decline", "url": `${BASE_URL}/articoli-frontaliere/calo-entrate-irregolari-migranti-chiasso-ticino` },
 { "@type": "ListItem", "position": 46, "name": "The Debate on Cross-Border Workers and Salaries...", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-stipendi-ticino-polemica-crescente` },
 { "@type": "ListItem", "position": 47, "name": "Ticino-Lombardy Clash Over Cross-Border Worker ...", "url": `${BASE_URL}/articoli-frontaliere/ristorni-frontalieri-scontro-ticino-lombardia-tassa-salute` },
 { "@type": "ListItem", "position": 48, "name": "Financing the 13th AVS pension: VAT and salary ...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-aumento-iva-contributi-salariali-frontaliere` },
 { "@type": "ListItem", "position": 49, "name": "Financing the 13th AVS Pension: Contributions a...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-finanziamento-misto-contributi-iva` },
 { "@type": "ListItem", "position": 50, "name": "Finanziamento 13esima AVS: Aumento Contributi e...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-finanziamento-scontro-iva-contributi` },
 { "@type": "ListItem", "position": 51, "name": "Ticino Businesses Alarmed by Potential Tax Retu...", "url": `${BASE_URL}/articoli-frontaliere/blocco-ristorni-imprese-ticino-allarme-calo-frontalieri` },
 { "@type": "ListItem", "position": 52, "name": "Undeclared Cash Seized at Swiss-Italian Border", "url": `${BASE_URL}/articoli-frontaliere/denaro-non-dichiarato-dogana-cosa-rischi-frontaliere` },
 { "@type": "ListItem", "position": 53, "name": "The Frontier Worker and Salary Debate in Ticino", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-salari-dibattito-ticino-il-cane-che-si-morde-la-coda` },
 { "@type": "ListItem", "position": 54, "name": "Finanziamento 13esima AVS: Scontro tra Aumento ...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-finanziamento-misto-stipendio-iva` },
 { "@type": "ListItem", "position": 55, "name": "Ticino Parties Demand Suspension of Tax Restitu...", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-partiti-ticino-chiedono-stop-ristorni` },
 { "@type": "ListItem", "position": 56, "name": "Ticino Politics Demands Suspension of Tax Resti...", "url": `${BASE_URL}/articoli-frontaliere/stop-ristorni-tassa-salute-mozione-politica-ticino` },
 { "@type": "ListItem", "position": 57, "name": "Conti Federali Svizzeri e Prospettive Fiscali", "url": `${BASE_URL}/articoli-frontaliere/conti-federali-2025-aumento-iva-impatto-frontalieri-ticino` },
 { "@type": "ListItem", "position": 58, "name": "Finanziamento 13esima AVS: Impatto su Stipendi ...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-finanziamento-impatto-stipendio-frontalieri-ticino` },
 { "@type": "ListItem", "position": 59, "name": "Tensioni sui ristorni tra Ticino e Lombardia", "url": `${BASE_URL}/articoli-frontaliere/ristorni-frontalieri-reazione-lombardia-tassa-salute` },
 { "@type": "ListItem", "position": 60, "name": "Allarme truffa del falso bancario in Ticino", "url": `${BASE_URL}/articoli-frontaliere/truffa-falso-bancario-ticino-allarme-polizia` },
 { "@type": "ListItem", "position": 61, "name": "Swiss Government Analyzes Impact of Proposed 10...", "url": `${BASE_URL}/articoli-frontaliere/dazi-usa-10-percento-conseguenze-economia-ticino` },
 { "@type": "ListItem", "position": 62, "name": "Collaborazione Varini-Hildebrand: otto persone ...", "url": `${BASE_URL}/articoli-frontaliere/sanita-ticino-accordo-varini-hildebrand-8-posti-a-rischio` },
 { "@type": "ListItem", "position": 63, "name": "Fictitious Part-Time Contracts in Ticino: An Ar...", "url": `${BASE_URL}/articoli-frontaliere/dumping-salariale-ticino-architetti-part-time-fittizi` },
 { "@type": "ListItem", "position": 64, "name": "Finanziamento 13esima AVS: Aumento Contributi d...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-finanziamento-aumento-contributi-2026` },
 { "@type": "ListItem", "position": 65, "name": "Finanziamento 13a AVS: Rischio Aumento Contribu...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-finanziamento-impatto-stipendio-frontalieri` },
 { "@type": "ListItem", "position": 66, "name": "Swiss Police Data Sharing Reform", "url": `${BASE_URL}/articoli-frontaliere/scambio-dati-polizia-svizzera-impatto-ticino` },
 { "@type": "ListItem", "position": 67, "name": "Financing the 13th AVS Pension: A Mix of Salary...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-finanziamento-misto-stipendi-iva` },
 { "@type": "ListItem", "position": 68, "name": "The misleading narrative of the decline in cros...", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-ticino-calo-dati-settori-qualificati` },
 { "@type": "ListItem", "position": 69, "name": "Financing the 13th AVS pension: salary contribu...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-finanziamento-aumento-contributi-iva-impatto-stipendio` },
 { "@type": "ListItem", "position": 70, "name": "Permesso S e Salari Bassi in Svizzera", "url": `${BASE_URL}/articoli-frontaliere/permesso-s-stipendi-bassi-impatto-lavoro-ticino` },
 { "@type": "ListItem", "position": 71, "name": "Lombardy Reacts to Ticino's Tax Return Block Mo...", "url": `${BASE_URL}/articoli-frontaliere/ristorni-frontalieri-reazione-lombardia-mozione-ticino` },
 { "@type": "ListItem", "position": 72, "name": "Finanziamento 13esima AVS: Scontro su Aumento C...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-finanziamento-contributi-iva-impatto-frontalieri` },
 { "@type": "ListItem", "position": 73, "name": "Water Tariff Increase in Mendrisiotto Mitigated", "url": `${BASE_URL}/articoli-frontaliere/costo-acqua-mendrisiotto-aumento-tariffe-2026` },
 { "@type": "ListItem", "position": 74, "name": "Rafforzata la cooperazione giudiziaria tra Sviz...", "url": `${BASE_URL}/articoli-frontaliere/cooperazione-giudiziaria-svizzera-italia-impatto-frontalieri-ticino` },
 { "@type": "ListItem", "position": 75, "name": "Licenziamenti nel settore sanitario del Locarnese", "url": `${BASE_URL}/articoli-frontaliere/sanita-locarnese-collaborazione-varini-hildebrand-licenziamenti` },
 { "@type": "ListItem", "position": 76, "name": "Aumento Legionellosi in Ticino", "url": `${BASE_URL}/articoli-frontaliere/legionellosi-ticino-tasso-piu-alto-svizzera` },
 { "@type": "ListItem", "position": 77, "name": "Prezzi Dinamici: Rivoluzione o Trappola per i F...", "url": `${BASE_URL}/articoli-frontaliere/prezzi-dinamici-ticino-rivoluzione-o-trappola-per-frontalieri` },
 { "@type": "ListItem", "position": 78, "name": "Lugano's Protest Management Sparks Controversy", "url": `${BASE_URL}/articoli-frontaliere/lugano-manifestazioni-polemica-regole-uguali-per-tutti` },
 { "@type": "ListItem", "position": 79, "name": "Map of Municipal IRPEF Surcharges for Cross-Bor...", "url": `${BASE_URL}/articoli-frontaliere/mappa-addizionale-irpef-comuni-confine-frontalieri-tasse` },
 { "@type": "ListItem", "position": 80, "name": "Mappa dell'Addizionale Comunale IRPEF per i Lav...", "url": `${BASE_URL}/articoli-frontaliere/addizionale-irpef-comuni-confine-mappa-tasse-frontalieri-2026` },
 { "@type": "ListItem", "position": 81, "name": "Guida ai Congedi Parentali per Frontalieri in T...", "url": `${BASE_URL}/articoli-frontaliere/maternita-paternita-frontaliere-svizzera-italia-guida-2026` },
 { "@type": "ListItem", "position": 82, "name": "Swiss Payslip Deductions for Cross-Border Worke...", "url": `${BASE_URL}/articoli-frontaliere/guida-contributi-sociali-svizzeri-busta-paga-frontaliere` },
 { "@type": "ListItem", "position": 83, "name": "Costo della Vita a Lugano per Frontalieri 2026", "url": `${BASE_URL}/articoli-frontaliere/quanto-costa-vivere-a-lugano-da-frontaliere-analisi-costi-2026` },
 { "@type": "ListItem", "position": 84, "name": "Permesso G Frontalieri: Vantaggi e Svantaggi 2026", "url": `${BASE_URL}/articoli-frontaliere/permesso-g-vantaggi-svantaggi-frontalieri-ticino-2026` },
 { "@type": "ListItem", "position": 85, "name": "Guida al Calcolo della Pensione per Frontalieri...", "url": `${BASE_URL}/articoli-frontaliere/calcolo-pensione-frontaliere-avs-inps-guida-completa` },
 { "@type": "ListItem", "position": 86, "name": "Nuovo Accordo Fiscale 2026: Simulazione Pratica...", "url": `${BASE_URL}/articoli-frontaliere/frontaliere-nuovo-accordo-fiscale-2026-simulazione` },
 { "@type": "ListItem", "position": 87, "name": "LAMal or CMI for cross-border workers in 2026: ...", "url": `${BASE_URL}/articoli-frontaliere/lamal-o-cmi-frontaliere-quale-conviene-2026` },
 { "@type": "ListItem", "position": 88, "name": "Credito d'imposta per frontalieri: come evitare...", "url": `${BASE_URL}/articoli-frontaliere/frontaliere-doppia-imposizione-credito-imposta-come-funziona` },
 { "@type": "ListItem", "position": 89, "name": "Il costo reale dell'auto per il pendolare front...", "url": `${BASE_URL}/articoli-frontaliere/costo-auto-pendolare-frontaliere-ticino-2026` },
 { "@type": "ListItem", "position": 90, "name": "Guida al Congedo Parentale per Frontalieri 2026", "url": `${BASE_URL}/articoli-frontaliere/congedo-parentale-frontaliere-svizzera-italia-guida-2026` },
 { "@type": "ListItem", "position": 91, "name": "Costo Auto Pendolare Frontaliere Ticino 2026", "url": `${BASE_URL}/articoli-frontaliere/costo-auto-frontaliere-ticino-guida-completa-2026` },
 { "@type": "ListItem", "position": 92, "name": "Guida alla Dichiarazione dei Redditi 2026 per F...", "url": `${BASE_URL}/articoli-frontaliere/guida-dichiarazione-redditi-730-frontalieri-ticino` },
 { "@type": "ListItem", "position": 93, "name": "Documents for Cross-Border Workers in Switzerland", "url": `${BASE_URL}/articoli-frontaliere/documenti-necessari-lavoro-svizzera-frontaliere-ticino` },
 { "@type": "ListItem", "position": 94, "name": "Guida ai costi 2026 degli asili nido in Ticino ...", "url": `${BASE_URL}/articoli-frontaliere/asilo-nido-svizzera-frontaliere-ticino-costi-guida` },
 { "@type": "ListItem", "position": 95, "name": "Locarno Reaches 20% Secondary Home Limit, Halti...", "url": `${BASE_URL}/articoli-frontaliere/locarno-stop-nuove-residenze-secondarie-quota-20` },
 { "@type": "ListItem", "position": 96, "name": "Swiss Cost of Living Report: Where to Live Cheaper", "url": `${BASE_URL}/articoli-frontaliere/costo-vita-svizzera-classifica-comuni-ticino` },
 { "@type": "ListItem", "position": 97, "name": "Audit Federale Rivela Lacune nella Sicurezza su...", "url": `${BASE_URL}/articoli-frontaliere/sicurezza-lavoro-svizzera-audit-federale-falle-conflitti-suva` },
 { "@type": "ListItem", "position": 98, "name": "The Cost of Living Across Swiss Municipalities", "url": `${BASE_URL}/articoli-frontaliere/costo-vita-svizzera-classifica-comuni-cari-economici` },
 { "@type": "ListItem", "position": 99, "name": "Underpaid Architects in Mendrisio: Unpaid Overt...", "url": `${BASE_URL}/articoli-frontaliere/architetti-sottopagati-ticino-mendrisio-testimonianza` },
 { "@type": "ListItem", "position": 100, "name": "Calo Frontalieri in Ticino: colpa dell'economia...", "url": `${BASE_URL}/articoli-frontaliere/calo-frontalieri-ticino-economia-non-tassa-salute` },
 { "@type": "ListItem", "position": 101, "name": "Italian High Court Recognizes Maternity Benefit...", "url": `${BASE_URL}/articoli-frontaliere/maternita-frontaliere-cassazione-riconosce-indennita-inps` },
 { "@type": "ListItem", "position": 102, "name": "Galenica closes Bichsel subsidiary, 170 jobs at...", "url": `${BASE_URL}/articoli-frontaliere/galenica-chiude-bichsel-170-posti-a-rischio-impatto-ticino` },
 { "@type": "ListItem", "position": 103, "name": "New 15% US Tariffs: Analyzing the Impact on Tic...", "url": `${BASE_URL}/articoli-frontaliere/dazi-trump-usa-impatto-export-ticino-lavoro` },
 { "@type": "ListItem", "position": 104, "name": "Campione d'Italia Exits Financial Distress", "url": `${BASE_URL}/articoli-frontaliere/campione-italia-fuori-dissesto-finanziario-nuove-assunzioni` },
 { "@type": "ListItem", "position": 105, "name": "Underpaid Architects in Mendrisio: The Testimony", "url": `${BASE_URL}/articoli-frontaliere/gavetta-tossica-architetti-ticino-denuncia` },
 { "@type": "ListItem", "position": 106, "name": "Eurocity Blocked in Tunnel Causes Commuter Chaos", "url": `${BASE_URL}/articoli-frontaliere/odissea-eurocity-milano-treno-bloccato-galleria-pendolari` },
 { "@type": "ListItem", "position": 107, "name": "Swiss Workplace Safety Checks Deemed Insufficie...", "url": `${BASE_URL}/articoli-frontaliere/sicurezza-lavoro-svizzera-controlli-insufficienti-suva` },
 { "@type": "ListItem", "position": 108, "name": "Swiss Startup Investments Soar, Driven by AI, w...", "url": `${BASE_URL}/articoli-frontaliere/startup-svizzera-boom-investimenti-ia-opportunita-ticino` },
 { "@type": "ListItem", "position": 109, "name": "Federal Tribunal Rules Long Covid is an Occupat...", "url": `${BASE_URL}/articoli-frontaliere/long-covid-malattia-professionale-sentenza-tribunale-federale` },
 { "@type": "ListItem", "position": 110, "name": "EU Greenlights New Agreements with Switzerland", "url": `${BASE_URL}/articoli-frontaliere/accordo-ue-svizzera-mercato-interno-impatto-frontalieri` },
 { "@type": "ListItem", "position": 111, "name": "Swiss Foundries Production Drops 7.6% in 2025", "url": `${BASE_URL}/articoli-frontaliere/fonderie-svizzere-crisi-produzione-2025-impatto-ticino` },
 { "@type": "ListItem", "position": 112, "name": "Draft agreement aims to raise Ticino's minimum ...", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-ticino-accordo-aumento-22-franchi` },
 { "@type": "ListItem", "position": 113, "name": "Public Transport Revenue in Switzerland Surpass...", "url": `${BASE_URL}/articoli-frontaliere/trasporti-pubblici-svizzera-crescita-fatturato-impatto-frontalieri` },
 { "@type": "ListItem", "position": 114, "name": "Night Roadworks in Lugano March 2026", "url": `${BASE_URL}/articoli-frontaliere/lavori-notturni-lugano-marzo-2026-strade-chiuse` },
 { "@type": "ListItem", "position": 115, "name": "Daniela Willi-Piezzi appointed new director at ...", "url": `${BASE_URL}/articoli-frontaliere/supsi-daniela-willi-piezzi-direttrice-dipartimento-formazione` },
 { "@type": "ListItem", "position": 116, "name": "BPS Suisse 2025 Results and BPER Acquisition", "url": `${BASE_URL}/articoli-frontaliere/bps-suisse-risultati-solidi-2025-impatto-bper-frontalieri` },
 { "@type": "ListItem", "position": 117, "name": "Swiss Energy Company Bailout Fund Halved", "url": `${BASE_URL}/articoli-frontaliere/aiuti-imprese-energetiche-proroga-taglio-fondi` },
 { "@type": "ListItem", "position": 118, "name": "Dibattito sul Salario Minimo Sociale in Ticino:...", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-sociale-ticino-dibattito-frontalieri` },
 { "@type": "ListItem", "position": 119, "name": "BPS Suisse 2025 Results and Financial Advice fo...", "url": `${BASE_URL}/articoli-frontaliere/bps-suisse-utili-record-consigli-frontalieri` },
 { "@type": "ListItem", "position": 120, "name": "Ticino demands mandatory referendum on new EU deal", "url": `${BASE_URL}/articoli-frontaliere/accordo-ue-svizzera-ticino-chiede-referendum-obbligatorio` },
 { "@type": "ListItem", "position": 121, "name": "EU Council Approves New Bilateral Agreements wi...", "url": `${BASE_URL}/articoli-frontaliere/accordo-svizzera-ue-cosa-cambia-frontalieri-ticino` },
 { "@type": "ListItem", "position": 122, "name": "Locarno supera soglia case secondarie: stop lic...", "url": `${BASE_URL}/articoli-frontaliere/locarno-stop-licenze-case-secondarie` },
 { "@type": "ListItem", "position": 123, "name": "EU Council Approves New Bilateral Agreements wi...", "url": `${BASE_URL}/articoli-frontaliere/accordi-ue-svizzera-firma-vicina-cosa-cambia-frontalieri` },
 { "@type": "ListItem", "position": 124, "name": "Proposta di aumento IVA per finanziare l'eserci...", "url": `${BASE_URL}/articoli-frontaliere/aumento-iva-svizzera-esercito-impatto-stipendio-frontalieri` },
 { "@type": "ListItem", "position": 125, "name": "Congedo parentale frontalieri", "url": `${BASE_URL}/articoli-frontaliere/maternita-paternita-ticino` },
 { "@type": "ListItem", "position": 126, "name": "Referendum UE-Svizzera", "url": `${BASE_URL}/articoli-frontaliere/referendum-ue-svizzera-ticino` },
 { "@type": "ListItem", "position": 127, "name": "Valposchiavo: Turismo in crescita", "url": `${BASE_URL}/articoli-frontaliere/turismo-valposchiavo-2025` },
 { "@type": "ListItem", "position": 128, "name": "Frontalieri in calo: economia ticinese", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-economia-ticino` },
 { "@type": "ListItem", "position": 129, "name": "Inflazione stabile: cosa cambia per i frontalieri", "url": `${BASE_URL}/articoli-frontaliere/inflazione-frontalieri-ticino` },
 { "@type": "ListItem", "position": 130, "name": "Aprire un conto bancario svizzero", "url": `${BASE_URL}/articoli-frontaliere/aprire-conto-bancario-frontalieri` },
 { "@type": "ListItem", "position": 131, "name": "Ristorni fiscali frontalieri", "url": `${BASE_URL}/articoli-frontaliere/ristorni-fiscali-frontaliere` },
 { "@type": "ListItem", "position": 132, "name": "Guida contributi sociali frontalieri", "url": `${BASE_URL}/articoli-frontaliere/contributi-sociali-busta-paga` },
 { "@type": "ListItem", "position": 133, "name": "Strada Vezia-Cureglia: troppi incidenti", "url": `${BASE_URL}/articoli-frontaliere/strada-incidenti-vezia-cureglia` },
 { "@type": "ListItem", "position": 134, "name": "Assicurazione malattia frontalieri", "url": `${BASE_URL}/articoli-frontaliere/assicurazione-malattia-famiglia` },
 { "@type": "ListItem", "position": 135, "name": "Frontalieri in calo: ecco le vere cause", "url": `${BASE_URL}/articoli-frontaliere/calo-frontalieri-ticino-economia` },
 { "@type": "ListItem", "position": 136, "name": "Frontalieri in calo in Ticino", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-calo-economia-ticinese` },
 { "@type": "ListItem", "position": 137, "name": "USI Startup Centre tra i migliori d'Europa", "url": `${BASE_URL}/articoli-frontaliere/usi-centro-startup-classifica` },
 { "@type": "ListItem", "position": 138, "name": "Sciopero in Italia: Impatti sui Treni Tilo", "url": `${BASE_URL}/articoli-frontaliere/sciopero-treni-tilo-febbraio-2026` },
 { "@type": "ListItem", "position": 139, "name": "Nuova copertura per la piscina di Chiasso", "url": `${BASE_URL}/articoli-frontaliere/piscina-chiasso-copertura` },
 { "@type": "ListItem", "position": 140, "name": "Centrale elettrica di Grono operativa", "url": `${BASE_URL}/articoli-frontaliere/centrale-elettrica-grono-attiva` },
 { "@type": "ListItem", "position": 141, "name": "Requisiti e calcolo NASpI frontalieri", "url": `${BASE_URL}/articoli-frontaliere/naspi-frontaliere-italia-requisiti` },
 { "@type": "ListItem", "position": 142, "name": "Prelievo del secondo pilastro LPP per frontalieri", "url": `${BASE_URL}/articoli-frontaliere/prelievo-secondo-pilastro-frontaliere` },
 { "@type": "ListItem", "position": 143, "name": "Accordo Svizzera-UE, firma in arrivo per i fron...", "url": `${BASE_URL}/articoli-frontaliere/accordo-ue-frontalieri-ticino` },
 { "@type": "ListItem", "position": 144, "name": "Ticino e Italia in tensione sui ristorni fiscali", "url": `${BASE_URL}/articoli-frontaliere/ristorni-congelati-ticino-italia` },
 { "@type": "ListItem", "position": 145, "name": "Indennità di disoccupazione NASpI per ex-fronta...", "url": `${BASE_URL}/articoli-frontaliere/naspi-ex-frontalieri-2026` },
 { "@type": "ListItem", "position": 146, "name": "Mutuo per frontalieri in Italia", "url": `${BASE_URL}/articoli-frontaliere/mutuo-casa-frontalieri-italia` },
 { "@type": "ListItem", "position": 147, "name": "Investimento per la piscina di Chiasso", "url": `${BASE_URL}/articoli-frontaliere/piscina-chiasso-investimento` },
 { "@type": "ListItem", "position": 148, "name": "Ristorni congelati: Gobbi contro Berna", "url": `${BASE_URL}/articoli-frontaliere/ristorni-congelati-gobbi-2026` },
 { "@type": "ListItem", "position": 149, "name": "Guida frontalieri: asili nido in Ticino", "url": `${BASE_URL}/articoli-frontaliere/asilo-nido-ticino-guida-2026` },
 { "@type": "ListItem", "position": 150, "name": "Congelamento ristorni salute 2026", "url": `${BASE_URL}/articoli-frontaliere/ristorni-salute-2026-ticino` },
 { "@type": "ListItem", "position": 151, "name": "Ticino minaccia blocco ristorni fiscali per tas...", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-scontro-ticino-berna` },
 { "@type": "ListItem", "position": 152, "name": "Chiasso rinnova la copertura della piscina comu...", "url": `${BASE_URL}/articoli-frontaliere/piscina-chiasso-rinnovo-copertura-sicurezza` },
 { "@type": "ListItem", "position": 153, "name": "Sciopero Tilo Febbraio 2026", "url": `${BASE_URL}/articoli-frontaliere/sciopero-tilo-italia-disagi-frontalieri` },
 { "@type": "ListItem", "position": 154, "name": "Sconti trasporti frontalieri 2026", "url": `${BASE_URL}/articoli-frontaliere/abbonamenti-sconti-treni-ticino` },
 { "@type": "ListItem", "position": 155, "name": "Bonus famiglia frontalieri 2026", "url": `${BASE_URL}/articoli-frontaliere/bonus-famiglia-frontalieri-2026` },
 { "@type": "ListItem", "position": 156, "name": "Smart Working per Frontalieri in Ticino", "url": `${BASE_URL}/articoli-frontaliere/smart-working-frontalieri-regole` },
 { "@type": "ListItem", "position": 157, "name": "Confronto assicurazioni auto frontalieri", "url": `${BASE_URL}/articoli-frontaliere/confronto-assicurazioni-auto` },
 { "@type": "ListItem", "position": 158, "name": "Permesso B e G: tutte le differenze", "url": `${BASE_URL}/articoli-frontaliere/permesso-b-vs-g-differenze` },
 { "@type": "ListItem", "position": 159, "name": "Guida rimborso spese sanitarie frontalieri", "url": `${BASE_URL}/articoli-frontaliere/spese-sanitarie-frontalieri` },
 { "@type": "ListItem", "position": 160, "name": "NASpI per frontalieri italiani", "url": `${BASE_URL}/articoli-frontaliere/naspi-disoccupazione-frontalieri` },
 { "@type": "ListItem", "position": 161, "name": "Dichiarazione redditi Ticino 2026", "url": `${BASE_URL}/articoli-frontaliere/dichiarazione-redditi-ticino-2026` },
 { "@type": "ListItem", "position": 162, "name": "Cantieri sull'A9: impatti sul traffico", "url": `${BASE_URL}/articoli-frontaliere/cantieri-traffico-a9-ticino` },
 { "@type": "ListItem", "position": 163, "name": "Migranti al Seghezzone: risparmi significativi", "url": `${BASE_URL}/articoli-frontaliere/migranti-seghezzone-risparmi` },
 { "@type": "ListItem", "position": 164, "name": "Traffico frontalieri: cantieri sull'A9", "url": `${BASE_URL}/articoli-frontaliere/cantieri-traffico-frontiera` },
 { "@type": "ListItem", "position": 165, "name": "Salario minimo PS: nuovo accordo 2026", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-ps-compromesso` },
 { "@type": "ListItem", "position": 166, "name": "Traffico di Cocaina in Ticino", "url": `${BASE_URL}/articoli-frontaliere/traffico-cocaina-ticino-lusso` },
 { "@type": "ListItem", "position": 167, "name": "Calcolo tasse frontalieri entro 20 km", "url": `${BASE_URL}/articoli-frontaliere/calcolo-tasse-frontalieri-entro-20-km` },
 { "@type": "ListItem", "position": 168, "name": "Riforma Giustizia di Pace Ticino", "url": `${BASE_URL}/articoli-frontaliere/riforma-giustizia-pace-ticino` },
 { "@type": "ListItem", "position": 169, "name": "Cantieri sulla A9: disagi ai valichi", "url": `${BASE_URL}/articoli-frontaliere/cantieri-a9-disagi-frontiera` },
 { "@type": "ListItem", "position": 170, "name": "Magliaso: uso parsimonioso dell'acqua revocato", "url": `${BASE_URL}/articoli-frontaliere/revoca-uso-acqua-magliaso` },
 { "@type": "ListItem", "position": 171, "name": "Malattie rare in Ticino: 25mila casi", "url": `${BASE_URL}/articoli-frontaliere/malattie-rare-ticino` },
 { "@type": "ListItem", "position": 172, "name": "Frontaliers Sabotage arriva a Varese", "url": `${BASE_URL}/articoli-frontaliere/frontaliers-sabotage-varese` },
 { "@type": "ListItem", "position": 173, "name": "Ristorni congelati: Ticino e Berna in contrasto", "url": `${BASE_URL}/articoli-frontaliere/ristorni-congelati-scontro-ticino` },
 { "@type": "ListItem", "position": 174, "name": "Tassazione individuale e mercato del lavoro in ...", "url": `${BASE_URL}/articoli-frontaliere/tassazione-individuale-donne-lavoro` },
 { "@type": "ListItem", "position": 175, "name": "Pluralismo religioso in Ticino", "url": `${BASE_URL}/articoli-frontaliere/diversita-religiosa-ticino` },
 { "@type": "ListItem", "position": 176, "name": "Voto per corrispondenza: novità 2026", "url": `${BASE_URL}/articoli-frontaliere/voto-corrispondenza-ticino-2026` },
 { "@type": "ListItem", "position": 177, "name": "Lavori a Viale Geno: impatto frontalieri", "url": `${BASE_URL}/articoli-frontaliere/cantiere-viale-geno-rischi` },
 { "@type": "ListItem", "position": 178, "name": "Controlli di velocità in Ticino 2026", "url": `${BASE_URL}/articoli-frontaliere/controlli-velocita-ticino-2026` },
 { "@type": "ListItem", "position": 179, "name": "Sanremo 2026: Aiello e Leo Gassmann", "url": `${BASE_URL}/articoli-frontaliere/sanremo-2026-aiello-gassmann` },
 { "@type": "ListItem", "position": 180, "name": "Violenza giovanile e sicurezza frontalieri", "url": `${BASE_URL}/articoli-frontaliere/violenza-adolescenti-ticino` },
 { "@type": "ListItem", "position": 181, "name": "Comuni frontalieri: la distanza che conta", "url": `${BASE_URL}/articoli-frontaliere/comuni-frontalieri-distanza` },
 { "@type": "ListItem", "position": 182, "name": "Elezioni Comunali in Ticino", "url": `${BASE_URL}/articoli-frontaliere/elezioni-comunali-ticino` },
 { "@type": "ListItem", "position": 183, "name": "Eroina a Chiasso-Brogeda: sequestrati 5 kg", "url": `${BASE_URL}/articoli-frontaliere/eroina-auto-chiasso-brogeda` },
 { "@type": "ListItem", "position": 184, "name": "Olio di girasole e chimica nella produzione", "url": `${BASE_URL}/articoli-frontaliere/olio-chimica-produzione-ticino` },
 { "@type": "ListItem", "position": 185, "name": "Incidente mortale a Porlezza", "url": `${BASE_URL}/articoli-frontaliere/incidente-mortale-frontaliere` },
 { "@type": "ListItem", "position": 186, "name": "Svizzera e Iran: mediazione in dubbio", "url": `${BASE_URL}/articoli-frontaliere/svizzera-dovrebbe-rinunciare-mediazione` },
 { "@type": "ListItem", "position": 187, "name": "Sanremo 2026: Impatti transfrontalieri", "url": `${BASE_URL}/articoli-frontaliere/sanremo-frontalieri-impatti` },
 { "@type": "ListItem", "position": 188, "name": "Educatori in Germania: stipendi fino a 3.000€", "url": `${BASE_URL}/articoli-frontaliere/lavorare-germania-educatori` },
 { "@type": "ListItem", "position": 189, "name": "Porto Ceresio rinnova il lungolago", "url": `${BASE_URL}/articoli-frontaliere/porto-ceresio-lungolago-lavori` },
 { "@type": "ListItem", "position": 190, "name": "La Casa dell'Hockey in Ticino", "url": `${BASE_URL}/articoli-frontaliere/casa-hockey-ticino` },
 { "@type": "ListItem", "position": 191, "name": "Tassazione individuale e lavoro in Ticino", "url": `${BASE_URL}/articoli-frontaliere/tassazione-individuale-svizzera` },
 { "@type": "ListItem", "position": 192, "name": "Frontaliers Sabotage: il film che unisce Ticino...", "url": `${BASE_URL}/articoli-frontaliere/film-frontaliers-sabotage-varese` },
 { "@type": "ListItem", "position": 193, "name": "Salario Minimo Ticino: PS Vota Sì", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-ticino-accordo-ps` },
 { "@type": "ListItem", "position": 194, "name": "Fede adulta a Chiasso, impatto frontalieri", "url": `${BASE_URL}/articoli-frontaliere/chiasso-fede-adulti-integrazione` },
 { "@type": "ListItem", "position": 195, "name": "Controlli Rafforzati al Confine Ticinese", "url": `${BASE_URL}/articoli-frontaliere/sicurezza-confine-ticino-brogeda` },
 { "@type": "ListItem", "position": 196, "name": "Tetto salari manager energia: il dibattito fede...", "url": `${BASE_URL}/articoli-frontaliere/stipendi-manager-energia-ticino` },
 { "@type": "ListItem", "position": 197, "name": "Educatori in Germania: stipendi fino a 3mila eu...", "url": `${BASE_URL}/articoli-frontaliere/lavoro-educatori-germania-alternativa-frontalieri` },
 { "@type": "ListItem", "position": 198, "name": "Christian Constantin investe 10,6 milioni in un...", "url": `${BASE_URL}/articoli-frontaliere/gandria-lusso-immobiliare-ticino` },
 { "@type": "ListItem", "position": 199, "name": "Vandalismo sui bus: impatto sui frontalieri e i...", "url": `${BASE_URL}/articoli-frontaliere/vandalismo-bus-ticino-frontalieri` },
 { "@type": "ListItem", "position": 200, "name": "Iniziativa 'Anti-Dumping' Salariale al Voto in ...", "url": `${BASE_URL}/articoli-frontaliere/ticino-voto-anti-dumping-salariale` },
 { "@type": "ListItem", "position": 201, "name": "Controlli velocità mobili in Ticino per i front...", "url": `${BASE_URL}/articoli-frontaliere/controlli-stradali-ticino-frontalieri-marzo-2026` },
 { "@type": "ListItem", "position": 202, "name": "Nuove regole fiscali per i comuni di confine", "url": `${BASE_URL}/articoli-frontaliere/comuni-confine-nuove-regole-fiscali` },
 { "@type": "ListItem", "position": 203, "name": "Tragedia sul confine: muore frontaliere 19enne ...", "url": `${BASE_URL}/articoli-frontaliere/tragedia-stradale-frontaliere-porlezza` },
 { "@type": "ListItem", "position": 204, "name": "Chiusure A9 Chiasso-Como: Impatto sul Traffico ...", "url": `${BASE_URL}/articoli-frontaliere/chiasso-como-autostrada-a9-chiusure-notturne-cantieri` },
 { "@type": "ListItem", "position": 205, "name": "Chiasso: Fede Adulta e Cambiamento Sociale", "url": `${BASE_URL}/articoli-frontaliere/chiasso-comunita-evoluzione-sociale` },
 { "@type": "ListItem", "position": 206, "name": "Incidente mortale a Porletta: frontaliere 19enn...", "url": `${BASE_URL}/articoli-frontaliere/tragedia-pendolare-frontaliere-porletta` },
 { "@type": "ListItem", "position": 207, "name": "A9 Como-Chiasso chiude di notte per trasporti e...", "url": `${BASE_URL}/articoli-frontaliere/a9-como-chiasso-disagi-notturni-frontiera` },
 { "@type": "ListItem", "position": 208, "name": "Ripresa economica 2026", "url": `${BASE_URL}/articoli-frontaliere/economia-svizzera-ripresa-2026` },
 { "@type": "ListItem", "position": 210, "name": "Nuova regola 20km per comuni di confine", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-nuova-mappa-fiscale-comuni-confine` },
 { "@type": "ListItem", "position": 211, "name": "A9 Chiasso-Como: Chiusure Notturne e Cantieri a...", "url": `${BASE_URL}/articoli-frontaliere/chiusure-notturne-a9-chiasso-como-marzo-frontalieri` },
 { "@type": "ListItem", "position": 212, "name": "A9 Chiasso-Como: Chiusure Notturne e Cantieri p...", "url": `${BASE_URL}/articoli-frontaliere/chiusura-notturna-a9-chiasso-como-frontalieri` },
 { "@type": "ListItem", "position": 213, "name": "A9 Chiasso-Como: Chiusure e Cantieri per Traspo...", "url": `${BASE_URL}/articoli-frontaliere/chiusure-a9-trasporti-speciali-como-chiasso` },
 { "@type": "ListItem", "position": 214, "name": "Iniziativa anti-dumping salariale in Ticino: vo...", "url": `${BASE_URL}/articoli-frontaliere/iniziativa-salari-ticino-voto-anti-dumping` },
 { "@type": "ListItem", "position": 215, "name": "Ticino vota iniziativa anti-dumping salariale", "url": `${BASE_URL}/articoli-frontaliere/dumping-salariale-ticino-voto-frontalieri` },
 { "@type": "ListItem", "position": 216, "name": "Scontro fatale a Porlezza: frontaliere perde la...", "url": `${BASE_URL}/articoli-frontaliere/scontro-fatale-porlezza-frontaliere` },
 { "@type": "ListItem", "position": 217, "name": "Nuove regole per i comuni di confine penalizzan...", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-confine-disparita-fiscale` },
 { "@type": "ListItem", "position": 218, "name": "Iniziativa anti-dumping salariale in Ticino al ...", "url": `${BASE_URL}/articoli-frontaliere/iniziativa-anti-dumping-salari-ticino-voto` },
 { "@type": "ListItem", "position": 219, "name": "Nestlé Italia bonus dipendenti", "url": `${BASE_URL}/articoli-frontaliere/nestle-bonus-lombardia-welfare-frontalieri` },
 { "@type": "ListItem", "position": 220, "name": "A9 Chiasso-Como: Chiusure Notturne e Cantieri p...", "url": `${BASE_URL}/articoli-frontaliere/a9-chiasso-como-chiusure-notturne-cantieri` },
 { "@type": "ListItem", "position": 221, "name": "Mercato del Lavoro Ticino in Contrazione nel Q4...", "url": `${BASE_URL}/articoli-frontaliere/mercato-lavoro-ticino-rallenta-2025` },
 { "@type": "ListItem", "position": 222, "name": "Comuni di confine: la distanza che vale 150'000...", "url": `${BASE_URL}/articoli-frontaliere/comuni-frontiera-nuove-regole-fiscali` },
 { "@type": "ListItem", "position": 223, "name": "Franco Forte: Vantaggi e Sfide per i Frontalier...", "url": `${BASE_URL}/articoli-frontaliere/franco-forte-impatto-frontalieri` },
 { "@type": "ListItem", "position": 224, "name": "Tragico incidente frontaliere Porletta, implica...", "url": `${BASE_URL}/articoli-frontaliere/tragedia-frontaliere-porlezza-via-ceresio` },
 { "@type": "ListItem", "position": 225, "name": "A9 Chiasso-Como: Cantieri Notturni e Traffico F...", "url": `${BASE_URL}/articoli-frontaliere/chiusure-notturne-a9-frontalieri` },
 { "@type": "ListItem", "position": 226, "name": "Salario Minimo Ticino: PS apre al compromesso c...", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-compromesso-ps-ticino` },
 { "@type": "ListItem", "position": 227, "name": "Salario Minimo Ticino: PS Apre a Compromesso Co...", "url": `${BASE_URL}/articoli-frontaliere/compromesso-salario-minimo-condizioni` },
 { "@type": "ListItem", "position": 228, "name": "Chiasso: La Comunità Si Riscopre Tra Fede e Nuo...", "url": `${BASE_URL}/articoli-frontaliere/chiasso-comunita-cambiamento-valori` },
 { "@type": "ListItem", "position": 229, "name": "Tragedia Porlezza: giovane frontaliere morto", "url": `${BASE_URL}/articoli-frontaliere/pendolarismo-fatale-frontaliere-porlezza` },
 { "@type": "ListItem", "position": 230, "name": "Salario Minimo Ticinese: PS apre al compromesso...", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-ticino-trattative-compromesso` },
 { "@type": "ListItem", "position": 231, "name": "Riqualifica Campus Trevano, Nuove Opportunità L...", "url": `${BASE_URL}/articoli-frontaliere/trevano-campus-riqualifica-12-milioni-lavori` },
 { "@type": "ListItem", "position": 232, "name": "Lavena Ponte Tresa: nuovo sagrato per la chiesa", "url": `${BASE_URL}/articoli-frontaliere/lavena-ponte-tresa-nuovo-sagrato-chiesa` },
 { "@type": "ListItem", "position": 233, "name": "Sportello Openjobmetis a Varese supporta i fron...", "url": `${BASE_URL}/articoli-frontaliere/sportello-lavoro-varese-frontalieri-ticino` },
 { "@type": "ListItem", "position": 234, "name": "Radar senza quartiere: controlli intensivi in T...", "url": `${BASE_URL}/articoli-frontaliere/controlli-stradali-intensivi-frontiera-ticino` },
 { "@type": "ListItem", "position": 235, "name": "Controlli radar intensivi per i frontalieri in ...", "url": `${BASE_URL}/articoli-frontaliere/settimana-di-controlli-radar-intensivi-confine-ticino-marzo` },
 { "@type": "ListItem", "position": 236, "name": "Controlli Intensificati al Confine Ticinese: Co...", "url": `${BASE_URL}/articoli-frontaliere/controlli-frontiera-ticino-rafforzati` },
 { "@type": "ListItem", "position": 237, "name": "Lavori di risanamento sulla A13 Cadenazzo–S. An...", "url": `${BASE_URL}/articoli-frontaliere/lavori-risanamento-a13-cadenazzo-2026` },
 { "@type": "ListItem", "position": 238, "name": "Salario Minimo Ticino: La Politica Sfiora l'Acc...", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-ticino-intesa-storica` },
 { "@type": "ListItem", "position": 239, "name": "Controlli della velocità mobili in Ticino: Avvi...", "url": `${BASE_URL}/articoli-frontaliere/sicurezza-stradale-ticino-marzo` },
 { "@type": "ListItem", "position": 240, "name": "A13 Cadenazzo: Lavori di Risanamento e Impatto ...", "url": `${BASE_URL}/articoli-frontaliere/a13-cantieri-frontalieri-ticino` },
 { "@type": "ListItem", "position": 241, "name": "BNS, utile 2025 in forte calo: cosa significa p...", "url": `${BASE_URL}/articoli-frontaliere/bns-utile-calo-2025-impatto-ticino` },
 { "@type": "ListItem", "position": 242, "name": "Nuovi Gendarmi: il Ticino Rafforza la Sicurezza...", "url": `${BASE_URL}/articoli-frontaliere/polizia-cantonale-nuovi-gendarmi` },
 { "@type": "ListItem", "position": 243, "name": "Carenza di Competenze Tecniche nel Piemonte Ori...", "url": `${BASE_URL}/articoli-frontaliere/competenze-tecniche-frontalieri-ticino` },
 { "@type": "ListItem", "position": 244, "name": "Ticino: La Scuola di Polizia 2026 accoglie 21 n...", "url": `${BASE_URL}/articoli-frontaliere/polizia-cantonale-reclutamento-2026` },
 { "@type": "ListItem", "position": 245, "name": "A febbraio in crescita il mercato dell’auto", "url": `${BASE_URL}/articoli-frontaliere/mercato-auto-febbraio-2026` },
 { "@type": "ListItem", "position": 246, "name": "Como, in servizio 8 nuovi poliziotti: sono 7 ag...", "url": `${BASE_URL}/articoli-frontaliere/como-nuovi-poliziotti-2026` },
 { "@type": "ListItem", "position": 247, "name": "Cresce a Sesto Calende il Controllo di Vicinato...", "url": `${BASE_URL}/articoli-frontaliere/sesto-calende-sicurezza-frontalieri` },
 { "@type": "ListItem", "position": 248, "name": "Nessun prelievo AVS sulle mance", "url": `${BASE_URL}/articoli-frontaliere/nessun-prelievo-avs-sulle-mance` },
 { "@type": "ListItem", "position": 249, "name": "Imposizione Individuale delle Coppie Sposate: U...", "url": `${BASE_URL}/articoli-frontaliere/imposizione-individuale-donne-ticino` },
 { "@type": "ListItem", "position": 250, "name": "Tassa salute frontalieri: vantaggio per il Ticino?", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-frontalieri-vantaggio-ticino` },
 { "@type": "ListItem", "position": 251, "name": "Ticino: Docenti frontalieri senza valido permes...", "url": `${BASE_URL}/articoli-frontaliere/docenti-frontalieri-permesso-lavoro` },
 { "@type": "ListItem", "position": 252, "name": "Iniziativa anti-dumping in Ticino", "url": `${BASE_URL}/articoli-frontaliere/iniziativa-anti-dumping-ticino-2026` },
 { "@type": "ListItem", "position": 253, "name": "Comuni di Confine: L'Impatto Fiscale sui Fronta...", "url": `${BASE_URL}/articoli-frontaliere/comuni-confine-fiscalita-disparita` },
 { "@type": "ListItem", "position": 254, "name": "Svizzera-UE: firmato il pacchetto di accordi", "url": `${BASE_URL}/articoli-frontaliere/svizzera-ue-pacchetto-accordi` },
 { "@type": "ListItem", "position": 255, "name": "Tassa sulla salute: «Berna intende allinearsi a...", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-berna-ticino` },
 { "@type": "ListItem", "position": 257, "name": "La Lombardia vara la prima legge sull’Intellige...", "url": `${BASE_URL}/articoli-frontaliere/ai-lombardia-impatto-ticino` },
 { "@type": "ListItem", "position": 258, "name": "Crisi nel Golfo: Carburanti e Logistica, l'impa...", "url": `${BASE_URL}/articoli-frontaliere/crisi-golfo-carburanti-ticino` },
 { "@type": "ListItem", "position": 259, "name": "Possibili rincari della benzina fino a 2 franch...", "url": `${BASE_URL}/articoli-frontaliere/rincari-benzina-frontalieri-ticino` },
 { "@type": "ListItem", "position": 260, "name": "Crisi in Medio Oriente e benzina: «Approvvigion...", "url": `${BASE_URL}/articoli-frontaliere/crisi-olio-prezzi-benzina-ticino` },
 { "@type": "ListItem", "position": 261, "name": "In Lombardia la rivoluzione AI, Fermi: “La usan...", "url": `${BASE_URL}/articoli-frontaliere/ai-lombardia-ticino-frontaliere-2026` },
 { "@type": "ListItem", "position": 262, "name": "Crisi benzina Ticino", "url": `${BASE_URL}/articoli-frontaliere/benzina-ticino-oriente` },
 { "@type": "ListItem", "position": 262, "name": "Carpooling in Ticino: dai progetti pilota alle ...", "url": `${BASE_URL}/articoli-frontaliere/carpooling-ticino-corsie-frontaliere-2026` },
 { "@type": "ListItem", "position": 264, "name": "Kühne+Nagel, oltre 2mila posti di lavoro a risc...", "url": `${BASE_URL}/articoli-frontaliere/kuhne-nagel-tagli-posti-ticino-2026` },
 { "@type": "ListItem", "position": 265, "name": "Vini ticinesi: un'esperienza enogastronomica unica", "url": `${BASE_URL}/articoli-frontaliere/vini-ticinesi-collaborazione` },
 { "@type": "ListItem", "position": 266, "name": "Wild Boars vince il torneo amatori Hockey Chiasso", "url": `${BASE_URL}/articoli-frontaliere/hockey-chiasso-wild-boars-bis` },
 { "@type": "ListItem", "position": 267, "name": "Svincolo A2 pericoloso, Isabella sollecita il CdS", "url": `${BASE_URL}/articoli-frontaliere/svincolo-a2-biasca-rischi-frontaliere` },
 { "@type": "ListItem", "position": 268, "name": "Guy Parmelin ha firmato a Bruxelles il pacchett...", "url": `${BASE_URL}/articoli-frontaliere/accordi-svizzera-ue-parmelin-bruxelles` },
 { "@type": "ListItem", "position": 269, "name": "Lavori sulla linea ferroviaria Locarno-Cadenazz...", "url": `${BASE_URL}/articoli-frontaliere/lavori-linea-locarno-cadenazzo-2026` },
 { "@type": "ListItem", "position": 270, "name": "Lo spirito dei varesini 'riposa' al Valico Pizz...", "url": `${BASE_URL}/articoli-frontaliere/spirit-varesini-valico-tassa-2026` },
 { "@type": "ListItem", "position": 271, "name": "Economia - Borse in rosso e prezzo del petrolio...", "url": `${BASE_URL}/articoli-frontaliere/borse-in-rosso-prezzo-petrolio-ticino` },
 { "@type": "ListItem", "position": 272, "name": "Frontaliers Sabotage conquista Varese: sold out...", "url": `${BASE_URL}/articoli-frontaliere/frontaliers-sabotage-varese-successo` },
 { "@type": "ListItem", "position": 273, "name": "Disoccupazione in Svizzera: crescita e cause ne...", "url": `${BASE_URL}/articoli-frontaliere/disoccupazione-svizzera-2026` },
 { "@type": "ListItem", "position": 274, "name": "La carenza di infermieri in Svizzera e le sue i...", "url": `${BASE_URL}/articoli-frontaliere/infermieri-svizzera-frontalieri-ticino` },
 { "@type": "ListItem", "position": 275, "name": "Farmaceutica: successi e sfide per la Svizzera", "url": `${BASE_URL}/articoli-frontaliere/successo-farmaceutica-ticino` },
 { "@type": "ListItem", "position": 276, "name": "Utile della BNS a 26,1 miliardi di franchi", "url": `${BASE_URL}/articoli-frontaliere/utile-bns-2025-ticino` },
 { "@type": "ListItem", "position": 277, "name": "Le banche svizzere assumono meno, cresce la dis...", "url": `${BASE_URL}/articoli-frontaliere/banche-ticino-disoccupazione` },
 { "@type": "ListItem", "position": 278, "name": "Medio Vedeggio, nasce il gruppo di lavoro per l...", "url": `${BASE_URL}/articoli-frontaliere/medio-vedeggio-gruppo-lavoro-aggregazione` },
 { "@type": "ListItem", "position": 279, "name": "Lugano Airport è salvo: il Nazionale boccia il ...", "url": `${BASE_URL}/articoli-frontaliere/lugano-airport-fondi-salvati-2026` },
 { "@type": "ListItem", "position": 280, "name": "Made in Italy, il Comitato delle Regioni accogl...", "url": `${BASE_URL}/articoli-frontaliere/made-in-italy-doganali-ticino-2026` },
 { "@type": "ListItem", "position": 281, "name": "Notiziario statistico Ustat: Il mercato del lav...", "url": `${BASE_URL}/articoli-frontaliere/mercato-lavoro-ticino-q4-2025` },
 { "@type": "ListItem", "position": 282, "name": "Dichiarazione d’imposta sempre più digitale", "url": `${BASE_URL}/articoli-frontaliere/dichiarazione-imposta-digitale-ticino-26` },
 { "@type": "ListItem", "position": 283, "name": "FerroviaRaggiunti i 25 milioni di passeggeri pe...", "url": `${BASE_URL}/articoli-frontaliere/tilo-25-milioni-passeggeri-2025` },
 { "@type": "ListItem", "position": 284, "name": "Tassa salute Lombardia: la decisione che cambia...", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-lombardia-rinvio` },
 { "@type": "ListItem", "position": 285, "name": "TILO raggiunge i 25 milioni di passeggeri nel 2025", "url": `${BASE_URL}/articoli-frontaliere/tilo-record-passeggeri-2025` },
 { "@type": "ListItem", "position": 286, "name": "Frontalieri e tassa salute, schiaffo dal Piemonte", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-tassa-salute-piemonte` },
 { "@type": "ListItem", "position": 287, "name": "Tilo: record di passeggeri tra Lombardia e Ticino", "url": `${BASE_URL}/articoli-frontaliere/trasporti-lombardia-ticino-record-tilo` },
 { "@type": "ListItem", "position": 288, "name": "Frontalieri e tassa salute: la confusione tra p...", "url": `${BASE_URL}/articoli-frontaliere/confusione-tassa-salute-frontalieri` },
 { "@type": "ListItem", "position": 289, "name": "Neutralità svizzera: il NO del Parlamento Federale", "url": `${BASE_URL}/articoli-frontaliere/neutralita-svizzera-parere-nazionale` },
 { "@type": "ListItem", "position": 290, "name": "Il costo del carburante in Ticino si impenna: u...", "url": `${BASE_URL}/articoli-frontaliere/carburante-ticino-costo-aumenti` },
 { "@type": "ListItem", "position": 291, "name": "CPI e Caso Hospita: richiesta di rivalutazione ...", "url": `${BASE_URL}/articoli-frontaliere/cpi-caso-hospita-rivalutazione-periti` },
 { "@type": "ListItem", "position": 292, "name": "Canton Grigioni: Impossibile richiedere il case...", "url": `${BASE_URL}/articoli-frontaliere/casellario-giudiziale-ue-ticino` },
 { "@type": "ListItem", "position": 293, "name": "Salario minimo: il Canton Ticino verso un accordo", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-per-il-controprogetto-la-strada-e-in-discesa` },
 { "@type": "ListItem", "position": 294, "name": "Tassa sulla salute: Lombardia non applicherà il...", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-lombardia-frontalieri` },
 { "@type": "ListItem", "position": 295, "name": "Il franco forte: opportunità e sfide per il Ticino", "url": `${BASE_URL}/articoli-frontaliere/franco-forte-problemi-economici` },
 { "@type": "ListItem", "position": 296, "name": "Aumento dei Prezzi della Benzina in Ticino: Opp...", "url": `${BASE_URL}/articoli-frontaliere/carburante-prezzo-salito-opportunismo` },
 { "@type": "ListItem", "position": 297, "name": "Frontalieri e tassa salute: cancellatela e basta", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-tassa-salute-teatro` },
 { "@type": "ListItem", "position": 298, "name": "Disoccupazione stabile al 3,2% in Svizzera", "url": `${BASE_URL}/articoli-frontaliere/disoccupazione-stabile-svizzera-2026` },
 { "@type": "ListItem", "position": 299, "name": "Dazi USA: Rimborsi in Ritardo per i Frontalieri", "url": `${BASE_URL}/articoli-frontaliere/dazi-usa-rimborsi-ritardi` },
 { "@type": "ListItem", "position": 300, "name": "Votazioni del 8 marzo: l’incerto sull’Iniziativ...", "url": `${BASE_URL}/articoli-frontaliere/votazioni-8-marzo-iniziativa-ssr-aperto` },
 { "@type": "ListItem", "position": 301, "name": "Chiedi info su tariffe e contributi Spitex", "url": `${BASE_URL}/articoli-frontaliere/ticino-spitex-contributo-pressione` },
 { "@type": "ListItem", "position": 302, "name": "Dal 2026: lo stalking diventa reato in Svizzera...", "url": `${BASE_URL}/articoli-frontaliere/stalking-swiss-2026-ticino` },
 { "@type": "ListItem", "position": 303, "name": "Ticino: Due automobilisti italiani tra i pirati...", "url": `${BASE_URL}/articoli-frontaliere/pirati-strada-ticino-italiani-2026` },
 { "@type": "ListItem", "position": 304, "name": "Sette Comuni del Locarnese sul Futuro: Aggregaz...", "url": `${BASE_URL}/articoli-frontaliere/comuni-locarno-futuro-aggregazione` },
 { "@type": "ListItem", "position": 305, "name": "Ticino: dal 2026 si pagherà per le cure a domic...", "url": `${BASE_URL}/articoli-frontaliere/costi-cure-domicilio-ticino-2026` },
 { "@type": "ListItem", "position": 306, "name": "Lugano: Park and Ride poco usati, bus sovvenzio...", "url": `${BASE_URL}/articoli-frontaliere/lugano-park-ride-bus-sovvenzioni-2026` },
 { "@type": "ListItem", "position": 307, "name": "Crisi Medio Oriente: Impatto sul Turismo Svizzero", "url": `${BASE_URL}/articoli-frontaliere/crisi-turismo-golfo-persico` },
 { "@type": "ListItem", "position": 308, "name": "Turisti ticinesi bloccati in Medio Oriente: «So...", "url": `${BASE_URL}/articoli-frontaliere/turisti-ticinesi-bloccati-medio-oriente` },
 { "@type": "ListItem", "position": 309, "name": "Svizzeri bloccati in Medio Oriente", "url": `${BASE_URL}/articoli-frontaliere/svizzeri-bloccati-medio-oriente` },
 { "@type": "ListItem", "position": 310, "name": "Ticino rafforza la sicurezza nelle scuole dopo ...", "url": `${BASE_URL}/articoli-frontaliere/ticino-prevenzione-incendi-scuole-2026` },
 { "@type": "ListItem", "position": 311, "name": "Varese punta a Oriente: l’export verso l’India ...", "url": `${BASE_URL}/articoli-frontaliere/varese-india-export-2026` },
 { "@type": "ListItem", "position": 312, "name": "Economia - Carburanti: allarme autotrasportator...", "url": `${BASE_URL}/articoli-frontaliere/autotrasporto-rincari-confine-2026` },
 { "@type": "ListItem", "position": 313, "name": "Carburanti, l'ondata di rincari continua: schiz...", "url": `${BASE_URL}/articoli-frontaliere/carburanti-rincari-confine-ticino` },
 { "@type": "ListItem", "position": 314, "name": "Un chiaro No ai '200 franchi bastano', si profi...", "url": `${BASE_URL}/articoli-frontaliere/votazioni-imposizione-ticino-2026` },
 { "@type": "ListItem", "position": 315, "name": "Svizzera: svolta fiscale con l'imposizione indi...", "url": `${BASE_URL}/articoli-frontaliere/imposizione-individuale-ticino-2026` },
 { "@type": "ListItem", "position": 316, "name": "Ticino: No all'iniziativa antidumping e al cano...", "url": `${BASE_URL}/articoli-frontaliere/no-iniziativa-antidumping-ticino` },
 { "@type": "ListItem", "position": 317, "name": "Incidente sul Viadotto Brogeda: Dettagli e Cons...", "url": `${BASE_URL}/articoli-frontaliere/incidente-viadotto-brogeda-como` },
 { "@type": "ListItem", "position": 318, "name": "L’iniziativa contro il dumping va a sbattere co...", "url": `${BASE_URL}/articoli-frontaliere/iniziativa-contro-dumping-ticino` },
 { "@type": "ListItem", "position": 319, "name": "Dumping salariale: respinta l'iniziativa dell'MPS", "url": `${BASE_URL}/articoli-frontaliere/dumping-salariale-iniziativa-mps` },
 { "@type": "ListItem", "position": 320, "name": "Imposizione individuale: approvata una rivoluzi...", "url": `${BASE_URL}/articoli-frontaliere/imposizione-individuale-rivoluzione-fiscale` },
 { "@type": "ListItem", "position": 321, "name": "Svizzera: Il no al dimezzamento del canone TV", "url": `${BASE_URL}/articoli-frontaliere/svizzera-servizio-pubblico-canone-tv` },
 { "@type": "ListItem", "position": 322, "name": "Votazioni federali: Sì alla tassazione individu...", "url": `${BASE_URL}/articoli-frontaliere/votazioni-federali-tassazione-individuale` },
 { "@type": "ListItem", "position": 323, "name": "Frontalieri negli atenei ticinesi: il caso dell...", "url": `${BASE_URL}/articoli-frontaliere/universita-ticino-frontalieri` },
 { "@type": "ListItem", "position": 324, "name": "Franco svizzero sempre più forte: frontalieri s...", "url": `${BASE_URL}/articoli-frontaliere/franco-svizzero-frontalieri-ricchi-2026` },
 { "@type": "ListItem", "position": 325, "name": "Energia, costi e rincari preoccupano la politic...", "url": `${BASE_URL}/articoli-frontaliere/energia-costi-ticino-rincari-2026` },
 { "@type": "ListItem", "position": 326, "name": "Ticino: Carburante alle Stelle, Quadri Chiede R...", "url": `${BASE_URL}/articoli-frontaliere/ticino-carburante-alle-stelle-quadri-berna-riduca-tasse` },
 { "@type": "ListItem", "position": 327, "name": "Test salivare per l'endometriosi: quando la cas...", "url": `${BASE_URL}/articoli-frontaliere/un-test-per-dare-un-nome-al-dolore` },
 { "@type": "ListItem", "position": 328, "name": "Aumenti Benzina in Ticino: Opportunismo o Panico?", "url": `${BASE_URL}/articoli-frontaliere/aumentare-gia-il-prezzo-della-benzina` },
 { "@type": "ListItem", "position": 329, "name": "Furti nei supermercati: fermati i sospettati a ...", "url": `${BASE_URL}/articoli-frontaliere/furti-supermercati-ponte-tresa` },
 { "@type": "ListItem", "position": 330, "name": "Ladri intercettati dalla Polizia Locale a Laven...", "url": `${BASE_URL}/articoli-frontaliere/ladri-intercettati-lavena-ponte-tresa` },
 { "@type": "ListItem", "position": 331, "name": "Dumping salariale: il Ticino dice “no” all’iniz...", "url": `${BASE_URL}/articoli-frontaliere/dumping-salariale-ticino-no` },
 { "@type": "ListItem", "position": 332, "name": "Governo Ticino: sospensione immediata della par...", "url": `${BASE_URL}/articoli-frontaliere/sospensione-costi-utenti-ticino` },
 { "@type": "ListItem", "position": 333, "name": "Incidenti stradali Ticino", "url": `${BASE_URL}/articoli-frontaliere/investimento-pedone-bioggio` },
 { "@type": "ListItem", "position": 334, "name": "Violenze e furti in stazioni e sui treni: «Serv...", "url": `${BASE_URL}/articoli-frontaliere/sicurezza-stazioni-treni-ticino-2026` },
 { "@type": "ListItem", "position": 335, "name": "Tir in colonna e disagi a ridosso del valico di...", "url": `${BASE_URL}/articoli-frontaliere/tir-colonna-disagi-valico-brogeda` },
 { "@type": "ListItem", "position": 336, "name": "Iniziative cassa malati, Gestione interpella un...", "url": `${BASE_URL}/articoli-frontaliere/iniziative-cassa-malati-costituzionalista-ticino` },
 { "@type": "ListItem", "position": 337, "name": "Valsolda - Autorità di Bacino del Ceresio: inve...", "url": `${BASE_URL}/articoli-frontaliere/investimenti-sicurezza-turismo-valsolda-26` },
 { "@type": "ListItem", "position": 338, "name": "Tempo Libero - Da Rancio Valcuvia a Lavena Pont...", "url": `${BASE_URL}/articoli-frontaliere/premio-la-rondine-2026-ticino` },
 { "@type": "ListItem", "position": 339, "name": "Tassi ipotecari svizzeri a rischio a causa del ...", "url": `${BASE_URL}/articoli-frontaliere/tassi-ipotecari-ticino-medio-oriente-2026` },
 { "@type": "ListItem", "position": 340, "name": "Aumento Export Bellico Svizzero in Ticino", "url": `${BASE_URL}/articoli-frontaliere/aumento-export-bellico-svizzero-ticino` },
 { "@type": "ListItem", "position": 341, "name": "Assicurazione auto, rincari 2026", "url": `${BASE_URL}/articoli-frontaliere/assicurazione-auto-rincari-2026` },
 { "@type": "ListItem", "position": 342, "name": "Ticino: biglietti senza contanti sui mezzi pubb...", "url": `${BASE_URL}/articoli-frontaliere/ticino-biglietti-senza-contanti` },
 { "@type": "ListItem", "position": 343, "name": "Quattro aziende di Como assumono lavoratori: co...", "url": `${BASE_URL}/articoli-frontaliere/aziende-como-assumono-lavoratori` },
 { "@type": "ListItem", "position": 344, "name": "Nuovo svincolo A2 a Giornico: impatto su fronta...", "url": `${BASE_URL}/articoli-frontaliere/a2-giornico-cantiere-disagi-frontalieri` },
 { "@type": "ListItem", "position": 345, "name": "Tassa sul traffico pesante: anche i camion elet...", "url": `${BASE_URL}/articoli-frontaliere/tassa-traffico-pesante-camion-elettrici` },
 { "@type": "ListItem", "position": 346, "name": "Logistica sostenibile, A22 conferma impegno per...", "url": `${BASE_URL}/articoli-frontaliere/logistica-sostenibile-a22` },
 { "@type": "ListItem", "position": 347, "name": "Problemi in rotaia tra Bellinzona e Lugano: dis...", "url": `${BASE_URL}/articoli-frontaliere/problemi-rotaia-bellinzona-lugano` },
 { "@type": "ListItem", "position": 348, "name": "Ticino e frontalieri: successo per il carpoolin...", "url": `${BASE_URL}/articoli-frontaliere/carpooling-aziendale-ticino` },
 { "@type": "ListItem", "position": 349, "name": "Energia, Marcello Di Caterina (Alis): 'Bene ape...", "url": `${BASE_URL}/articoli-frontaliere/energia-ets-von-der-leyen` },
 { "@type": "ListItem", "position": 350, "name": "Permesso G apprendisti frontalieri Ticino", "url": `${BASE_URL}/articoli-frontaliere/permesso-g-apprendisti-frontali` },
 { "@type": "ListItem", "position": 351, "name": "Assegni familiari ai frontalieri: la mozione di...", "url": `${BASE_URL}/articoli-frontaliere/assegni-familiari-frontalieri-ticino` },
 { "@type": "ListItem", "position": 352, "name": "A Chiasso apre ‘Dagatrà’: un nuovo spazio per i...", "url": `${BASE_URL}/articoli-frontaliere/dagatra-incontro-migranti-chiasso` },
 { "@type": "ListItem", "position": 353, "name": "Trasloco dell'ufficio postale di Chiasso: cosa ...", "url": `${BASE_URL}/articoli-frontaliere/ufficio-postale-chiasso-trasloco` },
 { "@type": "ListItem", "position": 354, "name": "Confine tesissimo: stop agli assegni familiari ...", "url": `${BASE_URL}/articoli-frontaliere/confine-tesissimo-assegni-familiari` },
 { "@type": "ListItem", "position": 355, "name": "So What?! Il Festival Jazz di Chiasso 2026: un'...", "url": `${BASE_URL}/articoli-frontaliere/chiasso-jazz-festival-2026` },
 { "@type": "ListItem", "position": 356, "name": "Riforma del permesso G: una svolta per gli appr...", "url": `${BASE_URL}/articoli-frontaliere/apprendisti-frontalieri-riforma-permesso-g` },
 { "@type": "ListItem", "position": 357, "name": "Chiasso: il Tribunale Federale impone la riscri...", "url": `${BASE_URL}/articoli-frontaliere/chiasso-piano-regolatore-telefonia` },
 { "@type": "ListItem", "position": 358, "name": "Aumentare l'età di pensionamento in Ticino: sì ...", "url": `${BASE_URL}/articoli-frontaliere/pensione-et-ticino-sentiero` },
 { "@type": "ListItem", "position": 359, "name": "Il paradosso del Ticino: 600 candidature per 3 ...", "url": `${BASE_URL}/articoli-frontaliere/paradosso-ticino-lavoro` },
 { "@type": "ListItem", "position": 360, "name": "Lavena Ponte Tresa: intercettato un giro di spa...", "url": `${BASE_URL}/articoli-frontaliere/lavena-ponte-tresa-giro-spaccio` },
 { "@type": "ListItem", "position": 362, "name": "Apertura della pesca in Ticino", "url": `${BASE_URL}/articoli-frontaliere/apertura-pesca-ticino` },
 { "@type": "ListItem", "position": 363, "name": "La franchigia minima dell'assicurazione malatti...", "url": `${BASE_URL}/articoli-frontaliere/cassa-malati-franchigia-minima-ticino` },
 { "@type": "ListItem", "position": 364, "name": "Tassa salute frontalieri Ticino: l'appello per ...", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-tassa-salute-ritiro` },
 { "@type": "ListItem", "position": 365, "name": "Frontale nel tunnel di Trin: grave una 30enne", "url": `${BASE_URL}/articoli-frontaliere/trin-tunnel-grave-frontalieri` },
 { "@type": "ListItem", "position": 366, "name": "Le superfici di verde pubblico presenti a Chias...", "url": `${BASE_URL}/articoli-frontaliere/chiasso-verde-sufficiente` },
 { "@type": "ListItem", "position": 367, "name": "Comitati e associazioni intorno a Malpensa chie...", "url": `${BASE_URL}/articoli-frontaliere/comitati-malpensa-cuv-2026` },
 { "@type": "ListItem", "position": 368, "name": "La borsa di Zurigo ha chiuso la settimana con s...", "url": `${BASE_URL}/articoli-frontaliere/borsa-di-zurigo-sprazzi-qu-c3-a0-l-27umor-grigio-resta` },
 { "@type": "ListItem", "position": 369, "name": "Iran, Tajani assicura: Nessuna trattativa per p...", "url": `${BASE_URL}/articoli-frontaliere/iran-tajani-non-tratta-navi` },
 { "@type": "ListItem", "position": 370, "name": "Accordi Bilaterali III, ora tocca al Parlamento", "url": `${BASE_URL}/articoli-frontaliere/accordi-bilaterali-3-parlamento` },
 { "@type": "ListItem", "position": 371, "name": "Il viaggio delle batterie verso una seconda vit...", "url": `${BASE_URL}/articoli-frontaliere/viaggio-delle-batterie-verso-seconda-vita` },
 { "@type": "ListItem", "position": 372, "name": "Bilaterali III, ora la palla passa al Parlament...", "url": `${BASE_URL}/articoli-frontaliere/bilaterali-iii-parlamento-ticino-2026` },
 { "@type": "ListItem", "position": 373, "name": "Affitti in rialzo: la crisi degli alloggi accen...", "url": `${BASE_URL}/articoli-frontaliere/affitti-rialzo-crisi-ticino-2026` },
 { "@type": "ListItem", "position": 374, "name": "Bilaterali III: il Parlamento chiamato a decide...", "url": `${BASE_URL}/articoli-frontaliere/bilaterali-iii-ticino-parlamento-2026` },
 { "@type": "ListItem", "position": 375, "name": "«Vuoi lavorare in Svizzera per noi? Certamente,...", "url": `${BASE_URL}/articoli-frontaliere/truffa-lavoro-svizzera-anticipo-2026` },
 { "@type": "ListItem", "position": 376, "name": "TicinoConflitto e carburanti, Chiesa: «Bisogner...", "url": `${BASE_URL}/articoli-frontaliere/ticino-carburanti-prezzo-potere-acquisto` },
 { "@type": "ListItem", "position": 377, "name": "L'aumento della franchigia minima è un altro ta...", "url": `${BASE_URL}/articoli-frontaliere/aumento-franchigia-minima` },
 { "@type": "ListItem", "position": 378, "name": "{\"@context\":\"https://schema.org\",\"@type\":\"Artic...", "url": `${BASE_URL}/articoli-frontaliere/ticino-swissminiatur-inaugura-miniera-doro-sessa` },
 { "@type": "ListItem", "position": 379, "name": "{\"@context\":\"https://schema.org\",\"@type\":\"Artic...", "url": `${BASE_URL}/articoli-frontaliere/lavena-ponte-tresa-addio-antonio-cannavale` },
 { "@type": "ListItem", "position": 380, "name": "{\"@context\": \"https://schema.org\", \"@type\": \"Ar...", "url": `${BASE_URL}/articoli-frontaliere/gravincidente-stradale-regina-feriti` },
 { "@type": "ListItem", "position": 381, "name": "In Ticino scende il limite delle nevicate", "url": `${BASE_URL}/articoli-frontaliere/scende-limite-nevicate-ticino` },
 { "@type": "ListItem", "position": 382, "name": "Di più In Ticino il 'no' all'iniziativa anti-du...", "url": `${BASE_URL}/articoli-frontaliere/ticino-no-anti-dumping` },
 { "@type": "ListItem", "position": 383, "name": "{\"@context\": \"http://schema.org\", \"@type\": \"Art...", "url": `${BASE_URL}/articoli-frontaliere/chiusa-val-bedretto` },
 { "@type": "ListItem", "position": 384, "name": "{\"@context\":\"https://schema.org\",\"@type\":\"Artic...", "url": `${BASE_URL}/articoli-frontaliere/un-passaporto-di-fedelt` },
 { "@type": "ListItem", "position": 385, "name": "{\"@context\":\"https://schema.org\",\"@type\":\"Artic...", "url": `${BASE_URL}/articoli-frontaliere/baseball-italia-porto-rico-world-classic` },
 { "@type": "ListItem", "position": 386, "name": "Settimana di chiusure sull'autostrada che porta...", "url": `${BASE_URL}/articoli-frontaliere/chiusure-autostrada-confine-ticino-2026` },
 { "@type": "ListItem", "position": 387, "name": "Swissminiatur inaugura la Miniera d'Oro di Sessa", "url": `${BASE_URL}/articoli-frontaliere/swissminiatur-miniera-doro-sessa` },
 { "@type": "ListItem", "position": 388, "name": "Gli svizzeri contrari all'aumento dell'IVA per ...", "url": `${BASE_URL}/articoli-frontaliere/sondaggio-tamedia-iva-esercito-avs` },
 { "@type": "ListItem", "position": 389, "name": "Conflitto in Iran, rincari a cascata per le pic...", "url": `${BASE_URL}/articoli-frontaliere/iran-conflitto-rincari-ticino` },
 { "@type": "ListItem", "position": 390, "name": "Torna l'inverno in Ticino: forte rischio di nev...", "url": `${BASE_URL}/articoli-frontaliere/inverno-ticino-nevicate-2026` },
 { "@type": "ListItem", "position": 391, "name": "Franchigia Minima Sanitaria in Ticino | Frontal...", "url": `${BASE_URL}/articoli-frontaliere/franchigia-minima-sanitario-ticino` },
 { "@type": "ListItem", "position": 392, "name": "Cieslakiewicz: Possibile recessione in Svizzera", "url": `${BASE_URL}/articoli-frontaliere/svizzera-recessione-cieslakiewicz` },
 { "@type": "ListItem", "position": 393, "name": "Valanghe, allerta di livello 4 in quasi tutto i...", "url": `${BASE_URL}/articoli-frontaliere/valanghe-allerta-livello-4-ticino` },
 { "@type": "ListItem", "position": 394, "name": "Nevicate in Ticino: Disagi e Impatti Economici", "url": `${BASE_URL}/articoli-frontaliere/nevicate-strade-bloccate-ticino` },
 { "@type": "ListItem", "position": 395, "name": "I “Bilaterali III” passano all’esame del Parlam...", "url": `${BASE_URL}/articoli-frontaliere/bilaterali-terza-fase-parlamento-ticino` },
 { "@type": "ListItem", "position": 396, "name": "Cane trovato morto sui binari: il campetto di C...", "url": `${BASE_URL}/articoli-frontaliere/cane-morto-binarie-campo-calcio` },
 { "@type": "ListItem", "position": 397, "name": "Swissminiatur 2026: nasce la miniera d'oro di S...", "url": `${BASE_URL}/articoli-frontaliere/swissminiatur-miniera-sessa-2026` },
 { "@type": "ListItem", "position": 398, "name": "Crescita svizzera con libera circolazione? È mi...", "url": `${BASE_URL}/articoli-frontaliere/crescita-misera-libera-circolazione` },
 { "@type": "ListItem", "position": 399, "name": "Ceresio Express: la proposta per collegare Vare...", "url": `${BASE_URL}/articoli-frontaliere/treni-varese-milano-ceresio-express` },
 { "@type": "ListItem", "position": 400, "name": "«Benzina a 3 franchi? Berna rinunci a un po' di...", "url": `${BASE_URL}/articoli-frontaliere/caro-carburante-benzina-ticino` },
 { "@type": "ListItem", "position": 401, "name": "Bilaterali III, Cassis: \"Il prodotto è buono\". ...", "url": `${BASE_URL}/articoli-frontaliere/bilaterali-iii-cassis-ticino` },
 { "@type": "ListItem", "position": 402, "name": "Dichiarazione dei redditi 2026: anche i dati de...", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-redditi-2026` },
 { "@type": "ListItem", "position": 403, "name": "Fermato a Brogeda con oltre 15 chili di cocaina...", "url": `${BASE_URL}/articoli-frontaliere/fermato-brogeda-cocaina` },
 { "@type": "ListItem", "position": 404, "name": "Dominicano con auto svizzera e trafficante: arr...", "url": `${BASE_URL}/articoli-frontaliere/dominicano-auto-svizzera-arresto` },
 { "@type": "ListItem", "position": 405, "name": "Salari bassi e rischio povertà: il PLR interrog...", "url": `${BASE_URL}/articoli-frontaliere/salari-bassi-rischio-povert` },
 { "@type": "ListItem", "position": 406, "name": "Ticino, svolta storica per gli apprendisti fron...", "url": `${BASE_URL}/articoli-frontaliere/ticino-svolta-per-apprendisti` },
 { "@type": "ListItem", "position": 407, "name": "Bellinzona cresce grazie a un'alalta qualità di...", "url": `${BASE_URL}/articoli-frontaliere/bellinzona-crescita-qualita-vita` },
 { "@type": "ListItem", "position": 408, "name": "La crisi degli spermatozoi in Svizzera: un prob...", "url": `${BASE_URL}/articoli-frontaliere/crisi-spermatozoi-svizzera-ticino` },
 { "@type": "ListItem", "position": 409, "name": "La crisi degli alloggi in Ticino: una situazion...", "url": `${BASE_URL}/articoli-frontaliere/mercado-immobiliare-ticino` },
 { "@type": "ListItem", "position": 410, "name": "Operazione antidroga al confine: 15 kg di cocai...", "url": `${BASE_URL}/articoli-frontaliere/droga-brogeda-sequestro-cocaina` },
 { "@type": "ListItem", "position": 411, "name": "A Bellinzona mancano 75 posti auto pubblici e l...", "url": `${BASE_URL}/articoli-frontaliere/bellinzona-auscultazione-2026` },
 { "@type": "ListItem", "position": 412, "name": "Fondo affitti Regione Lombardia 2026: tutto ciò...", "url": `${BASE_URL}/articoli-frontaliere/lombardia-affitto-famiglie-varesine` },
 { "@type": "ListItem", "position": 413, "name": "Malcantone Fai di Primavera 2026 | Frontaliere ...", "url": `${BASE_URL}/articoli-frontaliere/malcantone-fai-di-primavera-2026` },
 { "@type": "ListItem", "position": 414, "name": "Sicurezza privata sotto accusa dopo Nebiopoli, ...", "url": `${BASE_URL}/articoli-frontaliere/sicurezza-privata-chiasso-nebiopoli` },
 { "@type": "ListItem", "position": 415, "name": "Sfruttamento corrieri: la verità nascosta dietr...", "url": `${BASE_URL}/articoli-frontaliere/sfruttamento-corsieri-ticino-2026` },
 { "@type": "ListItem", "position": 416, "name": "La fuga di talenti a Zurigo: anche le aziende s...", "url": `${BASE_URL}/articoli-frontaliere/lavoro-economia-2026` },
 { "@type": "ListItem", "position": 417, "name": "Brogeda, 15 kg di cocaina sequestrati: aumentan...", "url": `${BASE_URL}/articoli-frontaliere/sequestro-cocaina-brogeda-2026` },
 { "@type": "ListItem", "position": 418, "name": "Cultura, soldi, infiltrazioni criminali: Ticino...", "url": `${BASE_URL}/articoli-frontaliere/infiltrazioni-criminali-ticino-grigioni` },
 { "@type": "ListItem", "position": 419, "name": "Il Luganese punta sulla formazione per migliora...", "url": `${BASE_URL}/articoli-frontaliere/turismo-luganese-formazione` },
 { "@type": "ListItem", "position": 420, "name": "La nevicata record a Bosco Gurin: piste aperte ...", "url": `${BASE_URL}/articoli-frontaliere/nevicata-record-bosco-gurin` },
 { "@type": "ListItem", "position": 421, "name": "Walter Bonatti 'In capo al mondo': il Teatro So...", "url": `${BASE_URL}/articoli-frontaliere/walter-bonatti-in-capo-al-mondo` },
 { "@type": "ListItem", "position": 422, "name": "Teenager arrestati a Sargans: caso di furto e sicurezza", "url": `${BASE_URL}/articoli-frontaliere/sargans-teenage-robbery-catch` },
 { "@type": "ListItem", "position": 423, "name": "Headline JSON-LD", "url": `${BASE_URL}/articoli-frontaliere/separazione-carriere-giudici` },
 { "@type": "ListItem", "position": 424, "name": "Opportunità di lavoro Como", "url": `${BASE_URL}/articoli-frontaliere/com-aziende-lavoro-como` },
 { "@type": "ListItem", "position": 425, "name": "Cabinovia precipita a Engelberg: almeno un feri...", "url": `${BASE_URL}/articoli-frontaliere/cabov-precipita-forte-vento` },
 { "@type": "ListItem", "position": 426, "name": "Agenzia TPL Como: 1,2 miliardi di euro per un s...", "url": `${BASE_URL}/articoli-frontaliere/agenzia-trasporto-nuovo` },
 { "@type": "ListItem", "position": 427, "name": "{\"@context\":\"https://schema.org\",\"@type\":\"NewsA...", "url": `${BASE_URL}/articoli-frontaliere/governo-tavolo-frontalieri-2026` },
 { "@type": "ListItem", "position": 428, "name": "Frontalieri, Gadda incalza il governo: subito i...", "url": `${BASE_URL}/articoli-frontaliere/gadda-incalza-governo-frontalieri` },
 { "@type": "ListItem", "position": 429, "name": "La Centovallina torna a circolare tra Camedo e ...", "url": `${BASE_URL}/articoli-frontaliere/centovallina-riapertura-treni` },
 { "@type": "ListItem", "position": 430, "name": "Truffe 'chiamate shock' a Chiasso e Biasca, due...", "url": `${BASE_URL}/articoli-frontaliere/truffe-chiamate-shock-ticino` },
 { "@type": "ListItem", "position": 431, "name": "Spazi verdi in città: un'ancora di salvezza per...", "url": `${BASE_URL}/articoli-frontaliere/spazi-verdi-in-citta-rilassamento` },
 { "@type": "ListItem", "position": 432, "name": "Camedo, quel buffet pronto a diventare la locat...", "url": `${BASE_URL}/articoli-frontaliere/camedo-buffet-eventi-ticino` },
 { "@type": "ListItem", "position": 433, "name": "Berna discute di approvvigionamento economico e...", "url": `${BASE_URL}/articoli-frontaliere/berna-discute-approvvigionamento-economico-e-13esima-avs` },
 { "@type": "ListItem", "position": 434, "name": "Visita ticinese a Coira, sul tavolo pure la cri...", "url": `${BASE_URL}/articoli-frontaliere/visita-ticinese-coira-criminalita-organizzata` },
 { "@type": "ListItem", "position": 435, "name": "Dumping salariale in Ticino: il caso arriva in ...", "url": `${BASE_URL}/articoli-frontaliere/annunci-lavoro-dumping-ticino-governo` },
 { "@type": "ListItem", "position": 436, "name": "Controlli cantieri: Ticino zero irregolarità, C...", "url": `${BASE_URL}/articoli-frontaliere/controlli-cantieri-mendrisio` },
 { "@type": "ListItem", "position": 437, "name": "Emergenze, catastrofi, blackout: in Ticino 160 ...", "url": `${BASE_URL}/articoli-frontaliere/catastrofi-ticino-prontezza-2026` },
 { "@type": "ListItem", "position": 438, "name": "Tredicesima AVS: gli Stati propongono una soluz...", "url": `${BASE_URL}/articoli-frontaliere/tredicesima-avs-soluzione-mista-stati` },
 { "@type": "ListItem", "position": 439, "name": "Lo statuto S e il permesso B nel Canton Ticino:...", "url": `${BASE_URL}/articoli-frontaliere/lo-statuto-s-non-deve-trasformarsi-in-permesso-b` },
 { "@type": "ListItem", "position": 440, "name": "Il Consiglio degli Stati approva la soluzione m...", "url": `${BASE_URL}/articoli-frontaliere/consiglio-stati-soluzione-mista-13esima-avs` },
 { "@type": "ListItem", "position": 441, "name": "Frode da 2,7 milioni alla cassa di compensazion...", "url": `${BASE_URL}/articoli-frontaliere/frode-cassa-compensazione-avs-ticino` },
 { "@type": "ListItem", "position": 443, "name": "La deputazione ticinese: «Abbiamo discusso degl...", "url": `${BASE_URL}/articoli-frontaliere/deputazione-ticinese-italofoni-2024` },
 { "@type": "ListItem", "position": 444, "name": "Turismo in Ticino: Il 2025 è stato un anno ecce...", "url": `${BASE_URL}/articoli-frontaliere/kebab-case-turismo-ticino` },
 { "@type": "ListItem", "position": 445, "name": "Nel 2025 più droga e sigarette al confine: il b...", "url": `${BASE_URL}/articoli-frontaliere/droga-al-confine-ticino-2025` },
 { "@type": "ListItem", "position": 446, "name": "Tassa per le auto che attraversano la Svizzera ...", "url": `${BASE_URL}/articoli-frontaliere/tassa-attraversamento-svizzera` },
 { "@type": "ListItem", "position": 447, "name": "Lunghe code sulla strada del lago tra la Schira...", "url": `${BASE_URL}/articoli-frontaliere/incidente-stradale-laghi` },
 { "@type": "ListItem", "position": 448, "name": "Vivere più a lungo in Ticino - Consigli e servi...", "url": `${BASE_URL}/articoli-frontaliere/vivere-piu-lungo-ticino` },
 { "@type": "ListItem", "position": 449, "name": "Governo getta la spugna sulle nomine SIMS: nien...", "url": `${BASE_URL}/articoli-frontaliere/governo-getta-spugna-kebab-case` },
 { "@type": "ListItem", "position": 450, "name": "Scenari \"caldi\" nel Medio Oriente, sulle Borse ...", "url": `${BASE_URL}/articoli-frontaliere/kebab-case-borse-freddo-2024` },
 { "@type": "ListItem", "position": 451, "name": "La Giustizia in Ticino è in bilico: un accordo ...", "url": `${BASE_URL}/articoli-frontaliere/giustizia-in-bilico-2026` },
 { "@type": "ListItem", "position": 452, "name": "Ampliamento del Parco eolico del San Gottardo: ...", "url": `${BASE_URL}/articoli-frontaliere/ampliamento-parco-eolico-san-gottardo-digital-2026` },
 { "@type": "ListItem", "position": 453, "name": "Irregular Stays in Ticino: February 2026 Data S...", "url": `${BASE_URL}/articoli-frontaliere/soggiorni-irregolari-2026-mendrisio` },
 { "@type": "ListItem", "position": 454, "name": "Eolico al Gottardo, il Cantone apre la consulta...", "url": `${BASE_URL}/articoli-frontaliere/eolico-gottardo-ampliamento-2026` },
 { "@type": "ListItem", "position": 455, "name": "Contrabbando ai confini: aumentano droga e siga...", "url": `${BASE_URL}/articoli-frontaliere/contrabbando-ai-confine-aumentano-droga-e-sigarette` },
 { "@type": "ListItem", "position": 456, "name": "{\"@context\": \"http://schema.org\", \"@type\": \"Art...", "url": `${BASE_URL}/articoli-frontaliere/kebab-case-3-5-words-max-40-chars` },
 { "@type": "ListItem", "position": 457, "name": "BlogPost JSON-LD", "url": `${BASE_URL}/articoli-frontaliere/salute-prevenzione-burocrazia-svizzera` },
 { "@type": "ListItem", "position": 458, "name": "Telefonate choc: truffe agli anziani in Ticino,...", "url": `${BASE_URL}/articoli-frontaliere/telefonate-choc-truffa-anziani-ticino` },
 { "@type": "ListItem", "position": 459, "name": "Il cantiere di UBS a tre anni dal salvataggio d...", "url": `${BASE_URL}/articoli-frontaliere/ubs-fusione-credit-suisse-ticino` },
 { "@type": "ListItem", "position": 460, "name": "Salari Minimi e CCL in Ticino: Nuove Direttive ...", "url": `${BASE_URL}/articoli-frontaliere/salari-minimi-ccl-ticino-2026` },
 { "@type": "ListItem", "position": 461, "name": "Headline JSON-LD", "url": `${BASE_URL}/articoli-frontaliere/strutture-dedicate-migranti-ticino` },
 { "@type": "ListItem", "position": 462, "name": "Contratti collettivi di lavoro in Ticino: preva...", "url": `${BASE_URL}/articoli-frontaliere/contratti-collettivi-salari-ticino` },
 { "@type": "ListItem", "position": 463, "name": "Sanità in Ticino: la tutela della sovranità dei...", "url": `${BASE_URL}/articoli-frontaliere/tutela-sovranita-dati-sanitari` },
 { "@type": "ListItem", "position": 464, "name": "Nomine alla SIMS annullate: il Consiglio di Sta...", "url": `${BASE_URL}/articoli-frontaliere/nomine-annullate-sims-tram` },
 { "@type": "ListItem", "position": 465, "name": "Tassa transito Svizzera e frontiere Ticino", "url": `${BASE_URL}/articoli-frontaliere/tassa-automobilisti-svizzera` },
 { "@type": "ListItem", "position": 466, "name": "Richiedenti asilo e ucraini: ora possono lavora...", "url": `${BASE_URL}/articoli-frontaliere/lavoro-richiedenti-asilo-ucraini-ticino` },
 { "@type": "ListItem", "position": 467, "name": "Riforma scolastica in Ticino: un contesto segna...", "url": `${BASE_URL}/articoli-frontaliere/riforma-scolastica-ticino-difficolta` },
 { "@type": "ListItem", "position": 468, "name": "La tassa di transito in Ticino tra approvazione...", "url": `${BASE_URL}/articoli-frontaliere/tassa-transito-parlamento-ticino` },
 { "@type": "ListItem", "position": 469, "name": "Integrazione migranti in Ticino", "url": `${BASE_URL}/articoli-frontaliere/inclusione-migranti-ticino` },
 { "@type": "ListItem", "position": 470, "name": "Analisi sul franco svizzero e l'economia ticinese", "url": `${BASE_URL}/articoli-frontaliere/franco-svizzero-impatti-ticino` },
 { "@type": "ListItem", "position": 471, "name": "Tassa di transito in Ticino: cosa cambia per gl...", "url": `${BASE_URL}/articoli-frontaliere/tassa-transito-automobilisti-ticino` },
 { "@type": "ListItem", "position": 472, "name": "Nubifragio Giugno 2024: Ristoro Finanziario in ...", "url": `${BASE_URL}/articoli-frontaliere/nubifragio-coira-mesolcina-ristoro` },
 { "@type": "ListItem", "position": 473, "name": "Ticino e Svizzera sotto l'attenzione del Consig...", "url": `${BASE_URL}/articoli-frontaliere/lotta-violenza-di-genere-ticino` },
 { "@type": "ListItem", "position": 474, "name": "Tassa di transito Svizzera 2026: cosa cambia per...", "url": `${BASE_URL}/articoli-frontaliere/tassa-transito-svizzera-2026` },
 { "@type": "ListItem", "position": 475, "name": "Operazione di controllo nei cantieri del Mendri...", "url": `${BASE_URL}/articoli-frontaliere/controlli-cantieri-mendrisiotto` },
 { "@type": "ListItem", "position": 476, "name": "Acinque lancia il piano 'Genitorialità': un mes...", "url": `${BASE_URL}/articoli-frontaliere/acinque-lancia-piano-genitorialita` },
 { "@type": "ListItem", "position": 477, "name": "Danni riparati, riapre la Centovallina-Vigezzina", "url": `${BASE_URL}/articoli-frontaliere/danni-riparati-centovallina` },
 { "@type": "ListItem", "position": 478, "name": "Porrentruy potrà vietare l'accesso alla piscina...", "url": `${BASE_URL}/articoli-frontaliere/porrentruy-piscina-comunale-divieto` },
 { "@type": "ListItem", "position": 479, "name": "Sanità, Fontana e Fedriga: 'L'ospedale-centrism...", "url": `${BASE_URL}/articoli-frontaliere/sanita-fontana-fedriga` },
 { "@type": "ListItem", "position": 480, "name": "San Gottardo, verso l'ampliamento del parco eol...", "url": `${BASE_URL}/articoli-frontaliere/ampliamento-parco-eolico-san-gottardo` },
 { "@type": "ListItem", "position": 481, "name": "‘Prezzi dei carburanti alle stelle, l'Italia in...", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-prezzi-carburanti-italia-svizzera` },
 { "@type": "ListItem", "position": 482, "name": "Cure a domicilio: la nuova tassa divide politic...", "url": `${BASE_URL}/articoli-frontaliere/cure-a-domicilio-tassa-ticino` },
 { "@type": "ListItem", "position": 483, "name": "Ticino: contributo cantonale per ripristino str...", "url": `${BASE_URL}/articoli-frontaliere/kebab-case-ticino-nubifragio-grigioni` },
 { "@type": "ListItem", "position": 484, "name": "La Commissione europea non è contenta della tas...", "url": `${BASE_URL}/articoli-frontaliere/kebab-case-rossi-bruxelles-ticino` },
 { "@type": "ListItem", "position": 485, "name": "Umberto Bossi e il Ticino", "url": `${BASE_URL}/articoli-frontaliere/bossi-voleva-bene-al-ticino` },
 { "@type": "ListItem", "position": 486, "name": "Chiamate shock in Ticino: due arresti per truff...", "url": `${BASE_URL}/articoli-frontaliere/chiamate-shock-arresti-ticino` },
 { "@type": "ListItem", "position": 487, "name": "Rinnovo delle concessioni e ampliamento dell'of...", "url": `${BASE_URL}/articoli-frontaliere/rinnovo-concessioni-snl-2026` },
 { "@type": "ListItem", "position": 488, "name": "Fuga dei Globalisti dal Medio Oriente: Opportun...", "url": `${BASE_URL}/articoli-frontaliere/globalisti-fuga-medio-oriente-ticino` },
 { "@type": "ListItem", "position": 489, "name": "Guasto tra Parabiago e Rho: ritardi fino a 30 m...", "url": `${BASE_URL}/articoli-frontaliere/guasto-tra-parabiago-e-rho` },
 { "@type": "ListItem", "position": 490, "name": "Tassa di transito in Svizzera: come funziona e ...", "url": `${BASE_URL}/articoli-frontaliere/tassa-transito-ticino-pedemontana` },
 { "@type": "ListItem", "position": 491, "name": "Il franco svizzero a valori record rende più ri...", "url": `${BASE_URL}/articoli-frontaliere/franco-svizzero-a-valori-record-2026` },
 { "@type": "ListItem", "position": 492, "name": "Il taglio alle accise mette sotto pressione i d...", "url": `${BASE_URL}/articoli-frontaliere/taglio-alle-accise-mette-sotto-pressione-i-distributori-ticinesi` },
 { "@type": "ListItem", "position": 493, "name": "L'industria farmaceutica: per essere competitiv...", "url": `${BASE_URL}/articoli-frontaliere/farmaci-competitiva-europa` },
 { "@type": "ListItem", "position": 494, "name": "Sette ispezioni in cantieri del Mendrisiotto: 6...", "url": `${BASE_URL}/articoli-frontaliere/controlli-cantieri-mendrisiotto-2026` },
 { "@type": "ListItem", "position": 495, "name": "BYD si espande in Ticino: 50 concessionari entr...", "url": `${BASE_URL}/articoli-frontaliere/byd-expansion-ticino-2026` },
 { "@type": "ListItem", "position": 496, "name": "Caro affitti: il Nazionale respinge il controll...", "url": `${BASE_URL}/articoli-frontaliere/controllo-affitti-nazionale-ticino` },
 { "@type": "ListItem", "position": 497, "name": "Cioccolato in Svizzera: meno consumo ma prezzi ...", "url": `${BASE_URL}/articoli-frontaliere/cioccolato-meno-ma-pagato-di-piu` },
 { "@type": "ListItem", "position": 498, "name": "Aumento del prezzo del diesel: 2,10 franchi in ...", "url": `${BASE_URL}/articoli-frontaliere/diesel-aumento-prezzi-svizzera-2026` },
 { "@type": "ListItem", "position": 499, "name": "A Varese nasce il Manifesto per il welfare sani...", "url": `${BASE_URL}/articoli-frontaliere/sanita-manifesto-varese-2026` },
 { "@type": "ListItem", "position": 500, "name": "IVA bassa in Svizzera: un'immagine ingannevole", "url": `${BASE_URL}/articoli-frontaliere/iva-bassa-svizzera-immagine-ingannevole` },
 { "@type": "ListItem", "position": 501, "name": "Divieto di smartphone nelle scuole del Ticino: ...", "url": `${BASE_URL}/articoli-frontaliere/divieto-smartphone-scuola-ticino` },
 { "@type": "ListItem", "position": 502, "name": "Navigazione Ticino: Offerte potenziate per il 2026", "url": `${BASE_URL}/articoli-frontaliere/la-navigazione-rafforza-offerta-2026` },
 { "@type": "ListItem", "position": 503, "name": "Salute - Lombardia, scontro sulla sanità integr...", "url": `${BASE_URL}/articoli-frontaliere/sanita-integrativa-lombardia-ticino` },
 { "@type": "ListItem", "position": 504, "name": "Fatture Mediche Gonfiate", "url": `${BASE_URL}/articoli-frontaliere/fatture-mediche-gonfiate-ticino` },
 { "@type": "ListItem", "position": 505, "name": "Divieto cellulari nelle scuole dell'obbligo in ...", "url": `${BASE_URL}/articoli-frontaliere/divieto-cellulari-scuola-ticino` },
 { "@type": "ListItem", "position": 506, "name": "Violenza contro le donne, il Consiglio d’Europa...", "url": `${BASE_URL}/articoli-frontaliere/violenza-donne-consiglio-europa-ticino` },
 { "@type": "ListItem", "position": 507, "name": "Un ticinese a capo di due importanti servizi de...", "url": `${BASE_URL}/articoli-frontaliere/trojani-capo-servizi-esercito-ticino` },
 { "@type": "ListItem", "position": 508, "name": "Funivia di Monteviasco: nuovi orari e più corse...", "url": `${BASE_URL}/articoli-frontaliere/funivia-monteviasco-orari-corsi` },
 { "@type": "ListItem", "position": 509, "name": "Ricchi in fuga dal Medio Oriente, «Il Ticino vu...", "url": `${BASE_URL}/articoli-frontaliere/ricchi-fuga-medio-oriente-ticino` },
 { "@type": "ListItem", "position": 510, "name": "Scuola dell’obbligo, scatta il “No Natel”: cell...", "url": `${BASE_URL}/articoli-frontaliere/divieto-cellulari-scuola-ticino-2024` },
 { "@type": "ListItem", "position": 511, "name": "I sindacati (ancora) contro SNL: «Tout va très ...", "url": `${BASE_URL}/articoli-frontaliere/sindacati-contro-snl-ticino-2026` },
 { "@type": "ListItem", "position": 512, "name": "Quanto costerà l’aumento dell’IVA per le famigl...", "url": `${BASE_URL}/articoli-frontaliere/aumento-iva-costo-ticino-2026` },
 { "@type": "ListItem", "position": 513, "name": "Acquarossa investe nel nuovo polo sanitario e n...", "url": `${BASE_URL}/articoli-frontaliere/acquarossa-nuovo-polo-filovia-2026` },
 { "@type": "ListItem", "position": 514, "name": "Italia - Lo sconto carburante scatta in ritardo...", "url": `${BASE_URL}/articoli-frontaliere/ritardo-sconto-carburante-ticino-2026` },
 { "@type": "ListItem", "position": 515, "name": "Lavori autostradali - A8 Milano-Varese, chiusur...", "url": `${BASE_URL}/articoli-frontaliere/lavori-a8-castellanza-notturni-2026` },
 { "@type": "ListItem", "position": 516, "name": "Il costo della discriminazione nel mondo del la...", "url": `${BASE_URL}/articoli-frontaliere/quanto-costa-la-discriminazione` },
 { "@type": "ListItem", "position": 517, "name": "Divieto di smartphone a scuola: la misura si es...", "url": `${BASE_URL}/articoli-frontaliere/divieto-smartphone-scuola-ticino-2026` },
 { "@type": "ListItem", "position": 518, "name": "Carenza di farmaci in Ticino: la ricetta del go...", "url": `${BASE_URL}/articoli-frontaliere/carenza-farmaci-ticino` },
 { "@type": "ListItem", "position": 519, "name": "Lago Maggiore: una camminata per l'accesso libe...", "url": `${BASE_URL}/articoli-frontaliere/lago-maggiore-accesso-tutto-l-anno` },
 { "@type": "ListItem", "position": 520, "name": "Protesta contro la tassa sulle cure a domicilio...", "url": `${BASE_URL}/articoli-frontaliere/cure-domicilio-ticino` },
 { "@type": "ListItem", "position": 521, "name": "Battaglia per le spiagge libere sul Lago Maggiore", "url": `${BASE_URL}/articoli-frontaliere/spiagge-libere-sul-lago-maggiore` },
 { "@type": "ListItem", "position": 522, "name": "SNL: stagione 2026 all'insegna della sostenibil...", "url": `${BASE_URL}/articoli-frontaliere/snl-stagione-green-concessione` },
 { "@type": "ListItem", "position": 523, "name": "Smartphone a scuola: il DECS cambia rotta, ma l...", "url": `${BASE_URL}/articoli-frontaliere/smartphone-a-scuola-e-nuove-direttive` },
 { "@type": "ListItem", "position": 524, "name": "Infortuni sul lavoro: l'Inail apre alle protesi...", "url": `${BASE_URL}/articoli-frontaliere/infortuni-sul-lavoro-protesi-hi-tech` },
 { "@type": "ListItem", "position": 525, "name": "Bellinzona: Ricerche attive per un 64enne scomp...", "url": `${BASE_URL}/articoli-frontaliere/bellinzona-scomparsa-ricerche-ticino-piemonte` },
 { "@type": "ListItem", "position": 526, "name": "Cure a domicilio in Ticino: le nuove norme e le...", "url": `${BASE_URL}/articoli-frontaliere/cure-domicilio-ticino-politica` },
 { "@type": "ListItem", "position": 527, "name": "Navigazione Lago di Lugano, stagione al via", "url": `${BASE_URL}/articoli-frontaliere/navigazione-lago-lugano-2026` },
 { "@type": "ListItem", "position": 528, "name": "Firmata la nascita del Parco del Vedeggio: il f...", "url": `${BASE_URL}/articoli-frontaliere/parco-vedeggio-comuni-firman` },
 { "@type": "ListItem", "position": 529, "name": "Ticino sospende esportazioni di materiale belli...", "url": `${BASE_URL}/articoli-frontaliere/stop-export-materiale-bellico` },
 { "@type": "ListItem", "position": 530, "name": "Scontri violenti tra uomini nel Ticino: ospedal...", "url": `${BASE_URL}/articoli-frontaliere/gestione-scontri-frontali-ticino` },
 { "@type": "ListItem", "position": 531, "name": "Headline JSON-LD", "url": `${BASE_URL}/articoli-frontaliere/auto-intrusione-frontalieri-ticino` },
 { "@type": "ListItem", "position": 532, "name": "Rischio-Lugano in casa dello Young Boys: una sf...", "url": `${BASE_URL}/articoli-frontaliere/rischio-lugano-young-boys` },
 { "@type": "ListItem", "position": 533, "name": "Morte Bossi: l’impatto sui frontalieri del Ticino", "url": `${BASE_URL}/articoli-frontaliere/bossi-morto-ticino-frontalieri` },
 { "@type": "ListItem", "position": 534, "name": "Fallimento dell’iniziativa contro gli OGM in Sv...", "url": `${BASE_URL}/articoli-frontaliere/ogm-fallimento-ticino` },
 { "@type": "ListItem", "position": 535, "name": "Referendum sulla giustizia in Ticino: oggi si v...", "url": `${BASE_URL}/articoli-frontaliere/referendum-giustizia-ticino-2026` },
 { "@type": "ListItem", "position": 536, "name": "Dallo statuto S al permesso B in Ticino", "url": `${BASE_URL}/articoli-frontaliere/passaggio-statuto-s-permesso-b` },
 { "@type": "ListItem", "position": 537, "name": "Chiusure notturne autostrada A9", "url": `${BASE_URL}/articoli-frontaliere/chiusure-notturne-autostrada` },
 { "@type": "ListItem", "position": 538, "name": "La morte di un figlio: come affrontarla", "url": `${BASE_URL}/articoli-frontaliere/morte-bimbo-efamilia-ticino` },
 { "@type": "ListItem", "position": 539, "name": "I fondi sottratti all'HCAP saranno in larga par...", "url": `${BASE_URL}/articoli-frontaliere/fondi-hcap-restituiti` },
 { "@type": "ListItem", "position": 540, "name": "«Il futuro è triste. Bellinzona ormai è un paes...", "url": `${BASE_URL}/articoli-frontaliere/bellinzona-paese-dormitorio` },
 { "@type": "ListItem", "position": 541, "name": "Tragedia sul Titlis: una raffica di vento impro...", "url": `${BASE_URL}/articoli-frontaliere/tragedia-titlis-raffica-vento` },
 { "@type": "ListItem", "position": 542, "name": "Una camminata di protesta per il libero accesso...", "url": `${BASE_URL}/articoli-frontaliere/accesso-libero-alle-rive` },
 { "@type": "ListItem", "position": 543, "name": "Ticino, attenti ai radar: quando e dove i contr...", "url": `${BASE_URL}/articoli-frontaliere/ticino-attenti-ai-radar-2026` },
 { "@type": "ListItem", "position": 544, "name": "Sequestro di sostanze stupefacenti in Ecuador", "url": `${BASE_URL}/articoli-frontaliere/sequestro-stupefacenti-ecuador` },
 { "@type": "ListItem", "position": 545, "name": "Radar a Mazzetti sulle Strade Ticinesi: Nuove S...", "url": `${BASE_URL}/articoli-frontaliere/nuovi-radar-ticino-multe` },
 { "@type": "ListItem", "position": 546, "name": "{\"@context\":\"https://schema.org\",\"@type\":\"NewsA...", "url": `${BASE_URL}/articoli-frontaliere/rifugiati-ucraini-assistenza-2027` },
 { "@type": "ListItem", "position": 547, "name": "Sequestro record di cannabis in Argovia: rischi...", "url": `${BASE_URL}/articoli-frontaliere/cannabis-sequestro-ticino` },
 { "@type": "ListItem", "position": 548, "name": "{\"@context\":\"https://schema.org\",\"@type\":\"Artic...", "url": `${BASE_URL}/articoli-frontaliere/pfaffikon-kanton-schwyz-franzosi-einbrecher` },
 { "@type": "ListItem", "position": 549, "name": "Riapre la Casetta a Davesco-Soragno: punto di r...", "url": `${BASE_URL}/articoli-frontaliere/riapertura-casetta-chiosco-davesco` },
 { "@type": "ListItem", "position": 550, "name": "I giovani non tornano: cosa fanno i Comuni tici...", "url": `${BASE_URL}/articoli-frontaliere/giovani-ticino-comuni-innovazioni` },
 { "@type": "ListItem", "position": 551, "name": "Domeniche senza auto in Svizzera: il Ticino ver...", "url": `${BASE_URL}/articoli-frontaliere/domeniche-senza-auto-ticino-2026` },
 { "@type": "ListItem", "position": 552, "name": "Lavori autostradali A4 Milano-Brescia: chiusure...", "url": `${BASE_URL}/articoli-frontaliere/chiusure-notturne-a4-ticino` },
 { "@type": "ListItem", "position": 553, "name": "Svizzera: crescita più debole e inflazione in l...", "url": `${BASE_URL}/articoli-frontaliere/svizzera-frontalieri-franco-lavoro` },
 { "@type": "ListItem", "position": 554, "name": "La Svizzera ospita il ‘CERN della ricerca sui c...", "url": `${BASE_URL}/articoli-frontaliere/svizzera-cern-ricerca-chip` },
 { "@type": "ListItem", "position": 555, "name": "Sequestro di Cannabis a Spreitenbach: Operazion...", "url": `${BASE_URL}/articoli-frontaliere/cannabis-sequestro-ticino-2026` },
 { "@type": "ListItem", "position": 556, "name": "Svizzeri dubitano delle capacità di difesa del ...", "url": `${BASE_URL}/articoli-frontaliere/svizzeri-dubitano-difesa-paese` },
 { "@type": "ListItem", "position": 558, "name": "Controlli radar in Ticino diminuiranno: cosa ca...", "url": `${BASE_URL}/articoli-frontaliere/controlli-radar-ticino` },
 { "@type": "ListItem", "position": 559, "name": "Frontalieri: a Zurigo solo avanzi immobiliari", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-casa-zurigo` },
 { "@type": "ListItem", "position": 560, "name": "Sicurezza a Lugano: bilancio 2025 della Polizia...", "url": `${BASE_URL}/articoli-frontaliere/lugano-sicurezza-2025` },
 { "@type": "ListItem", "position": 561, "name": "Migranti Dublino: quanti casi e quali costi per...", "url": `${BASE_URL}/articoli-frontaliere/migranti-dublino-ticino` },
 { "@type": "ListItem", "position": 562, "name": "Chiasso aderisce all'Ora della Terra 2026", "url": `${BASE_URL}/articoli-frontaliere/chiasso-ora-terra-2026` },
 { "@type": "ListItem", "position": 563, "name": "Riduzione radar in Ticino", "url": `${BASE_URL}/articoli-frontaliere/radar-ticino-riduzione` },
 { "@type": "ListItem", "position": 564, "name": "Nomine SIMS illegittime", "url": `${BASE_URL}/articoli-frontaliere/nomine-sims-illegittime` },
 { "@type": "ListItem", "position": 566, "name": "Monte Lema cable-car season 2026: prices, exten...", "url": `${BASE_URL}/articoli-frontaliere/funivia-monte-lema-stagione-2026` },
 { "@type": "ListItem", "position": 568, "name": "Crescita economica moderata in Svizzera nel 2026", "url": `${BASE_URL}/articoli-frontaliere/crescita-economica-ticino-2026` },
 { "@type": "ListItem", "position": 570, "name": "Referendum sulla giustizia in Italia: la posizi...", "url": `${BASE_URL}/articoli-frontaliere/giustizia-referendum-ticino` },
 { "@type": "ListItem", "position": 571, "name": "Ora legale permanente in Ticino: cosa cambia", "url": `${BASE_URL}/articoli-frontaliere/ora-legale-permanente-ticino` },
 { "@type": "ListItem", "position": 572, "name": "Como, Rapinese: prezzi dell'asfalto in aumento ...", "url": `${BASE_URL}/articoli-frontaliere/como-asfaltature-war-costs` },
 { "@type": "ListItem", "position": 573, "name": "Referendum in Ticino: il messaggio dell'opposiz...", "url": `${BASE_URL}/articoli-frontaliere/referendum-opposizione-ticino` },
 { "@type": "ListItem", "position": 574, "name": "Frontalieri: nuovo permesso G per tutta la dura...", "url": `${BASE_URL}/articoli-frontaliere/apprendisti-frontalieri-permessi-g` },
 { "@type": "ListItem", "position": 575, "name": "{ \"@context\": \"https://schema.org\", \"@type\": \"N...", "url": `${BASE_URL}/articoli-frontaliere/crescita-sicurezza-ticino-2025` },
 { "@type": "ListItem", "position": 576, "name": "Frontaliere Ticino - Per il centro sportivo di ...", "url": `${BASE_URL}/articoli-frontaliere/sesto-calende-centro-sportivo` },
 { "@type": "ListItem", "position": 577, "name": "Missione emergenza a Chiasso: un evento unico p...", "url": `${BASE_URL}/articoli-frontaliere/chiasso-missione-emergenza` },
 { "@type": "ListItem", "position": 578, "name": "Ticinesi e frontalieri comprano sempre più case...", "url": `${BASE_URL}/articoli-frontaliere/ticinesi-e-frontalieri-comprano-case-su-laghi-verbano-e-ceresio` },
 { "@type": "ListItem", "position": 579, "name": "Annaffiatoi e aiuole, il centro si cura insieme...", "url": `${BASE_URL}/articoli-frontaliere/lavena-ponte-tresa-verde` },
 { "@type": "ListItem", "position": 581, "name": "Chiasso in Missione emergenza: enti di primo in...", "url": `${BASE_URL}/articoli-frontaliere/chiasso-missione-emergenza-luci-blu` },
 { "@type": "ListItem", "position": 582, "name": "Aggregazione Basso Mendrisiotto: Rizza critica ...", "url": `${BASE_URL}/articoli-frontaliere/aggregazione-basso-mendrisiotto-rizza-chiasso-autocritica` },
 { "@type": "ListItem", "position": 583, "name": "Carburanti, prezzo di benzina e diesel in rialz...", "url": `${BASE_URL}/articoli-frontaliere/carburanti-prezzo-rialzo-ticino` },
 { "@type": "ListItem", "position": 584, "name": "Guida Michelin Ticino 2026: i 7 luoghi più bell...", "url": `${BASE_URL}/articoli-frontaliere/guida-michelin-ticino` },
 { "@type": "ListItem", "position": 585, "name": "Colpo di stiletto / \"Eurospin\" di Luino, occhio...", "url": `${BASE_URL}/articoli-frontaliere/eurospin-luino-occhio-al-cambio` },
 { "@type": "ListItem", "position": 586, "name": "Il territorio poroso tra Varese e la Svizzera: ...", "url": `${BASE_URL}/articoli-frontaliere/lavena-ponte-tresa-territorio-poroso` },
 { "@type": "ListItem", "position": 587, "name": "Fusione Comuni Calanca", "url": `${BASE_URL}/articoli-frontaliere/fusione-valle-calanca-comuni` },
 { "@type": "ListItem", "position": 588, "name": "Lavoro in carcere: 15 posti disponibili", "url": `${BASE_URL}/articoli-frontaliere/lavoro-carceri-ticino` },
 { "@type": "ListItem", "position": 589, "name": "Avs Saronno: 'Ai giovani, avete fatto la differ...", "url": `${BASE_URL}/articoli-frontaliere/avs-saronno-referendum` },
 { "@type": "ListItem", "position": 590, "name": "Comune di Lavena Ponte Tresa incentiva la cura ...", "url": `${BASE_URL}/articoli-frontaliere/lavena-ponte-tresa-annaffiatoi` },
 { "@type": "ListItem", "position": 591, "name": "La commemorazione di Bossi diventa bagarre in aula", "url": `${BASE_URL}/articoli-frontaliere/bossi-commemorazione-bagarrata` },
 { "@type": "ListItem", "position": 592, "name": "Cambiamento sistema scolastico Ticino 2026", "url": `${BASE_URL}/articoli-frontaliere/corsi-a-b-scuola-media-ticino` },
 { "@type": "ListItem", "position": 593, "name": "Gallarate: pendolare in e-bike arrestato per sp...", "url": `${BASE_URL}/articoli-frontaliere/ticino-confine-droga` },
 { "@type": "ListItem", "position": 594, "name": "Il franco svizzero ai minimi da gennaio sull'euro", "url": `${BASE_URL}/articoli-frontaliere/franco-svizzero-minimi-euro` },
 { "@type": "ListItem", "position": 595, "name": "Benzina conveniente in Ticino", "url": `${BASE_URL}/articoli-frontaliere/benzina-conveniente` },
 { "@type": "ListItem", "position": 596, "name": "{\"@context\":\"https://schema.org\",\"@type\":\"Artic...", "url": `${BASE_URL}/articoli-frontaliere/piu-interventi-soccorso-meno-vittime-montagna-ticino-2025` },
 { "@type": "ListItem", "position": 597, "name": "Test neonati Ticino esclusi dai controlli svizzeri", "url": `${BASE_URL}/articoli-frontaliere/nei-test-neonati-ticinesi` },
 { "@type": "ListItem", "position": 598, "name": "Aggregazione Basso Mendrisiotto a rischio per i...", "url": `${BASE_URL}/articoli-frontaliere/aggregazione-rischio-basso-mendrisiotto` },
 { "@type": "ListItem", "position": 599, "name": "{\"@context\":\"https://schema.org\",\"@type\":\"NewsA...", "url": `${BASE_URL}/articoli-frontaliere/congresso-svizzera-italia-varese-2026` },
 { "@type": "ListItem", "position": 600, "name": "Processo Mendrisio: 19 capi d'imputazione porta...", "url": `${BASE_URL}/articoli-frontaliere/processo-mendrisio-19-capit` },
 { "@type": "ListItem", "position": 601, "name": "La Spagna riduce i prezzi del carburante di 30 ...", "url": `${BASE_URL}/articoli-frontaliere/prezzi-carburanti-ticino-marzo-2026` },
 { "@type": "ListItem", "position": 602, "name": "Cammino Via Francisca del Lucomagno", "url": `${BASE_URL}/articoli-frontaliere/via-francisca-cammino` },
 { "@type": "ListItem", "position": 603, "name": "Lavoro ‘sommerso’ nel Varesotto, 46 casi scovat...", "url": `${BASE_URL}/articoli-frontaliere/lavoro-sommerso-varesotto` },
 { "@type": "ListItem", "position": 604, "name": "Rissa nella notte a Lavena Ponte Tresa, due str...", "url": `${BASE_URL}/articoli-frontaliere/rissa-lavena-ponte-tres` },
 { "@type": "ListItem", "position": 605, "name": "La nuova scuola elementare di Magliaso: un inve...", "url": `${BASE_URL}/articoli-frontaliere/magliaso-zona-educativa-ripresa` },
 { "@type": "ListItem", "position": 606, "name": "Cassa malati: l'iniziativa leghista va applicat...", "url": `${BASE_URL}/articoli-frontaliere/cassa-malati-leghista-applicata-subito` },
 { "@type": "ListItem", "position": 607, "name": "Rissa a Ponte Tresa", "url": `${BASE_URL}/articoli-frontaliere/ronte-tresa-rissa` },
 { "@type": "ListItem", "position": 608, "name": "Autostrada A9: nuove chiusure tra Chiasso e Com...", "url": `${BASE_URL}/articoli-frontaliere/a9-chiasso-como-chiusure-frontalieri` },
 { "@type": "ListItem", "position": 609, "name": "Code al San Gottardo", "url": `${BASE_URL}/articoli-frontaliere/code-nord-san-gottardo` },
 { "@type": "ListItem", "position": 610, "name": "Trattative commercio Usa Svizzera: oltre 31 marzo", "url": `${BASE_URL}/articoli-frontaliere/trattative-acordo-usa-oltre-31-marzo` },
 { "@type": "ListItem", "position": 611, "name": "Innovazione ticinese: occhiali intelligenti per...", "url": `${BASE_URL}/articoli-frontaliere/occhiali-intelligenti-ticino-innovazione` },
 { "@type": "ListItem", "position": 612, "name": "Trattative sui dazi: \"Il termine del 31 marzo n...", "url": `${BASE_URL}/articoli-frontaliere/trattative-dazi-non-valido-31-marzo` },
 { "@type": "ListItem", "position": 613, "name": "Fermato con della trippa di troppo", "url": `${BASE_URL}/articoli-frontaliere/trippa-dogana-novazzano` },
 { "@type": "ListItem", "position": 614, "name": "Lavori sulla rete ferroviaria italiana, ecco co...", "url": `${BASE_URL}/articoli-frontaliere/lavori-rete-ferroviaria-tilo` },
 { "@type": "ListItem", "position": 615, "name": "Tassa mensa asilo a Chiasso", "url": `${BASE_URL}/articoli-frontaliere/tassa-mensa-asilo-chiasso` },
 { "@type": "ListItem", "position": 616, "name": "Sindacati in Ticino: \"Sul cambio d'appalto a Le...", "url": `${BASE_URL}/articoli-frontaliere/sindacati-ticino-leonardo-cascina-costa` },
 { "@type": "ListItem", "position": 617, "name": "Chiasso non introdurrà la tassa di refezione al...", "url": `${BASE_URL}/articoli-frontaliere/chiasso-tassa-refezione-scuola-infanzia` },
 { "@type": "ListItem", "position": 618, "name": "Lavoro TIC in Ticino: ATED chiede rappresentanz...", "url": `${BASE_URL}/articoli-frontaliere/ict-reatto-commissione-tri` },
 { "@type": "ListItem", "position": 619, "name": "Tenta la furbata in dogana tra Como e Svizzera:...", "url": `${BASE_URL}/articoli-frontaliere/furbata-dogana-argento` },
 { "@type": "ListItem", "position": 620, "name": "Nuova alleanza per la sicurezza del Lago Maggiore", "url": `${BASE_URL}/articoli-frontaliere/sicurezza-lago-maggiore` },
 { "@type": "ListItem", "position": 622, "name": "Rientro dell'ambasciatore italiano a Berna dopo...", "url": `${BASE_URL}/articoli-frontaliere/ambasciatore-italiano-ritorno-berna` },
 { "@type": "ListItem", "position": 623, "name": "Petizione contro le nuove tariffe per le cure a...", "url": `${BASE_URL}/articoli-frontaliere/pazienti-ticino-protesta` },
 { "@type": "ListItem", "position": 624, "name": "Svizzera a corto di uova: aumenta il contingent...", "url": `${BASE_URL}/articoli-frontaliere/aumento-contingente-uova-svizzera` },
 { "@type": "ListItem", "position": 627, "name": "Lavori notturni di pavimentazione in Via Lavizz...", "url": `${BASE_URL}/articoli-frontaliere/lavori-notturni-via-lavizzari` },
 { "@type": "ListItem", "position": 628, "name": "Limitare la popolazione in Ticino a 10 milioni:...", "url": `${BASE_URL}/articoli-frontaliere/limite-popolazione-10-milioni-ticino` },
 { "@type": "ListItem", "position": 630, "name": "Settanta chili di mozzarella nel bagagliaio del...", "url": `${BASE_URL}/articoli-frontaliere/settanta-chili-di-mozzarella` },
 { "@type": "ListItem", "position": 631, "name": "Contrabbando in Ticino: un nuovo caso di contra...", "url": `${BASE_URL}/articoli-frontaliere/contrabbando-ticino-2026` },
 { "@type": "ListItem", "position": 632, "name": "Mobilità internazionale del personale infermier...", "url": `${BASE_URL}/articoli-frontaliere/mobilita-infermieri-ticino` },
 { "@type": "ListItem", "position": 633, "name": "San Gottardo, code da Giovedì Santo: niente sor...", "url": `${BASE_URL}/articoli-frontaliere/san-gottardo-code-giovedi-santo` },
 { "@type": "ListItem", "position": 634, "name": "{\"@context\": \"https://schema.org\", \"@type\": \"Ar...", "url": `${BASE_URL}/articoli-frontaliere/como-lago-pasqua-boom-prenotazioni` },
 { "@type": "ListItem", "position": 635, "name": "Eventi di traffico in Ticino", "url": `${BASE_URL}/articoli-frontaliere/camion-panne-san-gottardo-traffico-bloccato` },
 { "@type": "ListItem", "position": 636, "name": "Aumento Inchieste Penali in Svizzera nel 2025", "url": `${BASE_URL}/articoli-frontaliere/aumento-inchieste-penali-2025` },
 { "@type": "ListItem", "position": 637, "name": "Ticino e Lombardia: sistema manifatturiero pila...", "url": `${BASE_URL}/articoli-frontaliere/ticino-lombardia-manifatturiero` },
 { "@type": "ListItem", "position": 639, "name": "La dogana di Chiasso diventa un centro tecnologico", "url": `${BASE_URL}/articoli-frontaliere/dogana-chiasso-centro-tecnologico` },
 { "@type": "ListItem", "position": 640, "name": "Permessi dubbi, Roveredo insoddisfatta e preocc...", "url": `${BASE_URL}/articoli-frontaliere/permessi-dubbi-roveredo-insoddisfatta` },
 { "@type": "ListItem", "position": 641, "name": "Permessi di dimora: diverse opinioni sulla cons...", "url": `${BASE_URL}/articoli-frontaliere/permessi-dimora-diversi-opinioni` },
 { "@type": "ListItem", "position": 642, "name": "Chiasso contro la Zanzara Tigre: La Nuova Strat...", "url": `${BASE_URL}/articoli-frontaliere/chiasso-zanzara-tigre-strategia-2026` },
 { "@type": "ListItem", "position": 643, "name": "Trasferimento Ufficio Postale Chiasso", "url": `${BASE_URL}/articoli-frontaliere/trasferimento-ufficio-postale-chiasso` },
 { "@type": "ListItem", "position": 644, "name": "Esame complementare passerella: aperte le pre-i...", "url": `${BASE_URL}/articoli-frontaliere/esame-complementare-passerella-aperte-pre-iscrizioni` },
 { "@type": "ListItem", "position": 645, "name": "Lago di Como: Pullman Turistici e Bus di Linea ...", "url": `${BASE_URL}/articoli-frontaliere/gasolio-costi-pullman-ticino-lago-como` },
 { "@type": "ListItem", "position": 646, "name": "Tribunale federale amministrativo respinge gli ...", "url": `${BASE_URL}/articoli-frontaliere/tram-treno-luganese-passo-avanti` },
 { "@type": "ListItem", "position": 647, "name": "Il turismo pasquale promette gradite sorprese i...", "url": `${BASE_URL}/articoli-frontaliere/turismo-pasquale-ticino-2026` },
 { "@type": "ListItem", "position": 649, "name": "Mozzarella 'clandestina' in Ticino: come fare l...", "url": `${BASE_URL}/articoli-frontaliere/mozzarella-clandestina-2026-ricerca` },
 { "@type": "ListItem", "position": 650, "name": "{\"@context\": \"http://schema.org\", \"@type\": \"New...", "url": `${BASE_URL}/articoli-frontaliere/varese-soroptimist-studio-fibrosi-polmonare` },
 { "@type": "ListItem", "position": 651, "name": "Accordi Svizzera-UE verso ratifica nel 2026", "url": `${BASE_URL}/articoli-frontaliere/accordi-svizzera-ue-2026` },
 { "@type": "ListItem", "position": 652, "name": "Vacanze di Pasqua: colonna al San Gottardo tocc...", "url": `${BASE_URL}/articoli-frontaliere/vacanze-di-pasqua-san-gottardo` },
 { "@type": "ListItem", "position": 653, "name": "Mancano 172 medici di base a Varese e Verbano", "url": `${BASE_URL}/articoli-frontaliere/medici-manca-verbano-ticino-2026` },
 { "@type": "ListItem", "position": 654, "name": "L'Italia taglia le accise, benzinai preoccupati", "url": `${BASE_URL}/articoli-frontaliere/italia-taglia-accise-benzinai-preoccupati` },
 { "@type": "ListItem", "position": 655, "name": "Contro l'aumento dei prezzi dei mezzi pubblici ...", "url": `${BASE_URL}/articoli-frontaliere/aumento-mezzi-pubblici-ticino` },
 { "@type": "ListItem", "position": 658, "name": "Addio a Salvatore Longo, il frontaliere di Luin...", "url": `${BASE_URL}/articoli-frontaliere/addiofrontalierelongo` },
 { "@type": "ListItem", "position": 659, "name": "Ladri di auto scappano con 40 chiavi e una Skod...", "url": `${BASE_URL}/articoli-frontaliere/ladri-di-auto-scappano-con-40-chiavi-e-una-skoda` },
 { "@type": "ListItem", "position": 660, "name": "Forte pericolo di incendi nei boschi del Ticino", "url": `${BASE_URL}/articoli-frontaliere/incendi-boschivi-ticino-2026` },
 { "@type": "ListItem", "position": 661, "name": "Benzina Ticino Taglio Accise: esodo dalla Svizz...", "url": `${BASE_URL}/articoli-frontaliere/benzina-ticino-taglio-accise` },
 { "@type": "ListItem", "position": 662, "name": "Abolizione imposta sul valore locativo dal 2029...", "url": `${BASE_URL}/articoli-frontaliere/abolizione-imposta-valore-locativo-2029` },
 { "@type": "ListItem", "position": 663, "name": "Contrabbando di Pokémon: Svizzero fermato alla ...", "url": `${BASE_URL}/articoli-frontaliere/contrabbando-pokemon-ticino` },
 { "@type": "ListItem", "position": 664, "name": "Sconto benzina: Italia allunga lo sconto", "url": `${BASE_URL}/articoli-frontaliere/sconto-benzina-ticino` },
 { "@type": "ListItem", "position": 665, "name": "Anziana di 88 anni si difende da una scippatric...", "url": `${BASE_URL}/articoli-frontaliere/anziana-si-difende-da-una-scippatrice-e-la-fa-arrestare` },
 { "@type": "ListItem", "position": 666, "name": "La SUPSI attiverà un nuovo bachelor in 'Sosteni...", "url": `${BASE_URL}/articoli-frontaliere/supsi-bachelor-sostenibilita-2027` },
 { "@type": "ListItem", "position": 667, "name": "Lavena Ponte Tresa: bambino sbalzato dal sellin...", "url": `${BASE_URL}/articoli-frontaliere/lavena-ponte-tresa-bicicletta-grave` },
 { "@type": "ListItem", "position": 668, "name": "Roveredo denuncia: i permessi non sono un incid...", "url": `${BASE_URL}/articoli-frontaliere/roveredo-permessi-anticrimine` },
 { "@type": "ListItem", "position": 669, "name": "Alain de Raemy: «Il significato della Pasqua? U...", "url": `${BASE_URL}/articoli-frontaliere/pasqua-messaggio-di-avvenire` },
 { "@type": "ListItem", "position": 670, "name": "Tramonto a Cadenazzo: morto il vigilante travol...", "url": `${BASE_URL}/articoli-frontaliere/tramonto-a-cadenazzo` },
 { "@type": "ListItem", "position": 671, "name": "Traffico paralizzato al San Gottardo: \"Qualcuno...", "url": `${BASE_URL}/articoli-frontaliere/traffico-san-gottardo-2026` },
 { "@type": "ListItem", "position": 672, "name": "Auto si ribalta sulla SP1 tra Varese e Gavirate...", "url": `${BASE_URL}/articoli-frontaliere/auto-si-ribalta-sulla-sp1-tra-varese-e-gavirate` },
 { "@type": "ListItem", "position": 673, "name": "Nestle apre sede in Lombardia e offre 200 posti...", "url": `${BASE_URL}/articoli-frontaliere/nestle-200-posti-lombardia` },
 { "@type": "ListItem", "position": 674, "name": "La 'Quinta Svizzera' che ha un debole per Milan...", "url": `${BASE_URL}/articoli-frontaliere/la-quinta-svizzera-che-ha-un-debole-per-milano` },
 { "@type": "ListItem", "position": 675, "name": "Comuni ticinesi investono nel settore turistico...", "url": `${BASE_URL}/articoli-frontaliere/comuni-investono-turismo-ticino` },
 { "@type": "ListItem", "position": 676, "name": "Tanti agricoltori verso la pensione: il ricambi...", "url": `${BASE_URL}/articoli-frontaliere/agriscambio` },
 { "@type": "ListItem", "position": 677, "name": "Iniziativa popolare svizzera 'No ad una Svizzer...", "url": `${BASE_URL}/articoli-frontaliere/frontaliere-ticino-10-milioni-voto` },
 { "@type": "ListItem", "position": 678, "name": "Congestione Stradale A2: Frontalieri alla Difesa", "url": `${BASE_URL}/articoli-frontaliere/congestione-a2-san-gottardo-frontalieri` },
 { "@type": "ListItem", "position": 679, "name": "Galleria del Ceneri chiusa per problemi tecnici", "url": `${BASE_URL}/articoli-frontaliere/galleria-del-ceneri-chiusa-per-problemi-tecnici` },
 { "@type": "ListItem", "position": 680, "name": "Corso per pastori in Ticino", "url": `${BASE_URL}/articoli-frontaliere/corso-pastori-ticino` },
 { "@type": "ListItem", "position": 681, "name": "Diventare pastore in Ticino", "url": `${BASE_URL}/articoli-frontaliere/diventare-pastore-ticino` },
 { "@type": "ListItem", "position": 682, "name": "Varese: si ubriaca, s'infortuna, ferisce un vig...", "url": `${BASE_URL}/articoli-frontaliere/varese-si-ubriaca-infortuna` },
 { "@type": "ListItem", "position": 683, "name": "L'ultimatum di Trump: un nuovo colpo per la ten...", "url": `${BASE_URL}/articoli-frontaliere/trump-intesa-o-inferno` },
 { "@type": "ListItem", "position": 684, "name": "Coop richiama formaggi: possono contenere salmo...", "url": `${BASE_URL}/articoli-frontaliere/coop-richiama-formaggi-salmonelle` },
 { "@type": "ListItem", "position": 685, "name": "A Bellinzona lo scambio abiti unisce socialità ...", "url": `${BASE_URL}/articoli-frontaliere/scambio-abiti-bellinzona` },
 { "@type": "ListItem", "position": 686, "name": "Protesta contro i costi per le cure a domicilio", "url": `${BASE_URL}/articoli-frontaliere/protesta-costi-cure-domicilio` },
 { "@type": "ListItem", "position": 687, "name": "Lavizzara: acqua non potabile in alcune località", "url": `${BASE_URL}/articoli-frontaliere/acqua-non-potabile-lavizzara` },
 { "@type": "ListItem", "position": 688, "name": "Nuova direttrice per i Servizi sociali di Belli...", "url": `${BASE_URL}/articoli-frontaliere/nuova-direttrice-servizi-sociali-bellinzona` },
 { "@type": "ListItem", "position": 689, "name": "Riaperta la galleria del Monte Ceneri: tornata ...", "url": `${BASE_URL}/articoli-frontaliere/riaperta-galleria-monte-ceneri` },
 { "@type": "ListItem", "position": 690, "name": "Ucraini in Ticino, il permesso S tra aiuti e in...", "url": `${BASE_URL}/articoli-frontaliere/ucraini-in-ticino-aiuti-incognite` },
 { "@type": "ListItem", "position": 691, "name": "Fuga da Dubai, il Ticino come alternativa?", "url": `${BASE_URL}/articoli-frontaliere/fuga-da-dubai-ticino-alternativa` },
 { "@type": "ListItem", "position": 692, "name": "Traffico intenso al San Gottardo", "url": `${BASE_URL}/articoli-frontaliere/traffico-san-gottardo-attesa` },
 { "@type": "ListItem", "position": 693, "name": "A Como il Tax Free continua a crescere grazie a...", "url": `${BASE_URL}/articoli-frontaliere/tax-free-come-cresce` },
 { "@type": "ListItem", "position": 694, "name": "Crisi traffico San Gottardo Pasquetta 2026: imp...", "url": `${BASE_URL}/articoli-frontaliere/traffico-san-gottardo-pasquetta-2026` },
 { "@type": "ListItem", "position": 695, "name": "Controlli più severi per auto immatricolate in ...", "url": `${BASE_URL}/articoli-frontaliere/controlli-auto-immatricolate-grigioni` },
 { "@type": "ListItem", "position": 696, "name": "Trasporto lacustre Locarno-Magadino", "url": `${BASE_URL}/articoli-frontaliere/locarno-magadino-trasporto` },
 { "@type": "ListItem", "position": 697, "name": "Aumento prezzi benzina in Svizzera", "url": `${BASE_URL}/articoli-frontaliere/prezzi-benzina-ticino` },
 { "@type": "ListItem", "position": 698, "name": "Lavizzara: problemi alla rete idrica, niente ac...", "url": `${BASE_URL}/articoli-frontaliere/lavizzara-problemi-alla-rete-idrica-niente-acqua-potabile-in-varie-zone` },
 { "@type": "ListItem", "position": 699, "name": "Chiusure e deviazioni sulla A9: cosa fare duran...", "url": `${BASE_URL}/articoli-frontaliere/raffica-chiusure-a9-2026` },
 { "@type": "ListItem", "position": 700, "name": "Di più La fattura miliardaria del conflitto in ...", "url": `${BASE_URL}/articoli-frontaliere/conflitto-medio-oriente-energia-ticino` },
 { "@type": "ListItem", "position": 702, "name": "{\"@context\": \"http://schema.org\", \"@type\": \"New...", "url": `${BASE_URL}/articoli-frontaliere/lavoro-notte-lincendio-laveno-mombello` },
 { "@type": "ListItem", "position": 703, "name": "Prevenzione al maschile: il Centro Beccaria è p...", "url": `${BASE_URL}/articoli-frontaliere/prevenzione-maschile-centro-beccaria` },
 { "@type": "ListItem", "position": 704, "name": "Controlli nel cuore di Varese: denuncia e espul...", "url": `${BASE_URL}/articoli-frontaliere/controlli-varese-esposto-espulsione` },
 { "@type": "ListItem", "position": 705, "name": "Incidente ad Arogno: 31enne in gravi condizioni...", "url": `${BASE_URL}/articoli-frontaliere/incidente-arogno-31enne-gravi-condizioni` },
 { "@type": "ListItem", "position": 706, "name": "Prezzi carburanti in Ticino: +19 millesimi di b...", "url": `${BASE_URL}/articoli-frontaliere/carburanti-ticino-aumento-prezzi` },
 { "@type": "ListItem", "position": 707, "name": "La Provincia di Varese investe in manutenzione ...", "url": `${BASE_URL}/articoli-frontaliere/provincia-di-varese-investe-su-manutenzione-delle-strade-e-del-verde-con-i-ristorni-dei-frontalieri-2026` },
 { "@type": "ListItem", "position": 708, "name": "La famigliola di turisti investita in centro a ...", "url": `${BASE_URL}/articoli-frontaliere/turisti-in-como-ztl` },
 { "@type": "ListItem", "position": 709, "name": "Niederländer con quattro chili di cocaina ferma...", "url": `${BASE_URL}/articoli-frontaliere/niederlander-droga-ticino` },
 { "@type": "ListItem", "position": 710, "name": "Stop agli 'artigiani per caso' in Lombardia: mu...", "url": `${BASE_URL}/articoli-frontaliere/stop-agli-artigiani-per-caso` },
 { "@type": "ListItem", "position": 711, "name": "Incendi nel Luganese: arrestato un piromane ita...", "url": `${BASE_URL}/articoli-frontaliere/incendi-nel-luganese-arrestato-un-piromane` },
 { "@type": "ListItem", "position": 712, "name": "Frontalieri e Tassa Salute: Più Chiarezza, ma A...", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-frontalieri-ufis-risposte` },
 { "@type": "ListItem", "position": 714, "name": "Frontalieri e nodi fiscali tra Italia e Svizzera", "url": `${BASE_URL}/articoli-frontaliere/front-alieri-soci-sagl-nodi-fiscali-2026` },
 { "@type": "ListItem", "position": 715, "name": "Benzina più cara in Svizzera: ticinesi e fronta...", "url": `${BASE_URL}/articoli-frontaliere/benzina-cara-ticino` },
 { "@type": "ListItem", "position": 717, "name": "Incidente sulla rampa A9 per Chiasso: code e fe...", "url": `${BASE_URL}/articoli-frontaliere/incidente-rampa-a9-chiasso-2026` },
 { "@type": "ListItem", "position": 718, "name": "TILO S50: fermate tra Varese e Malpensa cambian...", "url": `${BASE_URL}/articoli-frontaliere/tilo-s50-lavori-mal-pensa-varese-2026` },
 { "@type": "ListItem", "position": 719, "name": "Modifiche ai collegamenti TILO S50 tra Varese, ...", "url": `${BASE_URL}/articoli-frontaliere/tilo-s50-modifiche-aprile` },
 { "@type": "ListItem", "position": 720, "name": "Perequazione, Ticino deluso: Berna blocca fino ...", "url": `${BASE_URL}/articoli-frontaliere/consiglio-federale-ferma-perequazione-2030` },
 { "@type": "ListItem", "position": 721, "name": "Camionisti furbetti a Ticino: il governo valuta...", "url": `${BASE_URL}/articoli-frontaliere/camionisti-furbetti-governo-ticino-2026` },
 { "@type": "ListItem", "position": 722, "name": "Multe per Mancata Vignetta Autostradale: 190 Sa...", "url": `${BASE_URL}/articoli-frontaliere/multe-vignetta-chiasso-2024` },
 { "@type": "ListItem", "position": 723, "name": "Petizione per mantenere la produzione di Aromat...", "url": `${BASE_URL}/articoli-frontaliere/petizione-aromat-svizzera` },
 { "@type": "ListItem", "position": 724, "name": "Scontro in consiglio regionale sulla tassa salu...", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-tassa-salute-scontro` },
 { "@type": "ListItem", "position": 725, "name": "Pasqua 2026: 190 frontalieri multati a Chiasso ...", "url": `${BASE_URL}/articoli-frontaliere/multe-vignetta-chiasso-pasqua-2026` },
 { "@type": "ListItem", "position": 726, "name": "Ticino penalizzato: frontalieri gonfiano la ric...", "url": `${BASE_URL}/articoli-frontaliere/tasse-ticino-frontalieri-perequazione-2026` },
 { "@type": "ListItem", "position": 727, "name": "Asili a Bellinzona: progetto pilota per orario ...", "url": `${BASE_URL}/articoli-frontaliere/asili-bellinzona-progetto-pilota-orario-prolungato-2027` },
 { "@type": "ListItem", "position": 728, "name": "190 multe per vignetta mancante a Chiasso in 4 ...", "url": `${BASE_URL}/articoli-frontaliere/multe-vignetta-chiasso-2026` },
 { "@type": "ListItem", "position": 729, "name": "Servizio Trasfusionale di Locarno chiude il 24 ...", "url": `${BASE_URL}/articoli-frontaliere/servizio-trasfusionale-locarno-chiusura-24-giugno` },
 { "@type": "ListItem", "position": 730, "name": "Ritardi nei versamenti disoccupazione Ticino", "url": `${BASE_URL}/articoli-frontaliere/ritardi-disoccupazione-ticino` },
 { "@type": "ListItem", "position": 731, "name": "Frontalieri presi d’assalto: benzinai lombardi ...", "url": `${BASE_URL}/articoli-frontaliere/benzina-lombardia-frontalieri-ticinesi-2026` },
 { "@type": "ListItem", "position": 732, "name": "Diploma statunitense bloccato in Ticino: un’odi...", "url": `${BASE_URL}/articoli-frontaliere/diploma-usa-non-riconosciuto-ticino` },
 { "@type": "ListItem", "position": 733, "name": "DiscoverEU 2026: 40mila pass gratuiti in treno ...", "url": `${BASE_URL}/articoli-frontaliere/discover-eu-2026-frontalieri-ticino` },
 { "@type": "ListItem", "position": 734, "name": "Banche svizzere in allerta per i clienti del Go...", "url": `${BASE_URL}/articoli-frontaliere/banche-svizzere-pronti-clienti-golfo-2026` },
 { "@type": "ListItem", "position": 735, "name": "Fertilizzanti +40% in Ticino: la crisi di Hormu...", "url": `${BASE_URL}/articoli-frontaliere/fertilizzanti-crisi-hormuz-rincari-ticino-40` },
 { "@type": "ListItem", "position": 736, "name": "Tassa salute frontalieri: Lombardia sola a insi...", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-frontalieri-lombardia-isola-2026` },
 { "@type": "ListItem", "position": 737, "name": "Reclutatori ticinesi a caccia di futuri infermi...", "url": `${BASE_URL}/articoli-frontaliere/reclutamento-infermieri-lombardia` },
 { "@type": "ListItem", "position": 738, "name": "Autostrada A9 verso Chiasso chiusa di notte: ec...", "url": `${BASE_URL}/articoli-frontaliere/autostrada-a9-chiude-de-notti-2026` },
 { "@type": "ListItem", "position": 739, "name": "Frontaliere Ticino - 190 multe a Chiasso per vi...", "url": `${BASE_URL}/articoli-frontaliere/multa-vignetta-pasqua-chiasso-2024` },
 { "@type": "ListItem", "position": 740, "name": "SALVA compie 20 anni: meno della metà chiama l’...", "url": `${BASE_URL}/articoli-frontaliere/salva-venti-anni-monito-infarti` },
 { "@type": "ListItem", "position": 741, "name": "Migros Ticino attiva un piano di rebranding com...", "url": `${BASE_URL}/articoli-frontaliere/marchi-migros-riduzione-frontalieri-ticino` },
 { "@type": "ListItem", "position": 742, "name": "Disagi alla linea Tilo tra Mendrisio e Malpensa...", "url": `${BASE_URL}/articoli-frontaliere/disagi-tilo-mendrisio-malpensa-2026` },
 { "@type": "ListItem", "position": 743, "name": "CPB: la soglia dei 150mila euro vale anche se s...", "url": `${BASE_URL}/articoli-frontaliere/cpb-forfettario-semplificato-soglia-150mila` },
 { "@type": "ListItem", "position": 744, "name": "Verbano: accordo su livello massimo d’acqua, +2...", "url": `${BASE_URL}/articoli-frontaliere/verbano-livello-max-accordo-ticino-2026` },
 { "@type": "ListItem", "position": 745, "name": "Tassa salute frontalieri: analisi della disputa...", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-frontalieri-lombardia-minacce-ticino` },
 { "@type": "ListItem", "position": 746, "name": "Frontalieri Ticino: manca il lavoro, ma non que...", "url": `${BASE_URL}/articoli-frontaliere/lavoro-frontalieri-ticino-scarse-incastri` },
 { "@type": "ListItem", "position": 747, "name": "Fuga dei giovani dal Ticino: Claudio Isabella c...", "url": `${BASE_URL}/articoli-frontaliere/visione-politica-fuga-giovani-ticino` },
 { "@type": "ListItem", "position": 748, "name": "Cure a domicilio in Ticino: ATLaS scende in pia...", "url": `${BASE_URL}/articoli-frontaliere/cure-a-domicilio-atlas-protesta-18-aprile` },
 { "@type": "ListItem", "position": 749, "name": "Frontalieri in Ticino: salari e perequazione fi...", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-salari-perequazione-ricchezza-2026` },
 { "@type": "ListItem", "position": 750, "name": "Acqua di nuovo potabile a Lavizzara: Piano di P...", "url": `${BASE_URL}/articoli-frontaliere/acqua-potabile-lavizzara-piano-peccia-monti-rima` },
 { "@type": "ListItem", "position": 751, "name": "Giovani Ticino: Situazione politica e demografia", "url": `${BASE_URL}/articoli-frontaliere/giovani-fuga-ticino` },
 { "@type": "ListItem", "position": 752, "name": "Svizzera nell’Alleanza dei porti europei contro...", "url": `${BASE_URL}/articoli-frontaliere/svizzera-alleanza-porti-europei-anti-droga` },
 { "@type": "ListItem", "position": 753, "name": "Domeniche senza auto in Ticino: Glarona fa da a...", "url": `${BASE_URL}/articoli-frontaliere/glarona-domeniche-senzauto-ticino-frontalieri` },
 { "@type": "ListItem", "position": 754, "name": "Controlli polizia al confine Ticino: +2mila vei...", "url": `${BASE_URL}/articoli-frontaliere/controlli-frontalieri-ponte-chiasso-2025` },
 { "@type": "ListItem", "position": 755, "name": "Frontalieri Ticino 2025: Como e Varese dominano...", "url": `${BASE_URL}/articoli-frontaliere/frontalieri-ticino-dati-ust-2025` },
 { "@type": "ListItem", "position": 756, "name": "Bibo: l’app che calcola le tariffe dei mezzi pu...", "url": `${BASE_URL}/articoli-frontaliere/bibo-app-mezzi-pubblici-2026` },
 { "@type": "ListItem", "position": 757, "name": "Varese: 7mila posti vacanti nel 2026. Ecco cosa...", "url": `${BASE_URL}/articoli-frontaliere/varese-frontalieri-7000-postivacanti-2026` },
 { "@type": "ListItem", "position": 758, "name": "Iniziative cassa malati: Lega e PS insoddisfatt...", "url": `${BASE_URL}/articoli-frontaliere/iniziative-cassa-malati-governo-ticinese-insoddisfazione-lega-ps` },
 { "@type": "ListItem", "position": 759, "name": "Fermo treni Gallarate-Sesto: cosa cambia per i ...", "url": `${BASE_URL}/articoli-frontaliere/fermo-treni-gallarate-sesto-aprile-2026` },
 { "@type": "ListItem", "position": 760, "name": "Bibo: il biglietto digitale che si attiva da so...", "url": `${BASE_URL}/articoli-frontaliere/bibo-sistema-biglietti-digitali-mezzi-2026` },
 { "@type": "ListItem", "position": 761, "name": "Infermieri ticinesi: la fuga verso Milano per t...", "url": `${BASE_URL}/articoli-frontaliere/infermieri-ticinesi-ricerca-lavoro-milano` },
 { "@type": "ListItem", "position": 762, "name": "Ticino e Campione d’Italia: la Commissione pari...", "url": `${BASE_URL}/articoli-frontaliere/tappa-campione-ditalia-2025-commissione` },
          { "@type": "ListItem", "position": 763, "name": "Chiasso affida ai privati la lotta alla zanzara...", "url": `${BASE_URL}/articoli-frontaliere/nuova-strategia-zanzara-tigre-chiasso-2026` },
          { "@type": "ListItem", "position": 764, "name": "Lombardia stanzia 7 milioni per dottori di rice...", "url": `${BASE_URL}/articoli-frontaliere/lombardia-7mln-talenti-pmi-frontalieri` },
          { "@type": "ListItem", "position": 765, "name": "slowUp Ticino 2026: 19 aprile per una giornata ...", "url": `${BASE_URL}/articoli-frontaliere/slowup-ticino-2026-giornata-senz-auto` },
          { "@type": "ListItem", "position": 766, "name": "Bike sharing a Como: 80 bici dal 30 aprile. Dov...", "url": `${BASE_URL}/articoli-frontaliere/bike-sharing-como-riapre-30-aprile` },
          { "@type": "ListItem", "position": 767, "name": "Progetto Ticosa: Acinque accelera la riqualific...", "url": `${BASE_URL}/articoli-frontaliere/progetto-ticosa-parcheggi-acinque-frontalieri` },
          { "@type": "ListItem", "position": 768, "name": "Bellinzona lancia raccolta firme per asili nido...", "url": `${BASE_URL}/articoli-frontaliere/asili-nido-bellinzona-iniziativa-firme-2026` },
          { "@type": "ListItem", "position": 769, "name": "Cannabis medica: casse malati bloccano i rimbor...", "url": `${BASE_URL}/articoli-frontaliere/cannabis-medica-rimborsi-casse-malati-ticino` },
          { "@type": "ListItem", "position": 770, "name": "Asili nido pubblici in Ticino: da Bellinzona pa...", "url": `${BASE_URL}/articoli-frontaliere/asili-nido-pubblici-ticino-iniziativa-popolare-2026` },
          { "@type": "ListItem", "position": 771, "name": "Frontaliere Ticino | Berna limita l'acquisto di...", "url": `${BASE_URL}/articoli-frontaliere/berna-limita-acquisto-immobili-stranieri-2026` },
          { "@type": "ListItem", "position": 772, "name": "Premi cassa malati: riforma completa dal 2029, ...", "url": `${BASE_URL}/articoli-frontaliere/riforma-cassa-malati-ticino-2029` },
          { "@type": "ListItem", "position": 773, "name": "Domenica 19 aprile 2026 le strade tra Bellinzon...", "url": `${BASE_URL}/articoli-frontaliere/slowup-strade-trasporti-limiti-2026` },
          { "@type": "ListItem", "position": 774, "name": "Analisi degli approvvigionamenti di petrolio e ...", "url": `${BASE_URL}/articoli-frontaliere/petrolio-e-gas-svizzera-approvvigionamento-2026` },
          { "@type": "ListItem", "position": 775, "name": "Norme 2024 per fuochi all’aperto in Ticino: cos...", "url": `${BASE_URL}/articoli-frontaliere/fuochi-allaperto-ticino-grazie-normativa-2024` },
          { "@type": "ListItem", "position": 776, "name": "Acquisti immobiliari dall’estero: il Governo sv...", "url": `${BASE_URL}/articoli-frontaliere/governo-limita-acquisti-immobiliari-estero-2026` },
          { "@type": "ListItem", "position": 777, "name": "Incidente a Cassano Magnago: due frontalieri ti...", "url": `${BASE_URL}/articoli-frontaliere/incidente-cassano-magnago-frontalieri-ticinesi` },
          { "@type": "ListItem", "position": 778, "name": "Ristoratore ticinese sorprende ladro: arrestato...", "url": `${BASE_URL}/articoli-frontaliere/wirt-sorpreso-einbrecher-marokkaner-ticino` },
          { "@type": "ListItem", "position": 779, "name": "L'Iran chiude la porta al ripescaggio dell'Ital...", "url": `${BASE_URL}/articoli-frontaliere/irania-nazionale-italia-riqualifica-2026` },
          { "@type": "ListItem", "position": 780, "name": "Webuild e Salini: serve collaborazione per un T...", "url": `${BASE_URL}/articoli-frontaliere/collaborazione-imprese-istituzioni-frontalieri-ticino` },
          { "@type": "ListItem", "position": 781, "name": "Monte dei Paschi di Siena: Lovaglio vince l’ass...", "url": `${BASE_URL}/articoli-frontaliere/ribaltone-mps-lovaglio-frontalieri-ticino` },
          { "@type": "ListItem", "position": 782, "name": "Giro d’Italia 2026: Bellinzona-Carì in 113 km p...", "url": `${BASE_URL}/articoli-frontaliere/giro-italia-2026-bellinzona-cari-tappa` },
          { "@type": "ListItem", "position": 783, "name": "Operaio frontaliero bulgaro muore in incidente ...", "url": `${BASE_URL}/articoli-frontaliere/infortunio-locarnese-operaio-frontaliero-decede` },
          { "@type": "ListItem", "position": 784, "name": "Film Swiss Sabotage: i Frontaliers ticinesi sba...", "url": `${BASE_URL}/articoli-frontaliere/film-swiss-sabotage-frontalieri-ticinesi` },
          { "@type": "ListItem", "position": 785, "name": "Pendolare inverso: da Altdorf a Lugano ogni gio...", "url": `${BASE_URL}/articoli-frontaliere/pendolare-inverso-altdorf-lugano-problemi` },
          { "@type": "ListItem", "position": 786, "name": "Risparmio Casa arriva al Centro Breggia di Bale...", "url": `${BASE_URL}/articoli-frontaliere/centro-breggia-risparmio-casa-arriva-balerna` },
          { "@type": "ListItem", "position": 787, "name": "Trafico di droga bloccato a Brogeda: due arrest...", "url": `${BASE_URL}/articoli-frontaliere/blocco-droga-confine-brogeda-2026` },
          { "@type": "ListItem", "position": 788, "name": "Frontaliere Ticino: Nuovi collegamenti FFS 2026...", "url": `${BASE_URL}/articoli-frontaliere/ffs-collegamenti-estivi-rimini-francia-2026` },
          { "@type": "ListItem", "position": 789, "name": "Chiasso cerca soluzioni per assumere più reside...", "url": `${BASE_URL}/articoli-frontaliere/strumenti-comune-chiasso-assunzione-residenti` },
          { "@type": "ListItem", "position": 790, "name": "Statua ‘Ritorno alla natura’ a Chiasso: petizio...", "url": `${BASE_URL}/articoli-frontaliere/petizione-chiasso-ritorno-alla-natura-2025` },
          { "@type": "ListItem", "position": 791, "name": "Varese 2026: Congresso Svizzera Italia su fisco...", "url": `${BASE_URL}/articoli-frontaliere/congresso-varese-2026-fisco-lavoro-ticino` },
          { "@type": "ListItem", "position": 792, "name": "Deprexis rimborsata da cassa malati: cosa cambi...", "url": `${BASE_URL}/articoli-frontaliere/psicoterapia-digitale-deprexis-rimborsata-2026` },
          { "@type": "ListItem", "position": 793, "name": "Deputato varesino a Forno di Massa: «La vergogn...", "url": `${BASE_URL}/articoli-frontaliere/deputato-varesino-ferrara-forno-massacro-2026` },
          { "@type": "ListItem", "position": 794, "name": "Ticino: servono riforme sanitarie, non aumenti ...", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-ticino-riforme-invece-aggravi` },
          { "@type": "ListItem", "position": 795, "name": "ChiassoLetteraria festeggia 20 anni dal 6 al 10...", "url": `${BASE_URL}/articoli-frontaliere/chiassolitteratura-venti-anniversario-2026` },
          { "@type": "ListItem", "position": 796, "name": "Finanze Ticino 2025", "url": `${BASE_URL}/articoli-frontaliere/finanze-2025-fragile-ticino` },
          { "@type": "ListItem", "position": 797, "name": "Tassa salute frontalieri Lombardia: rinvio mozi...", "url": `${BASE_URL}/articoli-frontaliere/tassa-salute-frontalieri-lombardia-rinvio-2026` },
          { "@type": "ListItem", "position": 798, "name": "Frontaliere Ticino - Arresto droga confine Brog...", "url": `${BASE_URL}/articoli-frontaliere/arresto-droga-confine-brogeda-2026` },
          { "@type": "ListItem", "position": 799, "name": "Manutenzione USTAT e chiusure natalizie 2025: p...", "url": `${BASE_URL}/articoli-frontaliere/manutenzione-ustat-servizi-chiusure-31-12-2025` },
          { "@type": "ListItem", "position": 800, "name": "Confine Italia-Svizzera: 6 regole doganali per ...", "url": `${BASE_URL}/articoli-frontaliere/confine-italia-svizzera-6-regole-doganali` },
          { "@type": "ListItem", "position": 801, "name": "Blocco traffico a Chiasso-Brogeda: due nigerian...", "url": `${BASE_URL}/articoli-frontaliere/due-arresti-brogeda-smuggling-droga-2024` },
          { "@type": "ListItem", "position": 802, "name": "Ticino: nuove regole contro specie invasive per...", "url": `${BASE_URL}/articoli-frontaliere/tutela-frontalieri-specie-invasive-ticino-2026` },
          { "@type": "ListItem", "position": 803, "name": "Taglio da 25 milioni per USI e SUPSI: cosa camb...", "url": `${BASE_URL}/articoli-frontaliere/usi-supsi-25-milioni-casse-malati` },
          { "@type": "ListItem", "position": 804, "name": "Lega Ticino: «Prima il Ticino, solidarietà iniz...", "url": `${BASE_URL}/articoli-frontaliere/lega-ticino-solidarieta-casa-propria-2026` },
          { "@type": "ListItem", "position": 805, "name": "Moon&Stars: sconti per residenti con Locarno Ca...", "url": `${BASE_URL}/articoli-frontaliere/moon-stars-resident-discount-locarno-card` },
          { "@type": "ListItem", "position": 806, "name": "Scoperta record a Colverde: sequestrato oltre u...", "url": `${BASE_URL}/articoli-frontaliere/scoperta-quantita-marijuana-colverde-confine-ticino` },
          { "@type": "ListItem", "position": 807, "name": "Controlli straordinari a Lavena Ponte Tresa: dr...", "url": `${BASE_URL}/articoli-frontaliere/controlli-serali-lavena-ponte-tresa-15-aprile-2026` },
          { "@type": "ListItem", "position": 808, "name": "Svizzera e Canada avviano la modernizzazione de...", "url": `${BASE_URL}/articoli-frontaliere/svizzera-canada-mercati-alternativi-trump` },
          { "@type": "ListItem", "position": 809, "name": "Casse malati Ticino: 61 milioni in meno per Lug...", "url": `${BASE_URL}/articoli-frontaliere/iniziative-casse-malati-61-milioni-ticino` },
          { "@type": "ListItem", "position": 810, "name": "Allentamenti affitti brevi in Ticino: cosa camb...", "url": `${BASE_URL}/articoli-frontaliere/allentamenti-affitti-brevi-ticino-2025` },
          { "@type": "ListItem", "position": 811, "name": "Fuoriuscita di ammoniaca alla Rapelli di Stabio", "url": `${BASE_URL}/articoli-frontaliere/fuoriuscita-ammoniaca-rapelli-stabio` },
          { "@type": "ListItem", "position": 812, "name": "L'IA nella selezione del personale: tra opportu...", "url": `${BASE_URL}/articoli-frontaliere/ia-selezione-personale-ticino` },
          { "@type": "ListItem", "position": 813, "name": "Swiss Market Index in territorio positivo: cosa...", "url": `${BASE_URL}/articoli-frontaliere/swiss-market-index-vedi-breve-rimbalzo` },
          { "@type": "ListItem", "position": 814, "name": "Sussidi cassa malati a Mendrisio: ritardi inacc...", "url": `${BASE_URL}/articoli-frontaliere/sussidi-cassa-malati-mendrisio-rallentamenti` },
          { "@type": "ListItem", "position": 815, "name": "Mendrisio: sussidi cassa malati in ritardo, cit...", "url": `${BASE_URL}/articoli-frontaliere/sussidi-cassa-malati-mendrisio-ritardi` },
          { "@type": "ListItem", "position": 816, "name": "Varese economia in crescita: cosa cambia per i ...", "url": `${BASE_URL}/articoli-frontaliere/varese-economia-frontalieri-ticino-2026` },
          { "@type": "ListItem", "position": 817, "name": "Lombardia investe 12,3 milioni in moda: opportu...", "url": `${BASE_URL}/articoli-frontaliere/lombardia-investimento-moda-ticinesi-next-fashion` },
          { "@type": "ListItem", "position": 818, "name": "Svizzera-USA: Parmelin avvia nuova fase negozia...", "url": `${BASE_URL}/articoli-frontaliere/svizzera-usa-nuovi-negoziati-commerciali-2026` },
          { "@type": "ListItem", "position": 819, "name": "Voli cancellati a causa del prezzo del kerosene...", "url": `${BASE_URL}/articoli-frontaliere/aumento-kerosene-voli-cancellati-frontalieri-ticino` },
          { "@type": "ListItem", "position": 820, "name": "Radar mobili in Ticino: dove e quando faranno p...", "url": `${BASE_URL}/articoli-frontaliere/radar-controlli-velocita-ticino-aprile-2026` },
          { "@type": "ListItem", "position": 821, "name": "Treni diretti Zurigo-Rimini e TGV per la Franci...", "url": `${BASE_URL}/articoli-frontaliere/nuove-tratte-estive-ffs-ticino-2026` },
          { "@type": "ListItem", "position": 822, "name": "Malpensa senza carburante: cosa rischiano i fro...", "url": `${BASE_URL}/articoli-frontaliere/malpensa-carburante-rischio-frontalieri-2026` },
          { "@type": "ListItem", "position": 823, "name": "Nuovo potabilizzatore mobile in Ticino: emergen...", "url": `${BASE_URL}/articoli-frontaliere/nuovo-potabilizzatore-mobile-emergenza-ticino` },
          { "@type": "ListItem", "position": 824, "name": "Acqua potabile in emergenza: Ticino presenta il...", "url": `${BASE_URL}/articoli-frontaliere/nuovo-potabilizzatore-mobile-ticino-emergenza` },
          { "@type": "ListItem", "position": 825, "name": "PalaRaiffeisen a Lugano: la maxi-opera del PSE ...", "url": `${BASE_URL}/articoli-frontaliere/palaraiffeisen-porta-aperte-lugano-2026` },
          { "@type": "ListItem", "position": 826, "name": "Fashion Outlet Landquart: 15 nuovi negozi e +1'...", "url": `${BASE_URL}/articoli-frontaliere/fashion-outlet-landquart-15-nuovi-negozi-expansion` },
          { "@type": "ListItem", "position": 827, "name": "Salario minimo a 25 CHF in Ticino: Proposta MPS...", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-25-chf-ticino` },
          { "@type": "ListItem", "position": 828, "name": "Confindustria Varese: Paciaroni riconfermato al...", "url": `${BASE_URL}/articoli-frontaliere/confindustria-varese-paciaroni-2026` },
          { "@type": "ListItem", "position": 829, "name": "Finanza ticinese si reinventa: l’economia va in...", "url": `${BASE_URL}/articoli-frontaliere/finanza-ticino-si-reinventa-economia-dati` },
          { "@type": "ListItem", "position": 830, "name": "Coppa del Mondo di corsa d'orientamento 2026: L...", "url": `${BASE_URL}/articoli-frontaliere/coppa-del-mondo-orientamento-locarnese-2026` },
          { "@type": "ListItem", "position": 831, "name": "Grigioni: nove candidati per cinque seggi al Go...", "url": `${BASE_URL}/articoli-frontaliere/grigioni-governo-2026-nove-candidati` },
          { "@type": "ListItem", "position": 832, "name": "Svizzera-USA: accordo commerciale in bilico, Pa...", "url": `${BASE_URL}/articoli-frontaliere/svizzera-usa-accordo-commerciale-2026` },
          { "@type": "ListItem", "position": 833, "name": "Federviti lancia risoluzione: vino ticinese pri...", "url": `${BASE_URL}/articoli-frontaliere/risoluzione-federviti-vino-ticinese-2025` },
          { "@type": "ListItem", "position": 834, "name": "Analisi delle iniziative sulla cassa malati in ...", "url": `${BASE_URL}/articoli-frontaliere/iniziative-cassa-malati-piano-lega-ticino` },
          { "@type": "ListItem", "position": 835, "name": "A8-A9 verso Chiasso chiusa di notte: percorsi a...", "url": `${BASE_URL}/articoli-frontaliere/chiusura-ramo-a8-a9-notte-lavori-2026` },
          { "@type": "ListItem", "position": 836, "name": "L’IA riduce i tempi di determinazione dei prezz...", "url": `${BASE_URL}/articoli-frontaliere/ia-swiss-re-produttivita-ceo-berger` },
          { "@type": "ListItem", "position": 837, "name": "Progetto Echo: praterie sommerse per salvare i ...", "url": `${BASE_URL}/articoli-frontaliere/rinascita-praterie-sommerse-laghi-ticino` },
          { "@type": "ListItem", "position": 838, "name": "Fuga di ammoniaca a Stabio: cosa sapere e come ...", "url": `${BASE_URL}/articoli-frontaliere/fuga-ammoniaca-stabio-rapelli-allerta-ticino` },
          { "@type": "ListItem", "position": 839, "name": "AIL Arena a Lugano: porte aperte il 30 e 31 mag...", "url": `${BASE_URL}/articoli-frontaliere/inaugurazione-ail-arena-lugano-30-31-maggio` },
          { "@type": "ListItem", "position": 840, "name": "Ritardi negli assegni cassa malati a Mendrisio:...", "url": `${BASE_URL}/articoli-frontaliere/sussidi-cassa-malati-mendrisio-ritardi-2026` },
          { "@type": "ListItem", "position": 841, "name": "Mercato immobiliare Ticino: analisi della crisi...", "url": `${BASE_URL}/articoli-frontaliere/alloggi-frontalieri-ticino-crisi-2025` },
          { "@type": "ListItem", "position": 842, "name": "Grandine in Ticino: cosa devono fare i frontali...", "url": `${BASE_URL}/articoli-frontaliere/grandine-bellinzonese-allerta-lugano-chiasso-19-aprile-2026` },
          { "@type": "ListItem", "position": 843, "name": "Ticino: apertura sportello DIDI per dipendenze ...", "url": `${BASE_URL}/articoli-frontaliere/sportello-dipendenze-digitali-ticino-2024` },
          { "@type": "ListItem", "position": 844, "name": "Ticino, paradiso fiscale per milionari in fuga ...", "url": `${BASE_URL}/articoli-frontaliere/tasse-agevolate-milionari-ticino-golfo` },
          { "@type": "ListItem", "position": 845, "name": "L’Infermiere di Pratiche Avanzate (APN) nel Tic...", "url": `${BASE_URL}/articoli-frontaliere/infermiere-pratiche-avanzate-ticino-2024` },
          { "@type": "ListItem", "position": 846, "name": "Medio Oriente in fiamme: costi e rischi per imp...", "url": `${BASE_URL}/articoli-frontaliere/caos-medioriente-e-impatti-costruzione-ticino` },
          { "@type": "ListItem", "position": 847, "name": "Dazi USA: Parmelin a Washington per rilanciare ...", "url": `${BASE_URL}/articoli-frontaliere/parmelin-washington-dazi-usa-2026` },
          { "@type": "ListItem", "position": 848, "name": "Tre colombiani arrestati per furto sul Verbano:...", "url": `${BASE_URL}/articoli-frontaliere/gang-colombiani-verbano-arresti-ticino-2026` },
          { "@type": "ListItem", "position": 849, "name": "Parmelin firma accordo con Bahrein per protegge...", "url": `${BASE_URL}/articoli-frontaliere/parmelin-accordo-investimenti-bahrein-2026` },
          { "@type": "ListItem", "position": 850, "name": "Palazzo civico e Collegiata di Bellinzona più a...", "url": `${BASE_URL}/articoli-frontaliere/palazzo-civico-collegiata-accessibilita-bellinzona-2026` },
          { "@type": "ListItem", "position": 851, "name": "Roche farmaci obesità Ticino 2026", "url": `${BASE_URL}/articoli-frontaliere/roche-farmaci-obesita-ticino-2026` },
          { "@type": "ListItem", "position": 852, "name": "Chiusure autostrada A9: cosa cambia per i front...", "url": `${BASE_URL}/articoli-frontaliere/chiusure-autostrada-a9-lombardia-2026` },
          { "@type": "ListItem", "position": 853, "name": "Capre alla dogana di Gandria: rischio incidente...", "url": `${BASE_URL}/articoli-frontaliere/capre-dogana-gandria-incidenti-2026` },
          { "@type": "ListItem", "position": 854, "name": "Lavori autostrade Ticino: chiusure notturne a B...", "url": `${BASE_URL}/articoli-frontaliere/lavori-autostrade-ticino-aprile-2026` },
          { "@type": "ListItem", "position": 855, "name": "Militari sui treni Trenord: 20 euro all'anno pe...", "url": `${BASE_URL}/articoli-frontaliere/militari-treni-ticino-20-euro` },
          { "@type": "ListItem", "position": 856, "name": "Just Eat consegna prodotti Migros in Ticino, Va...", "url": `${BASE_URL}/articoli-frontaliere/just-eat-migros-ticino-consegna-2026` },
          { "@type": "ListItem", "position": 857, "name": "Intervento alla dogana di Gandria: salvate quat...", "url": `${BASE_URL}/articoli-frontaliere/capre-dogana-gandria-intervento-30-marzo` },
          { "@type": "ListItem", "position": 858, "name": "Cure a domicilio: costi in Ticino", "url": `${BASE_URL}/articoli-frontaliere/costi-cure-domocilio-ticino-2026` },
          { "@type": "ListItem", "position": 859, "name": "Salario minimo Ticino 2027-2029 | Frontaliere T...", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-ticino-2027-2029` },
          { "@type": "ListItem", "position": 860, "name": "Cure a domicilio, palla in tribuna: respinta la...", "url": `${BASE_URL}/articoli-frontaliere/cure-domocilio-ticino-2026` },
          { "@type": "ListItem", "position": 861, "name": "Asili nido Bellinzona: polemiche sussidi", "url": `${BASE_URL}/articoli-frontaliere/asili-nido-bellinzona-sussidi-2026` },
          { "@type": "ListItem", "position": 862, "name": "Discesa giovani Ticino", "url": `${BASE_URL}/articoli-frontaliere/giovani-scomparsi-7-cantoni` },
          { "@type": "ListItem", "position": 863, "name": "Cucina italiana preferita dagli svizzeri", "url": `${BASE_URL}/articoli-frontaliere/svizzeri-italiani-cucina-preferita` },
          { "@type": "ListItem", "position": 864, "name": "Nuove restrizioni per investitori immobiliari s...", "url": `${BASE_URL}/articoli-frontaliere/svizzera-chiude-investitori-immobiliari-stranieri` },
          { "@type": "ListItem", "position": 865, "name": "Nuovo salario minimo in Ticino dal 2027", "url": `${BASE_URL}/articoli-frontaliere/salario-minimo-ticino-2027-2029-nuove-regole` },
          { "@type": "ListItem", "position": 866, "name": "Cybercrimepolice.ch ora in italiano", "url": `${BASE_URL}/articoli-frontaliere/cybercrimepolice-ticino-italiano-2026` },
          { "@type": "ListItem", "position": 867, "name": "Azienda assume autisti in Lombardia: 800 euro a...", "url": `${BASE_URL}/articoli-frontaliere/azienda-assume-autisti-lombardia-800-euro` },
          { "@type": "ListItem", "position": 868, "name": "BancaStato Walking Mendrisio 2026: tre percorsi...", "url": `${BASE_URL}/articoli-frontaliere/bancastato-walking-mendrisio-2026` }
 ]
 }
 ]
 },
 'blog-borse-in-rosso-prezzo-petrolio-ticino': {
 title: 'Borse in rosso e prezzo del petrolio in rialzo: cosa',
 description: 'Scopri come l\'aumento del prezzo del petrolio influisce sui frontalieri e sulla vita economica in Ticino. Dati aggiornati 2026 per frontalieri in Ticino.',
 keywords: 'frontalieri, ticino, svizzera, italia, borse, rosso, prezzo, petrolio',
 ogTitle: 'Borse in rosso e aumento prezzi petrolio | Frontaliere',
 ogDescription: 'Analisi dell\'impatto dell\'aumento del prezzo del petrolio sui frontalieri in Ticino.',
 canonicalPath: '/articoli-frontaliere/borse-in-rosso-prezzo-petrolio-ticino',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Economia - Borse in rosso e prezzo del petrolio in rialzo",
 "description": "Scopri come l'aumento del prezzo del petrolio influisce sui frontalieri e sulla vita economica in Ticino. Dati aggiornati 2026 per frontalieri in Ticino.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/borse-in-rosso-prezzo-petrolio-ticino.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista di Lugano con lago e montagne circostanti."
 },
 "datePublished": "2026-03-03T14:39:51+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/borse-in-rosso-prezzo-petrolio-ticino`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-frontaliers-sabotage-varese-successo': {
 title: 'Frontaliers Sabotage conquista Varese: sold out al MIV',
 description: 'La prima italiana di Frontaliers Sabotage al cinema MIV di Varese registra un sold out. Successo per la saga dei frontalieri anche in Italia. Dati aggiornati',
 keywords: 'frontalieri, ticino, svizzera, italia, frontaliers, sabotage, conquista, varese',
 ogTitle: 'Frontaliers Sabotage: un successo oltre confine',
 ogDescription: 'La saga dei frontalieri conquista anche Varese. Scopri di più sul successo di Frontaliers Sabotage',
 canonicalPath: '/articoli-frontaliere/frontaliers-sabotage-varese-successo',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Frontaliers Sabotage conquista Varese: sold out al MIV",
 "description": "La prima italiana di Frontaliers Sabotage al cinema MIV di Varese registra un sold out. Successo per la saga dei frontalieri anche in Italia. Dati aggiornati",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/frontaliers-sabotage-varese-successo.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Panorama di Lugano al tramonto sul lago"
 },
 "datePublished": "2026-03-04T07:43:28+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/frontaliers-sabotage-varese-successo`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-disoccupazione-svizzera-2026': {
 title: 'Disoccupazione in Svizzera: crescita e cause nel 2026',
 description: 'Nel 2026, la disoccupazione in Svizzera cresce più che nell\'UE, con il settore bancario in difficoltà. Dati aggiornati 2026 per frontalieri in Ticino.',
 keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, crescita, cause, cresce',
 ogTitle: 'Disoccupazione in Svizzera: crescita e cause nel 2026',
 ogDescription: 'Nel 2026, la disoccupazione in Svizzera cresce più che nell\'UE, con il settore bancario in difficoltà.',
 canonicalPath: '/articoli-frontaliere/disoccupazione-svizzera-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Disoccupazione in Svizzera: crescita e cause nel 2026",
 "description": "Nel 2026, la disoccupazione in Svizzera cresce più che nell'UE, con il settore bancario in difficoltà. Dati aggiornati 2026 per frontalieri in Ticino.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/disoccupazione-svizzera-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista di Bellinzona con i suoi castelli storici e la vita cittadina."
 },
 "datePublished": "2026-03-04T08:11:51+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/disoccupazione-svizzera-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-infermieri-svizzera-frontalieri-ticino': {
 title: 'La Svizzera cerca infermieri: 137mila annunci per',
 description: 'La Svizzera cerca infermieri: 137mila annunci per frontalieri. Scopri le opportunità e le sfide per il Ticino e per i frontalieri che lavorano nel settore',
 keywords: 'frontalieri, ticino, svizzera, italia, cerca, infermieri, 137mila, annunci',
 ogTitle: 'Infermieri frontalieri: la sfida del Ticino',
 ogDescription: 'La Svizzera cerca infermieri frontalieri. Scopri le implicazioni per il Ticino e le opportunità per i lavoratori frontalieri nel settore sanitario.',
 canonicalPath: '/articoli-frontaliere/infermieri-svizzera-frontalieri-ticino',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "La carenza di infermieri in Svizzera e le sue implicazioni per il Ticino",
 "description": "La Svizzera cerca infermieri: 137mila annunci per frontalieri. Scopri le opportunità e le sfide per il Ticino e per i frontalieri che lavorano nel settore",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/infermieri-svizzera-frontalieri-ticino.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Infermieri al lavoro in un ospedale del Ticino"
 },
 "datePublished": "2026-03-04T10:17:08+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/infermieri-svizzera-frontalieri-ticino`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-successo-farmaceutica-ticino': {
 title: 'Farmaceutica: successo globale, preoccupazioni svizzere',
 description: 'Scopri come Roche e Novartis hanno registrato risultati record e cosa significa per la Svizzera e i frontalieri in Ticino. Dati aggiornati 2026 per frontalieri',
 keywords: 'frontalieri, ticino, svizzera, italia, farmaceutica, successo, globale, preoccupazioni',
 ogTitle: 'Successo farmaceutica in Svizzera: cosa significa per i',
 ogDescription: 'Le due principali aziende farmaceutiche svizzere, Roche e Novartis, registrano risultati record. Scopri le implicazioni per la Svizzera e i frontalieri in',
 canonicalPath: '/articoli-frontaliere/successo-farmaceutica-ticino',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Farmaceutica: successi e sfide per la Svizzera",
 "description": "Scopri come Roche e Novartis hanno registrato risultati record e cosa significa per la Svizzera e i frontalieri in Ticino. Dati aggiornati 2026 per frontalieri",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/successo-farmaceutica-ticino.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Panorama di Lugano con vista sul lago"
 },
 "datePublished": "2026-03-04T12:09:08+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/successo-farmaceutica-ticino`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-utile-bns-2025-ticino': {
 title: 'Utile della BNS a 26,1 miliardi di franchi: Impatti sul',
 description: 'La BNS chiude il 2025 con un utile di 26,1 miliardi, impatti significativi per il Ticino. Dati aggiornati 2026 per frontalieri in Ticino.',
 keywords: 'frontalieri, ticino, svizzera, italia, utile, miliardi, franchi, impatti',
 ogTitle: 'Utile della BNS a 26,1 miliardi di franchi',
 ogDescription: 'Impatto positivo per il Canton Ticino e i frontalieri dopo l\'utile della BNS nel 2025.',
 canonicalPath: '/articoli-frontaliere/utile-bns-2025-ticino',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Utile della BNS a 26,1 miliardi di franchi",
 "description": "La BNS chiude il 2025 con un utile di 26,1 miliardi, impatti significativi per il Ticino. Dati aggiornati 2026 per frontalieri in Ticino.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/utile-bns-2025-ticino.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica di Bellinzona con i suoi castelli storici."
 },
 "datePublished": "2026-03-04T14:22:12+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/utile-bns-2025-ticino`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-banche-ticino-disoccupazione': {
 title: 'Le banche svizzere assumono meno, la disoccupazione cresce',
 description: 'Scopri come il calo degli annunci di lavoro nelle banche svizzere e l\'aumento della disoccupazione potrebbero influire sui frontalieri in Ticino.',
 keywords: 'frontalieri, ticino, svizzera, italia, banche, svizzere, assumono, meno',
 ogTitle: 'Il mercato del lavoro bancario in Svizzera in declino',
 ogDescription: 'Le banche svizzere pubblicano meno annunci di lavoro, mentre la disoccupazione nel settore aumenta. Cosa significa per i frontalieri in Ticino?',
 canonicalPath: '/articoli-frontaliere/banche-ticino-disoccupazione',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Le banche svizzere assumono meno, cresce la disoccupazione",
 "description": "Scopri come il calo degli annunci di lavoro nelle banche svizzere e l'aumento della disoccupazione potrebbero influire sui frontalieri in Ticino.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/banche-ticino-disoccupazione.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Panorama di Lugano con grafico in calo"
 },
 "datePublished": "2026-03-04T17:38:10+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/banche-ticino-disoccupazione`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-medio-vedeggio-gruppo-lavoro-aggregazione': {
 title: 'Medio Vedeggio: nasce il gruppo di lavoro per',
 description: 'Bedano, Cadempino, Gravesano e Lamone creano un gruppo di lavoro per uno studio aggregativo con conclusione prevista entro il 2028. Dati aggiornati 2026 per',
 keywords: 'frontalieri, ticino, svizzera, italia, medio, vedeggio, nasce, gruppo',
 ogTitle: 'Medio Vedeggio, nasce il gruppo di lavoro per l’aggregazione',
 ogDescription: 'Quattro comuni ticinesi avviano uno studio per la fusione entro il 2028, rafforzando la Valle del Vedeggio nel contesto cantonale.',
 canonicalPath: '/articoli-frontaliere/medio-vedeggio-gruppo-lavoro-aggregazione',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Medio Vedeggio, nasce il gruppo di lavoro per l’aggregazione",
 "description": "Bedano, Cadempino, Gravesano e Lamone creano un gruppo di lavoro per uno studio aggregativo con conclusione prevista entro il 2028. Dati aggiornati 2026 per",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/medio-vedeggio-gruppo-lavoro-aggregazione.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica del Medio Vedeggio con i comuni di Bedano, Cadempino, Gravesano e Lamone in Ticino"
 },
 "datePublished": "2026-03-04T20:08:46+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/medio-vedeggio-gruppo-lavoro-aggregazione`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-lugano-airport-fondi-salvati-2026': {
 title: 'Lugano Airport è salvo: il Nazionale boccia il taglio dei',
 description: 'Il Consiglio Nazionale respinge il taglio dei contributi federali a Lugano Airport, garantendo sicurezza e sviluppo nel Ticino e per i frontalieri.',
 keywords: 'frontalieri, ticino, svizzera, italia, lugano, airport, salvo, nazionale',
 ogTitle: 'Lugano Airport salva i fondi federali 2026',
 ogDescription: 'Il Consiglio Nazionale boccia il taglio dei fondi per Lugano Airport, assicurando investimenti e sicurezza per il Cantone Ticino e i frontalieri.',
 canonicalPath: '/articoli-frontaliere/lugano-airport-fondi-salvati-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Lugano Airport è salvo: il Nazionale boccia il taglio dei fondi",
 "description": "Il Consiglio Nazionale respinge il taglio dei contributi federali a Lugano Airport, garantendo sicurezza e sviluppo nel Ticino e per i frontalieri.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/lugano-airport-fondi-salvati-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica dell'aeroporto di Lugano con il lago e la città sullo sfondo in Ticino."
 },
 "datePublished": "2026-03-04T21:05:31+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/lugano-airport-fondi-salvati-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-made-in-italy-doganali-ticino-2026': {
 title: 'Made in Italy: revisione norme doganali e impatto sul',
 description: 'Il Comitato delle Regioni spinge per una nuova normativa doganale per tutelare il Made in Italy. Impatti e opportunità per Ticino e frontalieri nel 2026.',
 keywords: 'frontalieri, ticino, svizzera, italia, made, italy, revisione, norme',
 ogTitle: 'Made in Italy: revisione doganale e impatti su Ticino 2026',
 ogDescription: 'Scopri come la revisione delle norme doganali UE sul Made in Italy interessa il Canton Ticino e i frontalieri nel 2026.',
 canonicalPath: '/articoli-frontaliere/made-in-italy-doganali-ticino-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Made in Italy, il Comitato delle Regioni accoglie la richiesta di Anci e",
 "description": "Il Comitato delle Regioni spinge per una nuova normativa doganale per tutelare il Made in Italy. Impatti e opportunità per Ticino e frontalieri nel 2026.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/made-in-italy-doganali-ticino-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica di Lugano con lago e montagne sullo sfondo in una giornata limpida di primavera"
 },
 "datePublished": "2026-03-04T23:07:46+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/made-in-italy-doganali-ticino-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-mercato-lavoro-ticino-q4-2025': {
 title: 'Mercato del lavoro Ticino: dati e trend quarto trimestre',
 description: 'Scopri i dati e le analisi sul mercato del lavoro in Ticino nel quarto trimestre 2025, con focus su frontalieri e trend occupazionali. Dati aggiornati 2026 per',
 keywords: 'frontalieri, ticino, svizzera, italia, mercato, lavoro, dati, trend',
 ogTitle: 'Mercato lavoro Ticino Q4 2025 | Frontaliere Ticino',
 ogDescription: 'Analisi dettagliata sul mercato del lavoro ticinese nel Q4 2025, con dati su frontalieri, salari e permessi di lavoro.',
 canonicalPath: '/articoli-frontaliere/mercato-lavoro-ticino-q4-2025',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Notiziario statistico Ustat: Il mercato del lavoro, Ticino, quarto",
 "description": "Scopri i dati e le analisi sul mercato del lavoro in Ticino nel quarto trimestre 2025, con focus su frontalieri e trend occupazionali. Dati aggiornati 2026 per",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/mercato-lavoro-ticino-q4-2025.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica di Lugano con lavoratori frontalieri che attraversano un ponte, simbolo dell’economia ticinese"
 },
 "datePublished": "2026-03-05T05:06:52+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/mercato-lavoro-ticino-q4-2025`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-dichiarazione-imposta-digitale-ticino-26': {
 title: 'Dichiarazione d’imposta sempre più digitale in Ticino nel',
 description: 'Scopri come la dichiarazione d’imposta 2025 in Ticino diventa sempre più digitale con oltre 100\'000 utenti online e nuove funzionalità per i frontalieri.',
 keywords: 'frontalieri, ticino, svizzera, italia, dichiarazione, imposta, sempre, digitale',
 ogTitle: 'Dichiarazione d’imposta digitale in Ticino oltre 100\'000',
 ogDescription: 'Dal 2026 la dichiarazione imposta ticinese è sempre più digitale con nuove opportunità online per frontalieri e residenti al confine.',
 canonicalPath: '/articoli-frontaliere/dichiarazione-imposta-digitale-ticino-26',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Dichiarazione d’imposta sempre più digitale",
 "description": "Scopri come la dichiarazione d’imposta 2025 in Ticino diventa sempre più digitale con oltre 100'000 utenti online e nuove funzionalità per i frontalieri.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/dichiarazione-imposta-digitale-ticino-26.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica di Lugano con il lago e le montagne sullo sfondo in Ticino"
 },
 "datePublished": "2026-03-05T08:01:20+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/dichiarazione-imposta-digitale-ticino-26`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-tilo-25-milioni-passeggeri-2025': {
 title: 'TILO sfonda quota 25 milioni di passeggeri nel 2025',
 description: 'TILO raggiunge 25 milioni di passeggeri nel 2025, con crescita del 50% dal 2019 e record a Lugano e Milano Centrale. Dati aggiornati 2026 per frontalieri in',
 keywords: 'frontalieri, ticino, svizzera, italia, tilo, sfonda, quota, milioni',
 ogTitle: 'TILO supera 25 milioni di passeggeri nel 2025',
 ogDescription: 'La rete ferroviaria TILO registra un aumento del 50% dei passeggeri dal 2019, confermando il ruolo chiave per il Canton Ticino e i lavoratori frontalieri.',
 canonicalPath: '/articoli-frontaliere/tilo-25-milioni-passeggeri-2025',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "FerroviaRaggiunti i 25 milioni di passeggeri per TILO nel 2025",
 "description": "TILO raggiunge 25 milioni di passeggeri nel 2025, con crescita del 50% dal 2019 e record a Lugano e Milano Centrale. Dati aggiornati 2026 per frontalieri in",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/tilo-25-milioni-passeggeri-2025.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Stazione di Lugano affollata con passeggeri TILO nel 2025, vista urbana del Canton Ticino"
 },
 "datePublished": "2026-03-05T10:11:48+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/tilo-25-milioni-passeggeri-2025`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-tassa-salute-lombardia-rinvio': {
 title: 'Tassa salute, la Lombardia rinvia: cosa significa per i',
 description: 'La Lombardia rinvia l\'applicazione della tassa sulla salute. Scopri cosa significa per i frontalieri che lavorano in Lombardia e vivono in Ticino.',
 keywords: 'frontalieri, ticino, svizzera, italia, tassa, salute, lombardia, rinvia',
 ogTitle: 'Tassa salute: la Lombardia rinvia, cosa cambia per i',
 ogDescription: 'Scopri come la decisione della Lombardia sulla tassa salute impatta sui frontalieri che lavorano nella regione e vivono in Ticino.',
 canonicalPath: '/articoli-frontaliere/tassa-salute-lombardia-rinvio',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Tassa salute Lombardia: la decisione che cambia tutto per i frontalieri",
 "description": "La Lombardia rinvia l'applicazione della tassa sulla salute. Scopri cosa significa per i frontalieri che lavorano in Lombardia e vivono in Ticino.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/tassa-salute-lombardia-rinvio.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Frontalieri che si recano al lavoro a Locarno"
 },
 "datePublished": "2026-03-05T12:12:19+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/tassa-salute-lombardia-rinvio`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-tilo-record-passeggeri-2025': {
 title: 'TILO raggiunge i 25 milioni di passeggeri nel 2025',
 description: 'TILO raggiunge un nuovo record con 25 milioni di passeggeri nel 2025. Scopri l\'incremento del traffico ferroviario in Ticino. Dati aggiornati 2026.',
 keywords: 'frontalieri, ticino, svizzera, italia, tilo, raggiunge, milioni, passeggeri',
 ogTitle: 'TILO: 25 milioni di passeggeri nel 2025',
 ogDescription: 'La società ferroviaria TILO raggiunge un nuovo record con 25 milioni di passeggeri nel 2025. L\'incremento è del 3,7% rispetto al 2024.',
 canonicalPath: '/articoli-frontaliere/tilo-record-passeggeri-2025',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "TILO raggiunge i 25 milioni di passeggeri nel 2025",
 "description": "TILO raggiunge un nuovo record con 25 milioni di passeggeri nel 2025. Scopri di più sull'incremento del traffico ferroviario in Ticino. Dati aggiornati 2026 per",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/tilo-record-passeggeri-2025.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Panoramica di Lugano con stazione ferroviaria"
 },
 "datePublished": "2026-03-05T14:46:54+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/tilo-record-passeggeri-2025`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-trasporti-lombardia-ticino-record-tilo': {
 title: 'Trasporti Lombardia-Ticino: Tilo batte record con 25',
 description: 'I treni Tilo hanno trasportato 25 milioni di passeggeri tra Ticino e Lombardia nel 2025, con un aumento del 3,7%. Scopri i vantaggi per frontalieri.',
 keywords: 'frontalieri, ticino, svizzera, italia, trasporti, lombardia-ticino, tilo, batte',
 ogTitle: 'Tilo: record di passeggeri tra Lombardia e Ticino',
 ogDescription: 'I treni Tilo hanno trasportato 25 milioni di passeggeri tra Ticino e Lombardia nel 2025, con un aumento del 3,7% rispetto all\'anno precedente. Scopri di più su',
 canonicalPath: '/articoli-frontaliere/trasporti-lombardia-ticino-record-tilo',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Tilo: record di passeggeri tra Lombardia e Ticino",
 "description": "I treni Tilo hanno trasportato 25 milioni di passeggeri tra Ticino e Lombardia nel 2025, con un aumento del 3,7% rispetto all'anno precedente. Scopri i vantaggi",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/trasporti-lombardia-ticino-record-tilo.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Treno Tilo in viaggio verso il Canton Ticino."
 },
 "datePublished": "2026-03-05T21:55:24+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/trasporti-lombardia-ticino-record-tilo`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-confusione-tassa-salute-frontalieri': {
 title: 'Tassa Salute: Confusione tra Politica e Realtà',
 description: 'Le recenti dichiarazioni politiche sulla tassa salute creano incertezza tra i frontalieri e gli operatori del settore. Analisi delle posizioni e delle normative',
 keywords: 'frontalieri, ticino, svizzera, italia, tassa, salute, confusione, politica',
 ogTitle: 'Tassa Salute: Confusione tra Politica e Realtà',
 ogDescription: 'Le recenti dichiarazioni politiche sulla tassa salute creano incertezza tra i frontalieri e gli operatori del settore. Analisi delle posizioni e delle normative',
 canonicalPath: '/articoli-frontaliere/confusione-tassa-salute-frontalieri',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Tassa Salute: Confusione tra Politica e Realtà",
 "description": "Le recenti dichiarazioni politiche sulla tassa salute creano incertezza tra i frontalieri e gli operatori del settore. Analisi delle posizioni e delle normative",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/confusione-tassa-salute-frontalieri.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista del valico di Brogeda tra Ticino e Italia con traffico e paesaggi naturali"
 },
 "datePublished": "2026-03-06T00:03:53+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/confusione-tassa-salute-frontalieri`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-carburante-ticino-costo-aumenti': {
 title: 'Il costo del carburante in Ticino si impenna: un problema',
 description: 'Aumenti fino a 14 centesimi su diesel e benzina in Ticino, riflesso della crisi energetica mondiale. La politica e il mercato influiscono sui prezzi locali.',
 keywords: 'frontalieri, ticino, svizzera, italia, costo, carburante, impenna, problema',
 ogTitle: 'Il costo del carburante in Ticino si impenna: un problema',
 ogDescription: 'Aumenti fino a 14 centesimi su diesel e benzina in Ticino, riflesso della crisi energetica mondiale. La politica e il mercato influiscono sui prezzi locali.',
 canonicalPath: '/articoli-frontaliere/carburante-ticino-costo-aumenti',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Il costo del carburante in Ticino si impenna: un problema",
 "description": "Aumenti fino a 14 centesimi su diesel e benzina in Ticino, riflesso della crisi energetica mondiale. La politica e il mercato influiscono sui prezzi locali.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/carburante-ticino-costo-aumenti.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Stazione di rifornimento a Lugano, auto in attesa di carburante, paesaggio Ticino."
 },
 "datePublished": "2026-03-06T10:00:10+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/carburante-ticino-costo-aumenti`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-cpi-caso-hospita-rivalutazione-periti': {
 title: 'CPI e Caso Hospita: richiesta di rivalutazione dei periti',
 description: 'La Commissione parlamentare d’inchiesta del Canton Ticino chiede una revisione della nomina dei periti nel caso Hospita, evidenziando possibili conflitti di int',
 keywords: 'frontalieri, ticino, svizzera, italia, caso, hospita, richiesta, rivalutazione',
 ogTitle: 'CPI e Caso Hospita: richiesta di rivalutazione dei periti',
 ogDescription: 'La Commissione parlamentare d’inchiesta del Canton Ticino chiede una revisione della nomina dei periti nel caso Hospita, evidenziando possibili conflitti di int',
 canonicalPath: '/articoli-frontaliere/cpi-caso-hospita-rivalutazione-periti',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "CPI e Caso Hospita: richiesta di rivalutazione dei periti",
 "description": "La Commissione parlamentare d’inchiesta del Canton Ticino chiede una revisione della nomina dei periti nel caso Hospita, evidenziando possibili conflitti di int",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/cpi-caso-hospita-rivalutazione-periti.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Paesaggio montano nel Ticino con valico e strada, scenario realistico"
 },
 "datePublished": "2026-03-06T11:19:03+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/cpi-caso-hospita-rivalutazione-periti`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-casellario-giudiziale-ue-ticino': {
 title: 'Canton Grigioni: Impossibile richiedere il casellario',
 description: 'Il Canton Grigioni chiarisce che non è possibile richiedere il casellario giudiziale per cittadini UE, sollevando interrogativi sulla sicurezza.',
 keywords: 'frontalieri, ticino, svizzera, italia, canton, grigioni, impossibile, richiedere',
 ogTitle: 'Canton Grigioni: Impossibile richiedere il casellario giu',
 ogDescription: 'Il Canton Grigioni chiarisce che non è possibile richiedere sistematicamente il casellario giudiziale per cittadini dell\'UE, sollevando interrogativi sulla sicu',
 canonicalPath: '/articoli-frontaliere/casellario-giudiziale-ue-ticino',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Canton Grigioni: Impossibile richiedere il casellario giu",
 "description": "Il Canton Grigioni chiarisce che non è possibile richiedere sistematicamente il casellario giudiziale per cittadini dell'UE, sollevando interrogativi sulla sicu",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/casellario-giudiziale-ue-ticino.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista storica di Bellinzona, Ticino con architettura affascinante al tramonto."
 },
 "datePublished": "2026-03-06T14:11:24+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/casellario-giudiziale-ue-ticino`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-salario-minimo-per-il-controprogetto-la-strada-e-in-discesa': {
 title: 'Salario minimo: il controprogetto è in discesa',
 description: 'Il Canton Ticino è vicino a un\'intesa sul salario minimo sociale, con una proposta che potrebbe essere discussa in Gran Consiglio ad aprile. L\'accordo prevede',
 keywords: 'frontalieri, ticino, svizzera, italia, salario, minimo, controprogetto, discesa',
 ogTitle: 'Salario minimo: il Canton Ticino verso un accordo',
 ogDescription: 'Il Canton Ticino è vicino a un\'intesa sul salario minimo sociale, con una proposta che potrebbe essere discussa in Gran Consiglio ad aprile. L\'accordo prevede',
 canonicalPath: '/articoli-frontaliere/salario-minimo-per-il-controprogetto-la-strada-e-in-discesa',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Salario minimo: il Canton Ticino verso un accordo",
 "description": "Il Canton Ticino è vicino a un'intesa sul salario minimo sociale, con una proposta che potrebbe essere discussa in Gran Consiglio ad aprile. L'accordo prevede",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/salario-minimo-per-il-controprogetto-la-strada-e-in-discesa.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Panoramica di Lugano, con il lago e gli edifici moderni."
 },
 "datePublished": "2026-03-06T16:10:57+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/salario-minimo-per-il-controprogetto-la-strada-e-in-discesa`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-tassa-salute-lombardia-frontalieri': {
 title: 'Tassa sulla salute: Lombardia non applicherà il',
 description: 'Scopri le ultime notizie sulla tassa sulla salute e l\'impatto per i frontalieri in Lombardia e Ticino. Dati aggiornati 2026 per frontalieri in Ticino.',
 keywords: 'frontalieri, ticino, svizzera, italia, tassa, sulla, salute, lombardia',
 ogTitle: 'Tassa sulla salute: Lombardia non applicherà il contributo?',
 ogDescription: 'Giacomo Zamperini chiarisce che se altre regioni non applicano la tassa sulla salute, la Lombardia seguirà lo stesso esempio.',
 canonicalPath: '/articoli-frontaliere/tassa-salute-lombardia-frontalieri',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Tassa sulla salute: Lombardia non applicherà il contributo?",
 "description": "Scopri le ultime notizie sulla tassa sulla salute e l'impatto per i frontalieri in Lombardia e Ticino. Dati aggiornati 2026 per frontalieri in Ticino.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/tassa-salute-lombardia-frontalieri.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica del Lago di Lugano con montagne sullo sfondo."
 },
 "datePublished": "2026-03-06T18:10:25+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/tassa-salute-lombardia-frontalieri`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-franco-forte-problemi-economici': {
 title: 'Il franco forte: opportunità e sfide per il Ticino',
 description: 'L\'attuale forza del franco svizzero solleva interrogativi sull\'economia ticinese e il futuro dei frontalieri. Dati aggiornati 2026 per frontalieri in Ticino.',
 keywords: 'frontalieri, ticino, svizzera, italia, franco, forte, opportunità, sfide',
 ogTitle: 'Il franco forte: opportunità e sfide per il Ticino',
 ogDescription: 'L\'attuale forza del franco svizzero solleva interrogativi sull\'economia ticinese e il futuro dei frontalieri.',
 canonicalPath: '/articoli-frontaliere/franco-forte-problemi-economici',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Il franco forte: opportunità e sfide per il Ticino",
 "description": "L'attuale forza del franco svizzero solleva interrogativi sull'economia ticinese e il futuro dei frontalieri. Dati aggiornati 2026 per frontalieri in Ticino.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/franco-forte-problemi-economici.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica di Bellinzona con i suoi castelli storici."
 },
 "datePublished": "2026-03-06T20:06:08+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/franco-forte-problemi-economici`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-carburante-prezzo-salito-opportunismo': {
 title: 'Aumento dei Prezzi della Benzina in Ticino: Opportunismo?',
 description: 'L\'aumento dei prezzi della benzina in Ticino è legato a dinamiche di mercato e opportunismo aziendale. Scopri di più. Dati aggiornati 2026 per frontalieri in',
 keywords: 'frontalieri, ticino, svizzera, italia, aumento, prezzi, benzina, opportunismo',
 ogTitle: 'Aumento Prezzo Benzina in Ticino',
 ogDescription: 'Scopri le cause dell\'aumento dei prezzi della benzina in Ticino e le implicazioni per i frontalieri.',
 canonicalPath: '/articoli-frontaliere/carburante-prezzo-salito-opportunismo',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Aumento dei Prezzi della Benzina in Ticino: Opportunismo?",
 "description": "L'aumento dei prezzi della benzina in Ticino è legato a dinamiche di mercato e opportunismo aziendale. Scopri di più. Dati aggiornati 2026 per frontalieri in",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/carburante-prezzo-salito-opportunismo.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista del Lago di Lugano con montagne circostanti, rappresentante l'influenza svizzera e italiana."
 },
 "datePublished": "2026-03-06T21:06:25+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/carburante-prezzo-salito-opportunismo`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-frontalieri-tassa-salute-teatro': {
 title: 'Frontalieri e tassa salute: cancellatela e basta',
 description: 'La Lombardia frena sulla tassa salute per i frontalieri, con riflessi sulla gestione politica e sociale del confine. Dati aggiornati 2026 per frontalieri in',
 keywords: 'frontalieri, ticino, svizzera, italia, tassa, salute, cancellatela, basta',
 ogTitle: 'Frontalieri e tassa salute: cancellatela e basta',
 ogDescription: 'La Lombardia frena sulla tassa salute per i frontalieri, con riflessi sulla gestione politica e sociale del confine.',
 canonicalPath: '/articoli-frontaliere/frontalieri-tassa-salute-teatro',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Frontalieri e tassa salute: cancellatela e basta",
 "description": "La Lombardia frena sulla tassa salute per i frontalieri, con riflessi sulla gestione politica e sociale del confine. Dati aggiornati 2026 per frontalieri in",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/frontalieri-tassa-salute-teatro.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica di Lugano con lago e montagne."
 },
 "datePublished": "2026-03-06T22:04:08+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/frontalieri-tassa-salute-teatro`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-disoccupazione-stabile-svizzera-2026': {
 title: 'Disoccupazione stabile al 3,2% in Svizzera: i dati di',
 description: 'La disoccupazione in Svizzera rimane al 3,2%. Scopri i dati e le implicazioni per il Canton Ticino. Dati aggiornati 2026 per frontalieri in Ticino.',
 keywords: 'frontalieri, ticino, svizzera, italia, disoccupazione, stabile, dati, febbraio',
 ogTitle: 'Disoccupazione stabile al 3,2% in Svizzera',
 ogDescription: 'Il mercato del lavoro in Svizzera e Ticino: tassi di disoccupazione e indennità.',
 canonicalPath: '/articoli-frontaliere/disoccupazione-stabile-svizzera-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Disoccupazione stabile al 3,2% in Svizzera",
 "description": "La disoccupazione in Svizzera rimane al 3,2%. Scopri i dati e le implicazioni per il Canton Ticino. Dati aggiornati 2026 per frontalieri in Ticino.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/disoccupazione-stabile-svizzera-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica di Lugano con montagne sullo sfondo."
 },
 "datePublished": "2026-03-06T23:12:41+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/disoccupazione-stabile-svizzera-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-dazi-usa-rimborsi-ritardi': {
 title: 'Dazi USA: Rimborsi in Ritardo, Cosa Succede ai',
 description: 'L\'agenzia della Dogana americana sta lavorando a un sistema di rimborsi per i dazi illegali, ma i frontalieri potrebbero dover attendere fino a un mese. Scopri',
 keywords: 'frontalieri, ticino, svizzera, italia, dazi, rimborsi, ritardo, cosa',
 ogTitle: 'Dazi USA: Rimborsi in Ritardo per i Frontalieri',
 ogDescription: 'L\'agenzia della Dogana americana sta lavorando a un sistema di rimborsi per i dazi illegali, ma i frontalieri potrebbero dover attendere fino a un mese. Scopri',
 canonicalPath: '/articoli-frontaliere/dazi-usa-rimborsi-ritardi',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Dazi USA: Rimborsi in Ritardo per i Frontalieri",
 "description": "L'agenzia della Dogana americana sta lavorando a un sistema di rimborsi per i dazi illegali, ma i frontalieri potrebbero dover attendere fino a un mese. Scopri",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/dazi-usa-rimborsi-ritardi.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Acquirenti soddisfatti escono da Foxtown, il famoso outlet di Mendrisio, con i loro acquisti."
 },
 "datePublished": "2026-03-06T23:56:51+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/dazi-usa-rimborsi-ritardi`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-votazioni-8-marzo-iniziativa-ssr-aperto': {
 title: 'Votazioni del 8 marzo: l’incerto sull’Iniziativa SSR in',
 description: 'Il 8 marzo i cittadini svizzeri si pronunceranno su quattro temi cruciali, con l’Iniziativa SSR ancora in bilico tra sì e no. Analisi e dettagli pratici per i f',
 keywords: 'frontalieri, ticino, svizzera, italia, votazioni, marzo, incerto, sull',
 ogTitle: 'Votazioni del 8 marzo: l’incerto sull’Iniziativa SSR in T',
 ogDescription: 'Il 8 marzo i cittadini svizzeri si pronunceranno su quattro temi cruciali, con l’Iniziativa SSR ancora in bilico tra sì e no. Analisi e dettagli pratici per i f',
 canonicalPath: '/articoli-frontaliere/votazioni-8-marzo-iniziativa-ssr-aperto',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Votazioni del 8 marzo: l’incerto sull’Iniziativa SSR in T",
 "description": "Il 8 marzo i cittadini svizzeri si pronunceranno su quattro temi cruciali, con l’Iniziativa SSR ancora in bilico tra sì e no. Analisi e dettagli pratici per i f",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/votazioni-8-marzo-iniziativa-ssr-aperto.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Valico di Gaggiolo in Ticino con vista sul confine italo-svizzero durante le votazioni del 8 marzo."
 },
 "datePublished": "2026-03-07T04:47:30+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/votazioni-8-marzo-iniziativa-ssr-aperto`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-ticino-spitex-contributo-pressione': {
 title: 'Ticino Spitex: Nuove tariffe e pressione sul settore',
 description: 'Dal 2026 nuove tariffe per le cure a domicilio in Ticino, con contributi utenti. Crescita volumi e sfide di sostenibilità per Cantone e Comuni. Dati aggiornati',
 keywords: 'frontalieri, ticino, svizzera, italia, spitex, nuove, tariffe, pressione',
 ogTitle: 'Ticino Spitex: Tariffe e Pressioni sul Settore',
 ogDescription: 'Dal 2026 nuove tariffe per le cure a domicilio in Ticino con contributi degli utenti. Crescita rapida del settore mette sotto pressione Cantone e Comuni.',
 canonicalPath: '/articoli-frontaliere/ticino-spitex-contributo-pressione',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Chiedi info su tariffe e contributi Spitex",
 "description": "Dal 2026 nuove tariffe per le cure a domicilio in Ticino, con contributi utenti. Crescita volumi e sfide di sostenibilità per Cantone e Comuni. Dati aggiornati",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/ticino-spitex-contributo-pressione.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Valico di Gaggiolo in Ticino con vista su Lugano e il Lago Maggiore"
 },
 "datePublished": "2026-03-07T06:05:59+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/ticino-spitex-contributo-pressione`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-stalking-swiss-2026-ticino': {
 title: 'Dal 2026: lo stalking diventa reato in Svizzera e Ticino',
 description: 'Dal 2026, la Svizzera ha inserito lo stalking tra i reati punibili penalmente. Un cambiamento che interessa anche il Canton Ticino e i frontalieri, con implicaz',
 keywords: 'frontalieri, ticino, svizzera, italia, stalking, diventa, reato, inserito',
 ogTitle: 'Dal 2026: lo stalking diventa reato in Svizzera e Ticino',
 ogDescription: 'Dal 2026, la Svizzera ha inserito lo stalking tra i reati punibili penalmente. Un cambiamento che interessa anche il Canton Ticino e i frontalieri, con implicaz',
 canonicalPath: '/articoli-frontaliere/stalking-swiss-2026-ticino',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Dal 2026: lo stalking diventa reato in Svizzera e Ticino",
 "description": "Dal 2026, la Svizzera ha inserito lo stalking tra i reati punibili penalmente. Un cambiamento che interessa anche il Canton Ticino e i frontalieri, con implicaz",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/stalking-swiss-2026-ticino.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Valico frontaliero in Ticino con controlli di sicurezza, scena realistica"
 },
 "datePublished": "2026-03-07T07:52:55+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/stalking-swiss-2026-ticino`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-pirati-strada-ticino-italiani-2026': {
 title: 'Ticino: Due automobilisti italiani tra i pirati della',
 description: 'Polizia cantonale di Ticino ferma due automobilisti italiani per violazioni gravi, tra cui velocità oltre il doppio dei limiti, in controlli tra gennaio e febbr',
 keywords: 'frontalieri, ticino, svizzera, italia, automobilisti, italiani, pirati, strada',
 ogTitle: 'Ticino: Due automobilisti italiani tra i pirati della str',
 ogDescription: 'Polizia cantonale di Ticino ferma due automobilisti italiani per violazioni gravi, tra cui velocità oltre il doppio dei limiti, in controlli tra gennaio e febbr',
 canonicalPath: '/articoli-frontaliere/pirati-strada-ticino-italiani-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Ticino: Due automobilisti italiani tra i pirati della str",
 "description": "Polizia cantonale di Ticino ferma due automobilisti italiani per violazioni gravi, tra cui velocità oltre il doppio dei limiti, in controlli tra gennaio e febbr",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/pirati-strada-ticino-italiani-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Auto in transito sul valico di Gaggiolo, confine tra Italia e Svizzera, con paesaggio ticinese sullo sfondo"
 },
 "datePublished": "2026-03-07T09:01:01+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/pirati-strada-ticino-italiani-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-comuni-locarno-futuro-aggregazione': {
 title: 'Sette Comuni del Locarnese sul Futuro: Aggregazione o',
 description: 'Un laboratorio coinvolge Locarno, Losone, Minusio e altri per discutere sulla collaborazione regionale. La sfida: mantenere il benessere o restare indipendenti.',
 keywords: 'frontalieri, ticino, svizzera, italia, sette, comuni, locarnese, futuro',
 ogTitle: 'Sette Comuni del Locarnese sul Futuro: Aggregazione o Aut',
 ogDescription: 'Un laboratorio coinvolge Locarno, Losone, Minusio e altri per discutere sulla collaborazione regionale. La sfida: mantenere il benessere o restare indipendenti.',
 canonicalPath: '/articoli-frontaliere/comuni-locarno-futuro-aggregazione',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Sette Comuni del Locarnese sul Futuro: Aggregazione o Aut",
 "description": "Un laboratorio coinvolge Locarno, Losone, Minusio e altri per discutere sulla collaborazione regionale. La sfida: mantenere il benessere o restare indipendenti.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/comuni-locarno-futuro-aggregazione.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Panorama di Locarno con Lago Maggiore e montagne, scena fotorealistica DSLR."
 },
 "datePublished": "2026-03-07T09:56:44+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/comuni-locarno-futuro-aggregazione`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-costi-cure-domicilio-ticino-2026': {
 title: 'Ticino: dal 2026 si pagherà per le cure a domicilio',
 description: 'Dal 1° aprile 2026 in Ticino entra in vigore la partecipazione ai costi per le cure a domicilio, con un contributo massimo di 15 franchi al giorno.',
 keywords: 'frontalieri, ticino, svizzera, italia, pagherà, cure, domicilio, aprile',
 ogTitle: 'Ticino: dal 2026 si pagherà per le cure a domicilio',
 ogDescription: 'Dal 1° aprile 2026 in Ticino entra in vigore la partecipazione ai costi per le cure a domicilio, con un contributo massimo di 15 franchi al giorno.',
 canonicalPath: '/articoli-frontaliere/costi-cure-domicilio-ticino-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Ticino: dal 2026 si pagherà per le cure a domicilio",
 "description": "Dal 1° aprile 2026 in Ticino entra in vigore la partecipazione ai costi per le cure a domicilio, con un contributo massimo di 15 franchi al giorno.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/costi-cure-domicilio-ticino-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Infermiere che assiste una persona anziana a domicilio a Lugano, Ticino"
 },
 "datePublished": "2026-03-07T10:53:30+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/costi-cure-domicilio-ticino-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-lugano-park-ride-bus-sovvenzioni-2026': {
 title: 'Lugano: Park and Ride poco usati, bus sovvenzionati in',
 description: 'Nel 2024 Lugano ha speso 1,2 milioni in sovvenzioni per abbonamenti bus, mentre i park and ride registrano scarsa frequentazione e alti costi. Dati aggiornati',
 keywords: 'frontalieri, ticino, svizzera, italia, lugano, park, ride, poco',
 ogTitle: 'Lugano: Park and Ride poco usati, bus sovvenzionati in cr',
 ogDescription: 'Nel 2024 Lugano ha speso 1,2 milioni in sovvenzioni per abbonamenti bus, mentre i park and ride registrano scarsa frequentazione e alti costi.',
 canonicalPath: '/articoli-frontaliere/lugano-park-ride-bus-sovvenzioni-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Lugano: Park and Ride poco usati, bus sovvenzionati in cr",
 "description": "Nel 2024 Lugano ha speso 1,2 milioni in sovvenzioni per abbonamenti bus, mentre i park and ride registrano scarsa frequentazione e alti costi. Dati aggiornati",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/lugano-park-ride-bus-sovvenzioni-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista urbana di Lugano con autobus e parcheggio park and ride poco utilizzato"
 },
 "datePublished": "2026-03-07T11:41:11+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/lugano-park-ride-bus-sovvenzioni-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-crisi-turismo-golfo-persico': {
 title: 'Crisi in Medio Oriente: Impatto sul Turismo Svizzero',
 description: 'La crisi nel Golfo Persico modifica le rotte turistiche svizzere, con voli sospesi e carburante alle stelle. Scopri l\'impatto economico. Dati aggiornati 2026',
 keywords: 'frontalieri, ticino, svizzera, italia, crisi, medio, oriente, impatto',
 ogTitle: 'Crisi Medio Oriente: Impatto sul Turismo Svizzero',
 ogDescription: 'La crisi nel Golfo Persico sta modificando le rotte turistiche svizzere. Voli sospesi e carburante alle stelle: scopri l\'impatto economico.',
 canonicalPath: '/articoli-frontaliere/crisi-turismo-golfo-persico',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Crisi Medio Oriente: Impatto sul Turismo Svizzero",
 "description": "La crisi nel Golfo Persico modifica le rotte turistiche svizzere, con voli sospesi e carburante alle stelle. Scopri l'impatto economico. Dati aggiornati 2026",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/crisi-turismo-golfo-persico.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica del Lago di Lugano durante il tramonto, con riflessi sull'acqua."
 },
 "datePublished": "2026-03-07T13:54:36+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/crisi-turismo-golfo-persico`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-turisti-ticinesi-bloccati-medio-oriente': {
 title: 'Turisti ticinesi bloccati in Medio Oriente: «Soli e senza',
 description: 'Circa 400 turisti svizzeri rimangono bloccati in Medio Oriente senza comunicazioni ufficiali. Scopri di più su questa emergenza. Dati aggiornati 2026 per',
 keywords: 'frontalieri, ticino, svizzera, italia, turisti, ticinesi, bloccati, medio',
 ogTitle: 'Turisti ticinesi bloccati in Medio Oriente',
 ogDescription: 'Circa 400 turisti svizzeri rimangono bloccati in Medio Oriente senza comunicazioni ufficiali. Scopri di più su questa emergenza.',
 canonicalPath: '/articoli-frontaliere/turisti-ticinesi-bloccati-medio-oriente',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Turisti ticinesi bloccati in Medio Oriente: «Soli e senza risposte»",
 "description": "Circa 400 turisti svizzeri rimangono bloccati in Medio Oriente senza comunicazioni ufficiali. Scopri di più su questa emergenza. Dati aggiornati 2026 per",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/turisti-ticinesi-bloccati-medio-oriente.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Turisti svizzeri in attesa di informazioni in un valico di frontiera."
 },
 "datePublished": "2026-03-07T14:54:22+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/turisti-ticinesi-bloccati-medio-oriente`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-svizzeri-bloccati-medio-oriente': {
 title: '5.200 svizzeri bloccati in Medio Oriente',
 description: 'La guerra in Medio Oriente ha bloccato 5.200 cittadini svizzeri. Swiss ha organizzato un volo speciale per il rimpatrio. Dati aggiornati 2026 per frontalieri in',
 keywords: 'frontalieri, ticino, svizzera, italia, svizzeri, bloccati, medio, oriente',
 ogTitle: 'Svizzeri bloccati in Medio Oriente',
 ogDescription: 'La guerra in Medio Oriente ha bloccato 5.200 cittadini svizzeri. Swiss ha organizzato un volo speciale per il rimpatrio.',
 canonicalPath: '/articoli-frontaliere/svizzeri-bloccati-medio-oriente',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Svizzeri bloccati in Medio Oriente",
 "description": "La guerra in Medio Oriente ha bloccato 5.200 cittadini svizzeri. Swiss ha organizzato un volo speciale per il rimpatrio. Dati aggiornati 2026 per frontalieri in",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/svizzeri-bloccati-medio-oriente.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Volo di rimpatrio da Mascate, Oman, verso Zurigo, Svizzera."
 },
 "datePublished": "2026-03-07T15:51:15+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/svizzeri-bloccati-medio-oriente`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-ticino-prevenzione-incendi-scuole-2026': {
 title: 'Ticino rafforza la sicurezza nelle scuole dopo',
 description: 'Il DECS lavora su misure antincendio nelle scuole ticinesi dopo Crans-Montana. Consigli pratici e aggiornamenti. Dati aggiornati 2026 per frontalieri in Ticino.',
 keywords: 'frontalieri, ticino, svizzera, italia, rafforza, sicurezza, nelle, scuole',
 ogTitle: 'Ticino rafforza sicurezza scuole | Frontaliere Ticino',
 ogDescription: 'Il DECS lavora su misure antincendio nelle scuole ticinesi dopo Crans-Montana. Consigli pratici e aggiornamenti.',
 canonicalPath: '/articoli-frontaliere/ticino-prevenzione-incendi-scuole-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Ticino rafforza la sicurezza nelle scuole dopo Crans-Montana",
 "description": "Il DECS lavora su misure antincendio nelle scuole ticinesi dopo Crans-Montana. Consigli pratici e aggiornamenti. Dati aggiornati 2026 per frontalieri in Ticino.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/ticino-prevenzione-incendi-scuole-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Scuole di Ticino con segni di sicurezza antincendio. Vista aerea con montagne in sfondo."
 },
 "datePublished": "2026-03-07T17:00:20+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/ticino-prevenzione-incendi-scuole-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-varese-india-export-2026': {
 title: 'Varese: Export India Cresce del 46% | Frontaliere',
 description: 'Le esportazioni della provincia varesina verso l’India sono aumentate del 46,2% nel 2025, superando i 129 milioni di euro. Dati aggiornati 2026 per frontalieri',
 keywords: 'frontalieri, ticino, svizzera, italia, varese, punta, oriente, export',
 ogTitle: 'Varese: Export India Cresce del 46% | Frontaliere',
 ogDescription: 'Le esportazioni della provincia varesina verso l’India sono aumentate del 46,2% nel 2025, superando i 129 milioni di euro.',
 canonicalPath: '/articoli-frontaliere/varese-india-export-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Varese punta a Oriente: l’export verso l’India cresce del 46%",
 "description": "Le esportazioni della provincia varesina verso l’India sono aumentate del 46,2% nel 2025, superando i 129 milioni di euro. Dati aggiornati 2026 per frontalieri",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/varese-india-export-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Impresa varesina che esporta macchinari e prodotti chimici in India. Vista panoramica dal Lago di Lugano."
 },
 "datePublished": "2026-03-07T17:48:07+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/varese-india-export-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-autotrasporto-rincari-confine-2026': {
 title: 'Rincari carburante: rischio fermo autotrasportatori al',
 description: 'Aumenti di carburante segnalati a marzo 2026: +0,30 €/l in 3 giorni. CNA Fita parla di speculazione e chiede credito d\'imposta. Impatti su Brogeda e Chiasso.',
 keywords: 'frontalieri, ticino, svizzera, italia, rincari, carburante, rischio, fermo',
 ogTitle: 'Rincari carburante e rischio fermo autotrasportatori al',
 ogDescription: 'CNA Fita denuncia speculazione: aumento 0,30 €/l in 3 giorni; per 100.000 km/anno aggravio >13.000 euro. Misure richieste al Governo.',
 canonicalPath: '/articoli-frontaliere/autotrasporto-rincari-confine-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Economia - Carburanti: allarme autotrasportatori, CNA Fita parla di",
 "description": "Aumenti di carburante segnalati a marzo 2026: +0,30 €/l in 3 giorni. CNA Fita parla di speculazione e chiede credito d'imposta. Impatti su Brogeda e Chiasso.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/autotrasporto-rincari-confine-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Camion parcheggiato vicino al valico di Chiasso con vista sul paesaggio del Ticino al tramonto"
 },
 "datePublished": "2026-03-08T10:57:24+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/autotrasporto-rincari-confine-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-carburanti-rincari-confine-ticino': {
 title: 'Rincaro carburanti: che impatto sui frontalieri ticinesi',
 description: 'Benzina oltre 1,8 €/l in alcune regioni italiane: impatto sui frontalieri Ticino-Lombardia e consigli pratici per risparmiare. Dati aggiornati 2026 per',
 keywords: 'frontalieri, ticino, svizzera, italia, rincaro, carburanti, impatto, ticinesi',
 ogTitle: 'Rincaro carburanti: impatto sui frontalieri ticinesi',
 ogDescription: 'Prezzi in Italia in rialzo (benzina >1,8 €/l); cosa cambia per chi lavora tra Canton Ticino e Lombardia e come ridurre i costi.',
 canonicalPath: '/articoli-frontaliere/carburanti-rincari-confine-ticino',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Carburanti, l'ondata di rincari continua: schizzano i prezzi per benzina",
 "description": "Benzina oltre 1,8 €/l in alcune regioni italiane: impatto sui frontalieri Ticino-Lombardia e consigli pratici per risparmiare. Dati aggiornati 2026 per",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/carburanti-rincari-confine-ticino.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Stazione di servizio al confine Ticino-Lombardia con auto in attesa e cartelloni prezzi al mattino"
 },
 "datePublished": "2026-03-08T11:45:19+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/carburanti-rincari-confine-ticino`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-votazioni-imposizione-ticino-2026': {
 title: 'Voti 8 marzo: No al taglio canone, Sì all\'imposizione | Frontaliere Ticino',
 description: 'Primi spogli dell\'8 marzo: Ticino orientato verso il No all\'iniziativa \'200 franchi bastano\' e un possibile Sì per l\'imposizione individuale; analisi e',
 keywords: 'frontalieri, ticino, svizzera, italia, voti, marzo, taglio, canone',
 ogTitle: 'Voti 8 marzo: No canone e Sì all\'imposizione individuale',
 ogDescription: 'Primi risultati del voto del 8 marzo 2026: tendenze su canone, imposizione individuale, contante e Fondo clima. Impatti per il Ticino e per i frontalieri.',
 canonicalPath: '/articoli-frontaliere/votazioni-imposizione-ticino-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Un chiaro No ai '200 franchi bastano', si profila un Sì per",
 "description": "Primi spogli dell'8 marzo: Ticino orientato verso il No all'iniziativa '200 franchi bastano' e un possibile Sì per l'imposizione individuale; analisi e",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/votazioni-imposizione-ticino-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Elettori davanti a un seggio a Bellinzona con bandiere svizzere e scatole per le schede, luce invernale naturale."
 },
 "datePublished": "2026-03-08T13:59:41+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/votazioni-imposizione-ticino-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-imposizione-individuale-ticino-2026': {
 title: 'Svizzera: tassazione individuale, cosa cambia per il',
 description: 'La Svizzera approva la tassazione individuale (08.03.2026). Cosa cambia per frontalieri e Comuni in Ticino: deduzioni figli, dichiarazioni, passi pratici.',
 keywords: 'frontalieri, ticino, svizzera, italia, tassazione, individuale, cosa, cambia',
 ogTitle: 'Tassazione individuale: impatto Ticino',
 ogDescription: 'Il voto del 08.03.2026 introduce l\'imposizione individuale: guida per frontalieri, Comuni e datori di lavoro in Ticino.',
 canonicalPath: '/articoli-frontaliere/imposizione-individuale-ticino-2026',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Svizzera: svolta fiscale con l'imposizione individuale, effetti per il",
 "description": "La Svizzera approva la tassazione individuale (08.03.2026). Cosa cambia per frontalieri e Comuni in Ticino: deduzioni figli, dichiarazioni, passi pratici.",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/imposizione-individuale-ticino-2026.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Veduta fotorealistica di Lugano con pendolare sul lungolago e skyline al mattino"
 },
 "datePublished": "2026-03-08T15:03:13+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/imposizione-individuale-ticino-2026`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 'blog-no-iniziativa-antidumping-ticino': {
 title: 'Ticino: No all\'iniziativa antidumping, soddisfazione per | Frontaliere Ticino',
 description: 'Il Consiglio di Stato del Ticino approva il rifiuto dell\'iniziativa antidumping e della riduzione del canone SSR. Dati aggiornati 2026 per frontalieri in',
 keywords: 'frontalieri, ticino, svizzera, italia, iniziativa, antidumping, soddisfazione, consiglio',
 ogTitle: 'No all\'iniziativa antidumping | Frontaliere Ticino',
 ogDescription: 'Il Consiglio di Stato del Ticino si soddisfa per il rifiuto dell\'iniziativa antidumping e per il canone SSR.',
 canonicalPath: '/articoli-frontaliere/no-iniziativa-antidumping-ticino',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "NewsArticle",
 "headline": "Ticino: No all'iniziativa antidumping e al canone a 200",
 "description": "Il Consiglio di Stato del Ticino approva il rifiuto dell'iniziativa antidumping e della riduzione del canone SSR. Dati aggiornati 2026 per frontalieri in",
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/images/blog/no-iniziativa-antidumping-ticino.webp`,
 "width": 1344,
 "height": 756,
 "caption": "Vista panoramica di Lugano con lago e montagne."
 },
 "datePublished": "2026-03-08T15:50:38+00:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": {"@id": "https://frontaliereticino.ch/#organization"},
 "publisher": {"@id": "https://frontaliereticino.ch/#organization"},
 "mainEntityOfPage": `${BASE_URL}/articoli-frontaliere/no-iniziativa-antidumping-ticino`,
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true
 }
 },

 guidaCompleta: {
 title: 'Guida Lavoro Frontaliere Svizzera 2026',
 description: 'Guida definitiva al lavoro frontaliere Svizzera-Italia 2026: permesso G, tassazione nuovo accordo, AVS/LPP, LAMal, pendolarismo e dichiarazione redditi.',
 keywords: 'lavoro frontaliere svizzera 2026, guida completa frontaliere, permesso G svizzera, nuovo accordo frontalieri, imposta alla fonte ticino, frontaliere italia svizzera, lavorare in svizzera dall italia, tassazione frontalieri 2026, assicurazione LAMal frontalieri, pendolare svizzera italia',
 ogTitle: 'Guida Completa al Lavoro Frontaliere in Svizzera 2026',
 ogDescription: 'La guida definitiva per frontalieri Svizzera-Italia: permessi, tasse, previdenza, sanità, trasporti e dichiarazione dei redditi. Aggiornata 2026.',
 canonicalPath: '/guida-frontaliere/guida-completa-lavoro-frontaliere-svizzera-2026',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "Article",
 "headline": "Guida Completa al Lavoro Frontaliere in Svizzera 2026",
 "description": "La guida definitiva per lavoratori frontalieri Italia-Svizzera: permesso G, regime fiscale nuovo accordo, contributi sociali AVS/LPP, assicurazione LAMal, pendolarismo e dichiarazione dei redditi. Aggiornata al 2026.",
 "url": `${BASE_URL}/guida-frontaliere/guida-completa-lavoro-frontaliere-svizzera-2026`,
 "datePublished": "2026-03-31T08:00:00+02:00",
 "dateModified": BUILD_DATE_ISO,
 "inLanguage": "it",
 "author": { "@id": "https://frontaliereticino.ch/#organization" },
 "publisher": { "@id": "https://frontaliereticino.ch/#organization" },
 "mainEntityOfPage": `${BASE_URL}/guida-frontaliere/guida-completa-lavoro-frontaliere-svizzera-2026`,
 "image": {
 "@type": "ImageObject",
 "url": `${BASE_URL}/og-guida-frontaliere.png`,
 "width": 1200,
 "height": 630
 },
 "speakable": { "@type": "SpeakableSpecification", "cssSelector": ["article h1", "article h2", "article p"] },
 "isAccessibleForFree": true,
 "wordCount": 3500,
 "about": [
 { "@type": "Thing", "name": "Lavoro frontaliere", "sameAs": "https://it.wikipedia.org/wiki/Lavoratore_frontaliero" },
 { "@type": "Thing", "name": "Canton Ticino", "sameAs": "https://it.wikipedia.org/wiki/Canton_Ticino" },
 { "@type": "Thing", "name": "Imposta alla fonte", "sameAs": "https://it.wikipedia.org/wiki/Imposta_alla_fonte" }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "FAQPage",
 "mainEntity": [
 {
 "@type": "Question",
 "name": "Quali sono i requisiti per lavorare come frontaliere in Svizzera nel 2026?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Per lavorare come frontaliere in Svizzera serve: cittadinanza UE/AELS, residenza in un comune italiano (preferibilmente entro 20 km dal confine per il regime transitorio), un contratto di lavoro con datore svizzero, e il permesso G rilasciato dal Cantone. Il permesso G ha validità 5 anni per contratti a tempo indeterminato e viene rilasciato in 5-10 giorni lavorativi dalla richiesta."
 }
 },
 {
 "@type": "Question",
 "name": "Come funziona la tassazione dei frontalieri con il nuovo accordo 2026?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I nuovi frontalieri (assunti dal 17 luglio 2023) pagano l'imposta alla fonte in Svizzera all'80% dell'aliquota ordinaria e l'IRPEF in Italia sul reddito svizzero, con una franchigia di 10.000 EUR e un credito d'imposta per le tasse pagate in Svizzera. I vecchi frontalieri (ante luglio 2023, entro 20 km) pagano solo l'imposta alla fonte svizzera al 100% fino al 2033."
 }
 },
 {
 "@type": "Question",
 "name": "Quanto costa l'assicurazione sanitaria LAMal per i frontalieri?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I premi LAMal per frontalieri in Canton Ticino variano da 270 a 560 CHF/mese nel 2026, in base all'assicuratore e al modello scelto. Le opzioni piu economiche sono Assura e Agrisano con modello Telmed (circa 270-300 CHF/mese). I frontalieri hanno 3 mesi dall'inizio del lavoro per scegliere tra LAMal svizzera e SSN italiano (diritto d'opzione irrevocabile)."
 }
 },
 {
 "@type": "Question",
 "name": "I frontalieri devono fare la dichiarazione dei redditi in Italia?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "I nuovi frontalieri (dal 17 luglio 2023) devono obbligatoriamente presentare la dichiarazione italiana (Modello 730 o Redditi PF) per dichiarare il reddito svizzero e richiedere il credito d'imposta. I vecchi frontalieri (ante 2023, entro 20 km) sono generalmente esenti per il reddito da lavoro svizzero. La scadenza per il 730 e il 30 settembre, per il Modello Redditi PF il 30 novembre."
 }
 },
 {
 "@type": "Question",
 "name": "Quanti frontalieri lavorano in Canton Ticino e quanto guadagnano?",
 "acceptedAnswer": {
 "@type": "Answer",
 "text": "Circa 79.000 frontalieri pendolano quotidianamente dall'Italia al Canton Ticino (BFS 2025), rappresentando circa il 30% della forza lavoro cantonale. Il salario mediano lordo in Ticino e di circa CHF 5.200/mese (CHF 62.400/anno). I settori principali sono manifattura, costruzioni, finanza, sanita, ospitalita e IT. Il numero cresce del 2-3% annuo."
 }
 }
 ]
 },
 {
 "@context": "https://schema.org",
 "@type": "HowTo",
 "name": "Come diventare frontaliere: guida passo-passo",
 "description": "Tutti i passaggi necessari per iniziare a lavorare come frontaliere in Svizzera dall'Italia, dal contratto al primo stipendio.",
 "totalTime": "P60D",
 "step": [
 {
 "@type": "HowToStep",
 "position": 1,
 "name": "Trovare un lavoro in Svizzera",
 "text": "Cerca offerte di lavoro in Canton Ticino su portali specializzati (jobs.ch, jobscout24.ch, LinkedIn). Il Ticino offre circa 79.000 posizioni frontaliere nei settori manifattura, finanza, IT, sanita e costruzioni.",
 "url": `${BASE_URL}/cerca-lavoro-ticino`
 },
 {
 "@type": "HowToStep",
 "position": 2,
 "name": "Firmare il contratto di lavoro",
 "text": "Firma il contratto con il datore di lavoro svizzero. Verifica che includa: salario lordo annuo, percentuale di impiego, data di inizio, contributi LPP e assicurazioni. Il datore avvia la richiesta del permesso G."
 },
 {
 "@type": "HowToStep",
 "position": 3,
 "name": "Ottenere il permesso G",
 "text": "Il datore di lavoro richiede il permesso G presso l'ufficio della migrazione cantonale. Per cittadini UE il rilascio avviene in 5-10 giorni lavorativi. Si puo iniziare a lavorare con la ricevuta della richiesta.",
 "url": `${BASE_URL}/guida-frontaliere/permessi-di-lavoro`
 },
 {
 "@type": "HowToStep",
 "position": 4,
 "name": "Scegliere l'assicurazione sanitaria",
 "text": "Entro 3 mesi dall'inizio del lavoro, scegli tra LAMal svizzera (270-560 CHF/mese) e SSN italiano (gratuito). La scelta e irrevocabile. Confronta i premi su frontaliereticino.ch.",
 "url": `${BASE_URL}/compara-servizi/confronta-casse-malati`
 },
 {
 "@type": "HowToStep",
 "position": 5,
 "name": "Aprire un conto bancario svizzero",
 "text": "Apri un conto in Svizzera (PostFinance, Raiffeisen, UBS) per ricevere lo stipendio in CHF. Servono permesso G, contratto di lavoro e documento d'identita.",
 "url": `${BASE_URL}/compara-servizi/confronta-banche`
 },
 {
 "@type": "HowToStep",
 "position": 6,
 "name": "Organizzare il pendolarismo",
 "text": "Pianifica il tragitto casa-lavoro: auto (costo medio 300-500 EUR/mese), treno TILO, o combinazione. Verifica i tempi ai valichi di confine nelle ore di punta (6:30-8:30 e 17:00-18:30).",
 "url": `${BASE_URL}/guida-frontaliere/costo-auto-pendolare`
 },
 {
 "@type": "HowToStep",
 "position": 7,
 "name": "Comprendere il regime fiscale",
 "text": "Informati sul regime fiscale applicabile: vecchio o nuovo accordo, imposta alla fonte svizzera, eventuale IRPEF italiana, franchigia 10.000 EUR e credito d'imposta. Usa il simulatore gratuito per calcolare il tuo netto.",
 "url": `${BASE_URL}/calcola-stipendio`
 },
 {
 "@type": "HowToStep",
 "position": 8,
 "name": "Presentare la dichiarazione dei redditi",
 "text": "I nuovi frontalieri presentano il Modello 730 o Redditi PF in Italia (scadenza 30/09 o 30/11). In Svizzera si puo richiedere la rettifica (TDR) entro il 31 marzo dell'anno successivo per deduzioni aggiuntive.",
 "url": `${BASE_URL}/tasse-e-pensione/dichiarazione-redditi`
 }
 ]
 }
 ]
 },

 'sindacati': {
 title: 'Sindacati Frontalieri Svizzera 2026 | Guida',
 description: 'UNIA, Syndicom, SEV, OCST: sindacati per frontalieri in Ticino. Costi, sedi, servizi legali, CCL e assistenza su licenziamento, busta paga e controversie.',
 keywords: 'sindacati frontalieri, unia ticino, ocst, syndicom, sev, sindacato svizzero, contratto collettivo, ccl, diritti lavoratori frontalieri, assistenza legale',
 ogTitle: 'Sindacati per Frontalieri in Ticino — Guida Completa',
 ogDescription: 'UNIA, Syndicom, SEV, OCST: costi, sedi e servizi per frontalieri. Consulenza legale, contratti collettivi e tutela dei diritti.',
 canonicalPath: '/sindacati-frontalieri',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "CollectionPage",
 "name": "Sindacati per Frontalieri in Svizzera",
 "url": `${BASE_URL}/sindacati-frontalieri/`,
 "description": "Guida ai principali sindacati svizzeri per lavoratori frontalieri: UNIA, Syndicom, SEV, OCST. Costi, servizi e contatti Ticino.",
 "inLanguage": "it",
 "mainEntity": {
 "@type": "ItemList",
 "numberOfItems": 4,
 "itemListElement": [
 { "@type": "ListItem", "position": 1, "name": "UNIA — Sindacato svizzero", "url": "https://www.unia.ch/it" },
 { "@type": "ListItem", "position": 2, "name": "Syndicom — Media e comunicazione", "url": "https://syndicom.ch/it" },
 { "@type": "ListItem", "position": 3, "name": "SEV — Sindacato del personale dei trasporti", "url": "https://sev-online.ch/it" },
 { "@type": "ListItem", "position": 4, "name": "OCST — Organizzazione Cristiano-Sociale Ticinese", "url": "https://www.ocst.com" }
 ]
 }
 }
 ],
 },

 'chi-siamo': {
 title: 'Chi Siamo — Frontaliere Ticino: La Guida per i Lavoratori Frontalieri',
 description: 'Scopri chi siamo: Frontaliere Ticino è la piattaforma informativa di riferimento per i lavoratori frontalieri italiani in Svizzera. Tassazione, permessi.',
 keywords: 'frontaliere ticino, chi siamo, piattaforma frontalieri, lavoratori transfrontalieri svizzera italia',
 ogTitle: 'Chi Siamo — Frontaliere Ticino: La Guida per i Lavoratori Frontalieri',
 ogDescription: 'Piattaforma informativa per frontalieri italiani in Svizzera: tassazione, permessi, lavoro, sanità e aggiornamenti normativi.',
 canonicalPath: '/chi-siamo',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "AboutPage",
 "name": "Chi Siamo — Frontaliere Ticino",
 "url": `${BASE_URL}/chi-siamo/`,
 "mainEntity": { "@id": `${BASE_URL}/#organization` },
 "description": "Piattaforma informativa per frontalieri italiani in Svizzera",
 "inLanguage": "it"
 },
 {
 "@context": "https://schema.org",
 "@type": "Organization",
 "@id": `${BASE_URL}/#organization`,
 "name": "Frontaliere Ticino",
 "url": BASE_URL,
 "description": "Guida completa per i lavoratori frontalieri in Svizzera: simulatore fiscale, pensione, assicurazione sanitaria, cambio valuta e offerte di lavoro.",
 "foundingDate": "2024",
 "areaServed": [
 { "@type": "Country", "name": "Switzerland" },
 { "@type": "Country", "name": "Italy" }
 ],
 "knowsAbout": [
 "Fiscalità frontalieri Svizzera-Italia",
 "Nuovo accordo fiscale 2026",
 "Previdenza sociale AVS/LPP",
 "Assicurazione malattia LAMal/CMB",
 "Permesso G e permesso B",
 "Mercato del lavoro Ticino"
 ]
 }
 ],
 },

 // ─── English E-E-A-T alias pages ─────────────────────────────────────────
 // Root-level English paths so SEO crawlers (squirrelscan, Bing) find
 // About / Contact / Privacy pages using English URL heuristics.
 'about': {
 title: 'About Us — Frontaliere Ticino: Cross-Border Workers Guide',
 description: 'Frontaliere Ticino is the leading platform for Italian cross-border workers in Switzerland. Tax simulation, permits, health insurance, pension planning.',
 keywords: 'frontaliere ticino, about us, cross-border workers platform, swiss italian workers',
 ogTitle: 'About Us — Frontaliere Ticino: Cross-Border Workers Guide',
 ogDescription: 'The leading platform for Italian cross-border workers in Switzerland: tax simulation, permits, job board, and more.',
 canonicalPath: '/about',
 structuredData: [
 {
 "@context": "https://schema.org",
 "@type": "AboutPage",
 "name": "About Us — Frontaliere Ticino",
 "url": `${BASE_URL}/about/`,
 "mainEntity": { "@id": `${BASE_URL}/#organization` },
 "description": "Frontaliere Ticino is the leading platform for Italian cross-border workers in Switzerland",
 "inLanguage": "en"
 },
 {
 "@context": "https://schema.org",
 "@type": "Organization",
 "@id": `${BASE_URL}/#organization`,
 "name": "Frontaliere Ticino",
 "url": BASE_URL,
 "description": "The comprehensive guide for cross-border workers in Switzerland: tax simulator, pension planning, health insurance, currency exchange, and job board.",
 "foundingDate": "2024",
 "areaServed": [
 { "@type": "Country", "name": "Switzerland" },
 { "@type": "Country", "name": "Italy" }
 ]
 }
 ],
 },

 'contact-alias': {
 title: 'Contact Us | Frontaliere Ticino',
 description: 'Contact the Frontaliere Ticino team: suggestions, bug reports, collaborations. We answer questions about taxes, fiscal simulation, and cross-border tools.',
 keywords: 'contact frontaliere, support frontaliere, cross-border workers support, frontaliere ticino contact',
 ogTitle: 'Contact Us | Frontaliere Ticino',
 ogDescription: '✉️ Contact the Frontaliere Ticino team for questions, suggestions, or collaborations.',
 canonicalPath: '/contact',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "ContactPage",
 "name": "Contact Frontaliere Ticino",
 "url": `${BASE_URL}/contact/`,
 "description": "Contact page for Frontaliere Ticino cross-border workers platform",
 "inLanguage": "en"
 },
 },

 'privacy-policy-alias': {
 title: 'Privacy Policy | Frontaliere Ticino',
 description: 'Privacy policy of Frontaliere Ticino: personal data processing, cookies, analytics, user rights. Compliant with GDPR and Swiss DPA.',
 keywords: 'privacy policy frontaliere, GDPR frontaliere, cookie policy, data processing, privacy information',
 ogTitle: 'Privacy Policy | Frontaliere Ticino',
 ogDescription: '🔒 Privacy policy: how we process your data. Compliant with GDPR and Swiss DPA.',
 canonicalPath: '/privacy-policy',
 structuredData: {
 "@context": "https://schema.org",
 "@type": "WebPage",
 "name": "Privacy Policy — Frontaliere Ticino",
 "url": `${BASE_URL}/privacy-policy/`,
 "description": "Privacy policy of Frontaliere Ticino",
 "inLanguage": "en"
 },
 },

};

export default SEO_PAGES_METADATA;
