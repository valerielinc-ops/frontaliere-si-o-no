// Italian translations — fuel-daily SEO pages chunk.
// Keys consumed by build-plugins/fuelDailyPagesPlugin.ts when generating
// static HTML. Kept separate so they lazy-load only for users navigating to
// the fuel-daily hubs (consistent with the chunked i18n architecture).

const translations: Record<string, string> = {
  'fuelDaily.regional.h1.diesel': 'Prezzi diesel Svizzera oggi — Ticino',
  'fuelDaily.regional.h1.benzina': 'Prezzi benzina Svizzera oggi — Ticino',
  'fuelDaily.zone.h1.diesel': 'Prezzo diesel oggi a {zone}',
  'fuelDaily.zone.h1.benzina': 'Prezzo benzina oggi a {zone}',
  'fuelDaily.updated': 'Aggiornamento',
  'fuelDaily.avgPrice': 'Prezzo medio oggi',
  'fuelDaily.deltaYesterday': 'vs ieri',
  'fuelDaily.delta7days': 'vs 7 giorni fa',
  'fuelDaily.topCheapest': 'Le 3 stazioni più economiche',
  'fuelDaily.trendWeek': 'Andamento ultimi 7 giorni',
  'fuelDaily.noHistory': 'Storico in costruzione — il grafico si aggiorna ogni giorno.',
  'fuelDaily.faq.title': 'Domande frequenti',
  'fuelDaily.archiveLabel': 'Archivio prezzi mensile',
  'fuelDaily.regionalLabel': 'Ticino (regionale)',
  'fuelDaily.station.address': 'Indirizzo',
  'fuelDaily.station.price': 'Prezzo',
  'fuelDaily.date': 'Data',
  'fuelDaily.price': 'Prezzo',
  'fuelDaily.currency': 'CHF/litro',
};

export default translations;
