/**
 * Wuerth International AG job parser — HTML table + detail pages.
 *
 * Wuerth International uses a custom PHP site with jQuery DataTables
 * at wurth-international.com. The table data is server-side rendered
 * in the HTML (no AJAX needed). Each row links to a detail page with
 * the full description in accordion sections.
 *
 * Listing page: https://www.wurth-international.com/wurth-international-group/Karriere/Job-Portal/Jobs.php
 * Table ID: sortableTable9375499
 * Columns: Title | Location | Entry Level | Action (link to detail)
 *
 * Detail pages: Job-details_{id}.php
 *   - h1: job title
 *   - atribute-container: location, employment type (Vollzeit/Teilzeit), date posted
 *   - accordion sections: tasks, requirements, benefits, contact
 *
 * HQ: Chur, Canton GR, 7000
 *
 * Source: https://www.wurth-international.com/wurth-international-group/Karriere/Job-Portal/Jobs.php
 */
import { createHash } from 'node:crypto';
import { slugify, stripHtml, normalizeSpace, stripScriptsAndStyles } from './crawler-template.mjs';
import { getCompanyDefaults } from './crawler-location-config.mjs';
import { classifyMalformedRowDrift } from './malformed-row-observability.mjs';

/* ── Constants ─────────────────────────────────────────────── */

const HQ = getCompanyDefaults('wuerth-international');

const LISTING_URL = 'https://www.wurth-international.com/wurth-international-group/Karriere/Job-Portal/Jobs.php';
const BASE_URL = 'https://www.wurth-international.com/wurth-international-group/Karriere/Job-Portal/';

export const WUERTH_INTERNATIONAL_KEY = 'wuerth-international';
export const WUERTH_INTERNATIONAL_COMPANY_NAME = 'Würth International';
export const WUERTH_INTERNATIONAL_COMPANY_DOMAIN = 'wurth-international.com';

/* ── Date helper ──────────────────────────────────────────── */

/**
 * Parse "DD.MM.YYYY" → "YYYY-MM-DD". Returns '' on failure.
 */
export function parseDate(raw = '') {
  const m = String(raw || '').trim().match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/* ── Category detection ───────────────────────────────────── */

export function detectCategory(title = '', description = '') {
  const combined = `${title} ${description}`.toLowerCase();
  if (/steuer|tax|fiscal/i.test(combined)) return 'finance';
  if (/finanz|controll|buchhalt|accounting/i.test(combined)) return 'finance';
  if (/einkauf|procurement|purchasing|beschaffung/i.test(combined)) return 'logistics';
  if (/logist|lager|warehouse|supply chain|versand|transport/i.test(combined)) return 'logistics';
  if (/it\b|software|informatik|developer|system|sap|digital/i.test(combined)) return 'technology';
  if (/ingenieur|engineer|technik|technical/i.test(combined)) return 'engineering';
  if (/marketing|kommunikation|communication|vertrieb|verkauf|sales/i.test(combined)) return 'marketing';
  if (/hr\b|personal|human resources|recruit/i.test(combined)) return 'hr';
  if (/recht|legal|jurist|compliance/i.test(combined)) return 'legal';
  if (/praktik|ausbildung|trainee|apprentice|lernend/i.test(combined)) return 'internship';
  if (/kaufm|commercial|administrat|empfang|reception|sekretariat|büro|office|assistenz/i.test(combined)) return 'administration';
  return 'administration'; // Default for international trading company
}

/* ── Employment type detection ────────────────────────────── */

export function detectEmploymentType(raw = '') {
  const text = String(raw || '').toLowerCase();
  if (text.includes('vollzeit') || text.includes('full')) return 'FULL_TIME';
  if (text.includes('teilzeit') || text.includes('part')) return 'PART_TIME';
  return 'FULL_TIME';
}

/* ── Listing page parser ──────────────────────────────────── */

/**
 * Parse the career listing page HTML table.
 * Returns `{ jobs, skippedMalformedRows }`. Header/chrome rows without data
 * cells and duplicate URLs are not malformed and do not increment the count.
 */
export function parseListingPage(html) {
  if (!html || typeof html !== 'string') return { jobs: [], skippedMalformedRows: 0 };

  const jobs = [];
  const seen = new Set();
  let skippedMalformedRows = 0;

  // Find the DataTables table content
  const tableMatch = html.match(/<table[^>]*id="sortableTable9375499"[^>]*>([\s\S]*?)<\/table>/i);
  const tableHtml = tableMatch ? tableMatch[1] : html;

  // Parse each row
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rowRe.exec(tableHtml)) !== null) {
    const rowHtml = match[1];

    // Extract cells
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cells.push(normalizeSpace(stripHtml(cellMatch[1])));
    }

    if (cells.length === 0) continue;
    if (cells.length < 3) {
      skippedMalformedRows += 1;
      continue;
    }

    const title = cells[0];
    const location = cells[1] || 'Chur';
    const entryLevel = cells[2] || '';

    if (!title || title.length < 3) {
      skippedMalformedRows += 1;
      continue;
    }

    // Extract detail link
    const linkMatch = rowHtml.match(/<a[^>]+href="([^"]*Job-details[^"]*)"[^>]*>/i);
    if (!linkMatch) {
      skippedMalformedRows += 1;
      continue;
    }

    const detailPath = linkMatch[1];
    const fullUrl = detailPath.startsWith('http')
      ? detailPath
      : `${BASE_URL}${detailPath}`;

    if (seen.has(fullUrl)) continue;
    seen.add(fullUrl);

    jobs.push({ title, url: fullUrl, location, entryLevel });
  }

  return { jobs, skippedMalformedRows };
}

/* ── Detail page parser ───────────────────────────────────── */

/**
 * Parse a Wuerth International detail page.
 * Returns { title, description, location, employmentType, postedDate, applyUrl }.
 */
export function parseDetailPage(html) {
  if (!html || typeof html !== 'string') return null;

  // Extract title from h1
  const h1Match = stripScriptsAndStyles(html).match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = h1Match ? normalizeSpace(stripHtml(h1Match[1])) : '';
  if (!title || title.length < 3) return null;

  // Extract attributes: location, employment type, posted date
  const attrMatch = html.match(/<div[^>]*class="[^"]*atribute-container[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  let location = 'Chur';
  let employmentType = 'FULL_TIME';
  let postedDate = '';

  if (attrMatch) {
    const attrHtml = attrMatch[1];

    // Location: <i class="icon-location-pin ..."></i> Chur
    const locMatch = attrHtml.match(/icon-location-pin[^>]*><\/i>\s*([^<]+)/i);
    if (locMatch) {
      location = normalizeSpace(locMatch[1]) || 'Chur';
    }

    // Employment type: <i class="icon-interface-clock-b ..."></i>Vollzeit
    const typeMatch = attrHtml.match(/icon-interface-clock[^>]*><\/i>\s*([^<]+)/i);
    if (typeMatch) {
      employmentType = detectEmploymentType(typeMatch[1]);
    }

    // Posted date: Erschienen am: DD.MM.YYYY
    const dateMatch = attrHtml.match(/Erschienen\s*am:\s*(\d{1,2}\.\d{1,2}\.\d{4})/i);
    if (dateMatch) {
      postedDate = parseDate(dateMatch[1]);
    }
  }

  // Extract apply URL from "Jetzt bewerben" link
  let applyUrl = '';
  const applyMatch = html.match(/<a[^>]+href="([^"]*Bewerbungsformular[^"]*)"[^>]*>/i);
  if (applyMatch) {
    const applyPath = applyMatch[1];
    applyUrl = applyPath.startsWith('http')
      ? applyPath
      : `https://www.wurth-international.com${applyPath.replace(/^\.\.\/\.\.\/\.\./, '')}`;
  }

  // Extract description from all content sections
  const parts = [];

  // Intro paragraph(s) before accordion
  const introRe = /<div[^>]*class="[^"]*outer-container[^"]*hidden_when_searched[^"]*jobs_jobs_job_template[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*<\/div>/gi;
  let introMatch;
  while ((introMatch = introRe.exec(html)) !== null) {
    const content = introMatch[1];
    // Skip sections that contain the accordion (they have their own parser below)
    if (content.includes('accordion')) continue;
    const text = normalizeSpace(stripHtml(content));
    // Filter out just the title and attribute-only blocks
    if (text.length > 30 && !text.match(/^Steuerexperte|^Berufspraktikum/)) {
      parts.push(text);
    }
  }

  // Accordion sections (IHRE AUFGABEN, DAS BRINGEN SIE MIT, DAS BIETEN WIR, etc.)
  const accordionRe = /<div[^>]*class="[^"]*card-body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let accMatch;
  while ((accMatch = accordionRe.exec(html)) !== null) {
    const sectionHtml = accMatch[1];
    const text = normalizeSpace(stripHtml(sectionHtml));
    if (text.length > 20) {
      parts.push(text);
    }
  }

  // Also try to extract section headings for structure
  const headingRe = /class="[^"]*font-weight-bold[^"]*text-body[^"]*"[^>]*>\s*([\s\S]*?)<\/div>/gi;
  const headings = [];
  let hMatch;
  while ((hMatch = headingRe.exec(html)) !== null) {
    const heading = normalizeSpace(stripHtml(hMatch[1]));
    if (heading.length > 3 && heading.length < 100) {
      headings.push(heading);
    }
  }

  // Build structured description
  let description = '';
  if (parts.length > 0) {
    description = parts.join('\n\n');
  }

  return {
    title,
    description,
    location,
    employmentType,
    postedDate,
    applyUrl,
    headings,
  };
}

/* ── Fallback description ─────────────────────────────────── */

/**
 * Build a rich fallback description (>50 words) when detail page yields nothing.
 */
export function buildFallbackDescription(title, location, entryLevel = '') {
  const levelInfo = entryLevel ? ` Einstiegslevel: ${entryLevel}.` : '';
  return `${title} bei Würth International AG in ${location}, Kanton Graubünden, Schweiz.${levelInfo}\n\nDie Würth International AG ist ein Unternehmen der Würth-Gruppe, dem weltgrössten Handelskonzern für Montage- und Befestigungsmaterial. Am Hauptsitz in Chur (Graubünden) betreut Würth International die Zentraleinkaufsaktivitäten des Würth Konzerns in rund 80 Ländern. Das Unternehmen bietet ein internationales Arbeitsumfeld mit modernen Anstellungsbedingungen, flexiblen Arbeitszeiten, hybriden Arbeitsmodellen, überdurchschnittlichen Sozialleistungen und vielfältigen Weiterbildungsmöglichkeiten. Würth International ist ausgezeichnet mit dem Label Friendly Work Space und legt grossen Wert auf eine wertschätzende Unternehmenskultur.`;
}

/* ── Job identification ───────────────────────────────────── */

export function isWuerthInternationalJob(job = {}) {
  const key = String(job?.companyKey || '')
    .trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const company = String(job?.company || '').toLowerCase();
  const url = String(job?.url || '').toLowerCase();

  return (
    key === WUERTH_INTERNATIONAL_KEY ||
    company.includes('würth international') ||
    company.includes('wuerth international') ||
    company.includes('wurth international') ||
    url.includes('wurth-international.com')
  );
}

export function isTrustedDomain(rawUrl = '') {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return (
      host === 'wurth-international.com' ||
      host === 'www.wurth-international.com' ||
      host.endsWith('.wurth-international.com')
    );
  } catch {
    return false;
  }
}

/* ── Main fetch function ──────────────────────────────────── */

/**
 * Fetch all Wuerth International jobs.
 * 1. Fetch listing page, parse table rows
 * 2. For each job, fetch detail page for full description
 * Returns ParsedJob[] with source-locale fields only.
 */
export async function fetchAllWuerthInternationalJobs() {
  const timeoutMs = Number(process.env.JOBS_CRAWLER_TIMEOUT_MS) || 20000;
  const userAgent = process.env.JOBS_CRAWLER_USER_AGENT ||
    'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)';

  console.log(`🔧 Fetching Würth International jobs`);
  console.log(`   Listing: ${LISTING_URL}\n`);

  // Step 1: Fetch listing page
  const controller1 = new AbortController();
  const timer1 = setTimeout(() => controller1.abort(), timeoutMs);
  let listingHtml;
  try {
    const res = await fetch(LISTING_URL, {
      headers: { 'User-Agent': userAgent },
      signal: controller1.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from listing page`);
    listingHtml = await res.text();
  } catch (err) {
    throw new Error(`Failed to fetch listing page: ${err?.message || err}`);
  } finally {
    clearTimeout(timer1);
  }

  const { jobs: listings, skippedMalformedRows } = parseListingPage(listingHtml);
  const listingDiagnostic = classifyMalformedRowDrift(listings.length, skippedMalformedRows);
  if (skippedMalformedRows > 0) {
    console.warn(
      `⚠️ Würth International listing: skipped ${skippedMalformedRows}/${listingDiagnostic.total} malformed row(s).`,
    );
  }
  if (listingDiagnostic.severity === 'error') {
    throw new Error(
      `Würth International listing structure drift: ${skippedMalformedRows}/${listingDiagnostic.total} rows malformed`,
    );
  }
  console.log(`  📋 Found ${listings.length} job listings\n`);

  if (listings.length === 0) {
    console.warn('⚠️ No job listings found on the career page.');
    return [];
  }

  // Step 2: Fetch detail pages
  const jobs = [];
  for (const listing of listings) {
    try {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs);

      let detail = null;
      try {
        const res = await fetch(listing.url, {
          headers: { 'User-Agent': userAgent },
          signal: controller2.signal,
        });

        if (res.ok) {
          const detailHtml = await res.text();
          detail = parseDetailPage(detailHtml);
        }
      } finally {
        clearTimeout(timer2);
      }

      // Build job object
      const title = detail?.title || listing.title;
      const location = detail?.location || listing.location || 'Chur';
      const employmentTypeRaw = detail?.employmentType || 'FULL_TIME';
      const postedDate = detail?.postedDate || new Date().toISOString().slice(0, 10);

      // Build description
      let description = '';
      if (detail?.description && detail.description.split(/\s+/).length >= 50) {
        description = detail.description;
      } else {
        description = buildFallbackDescription(title, location, listing.entryLevel);
      }

      const urlHash = createHash('sha1').update(listing.url).digest('hex').slice(0, 12);
      const jobSlug = slugify(`${title} wuerth-international ${location}`);

      const job = {
        id: `${WUERTH_INTERNATIONAL_KEY}-${urlHash}`,
        slug: jobSlug,
        slugByLocale: { de: jobSlug },
        company: WUERTH_INTERNATIONAL_COMPANY_NAME,
        companyKey: WUERTH_INTERNATIONAL_KEY,
        companyDomain: WUERTH_INTERNATIONAL_COMPANY_DOMAIN,
        title,
        titleByLocale: { de: title },
        description,
        descriptionByLocale: { de: description },
        location,
        canton: HQ.canton,
        addressLocality: location,
        addressRegion: HQ.canton,
        addressCountry: 'CH',
        country: 'CH',
        postalCode: HQ.postalCode,
        streetAddress: `${location}, Graubünden`,
        category: detectCategory(title, description),
        sector: 'Industria / Distribuzione',
        contract: employmentTypeRaw === 'PART_TIME' ? 'part-time' : 'full-time',
        employmentType: employmentTypeRaw,
        experienceLevel: listing.entryLevel === 'Auszubildende' ? 'intern' : 'mid',
        featured: false,
        postedDate,
        url: listing.url,
        applyUrl: detail?.applyUrl || listing.url,
        source: 'Wuerth International Dedicated Parser (HTML)',
        sourceLang: 'de',
        crawledAt: new Date().toISOString(),
      };

      jobs.push(job);
      console.log(`  ✅ ${title.substring(0, 60)}`);
    } catch (err) {
      console.warn(`  ⚠️ Skipping ${listing.title} — detail fetch failed: ${err?.message || err}`);
    }

    // Polite delay between requests
    await new Promise((r) => setTimeout(r, 300));
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = [];
  for (const job of jobs) {
    const key = job.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(job);
  }

  console.log(`\n📋 Total unique Würth International jobs discovered: ${deduped.length}`);
  return deduped;
}
