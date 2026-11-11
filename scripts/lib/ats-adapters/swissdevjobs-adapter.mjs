/**
 * Adapter per SwissDevJobs (swissdevjobs.ch)
 * Portale specializzato tech svizzero con salari trasparenti in CHF.
 */

export class SwissDevJobsAdapter {
  constructor({ baseUrl = 'https://swissdevjobs.ch', userAgent = 'FrontaliereBot/1.0 (+https://frontaliereticino.ch)' } = {}) {
    this.baseUrl = baseUrl;
    this.userAgent = userAgent;
  }

  mapLightJob(item) {
    if (!item) return null;
    const publishedAt = item.activeFrom || item.datePosted || null;
    if (!publishedAt) return null;

    const key = item.jobId || item._id || item.slug;
    const minSalary = typeof item.annualSalaryFrom === 'number' ? item.annualSalaryFrom : null;
    const maxSalary = typeof item.annualSalaryTo === 'number' ? item.annualSalaryTo : null;

    return {
      id: `swissdevjobs_${key}`,
      provider: 'swissdevjobs',
      title: item.name || item.title || '',
      company: item.company || 'Tech Company Svizzera',
      location: item.actualCity || item.city || 'Svizzera',
      canton: null,
      salaryMin: minSalary,
      salaryMax: maxSalary,
      salaryCurrency: 'CHF',
      skills: Array.isArray(item.technologies) ? item.technologies : [],
      applicationUrl: `${this.baseUrl}/jobs/${item.slug || key}`,
      publishedAt
    };
  }

  extractDetailedJob(htmlText) {
    if (!htmlText) return null;
    const marker = 'window.__detailedJob =';
    const idx = htmlText.indexOf(marker);
    if (idx === -1) return null;

    const tail = htmlText.slice(idx + marker.length).trim();
    // Cerca la chiusura del blocco JSON/oggetto fino al primo ';' o '</script>'
    const endScript = tail.indexOf('</script>');
    const candidate = endScript !== -1 ? tail.slice(0, endScript).trim() : tail;
    const cleanJson = candidate.endsWith(';') ? candidate.slice(0, -1).trim() : candidate;

    try {
      return JSON.parse(cleanJson);
    } catch {
      return null;
    }
  }

  async fetchLightJobs({ fetchFn = globalThis.fetch } = {}) {
    const res = await fetchFn(`${this.baseUrl}/api/jobsLight`, {
      headers: { 'User-Agent': this.userAgent, 'Accept': 'application/json' }
    });
    if (!res.ok) return [];

    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.jobs || []);
    return list.map(item => this.mapLightJob(item)).filter(Boolean);
  }
}
