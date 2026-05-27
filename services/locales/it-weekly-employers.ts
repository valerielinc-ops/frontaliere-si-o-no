// Italian translations — weekly "Aziende che assumono" per-city hub chunk (F5).
// Keys consumed by build-plugins/weeklyEmployersPlugin.ts when rendering
// static HTML. Kept separate so they lazy-load only for users navigating
// to /aziende-che-assumono/* (consistent with chunked i18n architecture).

const translations: Record<string, string> = {
  'weeklyEmployers.section.label': 'Aziende che assumono',
  'weeklyEmployers.hero.h1.current.city': 'Aziende che assumono a {city} questa settimana',
  'weeklyEmployers.hero.h1.current.ticino': 'Aziende che assumono in Ticino questa settimana',
  'weeklyEmployers.hero.h1.archive.city': 'Aziende che assumevano a {city} — Settimana {week} {year}',
  'weeklyEmployers.hero.h1.archive.ticino': 'Aziende che assumevano in Ticino — Settimana {week} {year}',
  'weeklyEmployers.hero.kicker.current': 'Classifica settimanale',
  'weeklyEmployers.hero.kicker.archive': 'Archivio settimanale',
  'weeklyEmployers.hero.summary':
    'Questa settimana a {city} {companiesCount} aziende hanno pubblicato {jobsCount} nuove offerte.',
  'weeklyEmployers.hero.summaryNoDelta':
    'A {city} risultano {companiesCount} aziende con {jobsCount} offerte attive. Dati iniziali — il delta settimanale sarà disponibile dalla settimana prossima.',
  'weeklyEmployers.intro':
    'Classifica aggiornata ogni lunedì mattina delle aziende con il maggior numero di nuove offerte pubblicate a {city} nell\'ultima settimana. Utile per capire chi sta assumendo davvero oggi, quali ruoli stanno crescendo e dove concentrare la candidatura spontanea.',
  'weeklyEmployers.topCompanies.title': 'Top aziende che stanno assumendo',
  'weeklyEmployers.topCompanies.empty':
    'Nessuna nuova offerta rilevata in questa città negli ultimi 7 giorni.',
  'weeklyEmployers.newcomers.title': 'Aziende nuove — prima apparizione',
  'weeklyEmployers.newcomers.desc':
    'Aziende che non avevano mai pubblicato offerte nelle settimane precedenti. Spesso sono le prime avvisaglie di nuove assunzioni strutturate: vale la pena arrivare per primi.',
  'weeklyEmployers.newcomers.empty':
    'Nessuna azienda nuova questa settimana — tutte le aziende elencate hanno già pubblicato offerte in passato.',
  'weeklyEmployers.roles.title': 'Ruoli più richiesti questa settimana',
  'weeklyEmployers.roles.empty':
    'Non abbiamo ancora abbastanza offerte attive per costruire il breakdown dei ruoli.',
  'weeklyEmployers.relatedLinks.title': 'Approfondimenti correlati',
  'weeklyEmployers.relatedLinks.cityHub': 'Tutte le offerte a {city}',
  'weeklyEmployers.relatedLinks.employerBrand': 'Pagina azienda: {employer}',
  'weeklyEmployers.jobsCount.one': '{count} offerta',
  'weeklyEmployers.jobsCount.other': '{count} offerte',
  'weeklyEmployers.deltaPositive': '+{count} questa settimana',
  'weeklyEmployers.deltaZero': 'invariato',
  'weeklyEmployers.coldStart': 'Dati iniziali — delta disponibile dalla settimana prossima',
  'weeklyEmployers.faq.title': 'Domande frequenti',
  'weeklyEmployers.faq.howOften.q': 'Ogni quanto viene aggiornata questa classifica?',
  'weeklyEmployers.faq.howOften.a':
    'La classifica viene rigenerata automaticamente ogni lunedì mattina con i dati aggregati dei job-board monitorati dalla nostra pipeline.',
  'weeklyEmployers.faq.whatIsDelta.q': 'Cosa indica il "delta" accanto al nome azienda?',
  'weeklyEmployers.faq.whatIsDelta.a':
    'Indica quante offerte in più sono state pubblicate questa settimana rispetto allo snapshot precedente. Un delta alto significa che l\'azienda sta attivamente assumendo ora.',
  'weeklyEmployers.faq.apply.q': 'Come ci si candida a queste aziende?',
  'weeklyEmployers.faq.apply.a':
    'Ogni azienda porta alle sue offerte pubblicate sulla nostra bacheca, dove puoi candidarti direttamente o aprire il sito ufficiale dell\'azienda.',
  'weeklyEmployers.breadcrumb.home': 'Home',
  'weeklyEmployers.breadcrumb.section': 'Aziende che assumono',
  'weeklyEmployers.archive.noindexNote':
    'Archivio storico — mantenuto per continuità, non più aggiornato.',
  // Company × city page (D-2 Expansion B).
  'weeklyEmployers.companyCity.h1.current':
    'Aziende che assumono — {employer} a {city}, settimana corrente',
  'weeklyEmployers.companyCity.h1.archive':
    'Aziende che assumevano — {employer} a {city}, settimana {week} {year}',
  'weeklyEmployers.companyCity.kicker': 'Azienda × città',
  'weeklyEmployers.companyCity.heroWithDelta':
    'Questa settimana {employer} ha {jobsCount} offerte aperte a {city} ({deltaLabel}).',
  'weeklyEmployers.companyCity.heroNoDelta':
    'Questa settimana {employer} ha {jobsCount} offerte aperte a {city}. Dati iniziali — il delta settimanale sarà disponibile dalla prossima rilevazione.',
  'weeklyEmployers.companyCity.jobsHeading':
    'Offerte aperte di {employer} a {city} questa settimana',
  'weeklyEmployers.companyCity.applyCta': 'Apri l\'offerta',
  'weeklyEmployers.companyCity.brandHubLabel': 'Scheda azienda: {employer}',
  'weeklyEmployers.companyCity.parentHubLabel':
    'Tutte le aziende che assumono a {city} questa settimana',
  'weeklyEmployers.companyCity.cityHubLabel':
    'Tutte le offerte di lavoro a {city}',
  'weeklyEmployers.companyCity.siblingLabel': '{employer} a {city}',
  'weeklyEmployers.companyCity.faq.why.q':
    'Perché una pagina dedicata a {employer}?',
  'weeklyEmployers.companyCity.faq.howApply.q':
    'Come ci si candida a queste offerte?',
  'weeklyEmployers.companyCity.faq.update.q':
    'Quando viene aggiornata questa pagina?',
};

export default translations;
