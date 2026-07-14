#!/usr/bin/env node
/**
 * Fondation Soins Lausanne job parser — jobup.ch search SERP (clean-IP Jina
 * proxy) with a STRICT employer filter.
 *
 * Fondation Soins Lausanne (FSL) is one of AVASAD's (Association Vaudoise
 * d'Aide et de Soins à Domicile) regional foundations, providing home-based
 * nursing/care ("aide et soins à domicile") within the city of Lausanne (its
 * territory is city-scoped, unlike sister foundations such as APROMAD, ASPMAD,
 * ASANTE SANA, APREMADOL, ABSMAD that cover the rest of canton Vaud).
 *
 * SOURCE MIGRATION (issue #4168): the previous source, the shared AVASAD portal
 * `cms-vaud.ch`, is DEAD for automated fetches — it 403s the GitHub Actions
 * egress IP AND stays 403 even routed through the clean-IP Jina proxy, so it can
 * no longer be crawled. FSL's real, current openings are published on jobup.ch
 * (JobCloud/TX network). We fetch the jobup search results page (SERP) for the
 * employer term via the shared Jina Reader proxy with `X-Return-Format: html`
 * (jobup.ch itself WAF-blocks datacenter IPs; Jina's clean IP pool clears it),
 * then parse the `data-cy="serp-item-{uuid}"` job cards it renders.
 *
 * STRICT EMPLOYER FILTER (mandatory): the jobup term search for "Fondation Soins
 * Lausanne" is relevance-ranked and surfaces jobs from OTHER employers on the
 * same page — most notably "Fondation de Vernand" (a DIFFERENT foundation), plus
 * the AVASAD umbrella itself, Clinique de La Source, Fondation Le Relais, etc.
 * We keep ONLY cards whose employer, normalized (trim + case-insensitive) as an
 * EXACT string, equals "Fondation Soins Lausanne". No fuzzy / substring match —
 * "Fondation de Vernand" and every other employer are dropped. Verified live
 * (2026-07): 12 genuine FSL cards among 20 on page 1; 8 other employers filtered.
 *
 * jobup SERP card markup (per result):
 *   <a data-cy="job-link" ... href="/fr/emplois/detail/{uuid}/">
 *     <div data-cy="serp-item-{uuid}">…</div>
 *     <span class="… fw_bold textStyle_body2 …">{TITLE}</span>
 *     …"Lieu de travail":<p>{CITY}</p> "Taux d'activité":<p>{RATE}</p>
 *        "Type de contrat":<p>{CONTRACT}</p>…
 *     <p class="… c_gray.700 fw_bold">{EMPLOYER}</p>
 *   </a>
 *
 * Rich descriptions are enriched per kept card from the jobup.ch detail page's
 * schema.org JobPosting JSON-LD via the SHARED helper
 * `fetchJobupDetailDescription` (reused from jobup-ch-feed-common.mjs). If detail
 * enrichment is unavailable, a source-locale French fallback (well above the
 * 50-word thin-content floor) is synthesized from the card fields.
 */
import { createHash } from 'node:crypto';
import { detectLang } from './dedicated-crawler-common.mjs';
import { slugify } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { inferSwissTargetCanton } from './target-swiss-locations.mjs';
import { fetchViaJinaWithRetry } from './jina-proxy.mjs';
import {
  decodeEntities,
  fetchJobupDetailDescription,
  detectEmploymentTypeFromOccupation,
} from './jobup-ch-feed-common.mjs';
import {
  normalizeSpace,
  detectHealthcareCategory,
  detectHealthcareExperienceLevel,
  detectHealthcareEmploymentType,
} from './hospital-custom-html-helpers.mjs';

/* ── Constants ─────────────────────────────────────────────── */

export const FONDATION_SOINS_LAUSANNE_KEY = 'fondation-soins-lausanne';
export const FONDATION_SOINS_LAUSANNE_COMPANY_NAME = 'Fondation Soins Lausanne';
export const FONDATION_SOINS_LAUSANNE_COMPANY_DOMAIN = 'fondationsoinslausanne.ch';

// jobup.ch employer term search. Relevance-ranked; the strict filter below drops
// every non-FSL employer the query also surfaces (see file header).
const SEARCH_URL = 'https://www.jobup.ch/fr/emplois/?term=Fondation%20Soins%20Lausanne';

const HQ = getCompanyDefaults(FONDATION_SOINS_LAUSANNE_KEY) || {
  city: 'Lausanne',
  canton: 'VD',
  postalCode: '1010',
  addressRegion: 'VD',
};

/* ── SERP card parser ──────────────────────────────────────── */

/** Extract a labelled card field ("Lieu de travail" / "Taux d'activité" / "Type de contrat"). */
function serpFieldValue(segment, label) {
  // jobup renders "<label><!-- -->:</span><p …>VALUE</p>"; the visually-hidden
  // label span precedes the value paragraph.
  const rx = new RegExp(`${label}<!-- -->:</span><p[^>]*>([^<]+)</p>`);
  const m = segment.match(rx);
  return m ? normalizeSpace(decodeEntities(m[1])) : '';
}

/**
 * Parse the jobup search SERP HTML into raw job cards.
 * Returns `[{ uuid, url, title, company, location, workRate, contract }]`.
 * The employer is NOT filtered here — call `filterFondationSoinsLausanneCards`.
 */
export function parseJobupSerpCards(html = '') {
  const out = [];
  if (!html) return out;
  // Each result card is a "job-link" anchor to a detail page; split on it so
  // every segment holds exactly one card (title/fields/employer all inside).
  const segments = String(html).split(/<a[^>]*\bdata-cy="job-link"[^>]*href="\/fr\/emplois\/detail\//i);
  for (let i = 1; i < segments.length; i += 1) {
    const seg = segments[i];
    const uuid = (seg.match(/^([0-9a-f-]+)\//i) || [])[1];
    if (!uuid) continue;

    const title = normalizeSpace(decodeEntities((seg.match(/textStyle_body2[^>]*>([^<]+)</) || [])[1] || ''));
    // Employer: the bold caption paragraph rendered under the avatar logo.
    const company = normalizeSpace(
      decodeEntities((seg.match(/<p class="[^"]*c_gray\.700[^"]*fw_bold">([^<]+)<\/p>/) || [])[1] || ''),
    );
    const location = serpFieldValue(seg, 'Lieu de travail');
    const workRate = serpFieldValue(seg, "Taux d'activité");
    const contract = serpFieldValue(seg, 'Type de contrat');

    if (!title || title.length < 3) continue;
    out.push({
      uuid,
      // jobup.ch è un portale esterno; /fr/ è la lingua canonica per un datore
      // vodese francofono (FSL, Losanna), serve solo a estrarre la descrizione
      // via Jina — non è un URL del nostro sito. locale-segment-ok: portale-esterno
      url: `https://www.jobup.ch/fr/emplois/detail/${uuid}/`,
      title,
      company,
      location,
      workRate,
      contract,
    });
  }
  return out;
}

/**
 * STRICT employer filter: keep only cards whose employer is EXACTLY
 * "Fondation Soins Lausanne" (trim + case-insensitive). Excludes
 * "Fondation de Vernand" and every other employer the term search surfaces.
 * No fuzzy / substring matching.
 */
export function filterFondationSoinsLausanneCards(cards = []) {
  const target = FONDATION_SOINS_LAUSANNE_COMPANY_NAME.trim().toLowerCase();
  return (Array.isArray(cards) ? cards : []).filter(
    (c) => String(c?.company || '').trim().toLowerCase() === target,
  );
}

/* ── Field helpers ─────────────────────────────────────────── */

function parseCityFromCard(location = '') {
  // "Lausanne" / "Lausanne 10" / "Lausanne, Lausanne" → "Lausanne".
  const first = String(location || '').split(',')[0] || '';
  const city = normalizeSpace(first.replace(/\s+\d+$/, ''));
  return city || HQ.city;
}

function employmentTypeFromCard(workRate = '', title = '') {
  // Card work rate is a range like "60 – 80%"; the max percent drives the
  // FULL_TIME/PART_TIME classification (shared jobup helper).
  const nums = String(workRate || '').match(/\d{1,3}/g);
  if (nums && nums.length) {
    const max = Math.max(...nums.map(Number));
    return detectEmploymentTypeFromOccupation('', String(max));
  }
  return detectHealthcareEmploymentType(title);
}

function contractFromCard(contract = '') {
  // "Durée indéterminée" → permanent. Guard against the "indéterminée"
  // substring falsely matching a "déterminée" (fixed-term) test.
  if (/ind[ée]termin/i.test(contract)) return 'full-time';
  if (/d[ée]termin[ée]e|temporaire|cdd|int[ée]rim|fixed/i.test(contract)) return 'temporary';
  return 'full-time';
}

function buildFallbackDescription({ title, city, workRate, contract }) {
  // Source-locale (French) fallback used only when the jobup detail JSON-LD is
  // unavailable. Deliberately clears the 50-word thin-content floor.
  return normalizeSpace(
    [
      `${title} — un poste à pourvoir au sein de la ${FONDATION_SOINS_LAUSANNE_COMPANY_NAME}.`,
      `La Fondation Soins Lausanne assure des prestations d'aide et de soins à domicile pour la population de la ville de Lausanne, au sein du réseau vaudois AVASAD (Association Vaudoise d'Aide et de Soins à Domicile).`,
      `En rejoignant nos équipes pluridisciplinaires, vous contribuez concrètement à la santé, à l'autonomie et au bien-vivre des personnes accompagnées à leur domicile, dans le canton de Vaud.`,
      `Lieu de travail : ${city || HQ.city}.`,
      workRate ? `Taux d'activité : ${workRate}.` : '',
      contract ? `Type de contrat : ${contract}.` : '',
      `Postulez directement via l'annonce jobup.ch liée à cette offre.`,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

/* ── Company matchers ──────────────────────────────────────── */

export function isFondationSoinsLausanneJob(job) {
  const key = String(job?.companyKey || '').toLowerCase();
  const company = String(job?.company || '').trim().toLowerCase();
  const url = String(job?.url || '').toLowerCase();
  if (key === FONDATION_SOINS_LAUSANNE_KEY) return true;
  // Exact employer name only — never fuzzy-match sibling foundations
  // (e.g. "Fondation de Vernand") that share the jobup search results.
  if (company === FONDATION_SOINS_LAUSANNE_COMPANY_NAME.toLowerCase()) return true;
  return false;
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'jobup.ch' || host === 'www.jobup.ch') return true;
    if (host === FONDATION_SOINS_LAUSANNE_COMPANY_DOMAIN || host.endsWith(`.${FONDATION_SOINS_LAUSANNE_COMPANY_DOMAIN}`)) return true;
    return false;
  } catch {
    return false;
  }
}

/* ── Fetch helpers ─────────────────────────────────────────── */

async function fetchSerpHtml() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 40000;
  // jobup.ch WAF-blocks datacenter IPs → always go through the clean-IP Jina
  // proxy (HTML return format), retried across Jina's IP pool.
  const res = await fetchViaJinaWithRetry(SEARCH_URL, { timeoutMs, format: 'html' });
  if (!res || !res.ok) {
    const reason = res?.headers?.get?.('x-jina-retry-reason') || `HTTP ${res?.status}`;
    console.warn(`  ⚠️ jobup SERP fetch via Jina not usable (${reason})`);
    return '';
  }
  return await res.text();
}

/* ── Public API ────────────────────────────────────────────── */

export async function fetchAllFondationSoinsLausanneJobs() {
  console.log(`🏥 Fetching ${FONDATION_SOINS_LAUSANNE_COMPANY_NAME} jobs`);
  console.log(`   Source: ${SEARCH_URL}\n`);

  let html = '';
  try {
    html = await fetchSerpHtml();
  } catch (err) {
    console.warn(`  ⚠️ jobup SERP fetch failed: ${err?.message || err}`);
    return [];
  }
  if (!html) return [];

  const allCards = parseJobupSerpCards(html);
  const cards = filterFondationSoinsLausanneCards(allCards);
  const dropped = allCards.length - cards.length;
  console.log(
    `  ✓ ${allCards.length} jobup card(s) parsed → ${cards.length} kept as "${FONDATION_SOINS_LAUSANNE_COMPANY_NAME}" (${dropped} other-employer card(s) filtered out)`,
  );
  if (!cards.length) return [];

  const todayIso = new Date().toISOString().slice(0, 10);
  const jobs = [];
  let detailHits = 0;

  for (const card of cards) {
    const city = parseCityFromCard(card.location);
    const canton = inferSwissTargetCanton(city) || HQ.canton;
    const postalCode = HQ.postalCode;

    // Rich description from the jobup detail JSON-LD (shared helper). Falls back
    // to a synthesized French description above the thin-content floor.
    let detailDescription = '';
    try {
      detailDescription = await fetchJobupDetailDescription(card.url);
    } catch {
      detailDescription = '';
    }
    if (detailDescription) detailHits += 1;
    await new Promise((r) => setTimeout(r, 250));

    const detailWordCount = detailDescription.split(/\s+/).filter(Boolean).length;
    const description = detailWordCount >= 50
      ? detailDescription
      : buildFallbackDescription({ title: card.title, city, workRate: card.workRate, contract: card.contract });

    const sourceLang = detectLang(description || card.title, 'fr');
    const slug = slugify(`${card.title} ${FONDATION_SOINS_LAUSANNE_KEY} ${city}`);
    const urlHash = createHash('sha1').update(card.url).digest('hex').slice(0, 12);
    const employmentType = employmentTypeFromCard(card.workRate, card.title);
    const contract = contractFromCard(card.contract);

    jobs.push({
      id: `${FONDATION_SOINS_LAUSANNE_KEY}-${urlHash}`,
      slug,
      slugByLocale: { [sourceLang]: slug },
      company: FONDATION_SOINS_LAUSANNE_COMPANY_NAME,
      companyKey: FONDATION_SOINS_LAUSANNE_KEY,
      companyDomain: FONDATION_SOINS_LAUSANNE_COMPANY_DOMAIN,
      title: card.title,
      titleByLocale: { [sourceLang]: card.title },
      description,
      descriptionByLocale: { [sourceLang]: description },
      // Newly-discovered jobs ship with source-locale-only fields. The shared
      // AI-localization step clears this flag when it fills the remaining 3
      // locales; if it can't (cache miss + AI quota), the flag stays and
      // `translate-pending.yml` picks the job up out-of-band.
      needsRetranslation: true,
      location: city,
      canton,
      url: card.url,
      source: 'Fondation Soins Lausanne Dedicated Parser (jobup.ch search SERP + strict employer filter)',
      sourceLang,
      crawledAt: new Date().toISOString(),
      addressLocality: city,
      addressRegion: canton,
      addressCountry: 'CH',
      country: 'CH',
      postalCode,
      category: detectHealthcareCategory(`${card.title} ${description}`),
      contract,
      employmentType,
      experienceLevel: detectHealthcareExperienceLevel(card.title),
      sector: 'Sanità / Ospedali',
      currency: 'CHF',
      featured: false,
      postedDate: todayIso,
      applyUrl: card.url,
      requirements: [],
      requirementsByLocale: { [sourceLang]: [] },
      careerSiteUrl: SEARCH_URL,
    });
  }

  console.log(
    `\n📋 Total ${FONDATION_SOINS_LAUSANNE_COMPANY_NAME} jobs discovered: ${jobs.length} (${detailHits}/${cards.length} with rich jobup.ch detail content)`,
  );
  return jobs;
}
