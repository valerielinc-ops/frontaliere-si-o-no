// English translations — health-premiums SEO pages chunk.
// Kept in parity with it-health-premiums.ts. Consumed by the static-HTML
// generator in build-plugins/healthPremiumsLandingPlugin.ts.

const translations: Record<string, string> = {
  'healthPremiums.root.h1': 'Swiss health insurance premiums {year} by canton and age',
  'healthPremiums.canton.h1': 'Health insurance premiums {canton} {year}',
  'healthPremiums.leaf.h1': 'Health insurance premiums {canton} {year} — {age}',
  'healthPremiums.statsMedian': 'Median',
  'healthPremiums.statsMin': 'Lowest premium',
  'healthPremiums.statsMax': 'Highest premium',
  'healthPremiums.statsInsurers': 'Funds surveyed',
  'healthPremiums.top20Title': 'Top 20 health funds in {canton}',
  'healthPremiums.rankingTitle': 'Benchmark vs neighbouring cantons',
  'healthPremiums.editorialTitle': 'How the LAMal premium works in this bracket',
  'healthPremiums.comparatorCTA': 'Open the comparator',
  'healthPremiums.comparatorCTAText': 'Comparator pre-filtered by canton and age bracket.',
  'healthPremiums.derivationNote': 'Estimates based on BAG 2026 statutory caps for minors and young adults.',
  'healthPremiums.faqTitle': 'Frequently asked questions',
  'healthPremiums.breadcrumbRoot': 'Health Insurance Premiums',
  'healthPremiums.priceUnit': 'CHF/month',
  'healthPremiums.updatedLabel': 'Updated',
  'healthPremiums.ageGridTitle': 'Median by age bracket',
  'healthPremiums.cantonGridTitle': 'Median by canton — adult bracket (26+)',
  'healthPremiums.openLeaf': 'Open',
  // B-cont-4 — tri-year trend editorial
  'healthPremiums.triYear.sectionTitle': 'Three-year trend',
  'healthPremiums.triYear.summary': 'LAMal premium trajectory over the last three years with year-over-year change and two-year cumulative.',
  'healthPremiums.triYear.cantonSummary': 'Cumulative change of the adult median premium over the last three years.',
};

export default translations;
