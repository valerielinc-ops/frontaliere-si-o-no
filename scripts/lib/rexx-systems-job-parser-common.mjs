#!/usr/bin/env node
/**
 * Shared factory for Swiss employers using the **rexx systems** ATS
 * (rexx-systems.com GmbH, Hamburg DE — widely used by Swiss hospitals,
 * public administrations and mid-sized companies).
 *
 * Multi-tenant SaaS — each employer gets its own subdomain. Common shapes:
 *   - jobs.{slug}.ch / stellen.{slug}.ch
 *   - {slug}.recruiting.rexx-recruitment.com
 *
 * The public listing endpoint is always `/stellenangebote.html` (or `/`
 * which redirects there) and serves a fully server-rendered HTML page.
 *
 * Page anatomy
 * ────────────
 *   <div class="joboffer_container" onclick="window.location.href='{detailUrl}'">
 *     <div class="joboffer_title_text joboffer_box">
 *       <a target="_self" href="{detailUrl}">{TITLE}</a>
 *     </div>
 *     <!-- optional commented-out informations block with location -->
 *   </div>
 *
 * Detail-page anatomy (varies by tenant, but always headline-driven):
 *   <h1>{title}</h1>
 *   <h2>Ihre Aufgaben / Ihre Herausforderung / Aufgabengebiet</h2> {content}
 *   <h2>Ihr Profil / Anforderungen / Was Sie mitbringen</h2>      {content}
 *   <h2>Unser Angebot / Wir bieten</h2>                            {content}
 *   <h2>Interessiert?</h2>                                          {contact}
 *
 * The detail URL slug follows the pattern `/{Job-Slug}-de-j{NUMERIC_ID}.html`,
 * which we use as the stable job identifier.
 *
 * Known tenants in this codebase:
 *   - zgks      (Zuger Kantonsspital)
 *   - spital-schwyz
 *   - ksuri     (Kantonsspital Uri, served on stellen.ksuri.ch)
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';

const USER_AGENT = process.env.JOBS_CRAWLER_USER_AGENT
  || 'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  uuml: 'ü', ouml: 'ö', auml: 'ä', Uuml: 'Ü', Ouml: 'Ö', Auml: 'Ä',
  szlig: 'ß', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
  agrave: 'à', acirc: 'â', ccedil: 'ç', oelig: 'œ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—',
  laquo: '«', raquo: '»', middot: '·', hellip: '…',
};

function decodeEntities(s = '') {
  return String(s || '')
    .replace(/&([a-zA-Z]+);/g, (m, name) => Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m)
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function normalize(s = '') {
  return String(s || '').trim().toLowerCase();
}

function normalizeSpace(s = '') {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

async function fetchHtml(url) {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/* ── Listing extractor ───────────────────────────────────── */

/**
 * Extract jobs from a rexx-systems `/stellenangebote.html` page.
 *
 * @param {string} html
 * @returns {Array<{ id:string, title:string, detailUrl:string }>}
 */
export function parseRexxListing(html = '') {
  const out = [];
  const seen = new Set();
  // Some tenants use <div class="joboffer_container">, others <article class="joboffer_container">.
  // We just need the onclick href + the inner anchor text.
  const rx = /<(?:div|article)[^>]*class="joboffer_container"[^>]*onclick="window\.location\.href='([^']+)'"[^>]*>([\s\S]*?<a[^>]+href="[^"]+"[^>]*>[^<]+<\/a>)/g;
  let m;
  while ((m = rx.exec(html))) {
    const detailUrl = m[1];
    const inner = m[2];
    const linkMatch = inner.match(/<a[^>]+href="[^"]+"[^>]*>([^<]+)<\/a>/);
    if (!linkMatch) continue;
    const title = normalizeSpace(decodeEntities(linkMatch[1]));
    if (!title || title.length < 3) continue;
    // Extract numeric job id from `…-j{NUMBER}.html`
    const idMatch = detailUrl.match(/-j(\d+)\.html?$/i);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title, detailUrl });
  }
  return out;
}

/* ── Detail extractor ────────────────────────────────────── */

// Headlines that introduce real job content (German). Order matters: we
// concatenate sections in source order, but only between these markers.
const CONTENT_HEADLINE_RX = /^(Ihre\s+Aufgaben|Ihre\s+Herausforderung|Aufgabengebiet|Aufgaben|Ihre\s+Tätigkeit|Tätigkeitsbeschreibung|Ihr\s+Profil|Ihr\s+\s*Profil|Anforderungen|Was\s+Sie\s+mitbringen|Ihre\s+Qualifikation|Unser\s+Angebot|Wir\s+bieten|Wir\s+bieten\s+Ihnen|Das\s+bieten\s+wir|Interessiert|Ihr\s+Kontakt|Ihre\s+Bewerbung|Über\s+uns|Deine\s+Aufgaben|Dein\s+Profil|Deine\s+Perspektiven|Deine\s+Herausforderung|Deine\s+Qualifikation|Deine\s+Tätigkeit|Wir\s+freuen\s+uns)\b/i;

// Headlines that signal the END of the job content (cookie consent etc.).
const STOP_HEADLINE_RX = /^(Notwendige\s+Cookies|Webstatistik|Soziale\s+Netzwerke|Cookie|Datenschutz|Impressum|Newsletter)\b/i;

function stripHtmlInline(raw = '') {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ');
}

/**
 * Extract title + description sections from a rexx-systems detail page.
 *
 * @param {string} html
 * @returns {{ title:string, description:string }}
 */
export function extractRexxDetail(html = '') {
  if (!html || typeof html !== 'string') return { title: '', description: '' };

  // Strip noisy regions
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '');

  // Title = <h1>
  const titleMatch = cleaned.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const title = titleMatch ? normalizeSpace(decodeEntities(titleMatch[1])) : '';

  // Walk all <h2>/<h3> headers in order; capture text between consecutive ones.
  const headers = [...cleaned.matchAll(/<h([23])[^>]*>([^<]+)<\/h[23]>/g)];
  const parts = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const label = normalizeSpace(decodeEntities(h[2]));
    if (STOP_HEADLINE_RX.test(label)) break;
    if (!CONTENT_HEADLINE_RX.test(label)) continue;
    const start = h.index + h[0].length;
    const end = i + 1 < headers.length ? headers[i + 1].index : cleaned.length;
    const inner = cleaned.slice(start, end);
    const text = normalizeSpace(decodeEntities(stripHtmlInline(inner))).replace(/\s*•\s*/g, '\n• ');
    if (!text) continue;
    parts.push(`${label}:\n${text}`);
  }

  return { title, description: parts.join('\n\n') };
}

/* ── Classifiers ─────────────────────────────────────────── */

function detectCategory(title = '') {
  const t = normalize(title);
  if (/\b(pflege|pflegefach|stationsleitung|fage|spitex|nachtwache|geburts|hebamme)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(arzt|ärztin|oberarzt|chefarzt|leitend|medizin|chirurg|anästhes|onkolog|kardiolog|neurolog|pädiatr|gynäk|psychi|geriatr)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(labor|laborant|biomedizin|radiolog|röntgen|mtra|mrt|physiother|ergo|logopäd|rehabilit|apothek|pharma)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(praxisassistent|mpa|mfa)/.test(t)) return 'Sanità / Ospedali';
  if (/\b(techni|haustechni|facility|wartung)/.test(t)) return 'Tecnica';
  if (/\b(it|software|develop|programm|system|informatik)/.test(t)) return 'IT';
  if (/\b(admin|sekret|buchhalt|sachbearbeiter|finanz|controll|account)/.test(t)) return 'Amministrazione';
  if (/\b(hr|human|personal|talent|recruit)/.test(t)) return 'Risorse Umane';
  if (/\b(küche|koch|gastro|hauswirtschaft|reinigung|hotellerie)/.test(t)) return 'Ospitalità';
  if (/\b(logist|magazz|lager|einkauf|transport)/.test(t)) return 'Logistica';
  if (/\b(lernend|praktik|ausbildung|apprenti)/.test(t)) return 'Formazione';
  return 'Sanità / Ospedali';
}

function detectExperienceLevel(title = '') {
  const t = normalize(title);
  if (/\b(praktik|stage|intern|lehrling|lernend|apprenti|unterassistent)/.test(t)) return 'intern';
  if (/\b(junior|jr|assistent)/.test(t)) return 'junior';
  if (/\b(senior|sr|lead|head|director|chef|verantwort|leiter|leitend|stationsleitung|oberarzt|chefarzt)/.test(t)) return 'senior';
  return 'mid';
}

function detectEmploymentType(title = '') {
  const t = normalize(title);
  const pct = t.match(/(\d{2,3})\s*[-–]\s*(\d{2,3})\s*%/) || t.match(/(\d{2,3})\s*%/);
  if (pct) {
    const maxPct = pct[2] ? parseInt(pct[2], 10) : parseInt(pct[1], 10);
    return maxPct < 80 ? 'PART_TIME' : 'FULL_TIME';
  }
  if (/teilzeit/.test(t)) return 'PART_TIME';
  if (/vollzeit/.test(t)) return 'FULL_TIME';
  return 'OTHER';
}

/* ── Factory ─────────────────────────────────────────────── */

/**
 * Create a rexx-systems parser for one hospital / employer.
 *
 * @param {Object} config
 * @param {string} config.companyKey
 * @param {string} config.companyName
 * @param {string} config.companyDomain        Corporate domain (e.g. `zgks.ch`).
 * @param {string} config.atsHost              Listing host (e.g. `jobs.zgks.ch`).
 * @param {string} [config.listingPath='/stellenangebote.html']
 * @param {string} config.defaultCanton        ISO canton (e.g. `ZG`).
 * @param {string} config.defaultCity
 * @param {string} config.defaultPostalCode
 * @param {string} [config.publicCareerUrl]    Corporate career landing URL.
 * @param {string} [config.defaultSourceLang='de']
 */
export function createRexxSystemsParser(config) {
  const {
    companyKey,
    companyName,
    companyDomain,
    atsHost,
    listingPath = '/stellenangebote.html',
    defaultCanton,
    defaultCity,
    defaultPostalCode,
    publicCareerUrl,
    defaultSourceLang = 'de',
  } = config;

  if (!companyKey || !companyName || !atsHost || !defaultCanton) {
    throw new Error('createRexxSystemsParser: missing required config');
  }

  const LISTING_URL = `https://${atsHost}${listingPath}`;
  const corporateHost = String(companyDomain || '').replace(/^www\./, '').toLowerCase();
  const atsHostLower = String(atsHost).toLowerCase();

  function isCompanyJob(job) {
    const key = normalize(job?.companyKey || '');
    const url = normalize(job?.url || '');
    if (key === companyKey) return true;
    if (corporateHost && url.includes(corporateHost)) return true;
    if (url.includes(atsHostLower)) return true;
    return false;
  }

  function isTrustedDomain(rawUrl = '') {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      if (corporateHost && (host === corporateHost || host.endsWith(`.${corporateHost}`))) return true;
      if (host === atsHostLower) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function fetchAllJobs() {
    console.log(`🏥 Fetching ${companyName} jobs`);
    console.log(`   Listing: ${LISTING_URL} (rexx systems)`);
    if (publicCareerUrl) console.log(`   Public:  ${publicCareerUrl}`);
    console.log();

    const html = await fetchHtml(LISTING_URL);
    const entries = parseRexxListing(html);
    console.log(`  ✓ ${entries.length} jobs in listing`);
    if (!entries.length) return [];

    const todayIso = new Date().toISOString().slice(0, 10);
    const jobs = [];
    let detailHits = 0;

    for (const entry of entries) {
      let detailDescription = '';
      let detailTitle = '';
      try {
        const detailHtml = await fetchHtml(entry.detailUrl);
        const detail = extractRexxDetail(detailHtml);
        detailDescription = detail.description;
        detailTitle = detail.title;
        if (detailDescription) detailHits++;
      } catch (err) {
        console.log(`     ⚠ detail fetch failed for j${entry.id}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 200));

      const title = detailTitle || entry.title;
      const description = detailDescription || `${title} — ${companyName}`;
      const sourceLang = detectLang(description || title, defaultSourceLang);
      const jobSlug = slugify(`${title} ${companyKey} ${defaultCity}`);
      const urlHash = createHash('sha1').update(entry.detailUrl).digest('hex').slice(0, 12);

      jobs.push({
        id: `${companyKey}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { [sourceLang]: jobSlug },
        company: companyName,
        companyKey,
        companyDomain,
        title,
        titleByLocale: { [sourceLang]: title },
        description,
        descriptionByLocale: { [sourceLang]: description },
        // Newly-discovered jobs ship with source-locale-only fields. The shared
        // AI-localization step clears this flag when it fills the other 3
        // locales; if it can't, `translate-pending.yml` picks them up.
        needsRetranslation: true,
        location: defaultCity,
        canton: inferSwissTargetCanton(defaultCity) || defaultCanton,
        url: entry.detailUrl,
        source: `${companyName} Dedicated Parser (rexx systems ${atsHostLower})`,
        sourceLang,
        crawledAt: new Date().toISOString(),

        addressLocality: defaultCity,
        addressRegion: defaultCanton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: defaultPostalCode,
        category: detectCategory(title),
        contract: 'full-time',
        employmentType: detectEmploymentType(title),
        experienceLevel: detectExperienceLevel(title),
        sector: 'Sanità / Ospedali',
        currency: 'CHF',
        featured: false,
        postedDate: todayIso,
        applyUrl: entry.detailUrl,
        requirements: [],
        requirementsByLocale: { [sourceLang]: [] },
      });
    }

    console.log(`\n📋 Total ${companyName} jobs discovered: ${jobs.length} (${detailHits}/${entries.length} with rich detail content)`);
    return jobs;
  }

  return { fetchAllJobs, isCompanyJob, isTrustedDomain };
}
