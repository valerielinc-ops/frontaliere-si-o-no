/**
 * Adapter per Prospective (ohws.prospective.ch)
 * Utilizzato da Coop, Confédération Suisse (jobs.admin.ch), Stadler Rail,
 * Insel Gruppe, Ospedale Universitario Zurigo (USZ), Helvetia, cantoni e ospedali.
 */

export class ProspectiveAdapter {
  constructor({ apiBase = 'https://ohws.prospective.ch/public/v1', userAgent = 'FrontaliereBot/1.0 (+https://frontaliereticino.ch)' } = {}) {
    this.apiBase = apiBase;
    this.userAgent = userAgent;
  }

  mapJob(item) {
    if (!item) return null;
    const viewKey = item.viewkey || item.id;
    return {
      id: `prospective_${viewKey}`,
      provider: 'prospective',
      title: item.title || '',
      company: item.company || item.attributes?.company_name || 'Datore di Lavoro Svizzero',
      location: item.location || item.attributes?.city || 'Svizzera',
      canton: item.canton || item.attributes?.canton || null,
      descriptionHtml: item.description || item.body || '',
      applicationUrl: item.directlink || `${this.apiBase}/jobs/${viewKey}`,
      publishedAt: item.publish_date || item.publishedAt || new Date().toISOString()
    };
  }

  async fetchJobs(mediumId, { lang = 'de', limit = 100, maxPages = 5, fetchFn = globalThis.fetch } = {}) {
    const jobs = [];
    let offset = 0;

    for (let page = 0; page < maxPages; page++) {
      const url = `${this.apiBase}/medium/${mediumId}/jobs?lang=${encodeURIComponent(lang)}&limit=${limit}&offset=${offset}`;
      const res = await fetchFn(url, {
        headers: { 'User-Agent': this.userAgent, 'Accept': 'application/json' }
      });
      if (!res.ok) break;

      const data = await res.json();
      const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
      if (rawJobs.length === 0) break;

      for (const raw of rawJobs) {
        const mapped = this.mapJob(raw);
        if (mapped) jobs.push(mapped);
      }

      offset += limit;
      if (offset >= (data.total || 0)) break;
    }

    return jobs;
  }
}
