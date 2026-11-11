/**
 * Adapter per Refline (apply.refline.ch)
 * ATS svizzero leader nel settore pubblico: cantoni, ospedali cantonali,
 * dominio ETH (Empa, PSI, WSL), Zürcher Kantonalbank, comuni.
 */

export class ReflineAdapter {
  constructor({ host = 'apply.refline.ch', userAgent = 'FrontaliereBot/1.0 (+https://frontaliereticino.ch)' } = {}) {
    this.host = host;
    this.userAgent = userAgent;
  }

  /**
   * Estrae e normalizza l'ID univoco dell'annuncio dall'URL Refline.
   * Pattern: https://apply.refline.ch/<customer>/<jobId>/pub/<channel>/index.html
   */
  extractJobIdentity(urlStr) {
    if (!urlStr) return null;
    try {
      const parsed = new URL(urlStr);
      const match = /^\/([^/]+)\/([^/]+)\/pub\//i.exec(parsed.pathname);
      if (match) {
        return {
          customer: match[1],
          jobId: match[2],
          canonicalKey: `refline_${match[1]}_${match[2]}`
        };
      }
    } catch {
      // Invalid URL
    }
    return null;
  }

  /**
   * Estrae i metadati schema.org/JobPosting dal corpo HTML di un annuncio Refline.
   */
  extractJsonLdJobPosting(htmlText) {
    if (!htmlText) return null;
    const jsonLdRegex = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let match;
    while ((match = jsonLdRegex.exec(htmlText)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed['@type'] === 'JobPosting') {
          return parsed;
        }
      } catch {
        // Ignora JSON malformato
      }
    }
    return null;
  }

  mapJobPosting(jsonLd, urlStr) {
    if (!jsonLd) return null;
    const identity = this.extractJobIdentity(urlStr);
    const id = identity ? identity.canonicalKey : `refline_${Date.now()}`;

    const org = jsonLd.hiringOrganization;
    const company = (typeof org === 'string' ? org : org?.name) || 'Datore di Lavoro Svizzero';

    const address = jsonLd.jobLocation?.address;
    const location = (typeof address === 'string' ? address : address?.addressLocality) || 'Svizzera';
    const canton = address?.addressRegion || null;

    const publishedAt = jsonLd.datePosted || null;
    if (!publishedAt) return null;

    return {
      id,
      provider: 'refline',
      title: jsonLd.title || '',
      company,
      location,
      canton,
      descriptionHtml: jsonLd.description || '',
      applicationUrl: urlStr,
      publishedAt
    };
  }
}
