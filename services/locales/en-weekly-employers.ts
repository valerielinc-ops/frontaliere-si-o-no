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
};

export default translations;
