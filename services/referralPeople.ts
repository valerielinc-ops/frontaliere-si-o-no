/**
 * Generates direct LinkedIn People tab links or search URLs for companies and schools.
 * Ported and hardened from Freehire's referralPeople module.
 */

/**
 * Calcola l'URL diretto alla scheda "People" dell'azienda su LinkedIn,
 * oppure effettua il fallback su una ricerca persone mirata per nome azienda.
 *
 * @param companyName Nome testuale dell'azienda (es. "Rolex", "UBS", "Novartis")
 * @param linkedInPageUrl URL opzionale del profilo LinkedIn aziendale già noto
 * @returns URL LinkedIn formattato, oppure null se companyName è vuoto
 */
export function getLinkedInPeopleSearchUrl(companyName: string, linkedInPageUrl?: string | null): string | null {
  const name = companyName ? companyName.trim() : '';
  if (!name) return null;

  if (linkedInPageUrl) {
    try {
      const parsed = new URL(linkedInPageUrl.trim());
      const host = parsed.hostname.toLowerCase();
      const isLinkedInHost = host === 'linkedin.com' || host.endsWith('.linkedin.com');
      const isHttp = parsed.protocol === 'https:' || parsed.protocol === 'http:';

      if (isHttp && isLinkedInHost) {
        const match = /^\/(company|school)\/([^/]+)(?:\/people)?\/?$/i.exec(parsed.pathname);
        if (match) {
          const kind = match[1].toLowerCase();
          const slug = match[2];
          return `https://www.linkedin.com/${kind}/${slug}/people/`;
        }
      }
    } catch {
      // In caso di URL malformato o invalid URI, procedi verso il fallback
    }
  }

  const searchUrl = new URL('https://www.linkedin.com/search/results/people/');
  searchUrl.searchParams.set('keywords', name);
  return searchUrl.toString();
}

/** Alias for Freehire compatibility */
export const referralPeopleUrl = getLinkedInPeopleSearchUrl;
