// German translations — weekly "Unternehmen einstellen" per-city hub chunk (F5).

const translations: Record<string, string> = {
  'weeklyEmployers.section.label': 'Unternehmen mit offenen Stellen',
  'weeklyEmployers.hero.h1.current.city':
    'Unternehmen, die diese Woche in {city} einstellen',
  'weeklyEmployers.hero.h1.current.ticino':
    'Unternehmen, die diese Woche im Tessin einstellen',
  'weeklyEmployers.hero.h1.archive.city':
    'Unternehmen, die in {city} eingestellt haben — Woche {week} {year}',
  'weeklyEmployers.hero.h1.archive.ticino':
    'Unternehmen, die im Tessin eingestellt haben — Woche {week} {year}',
  'weeklyEmployers.hero.kicker.current': 'Wöchentliche Rangliste',
  'weeklyEmployers.hero.kicker.archive': 'Wöchentliches Archiv',
  'weeklyEmployers.hero.summary':
    'Diese Woche haben in {city} {companiesCount} Unternehmen {jobsCount} neue Stellen ausgeschrieben.',
  'weeklyEmployers.hero.summaryNoDelta':
    'In {city} haben aktuell {companiesCount} Unternehmen {jobsCount} offene Stellen. Basisdaten — die Wochenveränderung ist ab nächster Woche verfügbar.',
  'weeklyEmployers.intro':
    'Rangliste, jeden Montagmorgen aktualisiert, der Unternehmen mit den meisten neuen Stellen in {city} in den letzten 7 Tagen. Hilfreich, um zu sehen, wer jetzt wirklich einstellt, welche Rollen im Trend liegen und wo sich eine Initiativbewerbung lohnt.',
  'weeklyEmployers.topCompanies.title': 'Top-Unternehmen mit offenen Stellen',
  'weeklyEmployers.topCompanies.empty':
    'In den letzten 7 Tagen wurden in dieser Stadt keine neuen Stellen entdeckt.',
  'weeklyEmployers.newcomers.title': 'Neue Unternehmen — erste Erwähnung',
  'weeklyEmployers.newcomers.desc':
    'Unternehmen, die in den Vorwochen nie Stellen ausgeschrieben hatten. Oft ein frühes Zeichen für strukturierte Einstellungen — eine gute Chance, sich vor der Konkurrenz zu bewerben.',
  'weeklyEmployers.newcomers.empty':
    'Diese Woche keine neuen Unternehmen — alle aufgeführten Firmen haben bereits in Vorwochen Stellen ausgeschrieben.',
  'weeklyEmployers.roles.title': 'Gefragteste Rollen diese Woche',
  'weeklyEmployers.roles.empty':
    'Noch nicht genügend aktive Stellen, um die Rollenaufteilung zu erstellen.',
  'weeklyEmployers.relatedLinks.title': 'Verwandte Seiten',
  'weeklyEmployers.relatedLinks.cityHub': 'Alle Stellen in {city}',
  'weeklyEmployers.relatedLinks.employerBrand': 'Arbeitgeberseite: {employer}',
  'weeklyEmployers.jobsCount.one': '{count} Stelle',
  'weeklyEmployers.jobsCount.other': '{count} Stellen',
  'weeklyEmployers.deltaPositive': '+{count} diese Woche',
  'weeklyEmployers.deltaZero': 'unverändert',
  'weeklyEmployers.coldStart': 'Basisdaten — Wochenveränderung ab nächster Woche verfügbar',
  'weeklyEmployers.faq.title': 'Häufige Fragen',
  'weeklyEmployers.faq.howOften.q': 'Wie oft wird diese Rangliste aktualisiert?',
  'weeklyEmployers.faq.howOften.a':
    'Die Rangliste wird automatisch jeden Montagmorgen mit aggregierten Daten der von unserer Pipeline überwachten Job-Portale neu generiert.',
  'weeklyEmployers.faq.whatIsDelta.q':
    'Was bedeutet die "Veränderung" neben dem Firmennamen?',
  'weeklyEmployers.faq.whatIsDelta.a':
    'Sie zeigt, wie viele Stellen diese Woche gegenüber dem vorherigen Snapshot mehr ausgeschrieben wurden. Eine hohe Veränderung bedeutet, dass das Unternehmen aktuell aktiv einstellt.',
  'weeklyEmployers.faq.apply.q': 'Wie bewerbe ich mich bei diesen Unternehmen?',
  'weeklyEmployers.faq.apply.a':
    'Jedes Unternehmen verlinkt auf seine aktiven Stellen auf unserem Job-Board, wo Sie sich direkt bewerben oder die offizielle Firmenseite öffnen können.',
  'weeklyEmployers.breadcrumb.home': 'Startseite',
  'weeklyEmployers.breadcrumb.section': 'Unternehmen mit offenen Stellen',
  'weeklyEmployers.archive.noindexNote':
    'Historisches Archiv — zur Kontinuität aufbewahrt, nicht mehr aktualisiert.',
  // Company × city page (D-2 Expansion B).
  'weeklyEmployers.companyCity.h1.current':
    'Unternehmen mit offenen Stellen — {employer} in {city}, aktuelle Woche',
  'weeklyEmployers.companyCity.h1.archive':
    'Unternehmen mit offenen Stellen — {employer} in {city}, Woche {week} {year}',
  'weeklyEmployers.companyCity.kicker': 'Unternehmen × Stadt',
  'weeklyEmployers.companyCity.heroWithDelta':
    'Diese Woche hat {employer} {jobsCount} offene Stellen in {city} ({deltaLabel}).',
  'weeklyEmployers.companyCity.heroNoDelta':
    'Diese Woche hat {employer} {jobsCount} offene Stellen in {city}. Basisdaten — die Wochenveränderung ist ab der nächsten Erhebung verfügbar.',
  'weeklyEmployers.companyCity.jobsHeading':
    'Offene Stellen bei {employer} in {city} diese Woche',
  'weeklyEmployers.companyCity.applyCta': 'Stelle ansehen',
  'weeklyEmployers.companyCity.brandHubLabel': 'Arbeitgeberseite: {employer}',
  'weeklyEmployers.companyCity.parentHubLabel':
    'Alle Unternehmen mit offenen Stellen in {city} diese Woche',
  'weeklyEmployers.companyCity.cityHubLabel': 'Alle Stellen in {city}',
  'weeklyEmployers.companyCity.siblingLabel': '{employer} in {city}',
  'weeklyEmployers.companyCity.faq.why.q':
    'Warum eine eigene Seite für {employer}?',
  'weeklyEmployers.companyCity.faq.howApply.q':
    'Wie bewerbe ich mich auf diese Stellen?',
  'weeklyEmployers.companyCity.faq.update.q':
    'Wie oft wird diese Seite aktualisiert?',
};

export default translations;
