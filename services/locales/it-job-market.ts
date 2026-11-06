// Italian translations — job-market-snapshot chunk (F4).
// Keys consumed by build-plugins/jobMarketSnapshotPlugin.ts static HTML.
// Kept separate so they lazy-load only when users land on the snapshot hub.

const translations: Record<string, string> = {
  'jobMarket.hub.heading': 'Mercato del lavoro in Ticino — report settimanale',
  'jobMarket.hub.intro':
    'Ogni settimana raccogliamo e pubblichiamo i dati aggregati sul mercato del lavoro in Ticino.',
  'jobMarket.hub.latestLabel': 'Ultime settimane',
  'jobMarket.hub.archiveLabel': 'Archivio mensile',
  'jobMarket.hub.seeCurrentWeek': 'Vai al report della settimana corrente',
  'jobMarket.seriesKicker': 'Report mercato del lavoro · Ticino',
  'jobMarket.stat.newJobs': 'Nuove offerte',
  'jobMarket.stat.closedJobs': 'Offerte chiuse',
  'jobMarket.stat.activeEmployers': 'Aziende attive',
  'jobMarket.stat.medianSalary': 'Stipendio mediano',
  'jobMarket.topRoles': 'Top 5 ruoli per volume',
  'jobMarket.topEmployers': 'Top 5 datori di lavoro',
  'jobMarket.cityBreakdown': 'Distribuzione per città',
  'jobMarket.trend': 'Andamento ultime 12 settimane',
  'jobMarket.trendEmpty':
    'Lo storico a 12 settimane è in costruzione: il grafico si popola man mano che accumuliamo nuovi snapshot settimanali.',
  'jobMarket.degraded':
    'Stiamo iniziando a raccogliere lo storico settimanale del mercato ticinese.',
  'jobMarket.methodology': 'Metodologia',
  'jobMarket.faq.title': 'Domande frequenti',
  'jobMarket.weekLabel': 'Settimana',
  'jobMarket.monthLabel': 'Mese',
  'jobMarket.freshness': 'Aggiornato al',
  'jobMarket.relatedLinks': 'Approfondimenti',
  // D-3A: per-sector snapshot pages
  'jobMarket.sector.kicker': 'Report di settore · Ticino',
  'jobMarket.sector.h1': 'Mercato lavoro {sector} Ticino — offerte attive oggi',
  'jobMarket.sector.activeJobs': 'Offerte attive',
  'jobMarket.sector.weeklyDelta': 'Delta settimanale',
  'jobMarket.sector.monthlyDelta': 'Delta mensile',
  'jobMarket.sector.topEmployers': 'Datori di lavoro più attivi',
  'jobMarket.sector.trend': 'Trend nuove posizioni — ultime 12 settimane',
  'jobMarket.sector.hubCta': 'Vedi tutte le offerte {sector} in Ticino',
  'jobMarket.sector.snapshotCta': 'Report mercato del lavoro Ticino',
  'jobMarket.sector.faqTitle': 'Domande frequenti',
  'jobMarket.sector.breadcrumb': 'Settori',
  'jobMarket.sector.historyFallback': 'storico in costruzione',
};

export default translations;
