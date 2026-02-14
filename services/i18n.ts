/**
 * Internationalization Service (i18n)
 * Supports: IT (default), EN, DE, FR
 * Lightweight solution — no external libraries needed
 */

export type Locale = 'it' | 'en' | 'de' | 'fr';

type TranslationKey = string;
type Translations = Record<TranslationKey, string>;
type AllTranslations = Record<Locale, Translations>;

// ─── Current Locale ──────────────────────────────────────────

let currentLocale: Locale = 'it';
const listeners: Array<(locale: Locale) => void> = [];

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  localStorage.setItem('frontaliere_locale', locale);
  document.documentElement.lang = locale;
  listeners.forEach(fn => fn(locale));
}

export function onLocaleChange(fn: (locale: Locale) => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export function initLocale(): void {
  const saved = localStorage.getItem('frontaliere_locale') as Locale | null;
  if (saved && ['it', 'en', 'de', 'fr'].includes(saved)) {
    currentLocale = saved;
  } else {
    // Auto-detect from browser
    const browserLang = navigator.language.split('-')[0] as Locale;
    if (['it', 'en', 'de', 'fr'].includes(browserLang)) {
      currentLocale = browserLang;
    }
  }
  document.documentElement.lang = currentLocale;
}

// ─── Translation Function ────────────────────────────────────

export function t(key: string, params?: Record<string, string | number>): string {
  const translation = translations[currentLocale]?.[key] || translations.it[key] || key;
  if (!params) return translation;
  return Object.entries(params).reduce(
    (str, [k, v]) => str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
    translation
  );
}

// ─── React Hook ──────────────────────────────────────────────

import { useState, useEffect } from 'react';

export function useLocale(): [Locale, (l: Locale) => void] {
  const [locale, setL] = useState<Locale>(currentLocale);
  useEffect(() => {
    return onLocaleChange(setL);
  }, []);
  return [locale, setLocale];
}

export function useTranslation() {
  const [locale] = useLocale();
  return { t, locale, setLocale };
}

// ─── Locale Labels ───────────────────────────────────────────

export const LOCALE_LABELS: Record<Locale, { flag: string; name: string; nativeName: string }> = {
  it: { flag: '🇮🇹', name: 'Italian', nativeName: 'Italiano' },
  en: { flag: '🇬🇧', name: 'English', nativeName: 'English' },
  de: { flag: '🇩🇪', name: 'German', nativeName: 'Deutsch' },
  fr: { flag: '🇫🇷', name: 'French', nativeName: 'Français' },
};

// ─── Translations ────────────────────────────────────────────

const translations: AllTranslations = {
  it: {
    // Nav
    'nav.simulator': 'Simulatore',
    'nav.comparators': 'Comparatori',
    'nav.pension': 'Pensione',
    'nav.guide': 'Guida',
    'nav.stats': 'Statistiche',
    'nav.support': 'Supporto',
    'nav.subtitle': 'Analisi Fiscale 2026',
    
    // Comparator sub-tabs
    'comparators.exchange': 'Cambio Valuta',
    'comparators.traffic': 'Traffico Valichi',
    'comparators.mobile': 'Telefonia Mobile',
    'comparators.banks': 'Conti Correnti',
    'comparators.health': 'Assicurazione Sanitaria',
    'comparators.transport': 'Costi Trasporto',
    'comparators.jobs': 'Offerte Lavoro',
    'comparators.companies': 'Aziende Ticino',
    'companies.title': 'Aziende in Ticino',
    'companies.subtitle': 'Mappa interattiva delle principali società con filtri per settore e dimensione',
    'companies.totalCompanies': 'Aziende',
    'companies.totalEmployees': 'Dipendenti',
    'companies.search': 'Cerca azienda, città, settore...',
    
    // Simulator sub-tabs
    'simulator.calculator': 'Calcolatore',
    'simulator.whatif': 'Cosa cambia se...',
    
    // Pension sub-tabs
    'pension.planner': 'Pianificatore',
    'pension.pillar3': '3° Pilastro',
    
    // Common
    'common.loading': 'Caricamento...',
    'common.error': 'Errore',
    'common.save': 'Salva',
    'common.cancel': 'Annulla',
    'common.close': 'Chiudi',
    'common.back': 'Indietro',
    'common.next': 'Avanti',
    'common.reset': 'Reset',
    'common.monthly': 'Mensile',
    'common.annual': 'Annuale',
    'common.years': 'anni',
    'common.months': 'mesi',
    'common.chf': 'CHF',
    'common.eur': 'EUR',
    'common.yes': 'Sì',
    'common.no': 'No',
    'common.disclaimer': 'Disclaimer',
    'common.update': 'Aggiorna',
    'common.subscribe': 'Iscriviti',
    'common.unsubscribe': 'Disiscriviti',
    'common.email': 'Email',
    'common.send': 'Invia',
    
    // Calculator
    'calc.title': 'Simulatore Fiscale Frontalieri',
    'calc.grossSalary': 'RAL Lorda Annua (CHF)',
    'calc.workerType': 'Tipo Frontaliere',
    'calc.workerTypeNew': 'Nuovo (dal 2024)',
    'calc.workerTypeOld': 'Vecchio (ante 2024)',
    'calc.children': 'Figli a carico',
    'calc.familyMembers': 'Componenti nucleo',
    'calc.result': 'Risultato Simulazione',
    'calc.netIncome': 'Stipendio Netto',
    
    // What-if Simulator
    'whatif.title': 'Simulatore "Cosa cambia se..."',
    'whatif.subtitle': 'Esplora scenari what-if e vedi come cambiano le tue tasse in tempo reale',
    'whatif.scenario.child': 'Se avessi un figlio?',
    'whatif.scenario.canton': 'Se cambiassi cantone?',
    'whatif.scenario.residence': 'Se prendessi la residenza CH?',
    'whatif.scenario.salary': 'Se cambiasse lo stipendio?',
    'whatif.scenario.marital': 'Se mi sposassi?',
    'whatif.currentValue': 'Valore attuale',
    'whatif.newValue': 'Nuovo valore',
    'whatif.impact': 'Impatto mensile',
    'whatif.increase': 'Aumento',
    'whatif.decrease': 'Diminuzione',
    
    // Currency Exchange
    'exchange.title': 'Confronto Cambio Valuta CHF → EUR',
    'exchange.subtitle': 'Scopri qual è la piattaforma più conveniente per convertire i tuoi franchi',
    'exchange.history': 'Storico Tasso CHF/EUR',
    'exchange.historySubtitle': 'Andamento del tasso di cambio negli ultimi mesi',
    'exchange.period.1m': '1 Mese',
    'exchange.period.3m': '3 Mesi',
    'exchange.period.6m': '6 Mesi',
    'exchange.period.1y': '1 Anno',
    'exchange.period.5y': '5 Anni',
    'exchange.bestOffer': 'Migliore Offerta',
    'exchange.worstOffer': 'Peggiore Offerta',
    
    // Traffic / Map
    'traffic.title': 'Traffico Valichi in Tempo Reale',
    'traffic.subtitle': 'Controlla i tempi di attesa ai valichi di confine CH-IT',
    'traffic.fastest': 'Valico più veloce',
    'traffic.slowest': 'Valico più congestionato',
    'traffic.mapView': 'Vista Mappa',
    'traffic.listView': 'Vista Lista',
    'traffic.statusGreen': 'Traffico scorrevole',
    'traffic.statusYellow': 'Traffico moderato',
    'traffic.statusRed': 'Code',
    'traffic.waitTime': 'Tempo attesa',
    'traffic.minutes': 'min',
    
    // Job Comparator
    'jobs.title': 'Confronto Offerte Lavoro',
    'jobs.subtitle': 'Inserisci 2-3 offerte e scopri quale conviene di più al netto di tasse, trasporto e tempo',
    'jobs.addOffer': 'Aggiungi Offerta',
    'jobs.removeOffer': 'Rimuovi',
    'jobs.companyName': 'Azienda',
    'jobs.grossSalary': 'RAL Lorda (CHF)',
    'jobs.distance': 'Distanza (km)',
    'jobs.benefits': 'Benefit',
    'jobs.travelTime': 'Tempo viaggio (min)',
    'jobs.mealVouchers': 'Buoni pasto',
    'jobs.parking': 'Parcheggio incluso',
    'jobs.homeOffice': 'Home office (gg/sett)',
    'jobs.bestChoice': 'Scelta Migliore',
    'jobs.netAdvantage': 'Vantaggio netto',
    'jobs.totalCost': 'Costo totale',
    'jobs.country': 'Paese posizione',
    
    // Tax Calendar
    'calendar.title': 'Calendario Scadenze Fiscali 2026',
    'calendar.subtitle': 'Date chiave per frontalieri: IRPEF, 730, AVS, opzione ordinaria',
    'calendar.upcoming': 'Prossime scadenze',
    'calendar.past': 'Scadenze passate',
    'calendar.daysLeft': 'tra {days} giorni',
    'calendar.overdue': 'Scaduto',
    'calendar.today': 'Oggi',
    
    // Work Permits
    'permits.title': 'Guida Permessi di Lavoro Svizzeri',
    'permits.subtitle': 'G, B, C, L: quale serve, come richiederlo, tempi e documenti',
    'permits.type': 'Tipo permesso',
    'permits.duration': 'Durata',
    'permits.requirements': 'Requisiti',
    'permits.documents': 'Documenti necessari',
    'permits.processingTime': 'Tempi di rilascio',
    'permits.cost': 'Costo',
    
    // 3rd Pillar
    'pillar3.title': 'Simulatore 3° Pilastro',
    'pillar3.subtitle': 'Calcola quanto risparmi con il pilastro 3a/3b e la proiezione futura',
    'pillar3.type3a': 'Pilastro 3a (vincolato)',
    'pillar3.type3b': 'Pilastro 3b (libero)',
    'pillar3.maxDeduction': 'Deduzione max annua',
    'pillar3.projection': 'Proiezione a {years} anni',
    'pillar3.taxSaving': 'Risparmio fiscale annuo',
    'pillar3.totalAccumulated': 'Totale accumulato',
    
    // Newsletter
    'newsletter.title': 'Newsletter Settimanale',
    'newsletter.subtitle': 'Ricevi ogni lunedì il tasso CHF/EUR e il riepilogo traffico della settimana',
    'newsletter.emailPlaceholder': 'La tua email...',
    'newsletter.success': 'Iscrizione confermata! Riceverai la prima newsletter lunedì.',
    'newsletter.privacy': 'I tuoi dati sono protetti. Puoi disiscriverti in qualsiasi momento.',
    
    // PWA
    'pwa.installPrompt': 'Installa l\'app per usarla offline al valico!',
    'pwa.install': 'Installa',
    'pwa.dismiss': 'Non ora',
    'pwa.offline': 'Sei offline. I dati mostrati potrebbero non essere aggiornati.',
    
    // Pillar3 Investment
    'pillar3.investmentComparison': 'Come Investire il 3° Pilastro',
    'pillar3.investmentDesc': 'Il 3° pilastro può essere investito in diverse modalità. Ecco un confronto.',
    'pillar3.topProviders': 'Migliori Fornitori 3a Digitali (2026)',
    'pillar3.investmentAdvice': '💡 Consiglio: Per massimizzare il rendimento, scegli un fornitore digitale con bassi costi di gestione (TER < 0.5%) e un buon track record.',
    
    // Input Card
    'input.title': 'Parametri',
    'input.subtitle': 'Configurazione',
    'input.grossAnnualIncome': 'Reddito Lordo Annuo',
    'input.age': 'Età',
    'input.sex': 'Sesso',
    'input.male': 'Uomo',
    'input.female': 'Donna',
    'input.maritalStatus': 'Stato Civile',
    'input.single': 'Celibe/Nubile',
    'input.married': 'Sposato/a',
    'input.divorced': 'Divorziato/a',
    'input.widowed': 'Vedovo/a',
    'input.spouseWorks': 'Coniuge lavora?',
    'input.frontierType': 'Tipologia Frontaliere',
    'input.newFrontier': 'Nuovo',
    'input.oldFrontier': 'Vecchio',
    'input.borderZone': 'Fascia di Confine',
    'input.within20km': 'Entro 20km',
    'input.over20km': 'Oltre 20km',
    'input.familyHealth': 'Famiglia & Salute',
    'input.familyMembers': 'Membri Nucleo',
    'input.dependentChildren': 'Figli a Carico',
    'input.fixedExpenses': 'Spese Fisse Personali',
    'input.liveInCH': 'Vivere in CH',
    'input.liveInIT': 'Vivere in IT',
    'input.calculationOptions': 'Opzioni di Calcolo',
    'input.exchangeRate': 'Cambio EUR/CHF',
    'input.monthsBasis': 'Mensilità',
    'input.healthInsurance': 'Cassa Malati (Mese)',
    'input.experimentalFeatures': 'Funzionalità Sperimentali',
    'input.technicalParams': 'Parametri Tecnici',
    'input.swissRates': 'Aliquote Svizzera (%)',
    'input.lppPension': 'LPP (Pensione %)',
    'input.prefill': 'Precompila',
    'input.resetAll': 'Resetta Tutto',
    
    // Results
    'results.comparativeAnalysis': 'Analisi Comparativa',
    'results.frontierBetter': 'Meglio fare il Frontaliere!',
    'results.swissBetter': 'Meglio Vivere in Svizzera!',
    'results.netAdvantage': 'Vantaggio netto finale (Annuo):',
    'results.liveInTicino': 'Vivere in Ticino',
    'results.liveInItaly': 'Vivere in Italia',
    'results.netMonthlyResidual': 'Netto Mensile Residuo',
    'results.downloadPDF': 'Scarica PDF',
    'results.whyConvenient': 'Perché conviene? (Analisi Stile di Vita)',
    'results.chooseSwissIf': 'Scelgo la Svizzera se:',
    'results.chooseItalyIf': 'Scelgo l\'Italia se:',
    'results.monthlyReservesChart': 'Grafico delle Riserve Mensili',
    'results.swissPayslipNet': 'Netto Busta Paga Svizzera (Pre-Tasse IT)',
    'results.concurrentTax': 'Tassazione concorrente (Accordo 2023)',
    'results.exclusiveSwissTax': 'Tassazione esclusiva Svizzera',
    
    // Exchange timing
    'exchange.whenToExchange': 'Quando Conviene Cambiare?',
    'exchange.experimental': 'Sperimentale',
    'exchange.timingDisclaimer': 'Analisi basata sullo storico del tasso CHF→EUR. Tendenze statistiche, non garanzie future.',
    'exchange.bestTiming': 'Momento Migliore',
    'exchange.toAvoid': 'Da Evitare',
    'exchange.avgRateByDay': 'Tasso Medio per Giorno della Settimana',
    'exchange.avgRateByMonth': 'Tasso Medio per Mese dell\'Anno',
    'exchange.timingTips': 'Consigli pratici per il timing:',
    'exchange.calculateYourExchange': 'Calcola il Tuo Cambio',
    'exchange.refreshRate': 'Aggiorna Tasso',
    'exchange.amountToConvert': 'Importo da Convertire',
    'exchange.realMarketRate': 'Tasso di Mercato Reale',
    'exchange.detailedComparison': 'Confronto Dettagliato',
    'exchange.bestChoice': 'Miglior Scelta',
    'exchange.volatilityTitle': '📈 Analisi Volatilità',
    'exchange.volatilityDesc': 'Misura quanto il tasso oscilla nel periodo selezionato',
    'exchange.seasonalTitle': '🗓️ Pattern Stagionali',
    'exchange.seasonalDesc': 'Tendenze ricorrenti nei movimenti del cambio',
    'exchange.hacksTitle': '🎯 Life Hacks per il Cambio',
    'exchange.hack1': '🏧 Preleva CHF dal Bancomat in IT il lunedì mattina — tassi migliori post-weekend',
    'exchange.hack2': '📱 Usa Wise/Revolut per cambio sotto 1000 CHF — zero commissioni',
    'exchange.hack3': '📅 Cambia lo stipendio a fine mese — i tassi tendono a essere più favorevoli',
    'exchange.hack4': '💡 Dividi il cambio: 50% subito, 50% tra 2 settimane — media del rischio',
    'exchange.hack5': '⚡ Evita il venerdì pomeriggio — spread più alti prima del weekend',
    'exchange.hack6': '🔔 Imposta alert su Wise per il tuo tasso target — non perdere il momento giusto',
    
    // Traffic extra
    'traffic.refresh': 'Aggiorna',
    'traffic.map': 'Mappa',
    'traffic.list': 'Lista',
    'traffic.realData': 'Dati reali da Google Maps (cache 1h)',
    'traffic.simulatedData': 'Dati simulati — orari di punta: 7-9 (IT→CH), 17-19 (CH→IT)',
    'traffic.navigateHere': 'Naviga qui',
    'traffic.openGoogleMaps': 'Apri su Google Maps',
    'traffic.tipsTitle': 'Consigli per Evitare le Code',
    
    // Footer
    'footer.copyright': '© 2026 Frontaliere Si o No?',
    'footer.disclaimer': 'Simulatore a scopo puramente indicativo.',
    'footer.privacy': 'Privacy Policy',
    'footer.apiStatus': 'Stato API',
    'footer.followUs': 'Seguici su',
  },

  en: {
    // Nav
    'nav.simulator': 'Simulator',
    'nav.comparators': 'Comparators',
    'nav.pension': 'Pension',
    'nav.guide': 'Guide',
    'nav.stats': 'Statistics',
    'nav.support': 'Support',
    'nav.subtitle': 'Tax Analysis 2026',
    
    // Comparator sub-tabs
    'comparators.exchange': 'Currency Exchange',
    'comparators.traffic': 'Border Traffic',
    'comparators.mobile': 'Mobile Plans',
    'comparators.banks': 'Bank Accounts',
    'comparators.health': 'Health Insurance',
    'comparators.transport': 'Transport Costs',
    'comparators.jobs': 'Job Offers',
    'comparators.companies': 'Ticino Companies',
    'companies.title': 'Companies in Ticino',
    'companies.subtitle': 'Interactive map of major companies with filters by sector and size',
    'companies.totalCompanies': 'Companies',
    'companies.totalEmployees': 'Employees',
    'companies.search': 'Search company, city, sector...',
    
    // Simulator sub-tabs
    'simulator.calculator': 'Calculator',
    'simulator.whatif': 'What if...',
    
    // Pension sub-tabs
    'pension.planner': 'Planner',
    'pension.pillar3': '3rd Pillar',
    
    // Common
    'common.loading': 'Loading...',
    'common.error': 'Error',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.back': 'Back',
    'common.next': 'Next',
    'common.reset': 'Reset',
    'common.monthly': 'Monthly',
    'common.annual': 'Annual',
    'common.years': 'years',
    'common.months': 'months',
    'common.chf': 'CHF',
    'common.eur': 'EUR',
    'common.yes': 'Yes',
    'common.no': 'No',
    'common.disclaimer': 'Disclaimer',
    'common.update': 'Update',
    'common.subscribe': 'Subscribe',
    'common.unsubscribe': 'Unsubscribe',
    'common.email': 'Email',
    'common.send': 'Send',
    
    // Calculator
    'calc.title': 'Cross-Border Tax Simulator',
    'calc.grossSalary': 'Gross Annual Salary (CHF)',
    'calc.workerType': 'Worker Type',
    'calc.workerTypeNew': 'New (from 2024)',
    'calc.workerTypeOld': 'Old (before 2024)',
    'calc.children': 'Dependent children',
    'calc.familyMembers': 'Family members',
    'calc.result': 'Simulation Result',
    'calc.netIncome': 'Net Income',
    
    // What-if
    'whatif.title': '"What if..." Simulator',
    'whatif.subtitle': 'Explore what-if scenarios and see how your taxes change in real time',
    'whatif.scenario.child': 'What if I had a child?',
    'whatif.scenario.canton': 'What if I changed canton?',
    'whatif.scenario.residence': 'What if I took CH residence?',
    'whatif.scenario.salary': 'What if my salary changed?',
    'whatif.scenario.marital': 'What if I got married?',
    'whatif.currentValue': 'Current value',
    'whatif.newValue': 'New value',
    'whatif.impact': 'Monthly impact',
    'whatif.increase': 'Increase',
    'whatif.decrease': 'Decrease',
    
    // Currency
    'exchange.title': 'Currency Exchange Comparison CHF → EUR',
    'exchange.subtitle': 'Find the best platform to convert your Swiss francs',
    'exchange.history': 'CHF/EUR Rate History',
    'exchange.historySubtitle': 'Exchange rate trend over the last months',
    'exchange.period.1m': '1 Month',
    'exchange.period.3m': '3 Months',
    'exchange.period.6m': '6 Months',
    'exchange.period.1y': '1 Year',
    'exchange.period.5y': '5 Years',
    'exchange.bestOffer': 'Best Offer',
    'exchange.worstOffer': 'Worst Offer',
    
    // Traffic
    'traffic.title': 'Real-Time Border Crossing Traffic',
    'traffic.subtitle': 'Check waiting times at CH-IT border crossings',
    'traffic.fastest': 'Fastest crossing',
    'traffic.slowest': 'Most congested crossing',
    'traffic.mapView': 'Map View',
    'traffic.listView': 'List View',
    'traffic.statusGreen': 'Flowing traffic',
    'traffic.statusYellow': 'Moderate traffic',
    'traffic.statusRed': 'Congested',
    'traffic.waitTime': 'Wait time',
    'traffic.minutes': 'min',
    
    // Jobs
    'jobs.title': 'Job Offer Comparison',
    'jobs.subtitle': 'Enter 2-3 offers and find out which is best after taxes, transport & time',
    'jobs.addOffer': 'Add Offer',
    'jobs.removeOffer': 'Remove',
    'jobs.companyName': 'Company',
    'jobs.grossSalary': 'Gross Salary (CHF)',
    'jobs.distance': 'Distance (km)',
    'jobs.benefits': 'Benefits',
    'jobs.travelTime': 'Travel time (min)',
    'jobs.mealVouchers': 'Meal vouchers',
    'jobs.parking': 'Parking included',
    'jobs.homeOffice': 'Home office (days/week)',
    'jobs.bestChoice': 'Best Choice',
    'jobs.netAdvantage': 'Net advantage',
    'jobs.totalCost': 'Total cost',
    'jobs.country': 'Position country',
    
    // Calendar
    'calendar.title': 'Tax Deadline Calendar 2026',
    'calendar.subtitle': 'Key dates for cross-border workers: IRPEF, Form 730, AVS, ordinary option',
    'calendar.upcoming': 'Upcoming deadlines',
    'calendar.past': 'Past deadlines',
    'calendar.daysLeft': 'in {days} days',
    'calendar.overdue': 'Overdue',
    'calendar.today': 'Today',
    
    // Permits
    'permits.title': 'Swiss Work Permit Guide',
    'permits.subtitle': 'G, B, C, L: which one you need, how to apply, timing & documents',
    'permits.type': 'Permit type',
    'permits.duration': 'Duration',
    'permits.requirements': 'Requirements',
    'permits.documents': 'Required documents',
    'permits.processingTime': 'Processing time',
    'permits.cost': 'Cost',
    
    // 3rd Pillar
    'pillar3.title': '3rd Pillar Simulator',
    'pillar3.subtitle': 'Calculate your savings with pillar 3a/3b and future projections',
    'pillar3.type3a': 'Pillar 3a (restricted)',
    'pillar3.type3b': 'Pillar 3b (flexible)',
    'pillar3.maxDeduction': 'Max annual deduction',
    'pillar3.projection': 'Projection over {years} years',
    'pillar3.taxSaving': 'Annual tax saving',
    'pillar3.totalAccumulated': 'Total accumulated',
    
    // Newsletter
    'newsletter.title': 'Weekly Newsletter',
    'newsletter.subtitle': 'Receive every Monday the CHF/EUR rate and weekly traffic summary',
    'newsletter.emailPlaceholder': 'Your email...',
    'newsletter.success': 'Subscription confirmed! You\'ll receive the first newsletter on Monday.',
    'newsletter.privacy': 'Your data is protected. You can unsubscribe at any time.',
    
    // PWA
    'pwa.installPrompt': 'Install the app to use it offline at the border!',
    'pwa.install': 'Install',
    'pwa.dismiss': 'Not now',
    'pwa.offline': 'You\'re offline. Displayed data may not be up to date.',
    
    // Pillar3 Investment
    'pillar3.investmentComparison': 'How to Invest the 3rd Pillar',
    'pillar3.investmentDesc': 'The 3rd pillar can be invested in different ways. Here\'s a comparison.',
    'pillar3.topProviders': 'Top Digital 3a Providers (2026)',
    'pillar3.investmentAdvice': '💡 Tip: To maximize returns, choose a digital provider with low management fees (TER < 0.5%) and a good track record.',
    
    // Input Card
    'input.title': 'Parameters',
    'input.subtitle': 'Configuration',
    'input.grossAnnualIncome': 'Gross Annual Income',
    'input.age': 'Age',
    'input.sex': 'Gender',
    'input.male': 'Male',
    'input.female': 'Female',
    'input.maritalStatus': 'Marital Status',
    'input.single': 'Single',
    'input.married': 'Married',
    'input.divorced': 'Divorced',
    'input.widowed': 'Widowed',
    'input.spouseWorks': 'Spouse works?',
    'input.frontierType': 'Cross-Border Type',
    'input.newFrontier': 'New',
    'input.oldFrontier': 'Old',
    'input.borderZone': 'Border Zone',
    'input.within20km': 'Within 20km',
    'input.over20km': 'Over 20km',
    'input.familyHealth': 'Family & Health',
    'input.familyMembers': 'Household Members',
    'input.dependentChildren': 'Dependent Children',
    'input.fixedExpenses': 'Fixed Personal Expenses',
    'input.liveInCH': 'Living in CH',
    'input.liveInIT': 'Living in IT',
    'input.calculationOptions': 'Calculation Options',
    'input.exchangeRate': 'Exchange Rate EUR/CHF',
    'input.monthsBasis': 'Monthly Payments',
    'input.healthInsurance': 'Health Insurance (Month)',
    'input.experimentalFeatures': 'Experimental Features',
    'input.technicalParams': 'Technical Parameters',
    'input.swissRates': 'Swiss Rates (%)',
    'input.lppPension': 'LPP (Pension %)',
    'input.prefill': 'Prefill',
    'input.resetAll': 'Reset All',
    
    // Results
    'results.comparativeAnalysis': 'Comparative Analysis',
    'results.frontierBetter': 'Better to be a Cross-Border Worker!',
    'results.swissBetter': 'Better to Live in Switzerland!',
    'results.netAdvantage': 'Net final advantage (Annual):',
    'results.liveInTicino': 'Living in Ticino',
    'results.liveInItaly': 'Living in Italy',
    'results.netMonthlyResidual': 'Net Monthly Residual',
    'results.downloadPDF': 'Download PDF',
    'results.whyConvenient': 'Why is it convenient? (Lifestyle Analysis)',
    'results.chooseSwissIf': 'Choose Switzerland if:',
    'results.chooseItalyIf': 'Choose Italy if:',
    'results.monthlyReservesChart': 'Monthly Reserves Chart',
    'results.swissPayslipNet': 'Swiss Payslip Net (Pre-IT Tax)',
    'results.concurrentTax': 'Concurrent taxation (2023 Agreement)',
    'results.exclusiveSwissTax': 'Exclusive Swiss taxation',
    
    // Exchange timing
    'exchange.whenToExchange': 'When to Exchange?',
    'exchange.experimental': 'Experimental',
    'exchange.timingDisclaimer': 'Analysis based on historical CHF→EUR rate. Statistical trends, not future guarantees.',
    'exchange.bestTiming': 'Best Timing',
    'exchange.toAvoid': 'To Avoid',
    'exchange.avgRateByDay': 'Average Rate by Day of Week',
    'exchange.avgRateByMonth': 'Average Rate by Month',
    'exchange.timingTips': 'Practical timing tips:',
    'exchange.calculateYourExchange': 'Calculate Your Exchange',
    'exchange.refreshRate': 'Refresh Rate',
    'exchange.amountToConvert': 'Amount to Convert',
    'exchange.realMarketRate': 'Real Market Rate',
    'exchange.detailedComparison': 'Detailed Comparison',
    'exchange.bestChoice': 'Best Choice',
    'exchange.volatilityTitle': '📈 Volatility Analysis',
    'exchange.volatilityDesc': 'Measures how much the rate fluctuates in the selected period',
    'exchange.seasonalTitle': '🗓️ Seasonal Patterns',
    'exchange.seasonalDesc': 'Recurring trends in exchange rate movements',
    'exchange.hacksTitle': '🎯 Exchange Life Hacks',
    'exchange.hack1': '🏧 Withdraw CHF from Italian ATMs on Monday morning — better rates post-weekend',
    'exchange.hack2': '📱 Use Wise/Revolut for exchanges under 1000 CHF — zero fees',
    'exchange.hack3': '📅 Exchange your salary at month end — rates tend to be more favorable',
    'exchange.hack4': '💡 Split the exchange: 50% now, 50% in 2 weeks — average out the risk',
    'exchange.hack5': '⚡ Avoid Friday afternoons — wider spreads before the weekend',
    'exchange.hack6': '🔔 Set alerts on Wise for your target rate — don\'t miss the right moment',
    
    // Traffic extra
    'traffic.refresh': 'Refresh',
    'traffic.map': 'Map',
    'traffic.list': 'List',
    'traffic.realData': 'Real data from Google Maps (1h cache)',
    'traffic.simulatedData': 'Simulated data — rush hours: 7-9 (IT→CH), 17-19 (CH→IT)',
    'traffic.navigateHere': 'Navigate here',
    'traffic.openGoogleMaps': 'Open in Google Maps',
    'traffic.tipsTitle': 'Tips to Avoid Queues',
    
    // Footer
    'footer.copyright': '© 2026 Cross-Border Yes or No?',
    'footer.disclaimer': 'Simulator for indicative purposes only.',
    'footer.privacy': 'Privacy Policy',
    'footer.apiStatus': 'API Status',
    'footer.followUs': 'Follow us on',
  },

  de: {
    // Nav
    'nav.simulator': 'Simulator',
    'nav.comparators': 'Vergleiche',
    'nav.pension': 'Rente',
    'nav.guide': 'Leitfaden',
    'nav.stats': 'Statistiken',
    'nav.support': 'Hilfe',
    'nav.subtitle': 'Steueranalyse 2026',
    
    // Comparator sub-tabs
    'comparators.exchange': 'Währungstausch',
    'comparators.traffic': 'Grenzverkehr',
    'comparators.mobile': 'Mobilfunk',
    'comparators.banks': 'Bankkonten',
    'comparators.health': 'Krankenversicherung',
    'comparators.transport': 'Transportkosten',
    'comparators.jobs': 'Stellenangebote',
    'comparators.companies': 'Unternehmen Tessin',
    'companies.title': 'Unternehmen im Tessin',
    'companies.subtitle': 'Interaktive Karte der wichtigsten Unternehmen mit Filtern nach Branche und Größe',
    'companies.totalCompanies': 'Unternehmen',
    'companies.totalEmployees': 'Mitarbeiter',
    'companies.search': 'Unternehmen, Stadt, Branche suchen...',
    
    // Simulator sub-tabs
    'simulator.calculator': 'Rechner',
    'simulator.whatif': 'Was wäre wenn...',
    
    // Pension sub-tabs
    'pension.planner': 'Planer',
    'pension.pillar3': '3. Säule',
    
    // Common
    'common.loading': 'Wird geladen...',
    'common.error': 'Fehler',
    'common.save': 'Speichern',
    'common.cancel': 'Abbrechen',
    'common.close': 'Schließen',
    'common.back': 'Zurück',
    'common.next': 'Weiter',
    'common.reset': 'Zurücksetzen',
    'common.monthly': 'Monatlich',
    'common.annual': 'Jährlich',
    'common.years': 'Jahre',
    'common.months': 'Monate',
    'common.chf': 'CHF',
    'common.eur': 'EUR',
    'common.yes': 'Ja',
    'common.no': 'Nein',
    'common.disclaimer': 'Haftungsausschluss',
    'common.update': 'Aktualisieren',
    'common.subscribe': 'Abonnieren',
    'common.unsubscribe': 'Abbestellen',
    'common.email': 'E-Mail',
    'common.send': 'Senden',
    
    // Calculator
    'calc.title': 'Grenzgänger-Steuersimulator',
    'calc.grossSalary': 'Brutto-Jahresgehalt (CHF)',
    'calc.workerType': 'Grenzgänger-Typ',
    'calc.workerTypeNew': 'Neu (ab 2024)',
    'calc.workerTypeOld': 'Alt (vor 2024)',
    'calc.children': 'Abhängige Kinder',
    'calc.familyMembers': 'Familienmitglieder',
    'calc.result': 'Simulationsergebnis',
    'calc.netIncome': 'Nettoeinkommen',
    
    // What-if
    'whatif.title': '"Was wäre wenn..." Simulator',
    'whatif.subtitle': 'Erkunden Sie Szenarien und sehen Sie, wie sich Ihre Steuern ändern',
    'whatif.scenario.child': 'Was, wenn ich ein Kind hätte?',
    'whatif.scenario.canton': 'Was, wenn ich den Kanton wechsle?',
    'whatif.scenario.residence': 'Was, wenn ich CH-Wohnsitz nehme?',
    'whatif.scenario.salary': 'Was, wenn sich das Gehalt ändert?',
    'whatif.scenario.marital': 'Was, wenn ich heirate?',
    'whatif.currentValue': 'Aktueller Wert',
    'whatif.newValue': 'Neuer Wert',
    'whatif.impact': 'Monatliche Auswirkung',
    'whatif.increase': 'Erhöhung',
    'whatif.decrease': 'Verminderung',
    
    // Exchange
    'exchange.title': 'Währungsumtausch-Vergleich CHF → EUR',
    'exchange.subtitle': 'Finden Sie die beste Plattform für den Frankenwechsel',
    'exchange.history': 'CHF/EUR Kursverlauf',
    'exchange.historySubtitle': 'Wechselkursentwicklung der letzten Monate',
    'exchange.period.1m': '1 Monat',
    'exchange.period.3m': '3 Monate',
    'exchange.period.6m': '6 Monate',
    'exchange.period.1y': '1 Jahr',
    'exchange.period.5y': '5 Jahre',
    'exchange.bestOffer': 'Bestes Angebot',
    'exchange.worstOffer': 'Schlechtestes Angebot',
    
    // Traffic
    'traffic.title': 'Grenzverkehr in Echtzeit',
    'traffic.subtitle': 'Wartezeiten an den CH-IT Grenzübergängen prüfen',
    'traffic.fastest': 'Schnellster Übergang',
    'traffic.slowest': 'Stärkster Stau',
    'traffic.mapView': 'Kartenansicht',
    'traffic.listView': 'Listenansicht',
    'traffic.statusGreen': 'Fließender Verkehr',
    'traffic.statusYellow': 'Mäßiger Verkehr',
    'traffic.statusRed': 'Stau',
    'traffic.waitTime': 'Wartezeit',
    'traffic.minutes': 'Min',
    
    // Jobs
    'jobs.title': 'Jobangebots-Vergleich',
    'jobs.subtitle': 'Geben Sie 2-3 Angebote ein und finden Sie das beste nach Steuern und Transport',
    'jobs.addOffer': 'Angebot hinzufügen',
    'jobs.removeOffer': 'Entfernen',
    'jobs.companyName': 'Unternehmen',
    'jobs.grossSalary': 'Bruttogehalt (CHF)',
    'jobs.distance': 'Entfernung (km)',
    'jobs.benefits': 'Vorteile',
    'jobs.travelTime': 'Fahrzeit (Min)',
    'jobs.mealVouchers': 'Essensgutscheine',
    'jobs.parking': 'Parkplatz inklusive',
    'jobs.homeOffice': 'Home Office (Tage/Woche)',
    'jobs.bestChoice': 'Beste Wahl',
    'jobs.netAdvantage': 'Nettovorteil',
    'jobs.totalCost': 'Gesamtkosten',
    'jobs.country': 'Land der Stelle',
    
    // Calendar
    'calendar.title': 'Steuerterminkalender 2026',
    'calendar.subtitle': 'Wichtige Termine für Grenzgänger: IRPEF, Formular 730, AHV',
    'calendar.upcoming': 'Nächste Termine',
    'calendar.past': 'Vergangene Termine',
    'calendar.daysLeft': 'in {days} Tagen',
    'calendar.overdue': 'Überfällig',
    'calendar.today': 'Heute',
    
    // Permits
    'permits.title': 'Schweizer Arbeitserlaubnis-Leitfaden',
    'permits.subtitle': 'G, B, C, L: welche Sie brauchen, Antrag, Fristen & Dokumente',
    'permits.type': 'Bewilligungstyp',
    'permits.duration': 'Dauer',
    'permits.requirements': 'Voraussetzungen',
    'permits.documents': 'Erforderliche Dokumente',
    'permits.processingTime': 'Bearbeitungszeit',
    'permits.cost': 'Kosten',
    
    // 3rd Pillar
    'pillar3.title': '3. Säule Simulator',
    'pillar3.subtitle': 'Berechnen Sie Ihre Ersparnisse mit Säule 3a/3b',
    'pillar3.type3a': 'Säule 3a (gebunden)',
    'pillar3.type3b': 'Säule 3b (frei)',
    'pillar3.maxDeduction': 'Max. Jahresabzug',
    'pillar3.projection': 'Projektion über {years} Jahre',
    'pillar3.taxSaving': 'Jährliche Steuerersparnis',
    'pillar3.totalAccumulated': 'Gesamt angesammelt',
    
    // Newsletter
    'newsletter.title': 'Wöchentlicher Newsletter',
    'newsletter.subtitle': 'Erhalten Sie jeden Montag den CHF/EUR-Kurs und Verkehrszusammenfassung',
    'newsletter.emailPlaceholder': 'Ihre E-Mail...',
    'newsletter.success': 'Abonnement bestätigt! Sie erhalten den ersten Newsletter am Montag.',
    'newsletter.privacy': 'Ihre Daten sind geschützt. Sie können sich jederzeit abmelden.',
    
    // PWA
    'pwa.installPrompt': 'Installieren Sie die App für Offline-Nutzung am Grenzübergang!',
    'pwa.install': 'Installieren',
    'pwa.dismiss': 'Nicht jetzt',
    'pwa.offline': 'Sie sind offline. Die angezeigten Daten sind möglicherweise nicht aktuell.',
    
    // Pillar3 Investment
    'pillar3.investmentComparison': 'Wie man die 3. Säule investiert',
    'pillar3.investmentDesc': 'Die 3. Säule kann auf verschiedene Weisen investiert werden. Hier ein Vergleich.',
    'pillar3.topProviders': 'Top Digitale 3a-Anbieter (2026)',
    'pillar3.investmentAdvice': '💡 Tipp: Wählen Sie einen digitalen Anbieter mit niedrigen Verwaltungskosten (TER < 0.5%) und guter Erfolgsbilanz.',
    
    // Input Card
    'input.title': 'Parameter',
    'input.subtitle': 'Konfiguration',
    'input.grossAnnualIncome': 'Brutto-Jahreseinkommen',
    'input.age': 'Alter',
    'input.sex': 'Geschlecht',
    'input.male': 'Mann',
    'input.female': 'Frau',
    'input.maritalStatus': 'Familienstand',
    'input.single': 'Ledig',
    'input.married': 'Verheiratet',
    'input.divorced': 'Geschieden',
    'input.widowed': 'Verwitwet',
    'input.spouseWorks': 'Ehepartner berufstätig?',
    'input.frontierType': 'Grenzgänger-Typ',
    'input.newFrontier': 'Neu',
    'input.oldFrontier': 'Alt',
    'input.borderZone': 'Grenzzone',
    'input.within20km': 'Innerhalb 20km',
    'input.over20km': 'Über 20km',
    'input.familyHealth': 'Familie & Gesundheit',
    'input.familyMembers': 'Haushaltsmitglieder',
    'input.dependentChildren': 'Abhängige Kinder',
    'input.fixedExpenses': 'Feste persönliche Ausgaben',
    'input.liveInCH': 'Leben in CH',
    'input.liveInIT': 'Leben in IT',
    'input.calculationOptions': 'Berechnungsoptionen',
    'input.exchangeRate': 'Wechselkurs EUR/CHF',
    'input.monthsBasis': 'Monatsgehälter',
    'input.healthInsurance': 'Krankenversicherung (Monat)',
    'input.experimentalFeatures': 'Experimentelle Funktionen',
    'input.technicalParams': 'Technische Parameter',
    'input.swissRates': 'Schweizer Sätze (%)',
    'input.lppPension': 'BVG (Rente %)',
    'input.prefill': 'Vorausfüllen',
    'input.resetAll': 'Alles zurücksetzen',
    
    // Results
    'results.comparativeAnalysis': 'Vergleichsanalyse',
    'results.frontierBetter': 'Besser als Grenzgänger!',
    'results.swissBetter': 'Besser in der Schweiz leben!',
    'results.netAdvantage': 'Netto-Endvorteil (Jährlich):',
    'results.liveInTicino': 'Leben im Tessin',
    'results.liveInItaly': 'Leben in Italien',
    'results.netMonthlyResidual': 'Netto-Monatsrest',
    'results.downloadPDF': 'PDF herunterladen',
    'results.whyConvenient': 'Warum lohnt es sich? (Lebensstil-Analyse)',
    'results.chooseSwissIf': 'Schweiz wählen wenn:',
    'results.chooseItalyIf': 'Italien wählen wenn:',
    'results.monthlyReservesChart': 'Monatliche Reserven-Grafik',
    'results.swissPayslipNet': 'Schweizer Nettolohn (Vor IT-Steuern)',
    'results.concurrentTax': 'Gleichzeitige Besteuerung (Abkommen 2023)',
    'results.exclusiveSwissTax': 'Ausschließliche Schweizer Besteuerung',
    
    // Exchange timing
    'exchange.whenToExchange': 'Wann tauschen?',
    'exchange.experimental': 'Experimentell',
    'exchange.timingDisclaimer': 'Analyse basierend auf historischem CHF→EUR-Kurs. Statistische Trends, keine Zukunftsgarantien.',
    'exchange.bestTiming': 'Bester Zeitpunkt',
    'exchange.toAvoid': 'Zu vermeiden',
    'exchange.avgRateByDay': 'Durchschnittskurs nach Wochentag',
    'exchange.avgRateByMonth': 'Durchschnittskurs nach Monat',
    'exchange.timingTips': 'Praktische Timing-Tipps:',
    'exchange.calculateYourExchange': 'Berechne deinen Wechsel',
    'exchange.refreshRate': 'Kurs aktualisieren',
    'exchange.amountToConvert': 'Zu wechselnder Betrag',
    'exchange.realMarketRate': 'Realer Marktkurs',
    'exchange.detailedComparison': 'Detaillierter Vergleich',
    'exchange.bestChoice': 'Beste Wahl',
    'exchange.volatilityTitle': '📈 Volatilitätsanalyse',
    'exchange.volatilityDesc': 'Misst, wie stark der Kurs im gewählten Zeitraum schwankt',
    'exchange.seasonalTitle': '🗓️ Saisonale Muster',
    'exchange.seasonalDesc': 'Wiederkehrende Trends bei Wechselkursbewegungen',
    'exchange.hacksTitle': '🎯 Wechselkurs-Lifehacks',
    'exchange.hack1': '🏧 Heben Sie CHF am Montag morgen am italienischen Geldautomaten ab — bessere Kurse nach dem Wochenende',
    'exchange.hack2': '📱 Verwenden Sie Wise/Revolut für Wechsel unter 1000 CHF — keine Gebühren',
    'exchange.hack3': '📅 Wechseln Sie das Gehalt am Monatsende — die Kurse sind tendenziell günstiger',
    'exchange.hack4': '💡 Teilen Sie den Wechsel: 50% jetzt, 50% in 2 Wochen — Risiko mitteln',
    'exchange.hack5': '⚡ Vermeiden Sie Freitagnachmittag — höhere Spreads vor dem Wochenende',
    'exchange.hack6': '🔔 Richten Sie Alerts auf Wise für Ihren Zielkurs ein — verpassen Sie nicht den richtigen Moment',
    
    // Traffic extra
    'traffic.refresh': 'Aktualisieren',
    'traffic.map': 'Karte',
    'traffic.list': 'Liste',
    'traffic.realData': 'Echtzeitdaten von Google Maps (1h Cache)',
    'traffic.simulatedData': 'Simulierte Daten — Stoßzeiten: 7-9 (IT→CH), 17-19 (CH→IT)',
    'traffic.navigateHere': 'Hierhin navigieren',
    'traffic.openGoogleMaps': 'In Google Maps öffnen',
    'traffic.tipsTitle': 'Tipps zur Stauvermeidung',
    
    // Footer
    'footer.copyright': '© 2026 Grenzgänger Ja oder Nein?',
    'footer.disclaimer': 'Simulator nur zu Richtzwecken.',
    'footer.privacy': 'Datenschutzerklärung',
    'footer.apiStatus': 'API-Status',
    'footer.followUs': 'Folgen Sie uns auf',
  },

  fr: {
    // Nav
    'nav.simulator': 'Simulateur',
    'nav.comparators': 'Comparateurs',
    'nav.pension': 'Retraite',
    'nav.guide': 'Guide',
    'nav.stats': 'Statistiques',
    'nav.support': 'Support',
    'nav.subtitle': 'Analyse Fiscale 2026',
    
    // Comparator sub-tabs
    'comparators.exchange': 'Change Devise',
    'comparators.traffic': 'Trafic Douanes',
    'comparators.mobile': 'Téléphonie Mobile',
    'comparators.banks': 'Comptes Bancaires',
    'comparators.health': 'Assurance Maladie',
    'comparators.transport': 'Coûts Transport',
    'comparators.jobs': 'Offres d\'Emploi',
    'comparators.companies': 'Entreprises Tessin',
    'companies.title': 'Entreprises au Tessin',
    'companies.subtitle': 'Carte interactive des principales entreprises avec filtres par secteur et taille',
    'companies.totalCompanies': 'Entreprises',
    'companies.totalEmployees': 'Employés',
    'companies.search': 'Rechercher entreprise, ville, secteur...',
    
    // Simulator sub-tabs
    'simulator.calculator': 'Calculateur',
    'simulator.whatif': 'Et si...',
    
    // Pension sub-tabs
    'pension.planner': 'Planificateur',
    'pension.pillar3': '3ème Pilier',
    
    // Common
    'common.loading': 'Chargement...',
    'common.error': 'Erreur',
    'common.save': 'Enregistrer',
    'common.cancel': 'Annuler',
    'common.close': 'Fermer',
    'common.back': 'Retour',
    'common.next': 'Suivant',
    'common.reset': 'Réinitialiser',
    'common.monthly': 'Mensuel',
    'common.annual': 'Annuel',
    'common.years': 'ans',
    'common.months': 'mois',
    'common.chf': 'CHF',
    'common.eur': 'EUR',
    'common.yes': 'Oui',
    'common.no': 'Non',
    'common.disclaimer': 'Avertissement',
    'common.update': 'Mettre à jour',
    'common.subscribe': 'S\'abonner',
    'common.unsubscribe': 'Se désabonner',
    'common.email': 'Email',
    'common.send': 'Envoyer',
    
    // Calculator
    'calc.title': 'Simulateur Fiscal Frontaliers',
    'calc.grossSalary': 'Salaire brut annuel (CHF)',
    'calc.workerType': 'Type de frontalier',
    'calc.workerTypeNew': 'Nouveau (depuis 2024)',
    'calc.workerTypeOld': 'Ancien (avant 2024)',
    'calc.children': 'Enfants à charge',
    'calc.familyMembers': 'Membres du foyer',
    'calc.result': 'Résultat de la simulation',
    'calc.netIncome': 'Revenu net',
    
    // What-if
    'whatif.title': 'Simulateur "Et si..."',
    'whatif.subtitle': 'Explorez des scénarios et voyez comment vos impôts changent en temps réel',
    'whatif.scenario.child': 'Et si j\'avais un enfant ?',
    'whatif.scenario.canton': 'Et si je changeais de canton ?',
    'whatif.scenario.residence': 'Et si je prenais la résidence CH ?',
    'whatif.scenario.salary': 'Et si mon salaire changeait ?',
    'whatif.scenario.marital': 'Et si je me mariais ?',
    'whatif.currentValue': 'Valeur actuelle',
    'whatif.newValue': 'Nouvelle valeur',
    'whatif.impact': 'Impact mensuel',
    'whatif.increase': 'Augmentation',
    'whatif.decrease': 'Diminution',
    
    // Exchange
    'exchange.title': 'Comparaison de Change CHF → EUR',
    'exchange.subtitle': 'Trouvez la meilleure plateforme pour convertir vos francs',
    'exchange.history': 'Historique CHF/EUR',
    'exchange.historySubtitle': 'Évolution du taux de change ces derniers mois',
    'exchange.period.1m': '1 Mois',
    'exchange.period.3m': '3 Mois',
    'exchange.period.6m': '6 Mois',
    'exchange.period.1y': '1 An',
    'exchange.period.5y': '5 Ans',
    'exchange.bestOffer': 'Meilleure Offre',
    'exchange.worstOffer': 'Pire Offre',
    
    // Traffic
    'traffic.title': 'Trafic aux Douanes en Temps Réel',
    'traffic.subtitle': 'Vérifiez les temps d\'attente aux postes-frontière CH-IT',
    'traffic.fastest': 'Poste le plus rapide',
    'traffic.slowest': 'Poste le plus encombré',
    'traffic.mapView': 'Vue Carte',
    'traffic.listView': 'Vue Liste',
    'traffic.statusGreen': 'Trafic fluide',
    'traffic.statusYellow': 'Trafic modéré',
    'traffic.statusRed': 'Embouteillages',
    'traffic.waitTime': 'Temps d\'attente',
    'traffic.minutes': 'min',
    
    // Jobs
    'jobs.title': 'Comparaison d\'Offres d\'Emploi',
    'jobs.subtitle': 'Entrez 2-3 offres et découvrez la plus avantageuse après impôts et transport',
    'jobs.addOffer': 'Ajouter une offre',
    'jobs.removeOffer': 'Supprimer',
    'jobs.companyName': 'Entreprise',
    'jobs.grossSalary': 'Salaire brut (CHF)',
    'jobs.distance': 'Distance (km)',
    'jobs.benefits': 'Avantages',
    'jobs.travelTime': 'Temps de trajet (min)',
    'jobs.mealVouchers': 'Tickets restaurant',
    'jobs.parking': 'Parking inclus',
    'jobs.homeOffice': 'Télétravail (jours/sem)',
    'jobs.bestChoice': 'Meilleur Choix',
    'jobs.netAdvantage': 'Avantage net',
    'jobs.totalCost': 'Coût total',
    'jobs.country': 'Pays du poste',
    
    // Calendar
    'calendar.title': 'Calendrier Fiscal 2026',
    'calendar.subtitle': 'Dates clés pour frontaliers : IRPEF, formulaire 730, AVS, option ordinaire',
    'calendar.upcoming': 'Prochaines échéances',
    'calendar.past': 'Échéances passées',
    'calendar.daysLeft': 'dans {days} jours',
    'calendar.overdue': 'En retard',
    'calendar.today': 'Aujourd\'hui',
    
    // Permits
    'permits.title': 'Guide des Permis de Travail Suisses',
    'permits.subtitle': 'G, B, C, L : lequel vous faut-il, comment le demander, délais et documents',
    'permits.type': 'Type de permis',
    'permits.duration': 'Durée',
    'permits.requirements': 'Conditions',
    'permits.documents': 'Documents requis',
    'permits.processingTime': 'Délai de traitement',
    'permits.cost': 'Coût',
    
    // 3rd Pillar
    'pillar3.title': 'Simulateur 3ème Pilier',
    'pillar3.subtitle': 'Calculez vos économies avec le pilier 3a/3b et projections futures',
    'pillar3.type3a': 'Pilier 3a (lié)',
    'pillar3.type3b': 'Pilier 3b (libre)',
    'pillar3.maxDeduction': 'Déduction max annuelle',
    'pillar3.projection': 'Projection sur {years} ans',
    'pillar3.taxSaving': 'Économie fiscale annuelle',
    'pillar3.totalAccumulated': 'Total accumulé',
    
    // Newsletter
    'newsletter.title': 'Newsletter Hebdomadaire',
    'newsletter.subtitle': 'Recevez chaque lundi le taux CHF/EUR et le résumé du trafic',
    'newsletter.emailPlaceholder': 'Votre email...',
    'newsletter.success': 'Inscription confirmée ! Vous recevrez la première newsletter lundi.',
    'newsletter.privacy': 'Vos données sont protégées. Vous pouvez vous désabonner à tout moment.',
    
    // PWA
    'pwa.installPrompt': 'Installez l\'app pour l\'utiliser hors ligne à la frontière !',
    'pwa.install': 'Installer',
    'pwa.dismiss': 'Pas maintenant',
    'pwa.offline': 'Vous êtes hors ligne. Les données affichées peuvent ne pas être à jour.',
    
    // Pillar3 Investment
    'pillar3.investmentComparison': 'Comment investir le 3ème pilier',
    'pillar3.investmentDesc': 'Le 3ème pilier peut être investi de différentes manières. Voici une comparaison.',
    'pillar3.topProviders': 'Meilleurs fournisseurs 3a numériques (2026)',
    'pillar3.investmentAdvice': '💡 Conseil : Pour maximiser le rendement, choisissez un fournisseur numérique avec des frais bas (TER < 0.5%) et un bon historique.',
    
    // Input Card
    'input.title': 'Paramètres',
    'input.subtitle': 'Configuration',
    'input.grossAnnualIncome': 'Revenu brut annuel',
    'input.age': 'Âge',
    'input.sex': 'Genre',
    'input.male': 'Homme',
    'input.female': 'Femme',
    'input.maritalStatus': 'État civil',
    'input.single': 'Célibataire',
    'input.married': 'Marié(e)',
    'input.divorced': 'Divorcé(e)',
    'input.widowed': 'Veuf/Veuve',
    'input.spouseWorks': 'Conjoint travaille ?',
    'input.frontierType': 'Type de frontalier',
    'input.newFrontier': 'Nouveau',
    'input.oldFrontier': 'Ancien',
    'input.borderZone': 'Zone frontalière',
    'input.within20km': 'Dans les 20km',
    'input.over20km': 'Au-delà de 20km',
    'input.familyHealth': 'Famille & Santé',
    'input.familyMembers': 'Membres du foyer',
    'input.dependentChildren': 'Enfants à charge',
    'input.fixedExpenses': 'Dépenses fixes personnelles',
    'input.liveInCH': 'Vivre en CH',
    'input.liveInIT': 'Vivre en IT',
    'input.calculationOptions': 'Options de calcul',
    'input.exchangeRate': 'Taux de change EUR/CHF',
    'input.monthsBasis': 'Mensualités',
    'input.healthInsurance': 'Assurance maladie (mois)',
    'input.experimentalFeatures': 'Fonctionnalités expérimentales',
    'input.technicalParams': 'Paramètres techniques',
    'input.swissRates': 'Taux suisses (%)',
    'input.lppPension': 'LPP (Retraite %)',
    'input.prefill': 'Pré-remplir',
    'input.resetAll': 'Tout réinitialiser',
    
    // Results
    'results.comparativeAnalysis': 'Analyse comparative',
    'results.frontierBetter': 'Mieux d\'être frontalier !',
    'results.swissBetter': 'Mieux de vivre en Suisse !',
    'results.netAdvantage': 'Avantage net final (Annuel) :',
    'results.liveInTicino': 'Vivre au Tessin',
    'results.liveInItaly': 'Vivre en Italie',
    'results.netMonthlyResidual': 'Net mensuel résiduel',
    'results.downloadPDF': 'Télécharger PDF',
    'results.whyConvenient': 'Pourquoi est-ce avantageux ? (Analyse du mode de vie)',
    'results.chooseSwissIf': 'Choisir la Suisse si :',
    'results.chooseItalyIf': 'Choisir l\'Italie si :',
    'results.monthlyReservesChart': 'Graphique des réserves mensuelles',
    'results.swissPayslipNet': 'Net fiche de paie suisse (Avant impôts IT)',
    'results.concurrentTax': 'Taxation concurrente (Accord 2023)',
    'results.exclusiveSwissTax': 'Taxation exclusive suisse',
    
    // Exchange timing
    'exchange.whenToExchange': 'Quand changer ?',
    'exchange.experimental': 'Expérimental',
    'exchange.timingDisclaimer': 'Analyse basée sur l\'historique du taux CHF→EUR. Tendances statistiques, pas de garanties futures.',
    'exchange.bestTiming': 'Meilleur moment',
    'exchange.toAvoid': 'À éviter',
    'exchange.avgRateByDay': 'Taux moyen par jour de la semaine',
    'exchange.avgRateByMonth': 'Taux moyen par mois',
    'exchange.timingTips': 'Conseils pratiques pour le timing :',
    'exchange.calculateYourExchange': 'Calculez votre change',
    'exchange.refreshRate': 'Actualiser le taux',
    'exchange.amountToConvert': 'Montant à convertir',
    'exchange.realMarketRate': 'Taux de marché réel',
    'exchange.detailedComparison': 'Comparaison détaillée',
    'exchange.bestChoice': 'Meilleur choix',
    'exchange.volatilityTitle': '📈 Analyse de la volatilité',
    'exchange.volatilityDesc': 'Mesure les fluctuations du taux sur la période sélectionnée',
    'exchange.seasonalTitle': '🗓️ Schémas saisonniers',
    'exchange.seasonalDesc': 'Tendances récurrentes dans les mouvements du taux de change',
    'exchange.hacksTitle': '🎯 Astuces pour le change',
    'exchange.hack1': '🏧 Retirez des CHF au distributeur en Italie le lundi matin — meilleurs taux après le weekend',
    'exchange.hack2': '📱 Utilisez Wise/Revolut pour les changes sous 1000 CHF — zéro frais',
    'exchange.hack3': '📅 Changez votre salaire en fin de mois — les taux tendent à être plus favorables',
    'exchange.hack4': '💡 Divisez le change : 50% maintenant, 50% dans 2 semaines — moyennez le risque',
    'exchange.hack5': '⚡ Évitez le vendredi après-midi — spreads plus élevés avant le weekend',
    'exchange.hack6': '🔔 Configurez des alertes sur Wise pour votre taux cible — ne ratez pas le bon moment',
    
    // Traffic extra
    'traffic.refresh': 'Actualiser',
    'traffic.map': 'Carte',
    'traffic.list': 'Liste',
    'traffic.realData': 'Données réelles de Google Maps (cache 1h)',
    'traffic.simulatedData': 'Données simulées — heures de pointe : 7-9 (IT→CH), 17-19 (CH→IT)',
    'traffic.navigateHere': 'Naviguer ici',
    'traffic.openGoogleMaps': 'Ouvrir dans Google Maps',
    'traffic.tipsTitle': 'Conseils pour éviter les bouchons',
    
    // Footer
    'footer.copyright': '© 2026 Frontalier Oui ou Non ?',
    'footer.disclaimer': 'Simulateur à titre indicatif uniquement.',
    'footer.privacy': 'Politique de confidentialité',
    'footer.apiStatus': 'Statut API',
    'footer.followUs': 'Suivez-nous sur',
  },
};
