// Italian translations — border-wait SEO pages chunk.
// Keys consumed by build-plugins/borderWaitPagesPlugin.ts when generating
// static HTML for /traffico-dogane/{crossing}/oggi/ and related hubs.
// Kept separate so it lazy-loads only when users navigate to the traffic
// sub-tab (consistent with the chunked i18n architecture — see services/i18n.ts).

const translations: Record<string, string> = {
  'borderWait.root.h1': 'Tempi di attesa alle dogane Ticino–Italia — live oggi',
  'borderWait.regional.h1': 'Tempi di attesa ai valichi {region}',
  'borderWait.leaf.h1': 'Tempi di attesa alla dogana {crossing} — oggi',
  'borderWait.updated': 'Aggiornamento',
  'borderWait.waitMinutes': 'Minuti di attesa',
  'borderWait.source.bazg': 'Dato ufficiale Dogana Svizzera',
  'borderWait.source.tomtom': 'Stima TomTom (flusso veicolare)',
  'borderWait.source.google': 'Stima Google Maps',
  'borderWait.source.static': 'Dati statistici — tempo reale non disponibile',
  'borderWait.currentStatus': 'Stato attuale',
  'borderWait.hourlyToday': 'Andamento orario — oggi',
  'borderWait.weeklyPattern': 'Pattern settimanale — ultimi 30 giorni',
  'borderWait.bestHours': 'Orari migliori',
  'borderWait.worstHours': 'Orari peggiori',
  'borderWait.infoValico': 'Informazioni valico',
  'borderWait.webcamLive': 'Webcam live',
  'borderWait.webcamNote':
    "Immagini aggiornate automaticamente ogni minuto quando la pagina è aperta. Usa il link \"Fonte\" per la versione ufficiale.",
  'borderWait.webcamSource': 'Fonte',
  'borderWait.faq.title': 'Domande frequenti',
  'borderWait.breadcrumbHome': 'Home',
  'borderWait.related': 'Vedi anche',
  'borderWait.nohistory':
    'Storico in accumulo: i pattern settimanali saranno visibili nei prossimi giorni.',
};

export default translations;
