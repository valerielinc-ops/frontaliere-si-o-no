// scripts/lib/job-page-url.mjs
//
// L'URL della pagina annuncio sul sito (`<base>/<locale>/<sezione cantone>/<slug>`),
// quella che il build emette e che il manifest delle pagine pubblicate elenca.
// Estratto da `jobPageUrl` di scripts/send-job-alerts.mjs, che ora usa questa stessa
// funzione: anche il sender delle CompanyAlert deve sapere se la pagina di un annuncio
// e' online prima di spedire, e deve costruire lo STESSO URL. Una sola implementazione:
// due copie divergerebbero in silenzio. I dati sono iniettati per non trascinare
// il sender intero come dipendenza.
//
// Pura: nessuna lettura di file. Chi la chiama passa i due JSON dei cantoni.

import { createCantonResolvers } from '../../build-plugins/shared/cantonResolvers.mjs';

/**
 * @param {object} options
 * @param {object} options.cantonSlugFile      contenuto di data/canton-url-slugs.json
 * @param {object} options.municipalitiesFile  contenuto di data/canton-municipalities.json
 * @param {string} options.baseUrl             es. https://frontaliereticino.ch
 * @param {(locale: string) => string} options.localePathPrefix
 * @returns {(job: object, locale: string) => string|null}
 */
export function createJobPageUrlResolver({ cantonSlugFile, municipalitiesFile, baseUrl, localePathPrefix }) {
  const { resolveCantonSection, resolveJobCanton } = createCantonResolvers({ cantonSlugFile, municipalitiesFile });
  return function jobPageUrl(job, locale) {
    const cantonCode = resolveJobCanton({ canton: job.canton, location: job.location });
    const jobBoardPath = resolveCantonSection(locale, cantonCode);
    const localizedJobBoardPath = `${localePathPrefix(locale)}/${jobBoardPath}`;
    const slug = job.slugByLocale?.[locale] || job.slugByLocale?.it || job.slug || '';
    return slug ? `${baseUrl}${localizedJobBoardPath}/${slug}` : null;
  };
}
