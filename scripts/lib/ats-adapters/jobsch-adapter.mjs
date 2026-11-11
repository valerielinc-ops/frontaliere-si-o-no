/**
 * Adapter per JobCloud (jobs.ch / jobup.ch)
 * Il principale aggregatore di offerte di lavoro in Svizzera.
 */

export class JobsChAdapter {
  constructor({ userAgent = 'FrontaliereBot/1.0 (+https://frontaliereticino.ch)' } = {}) {
    this.userAgent = userAgent;
  }

  /**
   * Estrae lo stato iniziale idratato o il blocco schema.org dal markup di jobs.ch.
   */
  extractJobDataFromHtml(htmlText, fallbackUrl = '') {
    if (!htmlText) return null;

    // 1. Tenta estrazione da JSON-LD JobPosting
    const jsonLdRegex = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = jsonLdRegex.exec(htmlText)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed['@type'] === 'JobPosting') {
          const org = parsed.hiringOrganization;
          const company = (typeof org === 'string' ? org : org?.name) || 'Datore di Lavoro Svizzero';
          const address = parsed.jobLocation?.address;
          const location = (typeof address === 'string' ? address : address?.addressLocality) || 'Svizzera';
          const canton = address?.addressRegion || null;
          const idMatch = /\/(\d+)(?:\/|\?|$)/.exec(fallbackUrl);
          const jobId = idMatch ? idMatch[1] : String(Date.now());

          const publishedAt = parsed.datePosted || null;
          if (!publishedAt) continue;

          return {
            id: `jobsch_${jobId}`,
            provider: 'jobsch',
            title: parsed.title || '',
            company,
            location,
            canton,
            descriptionHtml: parsed.description || '',
            applicationUrl: fallbackUrl,
            publishedAt
          };
        }
      } catch {
        // Ignora JSON malformato
      }
    }

    // 2. Fallback su window.__INITIAL_STATE__
    const stateMatch = /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});/i.exec(htmlText);
    if (stateMatch) {
      try {
        const state = JSON.parse(stateMatch[1]);
        const job = state.jobDetail?.job || state.job;
        if (job) {
          const publishedAt = job.publicationDate || job.datePosted || null;
          if (!publishedAt) return null;

          return {
            id: `jobsch_${job.jobId || job.id}`,
            provider: 'jobsch',
            title: job.title || '',
            company: job.companyName || 'Azienda Svizzera',
            location: job.place || 'Svizzera',
            canton: job.canton || null,
            descriptionHtml: job.description || '',
            applicationUrl: fallbackUrl,
            publishedAt
          };
        }
      } catch {
        // Ignora errore parsing state
      }
    }

    return null;
  }
}
