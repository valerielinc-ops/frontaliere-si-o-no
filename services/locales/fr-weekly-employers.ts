// French translations — weekly "Entreprises qui recrutent" per-city hub chunk (F5).

const translations: Record<string, string> = {
  'weeklyEmployers.section.label': 'Entreprises qui recrutent',
  'weeklyEmployers.hero.h1.current.city':
    'Entreprises qui recrutent à {city} cette semaine',
  'weeklyEmployers.hero.h1.current.ticino':
    'Entreprises qui recrutent au Tessin cette semaine',
  'weeklyEmployers.hero.h1.archive.city':
    'Entreprises qui recrutaient à {city} — Semaine {week} {year}',
  'weeklyEmployers.hero.h1.archive.ticino':
    'Entreprises qui recrutaient au Tessin — Semaine {week} {year}',
  'weeklyEmployers.hero.kicker.current': 'Classement hebdomadaire',
  'weeklyEmployers.hero.kicker.archive': 'Archive hebdomadaire',
  'weeklyEmployers.hero.summary':
    'Cette semaine à {city}, {companiesCount} entreprises ont publié {jobsCount} nouvelles offres.',
  'weeklyEmployers.hero.summaryNoDelta':
    'À {city}, {companiesCount} entreprises ont actuellement {jobsCount} offres actives. Données initiales — la variation hebdomadaire sera disponible dès la semaine prochaine.',
  'weeklyEmployers.intro':
    'Classement mis à jour chaque lundi matin des entreprises ayant publié le plus de nouvelles offres à {city} ces 7 derniers jours. Utile pour identifier qui recrute vraiment maintenant, quels rôles sont en hausse et où concentrer ses candidatures spontanées.',
  'weeklyEmployers.topCompanies.title': 'Meilleures entreprises qui recrutent',
  'weeklyEmployers.topCompanies.empty':
    'Aucune nouvelle offre détectée dans cette ville ces 7 derniers jours.',
  'weeklyEmployers.newcomers.title': 'Nouvelles entreprises — première apparition',
  'weeklyEmployers.newcomers.desc':
    'Entreprises qui n\'avaient jamais publié d\'offres les semaines précédentes. Souvent un signal précoce d\'embauches structurées — une bonne occasion de postuler avant la concurrence.',
  'weeklyEmployers.newcomers.empty':
    'Aucune nouvelle entreprise cette semaine — toutes celles listées ont déjà publié des offres auparavant.',
  'weeklyEmployers.roles.title': 'Rôles les plus demandés cette semaine',
  'weeklyEmployers.roles.empty':
    'Pas encore assez d\'offres actives pour construire la répartition par rôle.',
  'weeklyEmployers.relatedLinks.title': 'Pages liées',
  'weeklyEmployers.relatedLinks.cityHub': 'Toutes les offres à {city}',
  'weeklyEmployers.relatedLinks.employerBrand': 'Page employeur : {employer}',
  'weeklyEmployers.jobsCount.one': '{count} offre',
  'weeklyEmployers.jobsCount.other': '{count} offres',
  'weeklyEmployers.deltaPositive': '+{count} cette semaine',
  'weeklyEmployers.deltaZero': 'inchangé',
  'weeklyEmployers.coldStart':
    'Données initiales — variation disponible dès la semaine prochaine',
  'weeklyEmployers.faq.title': 'Questions fréquentes',
  'weeklyEmployers.faq.howOften.q': 'À quelle fréquence ce classement est-il mis à jour ?',
  'weeklyEmployers.faq.howOften.a':
    'Le classement est régénéré automatiquement chaque lundi matin à partir des données agrégées des sites d\'offres d\'emploi suivis par notre pipeline.',
  'weeklyEmployers.faq.whatIsDelta.q':
    'Que signifie la "variation" à côté du nom de l\'entreprise ?',
  'weeklyEmployers.faq.whatIsDelta.a':
    'Elle indique combien d\'offres supplémentaires ont été publiées cette semaine par rapport au snapshot précédent. Une variation élevée signifie que l\'entreprise recrute activement en ce moment.',
  'weeklyEmployers.faq.apply.q': 'Comment postuler à ces entreprises ?',
  'weeklyEmployers.faq.apply.a':
    'Chaque entreprise renvoie vers ses offres actives sur notre tableau, où vous pouvez postuler directement ou ouvrir le site officiel de l\'entreprise.',
  'weeklyEmployers.breadcrumb.home': 'Accueil',
  'weeklyEmployers.breadcrumb.section': 'Entreprises qui recrutent',
  'weeklyEmployers.archive.noindexNote':
    'Archive historique — conservée pour continuité, non mise à jour.',
  // Company × city page (D-2 Expansion B).
  'weeklyEmployers.companyCity.h1.current':
    'Entreprises qui recrutent — {employer} à {city}, semaine courante',
  'weeklyEmployers.companyCity.h1.archive':
    'Entreprises qui recrutaient — {employer} à {city}, semaine {week} {year}',
  'weeklyEmployers.companyCity.kicker': 'Entreprise × ville',
  'weeklyEmployers.companyCity.heroWithDelta':
    'Cette semaine {employer} a {jobsCount} offres ouvertes à {city} ({deltaLabel}).',
  'weeklyEmployers.companyCity.heroNoDelta':
    'Cette semaine {employer} a {jobsCount} offres ouvertes à {city}. Données initiales — la variation hebdomadaire apparaîtra dès le prochain snapshot.',
  'weeklyEmployers.companyCity.jobsHeading':
    'Offres ouvertes chez {employer} à {city} cette semaine',
  'weeklyEmployers.companyCity.applyCta': 'Voir l\'offre',
  'weeklyEmployers.companyCity.brandHubLabel': 'Page employeur : {employer}',
  'weeklyEmployers.companyCity.parentHubLabel':
    'Toutes les entreprises qui recrutent à {city} cette semaine',
  'weeklyEmployers.companyCity.cityHubLabel': 'Toutes les offres à {city}',
  'weeklyEmployers.companyCity.siblingLabel': '{employer} à {city}',
  'weeklyEmployers.companyCity.faq.why.q':
    'Pourquoi une page dédiée à {employer} ?',
  'weeklyEmployers.companyCity.faq.howApply.q':
    'Comment postuler à ces offres ?',
  'weeklyEmployers.companyCity.faq.update.q':
    'À quelle fréquence cette page est-elle mise à jour ?',
};

export default translations;
