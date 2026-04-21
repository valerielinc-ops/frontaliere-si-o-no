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
};

export default translations;
