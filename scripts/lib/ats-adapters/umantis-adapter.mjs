/**
 * Adapter per Abacus Umantis (recruitingapp-*.umantis.com / portali aziendali svizzeri)
 * Utilizzato da Bobst, industrie manifatturiere e orologiere, banche private svizzere.
 */

export class UmantisAdapter {
  constructor({ userAgent = 'FrontaliereBot/1.0 (+https://frontaliereticino.ch)' } = {}) {
    this.userAgent = userAgent;
  }

  /**
   * Estrae i link alle offerte e l'eventuale token di paginazione successiva dal markup HTML.
   */
  parseListingPage(htmlText, baseUrl) {
    const jobs = [];
    if (!htmlText) return { jobs, nextHref: null };

    // Cerca attributo di paginazione successiva data-pagination-next-href="?tc..."
    const nextMatch = /data-pagination-next-href=["']([^"']+)["']/i.exec(htmlText);
    const nextHref = nextMatch ? new URL(nextMatch[1], baseUrl).toString() : null;

    // Cerca link alle posizioni: /Vacancies/<id>/Description/<lang>
    const vacancyRegex = /href=["']([^"']*\/Vacancies\/(\d+)\/Description\/[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const seenIds = new Set();

    while ((match = vacancyRegex.exec(htmlText)) !== null) {
      const relHref = match[1];
      const vacancyId = match[2];
      const rawTitle = match[3].replace(/<[^>]*>/g, '').trim();

      if (!seenIds.has(vacancyId) && rawTitle) {
        seenIds.add(vacancyId);
        const fullUrl = new URL(relHref, baseUrl).toString();
        jobs.push({
          id: `umantis_${vacancyId}`,
          provider: 'umantis',
          title: rawTitle,
          applicationUrl: fullUrl,
          vacancyId
        });
      }
    }

    return { jobs, nextHref };
  }

  mapJob(vacancyId, title, company, location, htmlBody, applicationUrl) {
    return {
      id: `umantis_${vacancyId}`,
      provider: 'umantis',
      title: title || '',
      company: company || 'Azienda Svizzera',
      location: location || 'Svizzera',
      canton: null,
      descriptionHtml: htmlBody || '',
      applicationUrl: applicationUrl || '',
      publishedAt: new Date().toISOString()
    };
  }
}
