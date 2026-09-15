/**
 * Stable inputs for the Bing SEO closed loop.
 *
 * The desired article titles live in the corpus repository. This site-side
 * policy intentionally stores only the affected live URLs: the site audits
 * the HTTP contract, while the corpus owns editorial source strings.
 */

import { SECTION_LEGACY_TI } from '../../build-plugins/shared/cantonResolvers.mjs';

export const BING_SEO_BASE_URL = 'https://frontaliereticino.ch';
export const BING_TITLE_MAX_CHARS = 66;
const TI_JOB_BOARD_ROOT = `/${SECTION_LEGACY_TI.it}`;

export const BING_TITLE_AUDIT_URLS = [
  '/articoli-svizzera/dati-tasse-frontalieri-italia/',
  '/articoli-svizzera/frontaliere-assicurazione-auto-confronto/',
  '/articoli-svizzera/frontaliere-credito-imposta-2026-famiglia-con-figli/',
  '/articoli-svizzera/frontaliere-doppia-imposizione-credito-imposta/',
  '/articoli-svizzera/frontaliere-licenziamento-diritti-2026/',
  '/articoli-svizzera/frontaliere-pensionamento-anticipato-2026-oltre-20km/',
  '/articoli-svizzera/parrucchieri-frontaliere-ticino/',
  '/articoli-svizzera/quadro-rw-2026-chi-dichiara-conto-svizzero/',
  '/de/grenzgaenger-artikel/antikmarkt-mendrisio-2026/',
  '/de/grenzgaenger-artikel/gesundheitssteuer-grenzgaenger-tessin-2026/',
  '/de/grenzgaenger-artikel/monte-lema-bahn-saison-2026/',
  '/de/schweiz-artikel/aufenthaltsbewilligung-b-quellensteuer-2026/',
  '/fr/articles-frontalier/autoroute-a9-fermee-la-nuit-2026/',
  '/fr/articles-frontalier/frais-de-transit-suisse/',
  '/fr/articles-frontalier/heures-de-travail-semanelles-suisses-en-2025/',
  '/fr/articles-frontalier/permis-g-vs-b-frontalier-2026-erreurs-communes/',
].map((path) => BING_SEO_BASE_URL + path);

export const BING_INDEXNOW_REMEDIATION_URLS = [
  BING_SEO_BASE_URL + TI_JOB_BOARD_ROOT + '/cuoca-cuoco-m-w-d-coop-ristorante-tenero-contra-ticino-wa2cmo/',
  BING_SEO_BASE_URL + TI_JOB_BOARD_ROOT + '/montatore-trice-di-impianti-sanitari-per-cucine-bagni-fust-giubiasco/',
  BING_SEO_BASE_URL + '/cerca-lavoro-vaud/100-cdd-atsso-hirslanden-klinik-lausanne/',
  BING_SEO_BASE_URL + '/cerca-lavoro-neuchatel/surveillant-e-en-magasin-neuchatel-jura-coop-renens-1-vy627n/',
  BING_SEO_BASE_URL + '/eventi/ticino/brissago/mutanti-mostra-fotografica-di-daniel-pittet-2026-09-01/',
  BING_SEO_BASE_URL + '/eventi/basilea/basel/top-secret-friends-2026-2026-09-10/',
];

export const BING_HOMEPAGE_URL = BING_SEO_BASE_URL + '/';
