// Italian translations — SEO internal-linking chunk.
// Consumed by:
//   - Footer "Risorse aggiornate" column
//   - SeoDailyBanner home component
//   - Stats subtab banners (fuel-prices / health-premiums / jobs-observatory)
//   - JobBoard sidebar "Strumenti correlati" block
// Kept separate so the copy loads only where it's rendered.

const translations: Record<string, string> = {
  // Footer section
  'seoLinks.footer.title': 'Risorse aggiornate',
  'seoLinks.footer.fuelToday': 'Prezzo diesel oggi',
  'seoLinks.footer.weeklyEmployers': 'Aziende che assumono',
  'seoLinks.footer.jobMarket': 'Mercato lavoro Ticino',
  'seoLinks.footer.healthPremiums': 'Premi cassa malati',
  'seoLinks.footer.newYesterday': 'Nuove offerte da ieri',
  'seoLinks.footer.gasolineToday': 'Prezzo benzina oggi',
  'seoLinks.footer.healthPremiumsByCommune': 'Premi malattia per comune',

  // Footer weekly-employers teaser (closes 4.5k orphan sitemap entries)
  'seoLinks.footer.weeklyEmployersTeaser.title': 'Aziende che assumono questa settimana',

  // Homepage Quick Links grid (reduces crawl depth of /traffico-dogane/* + fuel)
  'seoLinks.quickLinks.title': 'Link veloci',
  'seoLinks.quickLinks.ariaLabel': 'Link veloci alle pagine più richieste',
  'seoLinks.quickLinks.trafficHub': 'Traffico dogane',
  'seoLinks.quickLinks.trafficHubDesc': 'Tempi di attesa ai valichi in tempo reale',
  'seoLinks.quickLinks.fuelToday': 'Prezzi diesel oggi',
  'seoLinks.quickLinks.fuelTodayDesc': 'Aggiornati ogni mattina',
  'seoLinks.quickLinks.crossingDesc': 'Tempi di attesa oggi',

  // Home banner (SeoDailyBanner)
  'seoLinks.banner.fuelTitle': 'Prezzo diesel oggi',
  'seoLinks.banner.fuelDesc': 'Aggiornato ogni mattina per tutto il Ticino',
  'seoLinks.banner.fuelCta': 'Scopri i prezzi',
  'seoLinks.banner.jobsTitle': 'Nuove offerte della settimana',
  'seoLinks.banner.jobsDesc': 'Report settimanale del mercato del lavoro in Ticino',
  'seoLinks.banner.jobsCta': 'Vedi il report',
  'seoLinks.banner.employersTitle': 'Aziende che assumono',
  'seoLinks.banner.employersDesc': 'Chi sta cercando personale questa settimana',
  'seoLinks.banner.employersCta': 'Scopri le aziende',
  'seoLinks.banner.ariaLabel': 'Risorse aggiornate oggi',

  // Stats subtab banners
  'seoLinks.stats.fuelBanner': 'Vuoi il prezzo del diesel sempre aggiornato con dettaglio per città di confine?',
  'seoLinks.stats.fuelBannerCta': 'Apri la pagina aggiornata oggi',
  'seoLinks.stats.healthBanner': 'Confronta i premi cassa malati 2026 per cantone e fascia d\'età.',
  'seoLinks.stats.healthBannerCta': 'Apri le pagine per cantone',
  'seoLinks.stats.jobsBanner': 'Snapshot settimanale del mercato del lavoro in Ticino — nuove offerte, aziende più attive, ruoli più richiesti.',
  'seoLinks.stats.jobsBannerCta': 'Apri il report settimanale',

  // JobBoard sidebar
  'seoLinks.jobBoard.title': 'Strumenti correlati',
  'seoLinks.jobBoard.jobMarket': 'Mercato lavoro settimanale',
  'seoLinks.jobBoard.employers': 'Aziende che assumono',
  'seoLinks.jobBoard.healthPremiums': 'Premi cassa malati',
  'seoLinks.jobBoard.salary': 'Benchmark salari',

  // Related-links 3-cluster section headings (D-2 Expansion C).
  // These are used by the shared build-plugins/shared/relatedLinks.ts helper
  // for the sibling / parent-hubs / cross-category clusters rendered at the
  // bottom of every SEO landing page.
  'related.section.nav': 'Correlati',
  'related.section.hubs': 'Hub principali',
  'related.section.cross': 'Altri strumenti per il frontaliere',
  'related.section.sibling.generic': 'Pagine correlate',
  'related.section.sibling.fuel_daily': 'Altre zone del Ticino',
  'related.section.sibling.fuel_station': 'Altre stazioni nella zona',
  'related.section.sibling.fuel_italian_city': 'Altre città italiane al confine',
  'related.section.sibling.weekly_employers': 'Altre città del Ticino',
  'related.section.sibling.weekly_employer_company_city': 'Stessa azienda in altre città',
  'related.section.sibling.job_market_snapshot': 'Settimane precedenti',
  'related.section.sibling.health_premiums': 'Altre fasce d\'età',
  'related.section.sibling.border_wait': 'Altri valichi della stessa zona',
  'related.section.sibling.orphan_landing': 'Ricerche correlate',
};

export default translations;
