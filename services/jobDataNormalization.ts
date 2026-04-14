export type CanonicalJobCategory =
 | 'tech'
 | 'finance'
 | 'health'
 | 'engineering'
 | 'admin'
 | 'hospitality'
 | 'sales'
 | 'other';

export type CanonicalContractType = 'full-time' | 'part-time' | 'temporary' | 'internship' | 'contract';

type JobLike = {
 company?: string;
 companyKey?: string;
 companyDomain?: string;
 url?: string;
};

const ATS_HOST_MARKERS = [
 'joblink.allibo.com',
 '.allibo.com',
 'myworkdayjobs.com',
 'ncoreplat.com',
 'greenhouse.io',
 'lever.co',
 'smartrecruiters.com',
 'teamtailor.com',
 'personio.',
 'umantis.com',
 'zohorecruit.com',
 'arca24.careers',
 'oraclecloud.com',
 'recruitee.com',
 'successfactors.',
 'tal.net',
 'icims.com',
 'workable.com',
 'jobvite.com',
 'service-now.com',
];

function gFavicon(domain: string): string {
 return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
}

/** Clearbit Logo API — returns 128px PNG or HTTP 404 (never grey globe). */
const cLogo = (domain: string) => `https://logo.clearbit.com/${domain}`;

/**
 * Explicit logo URLs for every crawled company, keyed by companyKey.
 * Ensures correct logos regardless of ATS domain changes or Google favicon quirks.
 *
 * Logo URL guidelines:
 * 1. Prefer cLogo(domain) — Clearbit returns 404 for unknown, never grey globe
 * 2. For companies where Clearbit fails: use gFavicon(realCompanyDomain) — NOT ATS domains
 * 3. Never use gFavicon on ATS domains (myworkdayjobs.com, umantis.com, zohorecruit.com, ncoreplat.com, etc.)
 * 4. Test: a grey globe from Google favicon is exactly 726 bytes at sz=128
 */
export const CRAWLED_COMPANY_LOGOS: Record<string, string> = {
 'abb-svizzera-sede-ticino': gFavicon('abb.ch'),
 'ail-lugano': gFavicon('ail.ch'),
 'allianz-suisse': cLogo('allianz.ch'),
 'alpiq': cLogo('alpiq.com'),
 'alten-switzerland': gFavicon('alten.ch'),
 'amministrazione-cantonale-ti': gFavicon('ti.ch'),
 'artisa-group': gFavicon('artisagroup.com'),
 'avaloq': gFavicon('avaloq.com'),
 'banca-cler': gFavicon('cler.ch'),
 'banca-sempione': gFavicon('bancasempione.ch'),
 'bancastato': cLogo('bancastato.ch'),
 'board-international': gFavicon('board.com'),
 'boggi-milano': 'https://www.boggi.com/on/demandware.static/Sites-Boggi-Site/-/default/dwc9d6c35e/images/global/boggi-logo.svg',
 'bosch-thermotechnik-ag': gFavicon('bosch.ch'),
 'bps-suisse': cLogo('bps-suisse.ch'),
 'bracco': gFavicon('bracco.com'),
 'cambiavalute': gFavicon('cambiavalute.ch'),
 'capri-holdings': cLogo('capriholdings.com'),
 'caseificio-gottardo': gFavicon('caseificiodelgottardo.ch'),
 'citta-di-bellinzona': cLogo('bellinzona.ch'),
 'citta-di-locarno': cLogo('locarno.ch'),
 'citta-di-mendrisio': gFavicon('mendrisio.ch'),
 'convit-holding': 'https://convit.ch/images/convit-logo.png',
 'coop-ticino': gFavicon('coop.ch'),
 'corner-banca': gFavicon('corner.ch'),
 'damiani-group': gFavicon('damianigroup.com'),
 'delvitech-sa': 'https://legacy.delvi.tech/wp-content/uploads/2022/03/cropped-Delvi.tech_favicon.jpg',
 'dxt-commodities': 'https://dxt.com/wp-content/uploads/2025/04/logo-DXT.png',
 'efg-international': '/images/logos/efg-international.svg',
 'eoc-ente-ospedaliero-cantonale': gFavicon('eoc.ch'),
 'ermenegildo-zegna-logistica': '/images/logos/ermenegildo-zegna.svg',
 'ermenegildo-zegna': '/images/logos/ermenegildo-zegna.svg',
 'fart': gFavicon('fartiamo.ch'),
 'ffs-officine-ferrovie-federali': gFavicon('sbb.ch'),
 'fincons-group': gFavicon('finconsgroup.com'),
 'fnz': cLogo('fnz.com'),
 'galenica': gFavicon('galenica.com'),
 'goline': gFavicon('goline.ch'),
 'guess-europe': gFavicon('guess.eu'),
 'has-healthcare': cLogo('has-pharma.com'),
 'hopital-du-valais': gFavicon('valaishospital.ch'),
 'ibsa-institut-biochimique': 'https://rmkcdn.successfactors.com/0628fab4/f37d25aa-93c8-4480-bb16-3.png',
 'julius-baer': cLogo('juliusbaer.com'),
 'kantonsspital-graubuenden-ksgr': gFavicon('ksgr.ch'),
 'la-fonte': gFavicon('lafonte.ch'),
 'lastminute-com': gFavicon('lastminute.com'),
 'lidl-svizzera': gFavicon('lidl.ch'),
 'linnea': 'https://www.linnea.ch/wp-content/uploads/2023/10/cropped-favicon-192x192.png',
 'lis-lugano-istituti-sociali': gFavicon('lugano-lis.ch'),
 'lwphr': gFavicon('lwphr.ch'),
 'manor': gFavicon('manor.ch'),
 'medacta-international': 'https://www.medacta.com/images/header/Logo_Medacta.svg',
 'migros-ticino': gFavicon('migros.ch'),
 'mtic-group': gFavicon('mtic-group.org'),
 'oscam': gFavicon('oscam.ch'),
 'otis': cLogo('otis.com'),
 'pkb-private-bank': cLogo('pkb.ch'),
 'posta-svizzera-centro-regionale': 'https://ohws.prospective.ch/directlink/1002253030/assets/images/logos/post_logo_2023.svg',
 'prada': '/images/logos/prada-group.svg',
 'rapelli': cLogo('rapelli.ch'),
 'relewant': cLogo('relewant.com'),
 'rivopharm': cLogo('rivopharm.com'),
 'ruag-ag': gFavicon('ruag.ch'),
 'schindler': gFavicon('schindler.com'),
 'sintetica': cLogo('sintetica.com'),
 'skyguide-sa': gFavicon('skyguide.ch'),
 'supsi-dti': gFavicon('supsi.ch'),
 'swisscom-sede-ticino': gFavicon('swisscom.ch'),
 'swiss-medical-network': cLogo('swissmedical.net'),
 'the-living-circle': gFavicon('thelivingcircle.ch'),
 'tsmg': cLogo('tsmg.co'),
 'usi-universita-della-svizzera-italiana': gFavicon('usi.ch'),
 'vf-international-the-north-face-timberland': gFavicon('vfc.com'),
 'zambon': cLogo('zambon.com'),
 'zucchetti-switzerland': gFavicon('zucchetti.com'),
 'zurich-insurance-sede-ticino': gFavicon('zurich.ch'),
};

const CATEGORY_ALIASES: Record<string, CanonicalJobCategory> = {
 tech: 'tech',
 it: 'tech',
 software: 'tech',
 engineering: 'engineering',
 'quality assurance': 'engineering',
 quality: 'engineering',
 operations: 'engineering',
 production: 'engineering',
 regulatory: 'health',
 'medical affairs': 'health',
 health: 'health',
 healthcare: 'health',
 finance: 'finance',
 admin: 'admin',
 administration: 'admin',
 hr: 'admin',
 'human resources': 'admin',
 'general services': 'admin',
 sales: 'sales',
 marketing: 'sales',
 hospitality: 'hospitality',
 other: 'other',
};

function normalizeText(value: unknown): string {
 return String(value || '')
 .trim()
 .toLowerCase()
 .normalize('NFD')
 .replace(/[\u0300-\u036f]/g, '')
 .replace(/[^a-z0-9]+/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();
}

function normalizeDomain(input: unknown): string {
 const raw = String(input || '').trim().toLowerCase();
 if (!raw) return '';
 const withoutProtocol = raw.replace(/^https?:\/\//, '');
 const host = withoutProtocol.split('/')[0].replace(/^www\./, '');
 return host;
}

function toBaseDomain(host: string): string {
 const clean = normalizeDomain(host);
 if (!clean) return '';
 const parts = clean.split('.').filter(Boolean);
 if (parts.length <= 2) return clean;
 return parts.slice(-2).join('.');
}

export function hostFromExternalUrl(raw?: string): string {
 try {
 return toBaseDomain(new URL(String(raw || '')).hostname);
 } catch {
 return '';
 }
}

function isAtsHost(host: string): boolean {
 if (!host) return false;
 return ATS_HOST_MARKERS.some((marker) => host.includes(marker));
}

function looksLike(value: string, regex: RegExp): boolean {
 return regex.test(value);
}

export function normalizeJobCategory(raw: unknown, hintText = ''): CanonicalJobCategory {
 const rawNorm = normalizeText(raw);
 const hintNorm = normalizeText(hintText);

 if (rawNorm && CATEGORY_ALIASES[rawNorm]) {
 if (rawNorm === 'general services' && looksLike(hintNorm, /(manutent|mainten|elettro|mechanic|tecnic|facility)/)) {
 return 'engineering';
 }
 return CATEGORY_ALIASES[rawNorm];
 }

 const combined = `${rawNorm} ${hintNorm}`.trim();
 if (!combined) return 'other';

 if (looksLike(combined, /(web developer|software|sistemista|devops|cloud|robotics|c\+\+)/)) return 'tech';
 if (looksLike(combined, /(manutent|mainten|elettro|mechanic|ingegner|engineer|fresator|tornitor|quality|operations|production|r d|research|sviluppo)/)) return 'engineering';
 if (looksLike(combined, /(medical|clinical|healthcare|health care|medic|orthopedic|orthopaedic|regulatory|medical affairs)/)) return 'health';
 if (looksLike(combined, /(finance|account|audit|treasury|contabil|controll)/)) return 'finance';
 if (looksLike(combined, /(sales|marketing|commercial|product manager|business development|communication)/)) return 'sales';
 if (looksLike(combined, /(hr|human resources|recruit|talent|admin|amministr|servizi general|event|travel)/)) return 'admin';
 if (looksLike(combined, /(hotel|hospitality|ristor|bar|chef|camerier)/)) return 'hospitality';

 return 'other';
}

export function normalizeJobContract(raw: unknown, title = '', description = ''): CanonicalContractType {
 const rawText = `${String(raw || '')} ${String(title || '')} ${String(description || '')}`;
 const norm = normalizeText(rawText);

 const percent = Number((rawText.match(/\b(\d{1,3})\s*%/)?.[1] || ''));
 if (Number.isFinite(percent) && percent > 0 && percent < 90) return 'part-time';

 if (looksLike(norm, /(thesis|intern|internship|stage|tirocin|apprendist|praktikum)/)) return 'internship';
 if (looksLike(norm, /(part time|tempo parziale|teilzeit|temps partiel)/)) return 'part-time';
 if (looksLike(norm, /(temp|temporary|determinato|fixed term|befristet)/)) return 'temporary';
 if (looksLike(norm, /(contractor|freelance|consul|progetto|projektvertrag|contract)/)) return 'contract';
 if (looksLike(norm, /(permanent|indeterminato|full time|vollzeit|temps plein|fulltime)/)) return 'full-time';

 return 'full-time';
}

function normalizeCompanyIdentity(value: unknown): string {
 return normalizeText(value).replace(/\s+/g, ' ');
}

function isMedacta(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('medacta');
}

function isVf(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('vf international') || identity.includes('north face') || identity.includes('timberland');
}

function isEfg(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('efg international');
}

function isDelvitech(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('delvitech');
}

function isFincons(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('fincons');
}

function isConvit(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('convit');
}

function isGoline(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('goline');
}

function isLivingCircle(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('living circle');
}

function isBracco(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('bracco');
}

function isBoggi(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('boggi');
}

function isSwisscom(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('swisscom');
}

function isSunrise(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('sunrise');
}

function isAriston(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('ariston');
}

function isBosch(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('bosch');
}

function isRittmeyer(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity.includes('rittmeyer');
}

function isLinea(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return identity === 'linea' || identity.startsWith('linea ');
}

function isUsi(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return (
 identity.includes('usi')
 || identity.includes('universita della svizzera italiana')
 || identity.includes('università della svizzera italiana')
 );
}

function isAmministrazioneCantonaleTi(job: JobLike): boolean {
 const identity = normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`);
 return (
 identity.includes('amministrazione cantonale ticino')
 || identity.includes('amministrazione cantonale ti')
 || identity.includes('concorsi ti')
 );
}

/**
 * Patterns that indicate a job location is non-geographic (multi-location / abroad /
 * "depending on function"). These strings should be normalised in the UI rather than
 * displayed verbatim as if they were a city or canton.
 *
 * The regex is intentionally broad enough to cover German, French, and Italian
 * variants that appear in Swiss federal job portals.
 */
const MULTI_LOCATION_PATTERNS = /\b(in\s*?-?\s*?und\s+ausland|schweiz\s+und\s+ausland|suisse\s+et\s+(?:l.)?étranger|svizzera\s+e\s+(?:l.)?estero|abhängig\s+von\s+funktion|einsatzort|verschiedene\s+standorte|multiple\s+locations?|several\s+locations?|ganz\s+schweiz|toute\s+la\s+suisse)\b/i;

/**
 * Returns whether a raw `location` value represents a non-geographic description
 * (e.g. "Schweiz und Ausland (abhängig von Funktion und Einsatzort)") rather than
 * a concrete city or region. When true, callers should display a locale-appropriate
 * neutral label instead of the raw string.
 */
export function isMultiLocation(location: unknown): boolean {
 if (!location) return false;
 return MULTI_LOCATION_PATTERNS.test(String(location));
}

export function resolveCompanyWebsiteHost(job: JobLike): string {
 const explicitHost = toBaseDomain(job.companyDomain || '');
 const urlHost = hostFromExternalUrl(job.url);

 if (isMedacta(job)) return 'medacta.com';
 if (isVf(job)) return 'vfc.com';
 if (isEfg(job)) return 'efginternational.com';
 if (isDelvitech(job)) return 'delvi.tech';
 if (isFincons(job)) return 'finconsgroup.com';
 if (isConvit(job)) return 'convit.ch';
 if (isGoline(job)) return 'goline.ch';
 if (isLivingCircle(job)) return 'thelivingcircle.ch';
 if (isBracco(job)) return 'bracco.com';
 if (isBoggi(job)) return 'boggi.com';
 if (isSwisscom(job)) return 'swisscom.ch';
 if (isSunrise(job)) return 'sunrise.ch';
 if (isAriston(job)) return 'aristongroup.com';
 if (isBosch(job)) return 'bosch.ch';
 if (isRittmeyer(job)) return 'rittmeyer.com';
 if (isLinea(job)) return 'linea.ch';
 if (isUsi(job)) return 'irsol.usi.ch';
 if (normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`).includes('posta svizzera')
 || normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`).includes('post ch')
 || normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`).includes('posta-svizzera-centro-regionale')) {
 return 'post.ch';
 }
 if (isAmministrazioneCantonaleTi(job)) return 'ti.ch';

 if (explicitHost && !isAtsHost(explicitHost)) return explicitHost;
 if (urlHost && !isAtsHost(urlHost)) return urlHost;

 if (explicitHost) return explicitHost;
 if (urlHost) return urlHost;
 return '';
}

export function resolveCompanyLogoUrl(job: JobLike): string | null {
 // 1. Explicit crawled-company logo map (most reliable)
 const key = job.companyKey || '';
 if (key && CRAWLED_COMPANY_LOGOS[key]) {
 return CRAWLED_COMPANY_LOGOS[key];
 }

 // 2. Identity-based fallbacks for variant company names / keys
 if (isMedacta(job)) return CRAWLED_COMPANY_LOGOS['medacta-international'];
 if (isVf(job)) return CRAWLED_COMPANY_LOGOS['vf-international-the-north-face-timberland'];
 if (isEfg(job)) return CRAWLED_COMPANY_LOGOS['efg-international'];
 if (isDelvitech(job)) return CRAWLED_COMPANY_LOGOS['delvitech-sa'];
 if (isFincons(job)) return CRAWLED_COMPANY_LOGOS['fincons-group'];
 if (isConvit(job)) return CRAWLED_COMPANY_LOGOS['convit-holding'];
 if (isGoline(job)) return CRAWLED_COMPANY_LOGOS['goline'];
 if (isLivingCircle(job)) return CRAWLED_COMPANY_LOGOS['the-living-circle'];
 if (isBracco(job)) return CRAWLED_COMPANY_LOGOS['bracco'];
 if (isBoggi(job)) return CRAWLED_COMPANY_LOGOS['boggi-milano'];
 if (isSwisscom(job)) return CRAWLED_COMPANY_LOGOS['swisscom-sede-ticino'];
 if (isAriston(job)) return gFavicon('aristongroup.com');
 if (isBosch(job)) return CRAWLED_COMPANY_LOGOS['bosch-thermotechnik-ag'];
 if (isRittmeyer(job)) return gFavicon('rittmeyer.com');
 if (isUsi(job)) return CRAWLED_COMPANY_LOGOS['usi-universita-della-svizzera-italiana'];
 if (normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`).includes('posta svizzera')
 || normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`).includes('post ch')
 || normalizeCompanyIdentity(`${job.company || ''} ${job.companyKey || ''}`).includes('posta-svizzera-centro-regionale')) {
 return CRAWLED_COMPANY_LOGOS['posta-svizzera-centro-regionale'];
 }

 // 3. Domain-based resolution for non-crawled companies
 const host = resolveCompanyWebsiteHost(job);
 if (!host) return null;
 return gFavicon(host);
}
