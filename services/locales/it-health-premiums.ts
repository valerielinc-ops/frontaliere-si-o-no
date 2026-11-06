// Italian translations — health-premiums SEO pages chunk.
// Keys consumed by build-plugins/healthPremiumsLandingPlugin.ts when
// generating static HTML. Kept separate so they can lazy-load only for
// visitors navigating to LAMal premium landings (consistent with the
// chunked i18n architecture).

const translations: Record<string, string> = {
  'healthPremiums.root.h1': 'Premi Cassa Malati {year} per cantone e fascia d\'età',
  'healthPremiums.canton.h1': 'Premi Cassa Malati {canton} {year}',
  'healthPremiums.leaf.h1': 'Premi Cassa Malati {canton} {year} — fascia {age}',
  'healthPremiums.statsMedian': 'Mediana',
  'healthPremiums.statsMin': 'Premio minimo',
  'healthPremiums.statsMax': 'Premio massimo',
  'healthPremiums.statsInsurers': 'Casse considerate',
  'healthPremiums.top20Title': 'Top 20 casse malati in {canton}',
  'healthPremiums.rankingTitle': 'Confronto con i cantoni limitrofi',
  'healthPremiums.editorialTitle': 'Come funziona il premio LAMal in questa fascia',
  'healthPremiums.comparatorCTA': 'Apri il comparatore',
  'healthPremiums.comparatorCTAText': 'Comparatore pre-filtrato per cantone e fascia d\'età.',
  'healthPremiums.derivationNote': 'Stime basate sui massimali BAG 2026 per minori e giovani adulti.',
  'healthPremiums.faqTitle': 'Domande frequenti',
  'healthPremiums.breadcrumbRoot': 'Premi Cassa Malati',
  'healthPremiums.priceUnit': 'CHF/mese',
  'healthPremiums.updatedLabel': 'Aggiornato',
  'healthPremiums.ageGridTitle': 'Mediane per fascia di età',
  'healthPremiums.cantonGridTitle': 'Mediane per cantone — fascia adulti (26+)',
  'healthPremiums.openLeaf': 'Apri',
  // B-cont-4 — tri-year trend editorial
  'healthPremiums.triYear.sectionTitle': 'Trend triennale',
  'healthPremiums.triYear.summary': 'Andamento dei premi LAMal degli ultimi tre anni con variazioni anno su anno e cumulato biennale.',
  'healthPremiums.triYear.cantonSummary': 'Variazione cumulata della mediana adulti negli ultimi tre anni.',
};

export default translations;
