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
const TI_JOB_BOARD_PATH = `/${SECTION_LEGACY_TI.it}`;

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
  '/fr/articles-frontalier/frais-de-transit-suisse-2026/',
  '/fr/articles-frontalier/heures-de-travail-semanelles-suisses-en-2025/',
  '/fr/articles-frontalier/permis-g-vs-b-frontalier-2026-erreurs-communes/',
].map((path) => BING_SEO_BASE_URL + path);

export const BING_INDEXNOW_REMEDIATION_URLS = [
  BING_SEO_BASE_URL + `${TI_JOB_BOARD_PATH}/cuoca-cuoco-m-w-d-coop-ristorante-tenero-contra-ticino-wa2cmo/`,
  BING_SEO_BASE_URL + `${TI_JOB_BOARD_PATH}/montatore-trice-di-impianti-sanitari-per-cucine-bagni-fust-giubiasco/`,
  BING_SEO_BASE_URL + '/cerca-lavoro-vaud/100-cdd-atsso-hirslanden-klinik-lausanne/',
  BING_SEO_BASE_URL + '/cerca-lavoro-neuchatel/surveillant-e-en-magasin-neuchatel-jura-coop-renens-1-vy627n/',
  BING_SEO_BASE_URL + '/eventi/ticino/brissago/mutanti-mostra-fotografica-di-daniel-pittet-2026-09-01/',
  BING_SEO_BASE_URL + '/eventi/basilea/basel/top-secret-friends-2026-2026-09-10/',
];

// Route-level contracts for URLs surfaced by the Bing audit. These stay
// outside the sitemap crawl: retired aliases and edge redirects are checked
// for their HTTP status, while the employer landing is checked as indexable.
export const BING_ROUTE_CONTRACTS = [
  { path: '/jobs-im-tessin/', expectedStatus: 301, location: '/de/jobs-im-tessin/' },
  { path: '/grenzgaenger-artikel/', expectedStatus: 301, location: '/de/grenzgaenger-artikel/' },
  { path: '/trouver-emploi-tessin/', expectedStatus: 301, location: '/fr/trouver-emploi-tessin/' },
  { path: '/nav:pension/', expectedStatus: 301, location: '/tasse-e-pensione/calcola-previdenza/' },
  { path: '/servizi-partner/', expectedStatus: 301, location: '/' },
  { path: '/en/partner-services/', expectedStatus: 301, location: '/en/' },
  { path: '/de/partner-dienste/', expectedStatus: 301, location: '/de/' },
  { path: '/fr/services-partenaires/', expectedStatus: 301, location: '/fr/' },
  { path: '/job-board/', expectedStatus: 301, location: '/cerca-lavoro-svizzera/' },
  { path: '/calcolatore-5x1000/', expectedStatus: 410 },
  { path: '/per-le-aziende/', expectedStatus: 200 },
  { path: '/en/for-employers/', expectedStatus: 200 },
  { path: '/de/fuer-unternehmen/', expectedStatus: 200 },
  { path: '/fr/pour-les-entreprises/', expectedStatus: 200 },
].map((contract) => ({ ...contract, url: BING_SEO_BASE_URL + contract.path }));

export const BING_HOMEPAGE_URL = BING_SEO_BASE_URL + '/';
