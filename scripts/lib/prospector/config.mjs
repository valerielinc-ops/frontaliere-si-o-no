/**
 * Prospector — shared configuration.
 *
 * The prospector is the autonomous coverage loop: it discovers Swiss employers
 * we do NOT crawl yet, works out which ATS platform hosts their vacancies,
 * synthesises a crawler for them, and grades the result against the live page.
 *
 * Design note — why platform-first. Resolving `company name -> careers page` is
 * hard and lossy for micro-employers. Resolving `platform -> tenant -> company`
 * is cheap and enumerable: a hosted ATS has a finite tenant list, and one
 * family parser serves every tenant on it. So the loop spends its effort
 * learning PLATFORMS, and companies fall out as a by-product. This is what
 * makes small employers reachable at all — they never build a careers page,
 * they rent one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from this file so cwd never matters. */
export const ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Where the big crawl datasets live. Normally `<repo>/data`, but a sparse
 * worktree deliberately excludes `data/` (6,7 GB of tracked assets), so a local
 * run points this at the full checkout instead of materialising them. CI has
 * the real thing and never sets it.
 */
export const DATA_ROOT = process.env.PROSPECTOR_DATA_ROOT || path.join(ROOT, 'data');

export const PROSPECTOR_DIR = path.join(ROOT, 'data', 'prospector');
export const PLATFORMS_PATH = path.join(PROSPECTOR_DIR, 'platforms.json');
export const CANDIDATES_PATH = path.join(PROSPECTOR_DIR, 'candidates.json');
export const LEDGER_PATH = path.join(PROSPECTOR_DIR, 'ledger.jsonl');
export const VALIDATION_PATH = path.join(PROSPECTOR_DIR, 'validation.json');

/**
 * Identifying UA. Reuses the crawler-wide override so a single env var
 * retunes every outbound request the repo makes.
 */
export const UA = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/2.0; +https://frontaliereticino.ch/)';

/** Per-host politeness: minimum gap between two requests to the same host. */
export const HOST_DELAY_MS = Number(process.env.PROSPECTOR_HOST_DELAY_MS || 1100);

/** Global concurrency across all hosts. */
export const CONCURRENCY = Number(process.env.PROSPECTOR_CONCURRENCY || 6);

export const FETCH_TIMEOUT_MS = Number(process.env.PROSPECTOR_TIMEOUT_MS || 15000);

/** Swiss cantons, used to fan discovery sources out over the whole country. */
export const CANTONS = [
  'AG', 'AI', 'AR', 'BE', 'BL', 'BS', 'FR', 'GE', 'GL', 'GR', 'JU', 'LU', 'NE',
  'NW', 'OW', 'SG', 'SH', 'SO', 'SZ', 'TG', 'TI', 'UR', 'VD', 'VS', 'ZG', 'ZH',
];

/**
 * Career-page path hints in the four site locales. Ordered by hit rate observed
 * on Swiss SME sites — Italian first because Ticino is the loop's home market
 * and its employers are the least covered by the national job boards.
 */
export const CAREER_PATH_HINTS = [
  '/lavora-con-noi', '/lavora-con-noi/', '/it/lavora-con-noi/', '/posizioni-aperte',
  '/opportunita-di-lavoro', '/lavoro', '/carriere',
  '/jobs', '/jobs/', '/careers', '/careers/', '/career',
  '/karriere', '/karriere/', '/offene-stellen', '/stellen', '/stellenangebote',
  '/emplois', '/carrieres', '/nous-rejoindre', '/postes-vacants',
  '/chi-siamo/lavora-con-noi', '/azienda/lavora-con-noi', '/it/azienda/lavora-con-noi/',
];

/**
 * Anchor text / href tokens that mark a careers link, all four locales.
 * Deliberately broad: a false positive costs one HTTP request, a false negative
 * costs a whole employer.
 */
export const CAREER_TOKEN_RX =
  /(lavora[\s-]?con[\s-]?noi|posizioni[\s-]?aperte|posti[\s-]?liberi|offerte[\s-]?di[\s-]?lavoro|opportunit[aà]|carrier[ae]|karriere|offene[\s-]?stellen|stellenangebote|stellen|jobs?\b|job[\s-]?board|emplois?|carri[eè]res?|nous[\s-]?rejoindre|arbeiten[\s-]?bei|vacanc|recruit|bewerb|candidat|unisciti|join[\s-]?us|work[\s-]?with[\s-]?us|we[\s-]?are[\s-]?hiring)/i;

/**
 * Hosts that are never a company's own ATS: social, CDNs, analytics, and the
 * national job boards. A careers link pointing here says nothing about where
 * the employer actually publishes, so it must not seed a platform candidate.
 *
 * The national boards (jobs.ch, jobup.ch, indeed) are excluded on purpose: they
 * are aggregators we already read, and treating them as a "platform" would make
 * the loop rediscover the coverage we already have instead of the coverage we
 * lack.
 */
export const NON_PLATFORM_HOSTS = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'xing.com', 'wa.me', 'whatsapp.com',
  'google.com', 'googleapis.com', 'gstatic.com', 'googletagmanager.com',
  'gmpg.org', 'w3.org', 'schema.org', 'wordpress.org', 'wp.com',
  'office.com', 'microsoft.com', 'sharepoint.com', 'adobe.com',
  'jobs.ch', 'jobup.ch', 'indeed.com', 'indeed.ch', 'stepstone.ch',
  'monster.ch', 'jobscout24.ch', 'ostjob.ch', 'jobagent.ch',
  'job-room.ch', 'arbeit.swiss', 'eures.europa.eu',
  'youtu.be', 'issuu.com', 'vimeo.com', 'cookiebot.com', 'cloudflare.com',
  // App stores: a careers page that advertises the employer's own app links
  // here, and the store listing scores as a vacancy page because it repeats a
  // templated URL under job-ish copy. Measured false positive (itunes.apple.com
  // scored 5.2 for jobup.ch).
  'apple.com', 'itunes.apple.com', 'apps.apple.com', 'play.google.com',
  // Further aggregators and staffing marketplaces: real vacancy pages, but
  // coverage we already have or intend to reach as a source, not as a platform.
  'jobscout24.ch', 'jobwinner.ch', 'topjobs.ch', 'jobsuchmaschine.ch',
  'glassdoor.com', 'glassdoor.ch', 'karriere.at', 'stepstone.de',
]);

/**
 * A platform is only promoted from `candidate` to `confirmed` once this many
 * UNRELATED employers have been observed pointing at it. Two is enough to rule
 * out "the company happens to own a second domain", which is the dominant false
 * positive, while still promoting a niche vendor after a single extra sighting.
 */
export const PLATFORM_CONFIRM_THRESHOLD = Number(process.env.PROSPECTOR_CONFIRM_AT || 2);
