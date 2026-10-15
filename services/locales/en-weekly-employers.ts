// English translations — weekly "Companies hiring" per-city hub chunk (F5).

const translations: Record<string, string> = {
  'weeklyEmployers.section.label': 'Companies hiring',
  'weeklyEmployers.hero.h1.current.city': 'Companies hiring in {city} this week',
  'weeklyEmployers.hero.h1.current.ticino': 'Companies hiring in Ticino this week',
  'weeklyEmployers.hero.h1.archive.city': 'Companies hiring in {city} — Week {week} {year}',
  'weeklyEmployers.hero.h1.archive.ticino': 'Companies hiring in Ticino — Week {week} {year}',
  'weeklyEmployers.hero.kicker.current': 'Weekly leaderboard',
  'weeklyEmployers.hero.kicker.archive': 'Weekly archive',
  'weeklyEmployers.hero.summary':
    'This week in {city} {companiesCount} companies posted {jobsCount} new openings.',
  'weeklyEmployers.hero.summaryNoDelta':
    '{companiesCount} companies in {city} currently have {jobsCount} active openings. Baseline data — weekly delta available starting next week.',
  'weeklyEmployers.intro':
    'Leaderboard refreshed every Monday morning ranking the companies with the most new openings posted in {city} over the last 7 days. Useful to see who is actually hiring right now, which roles are trending, and where to focus your outreach.',
  'weeklyEmployers.topCompanies.title': 'Top companies hiring',
  'weeklyEmployers.topCompanies.empty':
    'No new openings detected in this city over the past 7 days.',
  'weeklyEmployers.newcomers.title': 'New companies — first appearance',
  'weeklyEmployers.newcomers.desc':
    'Companies that had never posted openings in the previous weeks. Often an early signal of structured hiring — a good chance to apply before the competition picks up.',
  'weeklyEmployers.newcomers.empty':
    'No new companies this week — every company listed has posted openings in previous weeks.',
  'weeklyEmployers.roles.title': 'Roles most in demand this week',
  'weeklyEmployers.roles.empty':
    'Not enough active openings yet to build the role breakdown.',
  'weeklyEmployers.relatedLinks.title': 'Related pages',
  'weeklyEmployers.relatedLinks.cityHub': 'All jobs in {city}',
  'weeklyEmployers.relatedLinks.employerBrand': 'Employer page: {employer}',
  'weeklyEmployers.jobsCount.one': '{count} opening',
  'weeklyEmployers.jobsCount.other': '{count} openings',
  'weeklyEmployers.deltaPositive': '+{count} this week',
  'weeklyEmployers.deltaZero': 'unchanged',
  'weeklyEmployers.coldStart': 'Baseline data — delta available starting next week',
  'weeklyEmployers.faq.title': 'Frequently asked questions',
  'weeklyEmployers.faq.howOften.q': 'How often is this leaderboard updated?',
  'weeklyEmployers.faq.howOften.a':
    'The leaderboard is regenerated automatically every Monday morning using aggregated data from the job boards monitored by our pipeline.',
  'weeklyEmployers.faq.whatIsDelta.q': 'What does the "delta" next to each company name mean?',
  'weeklyEmployers.faq.whatIsDelta.a':
    'It shows how many more openings were published this week compared to the previous snapshot. A high delta means the company is actively hiring right now.',
  'weeklyEmployers.faq.apply.q': 'How do I apply to these companies?',
  'weeklyEmployers.faq.apply.a':
    'Each company links to its active openings on our job board, where you can apply directly or open the company\'s official page.',
  'weeklyEmployers.breadcrumb.home': 'Home',
  'weeklyEmployers.breadcrumb.section': 'Companies hiring',
  'weeklyEmployers.archive.noindexNote':
    'Historical archive — kept for continuity, no longer updated.',
  // Company × city page (D-2 Expansion B).
  'weeklyEmployers.companyCity.h1.current':
    'Companies hiring — {employer} in {city}, current week',
  'weeklyEmployers.companyCity.h1.archive':
    'Companies hiring — {employer} in {city}, week {week} {year}',
  'weeklyEmployers.companyCity.kicker': 'Company × city',
  'weeklyEmployers.companyCity.heroWithDelta':
    'This week {employer} has {jobsCount} open positions in {city} ({deltaLabel}).',
  'weeklyEmployers.companyCity.heroNoDelta':
    'This week {employer} has {jobsCount} open positions in {city}. Baseline data — the weekly delta will appear starting with the next snapshot.',
  'weeklyEmployers.companyCity.jobsHeading':
    'Open positions at {employer} in {city} this week',
  'weeklyEmployers.companyCity.applyCta': 'View posting',
  'weeklyEmployers.companyCity.brandHubLabel': 'Employer page: {employer}',
  'weeklyEmployers.companyCity.parentHubLabel':
    'All companies hiring in {city} this week',
  'weeklyEmployers.companyCity.cityHubLabel': 'All jobs in {city}',
  'weeklyEmployers.companyCity.siblingLabel': '{employer} in {city}',
  'weeklyEmployers.companyCity.faq.why.q':
    'Why a dedicated page for {employer}?',
  'weeklyEmployers.companyCity.faq.howApply.q':
    'How do I apply to these openings?',
  'weeklyEmployers.companyCity.faq.update.q':
    'How often is this page updated?',
};

export default translations;
